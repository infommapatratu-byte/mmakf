// The regulatory engine — source register, instruments, rules, determinations.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR RULES THIS MODULE ENFORCES, AND WHY EACH ONE IS HERE
// ═══════════════════════════════════════════════════════════════════════════
//
//  1. AN UNAPPROVED RULE CANNOT DECIDE ANYTHING. evaluate() resolves a rule
//     version by DATE and then checks its state. A version whose window
//     contains the date but which is still in draft or review returns the typed
//     refusal `not_approved` — never `ineligible`. A half-written policy that
//     silently refused applicants would be the worst failure this subsystem
//     could have, because the applicant would be told they failed a rule that
//     nobody had ever agreed to.
//
//  2. "NO RULE" AND "FAILED THE RULE" ARE DIFFERENT ANSWERS. `no_rule_in_force`
//     means MMAKF has approved nothing on the point. `ineligible` means it has,
//     and the subject does not meet it. Returning one value for both would let
//     an unwritten policy present itself as a refusal — the same class of lie as
//     an empty committee rendering as a filled one.
//
//  3. A MISSING FACT IS NOT A FAILED CONDITION. If a rule tests `grade_rank` and
//     the caller supplied no grade, the answer is `insufficient_facts`, not
//     `ineligible`. Treating absence as failure is how a system refuses somebody
//     for a record it never asked them for.
//
//  4. ADOPTION IS AN EVENT WITH A DATE AND A NAME. A source provision — a rule
//     read off karateacademy.in — becomes MMAKF policy only by being cited in an
//     instrument version that is then APPROVED and PUBLISHED. adoptSourceProvision()
//     writes the citation; publishInstrumentVersion() is what flips the source
//     row to `adopted`. Nothing else in this module sets that status, so
//     "adopted" always means "an instrument carrying it became binding".
//
// ═══════════════════════════════════════════════════════════════════════════
// TIME
// ═══════════════════════════════════════════════════════════════════════════
//
// Effective ranges are HALF-OPEN: `effective_from <= d AND (effective_to IS NULL
// OR d < effective_to)`. The day a version ends is the day its successor begins,
// with no gap in which no rule exists and no overlap in which two do. Both of
// those are indefensible when the day in question is the day somebody was
// refused, and an inclusive upper bound produces one or the other every time.
//
// A determination pins `ruleVersionId`, not `ruleId`. Amending a rule in 2027
// must not restate what was decided in 2026.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE CONDITION LANGUAGE IS DELIBERATELY SMALL
// ═══════════════════════════════════════════════════════════════════════════
//
// `{ fact, op, value }` and eleven operators. It is not an expression evaluator
// and it will not become one. A rule that could execute arbitrary logic is a
// rule a governance committee cannot read, and an approval given to something
// unreadable is not an approval. Anything genuinely more complex than this is a
// decision a human should be making — which is what `requires_review` is for.
//
// See docs/governance/KARATE-ACADEMY-SOURCE-REGISTER.md and
// docs/governance/MMAKF-REGULATORY-GAP-ANALYSIS.md.

import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export const isPolicyError = (e: unknown): e is PolicyError => e instanceof PolicyError;

// ─── Dates ──────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function today(on: Date = new Date()): string {
  return on.toISOString().slice(0, 10);
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ISO.test(value)) {
    throw new PolicyError('bad_date', `${field} must be a calendar date in YYYY-MM-DD form.`);
  }
}

/**
 * Is `d` inside a half-open effective window?
 *
 * Exported because the tests assert the boundary directly: the first day is IN,
 * the last day is OUT, and there is no arrangement of the two in which a
 * supersession produces a gap or an overlap.
 */
export function inForceOn(
  d: string,
  from: string | null | undefined,
  to: string | null | undefined
): boolean {
  if (!from) return false;                 // never dated, never in force
  if (d < from) return false;
  if (to && d >= to) return false;         // exclusive upper bound
  return true;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export type PolicyState =
  | 'draft' | 'technical_review' | 'legal_review' | 'governance_review'
  | 'approved' | 'published' | 'effective' | 'superseded' | 'withdrawn' | 'archived';

/**
 * The permitted moves. Anything not listed is refused rather than silently
 * allowed, so a version cannot travel from `draft` to `published` because a
 * screen offered the button.
 */
const TRANSITIONS: Record<PolicyState, PolicyState[]> = {
  draft: ['technical_review', 'legal_review', 'governance_review', 'withdrawn'],
  technical_review: ['legal_review', 'governance_review', 'draft', 'withdrawn'],
  legal_review: ['governance_review', 'draft', 'withdrawn'],
  governance_review: ['approved', 'draft', 'withdrawn'],
  approved: ['published', 'draft', 'withdrawn'],
  published: ['effective', 'superseded', 'withdrawn'],
  effective: ['superseded', 'withdrawn'],
  superseded: ['archived'],
  withdrawn: ['archived'],
  archived: [],
};

/**
 * States in which a version has been published at least once, and may therefore
 * govern a date.
 *
 * `approved` is NOT here. Approval is the governance decision; publication is
 * telling people. A rule that binds members who were never able to read it is
 * not a rule anyone can be held to, and the gap between the two dates is real —
 * see the note on `policy_state` in the schema.
 *
 * `superseded` and `archived` ARE here, because a superseded version still
 * governs the dates inside its own window. That is the whole point of keeping it.
 */
const BINDING_STATES: readonly PolicyState[] = ['published', 'effective', 'superseded', 'archived'];

const isBinding = (state: string): boolean => BINDING_STATES.includes(state as PolicyState);

/** Editable states — a published version is frozen. */
const DRAFTING_STATES: readonly PolicyState[] =
  ['draft', 'technical_review', 'legal_review', 'governance_review'];

// ─── The condition language ─────────────────────────────────────────────────

export type ConditionOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'includes_all' | 'exists' | 'absent';

const OPS: readonly ConditionOp[] = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'includes_all', 'exists', 'absent',
];

/** Operators that are ABOUT presence, so a missing fact is an answer, not a gap. */
const PRESENCE_OPS: readonly ConditionOp[] = ['exists', 'absent'];

export interface RuleCondition {
  /** The name of the fact, as the caller supplies it. */
  fact: string;
  op: ConditionOp;
  value?: unknown;
  /** Human sentence for the surface — "holds 4th Kyu or above". */
  label?: string;
}

export interface ConditionResult extends RuleCondition {
  actual: unknown;
  met: boolean;
  /** True when the fact was not supplied at all. */
  missing: boolean;
}

export type Outcome =
  | 'eligible' | 'ineligible' | 'requires_review'
  | 'no_rule_in_force' | 'not_approved' | 'insufficient_facts';

function assertConditions(raw: unknown): RuleCondition[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PolicyError('bad_conditions', 'A rule version must carry at least one condition.');
  }
  return raw.map((c: any, i) => {
    if (!c || typeof c.fact !== 'string' || !c.fact.trim()) {
      throw new PolicyError('bad_conditions', `Condition ${i + 1} has no fact name.`);
    }
    if (!OPS.includes(c.op)) {
      throw new PolicyError(
        'bad_conditions',
        `Condition ${i + 1} uses operator "${c.op}", which this engine does not implement. ` +
        `Permitted: ${OPS.join(', ')}.`
      );
    }
    if (!PRESENCE_OPS.includes(c.op) && c.value === undefined) {
      throw new PolicyError('bad_conditions', `Condition ${i + 1} (${c.op}) needs a value.`);
    }
    if ((c.op === 'in' || c.op === 'not_in' || c.op === 'includes_all') && !Array.isArray(c.value)) {
      throw new PolicyError('bad_conditions', `Condition ${i + 1} (${c.op}) needs an array value.`);
    }
    return { fact: c.fact, op: c.op, value: c.value, label: c.label } as RuleCondition;
  });
}

/**
 * Compare one fact against one condition.
 *
 * Ordered comparisons accept numbers and ISO date strings and NOTHING ELSE.
 * JavaScript will happily tell you that 'brown' > 'black', and a grade check
 * that silently compared belt colours as strings would produce confident
 * nonsense. Refusing the comparison surfaces the modelling mistake instead.
 */
function testCondition(c: RuleCondition, facts: Record<string, unknown>): ConditionResult {
  const present = Object.prototype.hasOwnProperty.call(facts, c.fact)
    && facts[c.fact] !== undefined && facts[c.fact] !== null;
  const actual = present ? facts[c.fact] : undefined;

  if (c.op === 'exists') return { ...c, actual, met: present, missing: false };
  if (c.op === 'absent') return { ...c, actual, met: !present, missing: false };

  if (!present) return { ...c, actual, met: false, missing: true };

  switch (c.op) {
    case 'eq': return { ...c, actual, met: actual === c.value, missing: false };
    case 'ne': return { ...c, actual, met: actual !== c.value, missing: false };
    case 'in':
      return { ...c, actual, met: (c.value as unknown[]).includes(actual), missing: false };
    case 'not_in':
      return { ...c, actual, met: !(c.value as unknown[]).includes(actual), missing: false };
    case 'includes_all': {
      const held = Array.isArray(actual) ? actual : [actual];
      const wanted = c.value as unknown[];
      return { ...c, actual, met: wanted.every((w) => held.includes(w)), missing: false };
    }
    default: {
      const a = orderable(actual);
      const b = orderable(c.value);
      if (a === null || b === null) {
        throw new PolicyError(
          'uncomparable',
          `Condition on "${c.fact}" uses ${c.op}, which needs two numbers or two ISO dates. ` +
          `Got ${JSON.stringify(actual)} and ${JSON.stringify(c.value)}.`
        );
      }
      const met =
        c.op === 'gt' ? a > b :
        c.op === 'gte' ? a >= b :
        c.op === 'lt' ? a < b : a <= b;
      return { ...c, actual, met, missing: false };
    }
  }
}

/** A number, or an ISO date as a number of days. Anything else is not orderable. */
function orderable(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && ISO.test(v)) return Date.parse(`${v}T00:00:00Z`);
  return null;
}

// ─── Source material (Layer 1 and Layer 3) ──────────────────────────────────

export interface SourceDocumentInput {
  code: string;
  layer: 'academy_source' | 'external_reference';
  sourceOrg: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceSection?: string | null;
  sourceDate?: string | null;
  sourceType?: 'web_page' | 'pdf' | 'form' | 'circular' | 'email' | 'meeting_minute' | 'statute' | 'rulebook' | 'other';
  retrievedOn: string;
  /** The text actually read, so a later edit at source becomes detectable. */
  content?: string | null;
  fetchEvidence?: string | null;
  notes?: string | null;
}

/**
 * Record a document that was retrieved.
 *
 * `layer` cannot be `mmakf_regulation`. This table is for material MMAKF did not
 * write, and allowing the federation's own instruments in would make "is this
 * ours?" a matter of reading the org name.
 */
export async function recordSourceDocument(db: DB, ctx: AuditContext, input: SourceDocumentInput) {
  assertCanAnywhere(ctx.principal, 'source:write');
  assertIsoDate(input.retrievedOn, 'retrievedOn');
  if (input.sourceDate) assertIsoDate(input.sourceDate, 'sourceDate');
  if (input.layer !== 'academy_source' && input.layer !== 'external_reference') {
    throw new PolicyError(
      'bad_layer',
      "source_documents holds material MMAKF did not write. MMAKF's own instruments belong in policy_instruments."
    );
  }
  if (!/^https?:\/\//i.test(input.sourceUrl)) {
    throw new PolicyError('bad_url', 'A source document needs the URL it was read from.');
  }

  const sha = input.content
    ? crypto.createHash('sha256').update(input.content).digest('hex')
    : null;

  try {
    const [row] = await db.insert(s.sourceDocuments).values({
      code: input.code,
      layer: input.layer,
      sourceOrg: input.sourceOrg,
      sourceTitle: input.sourceTitle,
      sourceUrl: input.sourceUrl,
      sourceSection: input.sourceSection ?? null,
      sourceDate: input.sourceDate ?? null,
      sourceType: input.sourceType ?? 'web_page',
      retrievedOn: input.retrievedOn,
      retrievedByUserId: ctx.principal.userId ?? null,
      retrievedByLabel: ctx.principal.label,
      contentSha256: sha,
      fetchEvidence: input.fetchEvidence ?? null,
      notes: input.notes ?? null,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'source_document', entityId: row.id, action: 'create',
      newValue: { code: row.code, url: row.sourceUrl, layer: row.layer },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_code', `A source document with code ${input.code} already exists.`);
    }
    throw e;
  }
}

export interface SourceProvisionInput {
  ref: string;
  sourceDocumentId: number;
  topic: string;
  category?: string | null;
  sourceExcerpt: string;
  normalizedRule: string;
  confidence: 'verbatim' | 'verbatim_partial' | 'paraphrased' | 'inferred' | 'absent';
}

/**
 * Record one extracted rule.
 *
 * Both the excerpt and the normalisation are required. Keeping only the
 * normalisation loses the ability to check the reading; keeping only the excerpt
 * makes it unusable as a rule. `layer` is inherited from the document rather
 * than passed, so a provision can never claim a different provenance from the
 * page it was read off.
 */
export async function recordSourceProvision(db: DB, ctx: AuditContext, input: SourceProvisionInput) {
  assertCanAnywhere(ctx.principal, 'source:write');
  if (!input.sourceExcerpt?.trim()) {
    throw new PolicyError('no_excerpt', 'A source provision must carry the words it was extracted from.');
  }
  if (!input.normalizedRule?.trim()) {
    throw new PolicyError('no_normalisation', 'A source provision must carry what MMAKF understood it to mean.');
  }

  const [doc] = await db.select().from(s.sourceDocuments)
    .where(eq(s.sourceDocuments.id, input.sourceDocumentId)).limit(1);
  if (!doc) throw new PolicyError('no_document', 'That source document does not exist.');

  try {
    const [row] = await db.insert(s.sourceProvisions).values({
      ref: input.ref,
      sourceDocumentId: doc.id,
      layer: doc.layer,
      topic: input.topic,
      category: input.category ?? null,
      sourceExcerpt: input.sourceExcerpt,
      normalizedRule: input.normalizedRule,
      confidence: input.confidence,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'source_provision', entityId: row.id, action: 'create',
      newValue: { ref: row.ref, layer: row.layer, topic: row.topic },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_ref', `Source provision ${input.ref} is already registered.`);
    }
    throw e;
  }
}

/**
 * Move a source provision's standing — but never to `adopted`.
 *
 * Adoption is not a status somebody sets. It is the consequence of an instrument
 * version that cites the provision becoming binding, and only
 * publishInstrumentVersion() performs it. Without this refusal, the whole
 * traceability guarantee reduces to a dropdown.
 *
 * `rejected` and `flagged_not_adoptable` REQUIRE a note. A federation that
 * declines to adopt published material has to be able to say why — the four
 * regulative principles addressed to parents (KAB-003) are recorded, flagged and
 * reasoned, which is a different and much more defensible act than deleting them.
 */
export async function markSourceProvision(
  db: DB,
  ctx: AuditContext,
  ref: string,
  status: 'not_adopted' | 'under_review' | 'cited' | 'rejected' | 'flagged_not_adoptable',
  note?: string | null
) {
  assertCanAnywhere(ctx.principal, 'source:write');
  if ((status as string) === 'adopted') {
    throw new PolicyError(
      'adoption_not_a_status',
      'A provision becomes adopted only when an instrument version citing it is published. ' +
      'Use adoptSourceProvision() and then publish the version.'
    );
  }
  if ((status === 'rejected' || status === 'flagged_not_adoptable') && !note?.trim()) {
    throw new PolicyError('reason_required', `Marking a provision ${status} requires a stated reason.`);
  }

  const [before] = await db.select().from(s.sourceProvisions)
    .where(eq(s.sourceProvisions.ref, ref)).limit(1);
  if (!before) throw new PolicyError('no_provision', `No source provision ${ref}.`);

  const [row] = await db.update(s.sourceProvisions)
    .set({ adoptionStatus: status, adoptionNote: note ?? null, updatedAt: new Date() })
    .where(eq(s.sourceProvisions.id, before.id)).returning();

  await writeAudit(db, ctx, {
    entityType: 'source_provision', entityId: row.id, action: 'update',
    oldValue: { adoptionStatus: before.adoptionStatus },
    newValue: { adoptionStatus: row.adoptionStatus, note: row.adoptionNote },
  });
  return row;
}

export async function listSourceProvisions(
  db: DB,
  principal: Principal,
  filter: { layer?: string; topic?: string; adoptionStatus?: string } = {}
) {
  assertCanAnywhere(principal, 'source:read');
  const where = [
    filter.layer ? eq(s.sourceProvisions.layer, filter.layer as any) : undefined,
    filter.topic ? eq(s.sourceProvisions.topic, filter.topic) : undefined,
    filter.adoptionStatus ? eq(s.sourceProvisions.adoptionStatus, filter.adoptionStatus as any) : undefined,
  ].filter(Boolean) as any[];

  return db.select({
    provision: s.sourceProvisions,
    document: s.sourceDocuments,
  })
    .from(s.sourceProvisions)
    .innerJoin(s.sourceDocuments, eq(s.sourceProvisions.sourceDocumentId, s.sourceDocuments.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(s.sourceProvisions.ref));
}

// ─── Instruments (Layer 2) ──────────────────────────────────────────────────

export interface InstrumentInput {
  code: string;
  title: string;
  instrumentType: 'constitution' | 'regulation' | 'policy' | 'code' | 'guideline' | 'circular' | 'framework' | 'standard';
  subjectArea: string;
  summary?: string | null;
  jurisdiction?: string;
  issuer?: string;
  ownerCommitteeId?: number | null;
  classification?: 'public' | 'member' | 'official' | 'confidential' | 'restricted' | 'highly_restricted';
}

export async function createInstrument(db: DB, ctx: AuditContext, input: InstrumentInput) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  try {
    const [row] = await db.insert(s.policyInstruments).values({
      code: input.code,
      title: input.title,
      instrumentType: input.instrumentType,
      layer: 'mmakf_regulation',
      subjectArea: input.subjectArea,
      summary: input.summary ?? null,
      jurisdiction: input.jurisdiction ?? 'national',
      issuer: input.issuer ?? 'MMAKF',
      ownerCommitteeId: input.ownerCommitteeId ?? null,
      classification: input.classification ?? 'public',
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'policy_instrument', entityId: row.id, action: 'create',
      newValue: { code: row.code, type: row.instrumentType },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_code', `An instrument with code ${input.code} already exists.`);
    }
    throw e;
  }
}

export async function draftInstrumentVersion(
  db: DB,
  ctx: AuditContext,
  input: { instrumentId: number; version: string; bodyMarkdown?: string | null; fileUrl?: string | null; reviewDueOn?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const [inst] = await db.select().from(s.policyInstruments)
    .where(eq(s.policyInstruments.id, input.instrumentId)).limit(1);
  if (!inst) throw new PolicyError('no_instrument', 'That instrument does not exist.');
  if (input.reviewDueOn) assertIsoDate(input.reviewDueOn, 'reviewDueOn');

  try {
    const [row] = await db.insert(s.policyInstrumentVersions).values({
      instrumentId: inst.id,
      version: input.version,
      state: 'draft',
      bodyMarkdown: input.bodyMarkdown ?? null,
      fileUrl: input.fileUrl ?? null,
      reviewDueOn: input.reviewDueOn ?? null,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'policy_instrument_version', entityId: row.id, action: 'create',
      newValue: { instrument: inst.code, version: row.version },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_version', `Version ${input.version} of ${inst.code} already exists.`);
    }
    throw e;
  }
}

/**
 * Add a clause.
 *
 * Refused once the version has left drafting. A published instrument that could
 * grow a clause is an instrument whose approval means nothing — the committee
 * approved a document, and this would let somebody change what they approved.
 */
export async function addProvision(
  db: DB,
  ctx: AuditContext,
  input: {
    instrumentVersionId: number;
    clauseRef: string;
    text: string;
    heading?: string | null;
    category?: string | null;
    derivation: 'proposed' | 'external_reference' | 'statutory';
    externalBody?: string | null;
    externalCitation?: string | null;
    ordinal?: number;
  }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const version = await mutableVersion(db, input.instrumentVersionId);

  if (input.derivation === 'external_reference' && !input.externalBody?.trim()) {
    throw new PolicyError(
      'no_external_body',
      'A clause marked external_reference must name the body that owns the rule. ' +
      'MMAKF may not present another organisation\'s rule as its own or as nobody\'s.'
    );
  }

  try {
    const [row] = await db.insert(s.policyProvisions).values({
      instrumentVersionId: version.id,
      clauseRef: input.clauseRef,
      heading: input.heading ?? null,
      text: input.text,
      category: input.category ?? null,
      derivation: input.derivation,
      sourceProvisionId: null,
      externalBody: input.externalBody ?? null,
      externalCitation: input.externalCitation ?? null,
      ordinal: input.ordinal ?? 0,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'policy_provision', entityId: row.id, action: 'create',
      newValue: { clause: row.clauseRef, derivation: row.derivation },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_clause', `Clause ${input.clauseRef} already exists in that version.`);
    }
    throw e;
  }
}

/**
 * THE ONLY ROUTE FROM SOURCE MATERIAL INTO MMAKF POLICY.
 *
 * It writes a clause that cites the source provision, records who is adopting it
 * and on what date, and moves the source row to `under_review` — NOT `adopted`.
 * The source becomes adopted when the instrument version is published, because
 * that is when the rule actually starts to bind anybody.
 *
 * A provision already marked `flagged_not_adoptable` is refused outright. That
 * flag exists for material the federation has decided it must not adopt, and a
 * flag that a later drafting session could quietly step over would be decoration.
 */
export async function adoptSourceProvision(
  db: DB,
  ctx: AuditContext,
  input: {
    sourceRef: string;
    instrumentVersionId: number;
    clauseRef: string;
    text: string;
    heading?: string | null;
    adoptedByPersonId: number;
    adoptedOn: string;
    adoptionNote?: string | null;
    ordinal?: number;
  }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  assertIsoDate(input.adoptedOn, 'adoptedOn');
  const version = await mutableVersion(db, input.instrumentVersionId);

  const [src] = await db.select().from(s.sourceProvisions)
    .where(eq(s.sourceProvisions.ref, input.sourceRef)).limit(1);
  if (!src) throw new PolicyError('no_provision', `No source provision ${input.sourceRef}.`);

  if (src.adoptionStatus === 'flagged_not_adoptable') {
    throw new PolicyError(
      'flagged_not_adoptable',
      `${src.ref} is flagged as not adoptable and cannot be carried into an MMAKF instrument. ` +
      `Reason on record: ${src.adoptionNote ?? 'none stated'}.`
    );
  }
  if (src.adoptionStatus === 'rejected') {
    throw new PolicyError(
      'rejected',
      `${src.ref} was rejected. Reverse that decision on the record before adopting it.`
    );
  }
  if (!input.adoptedByPersonId) {
    throw new PolicyError('no_approver', 'Adoption must name the person adopting it.');
  }

  let provision;
  try {
    [provision] = await db.insert(s.policyProvisions).values({
      instrumentVersionId: version.id,
      clauseRef: input.clauseRef,
      heading: input.heading ?? null,
      text: input.text,
      derivation: 'source_derived',
      sourceProvisionId: src.id,
      adoptedByPersonId: input.adoptedByPersonId,
      adoptedOn: input.adoptedOn,
      adoptionNote: input.adoptionNote ?? null,
      ordinal: input.ordinal ?? 0,
    }).returning();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_clause', `Clause ${input.clauseRef} already exists in that version.`);
    }
    throw e;
  }

  await db.update(s.sourceProvisions)
    .set({ adoptionStatus: 'under_review', updatedAt: new Date() })
    .where(eq(s.sourceProvisions.id, src.id));

  await writeAudit(db, ctx, {
    entityType: 'policy_provision', entityId: provision.id, action: 'create',
    oldValue: { sourceRef: src.ref, sourceStatus: src.adoptionStatus },
    newValue: { clause: provision.clauseRef, derivation: 'source_derived', sourceRef: src.ref },
  });
  return provision;
}

/** A version that may still be edited, or a typed refusal explaining why not. */
async function mutableVersion(db: DB, id: number) {
  const [v] = await db.select().from(s.policyInstrumentVersions)
    .where(eq(s.policyInstrumentVersions.id, id)).limit(1);
  if (!v) throw new PolicyError('no_version', 'That instrument version does not exist.');
  if (!DRAFTING_STATES.includes(v.state)) {
    throw new PolicyError(
      'version_frozen',
      `Version ${v.version} is ${v.state} and can no longer be edited. Draft a new version instead.`
    );
  }
  return v;
}

/**
 * Move a version through its lifecycle.
 *
 * Reaching `approved` requires 'policy:approve' AND a named approver AND an
 * approval date. All three, because an approval with no name on it is exactly
 * the artefact this subsystem exists to make impossible.
 */
export async function advanceInstrumentState(
  db: DB,
  ctx: AuditContext,
  versionId: number,
  to: PolicyState,
  opts: {
    approvedByPersonId?: number | null;
    approvedByCommitteeId?: number | null;
    approvedOn?: string | null;
    approvedUnderResolutionId?: number | null;
    reason?: string | null;
  } = {}
) {
  const [v] = await db.select().from(s.policyInstrumentVersions)
    .where(eq(s.policyInstrumentVersions.id, versionId)).limit(1);
  if (!v) throw new PolicyError('no_version', 'That instrument version does not exist.');

  assertCanAnywhere(ctx.principal, to === 'approved' ? 'policy:approve' : 'policy:write');

  const permitted = TRANSITIONS[v.state as PolicyState] ?? [];
  if (!permitted.includes(to)) {
    throw new PolicyError(
      'bad_transition',
      `A version cannot move from ${v.state} to ${to}. Permitted: ${permitted.join(', ') || 'none'}.`
    );
  }
  if (to === 'published' || to === 'effective') {
    throw new PolicyError(
      'use_publish',
      'Publication takes the effective date and freezes the text. Use publishInstrumentVersion().'
    );
  }

  const patch: Record<string, unknown> = { state: to };

  if (to === 'approved') {
    if (!opts.approvedByPersonId) {
      throw new PolicyError('no_approver', 'Approval must name the person who approved it.');
    }
    assertIsoDate(opts.approvedOn, 'approvedOn');
    patch.approvedByPersonId = opts.approvedByPersonId;
    patch.approvedByCommitteeId = opts.approvedByCommitteeId ?? null;
    patch.approvedOn = opts.approvedOn;
    patch.approvedUnderResolutionId = opts.approvedUnderResolutionId ?? null;
  }
  if (to === 'withdrawn') {
    if (!opts.reason?.trim()) {
      throw new PolicyError('reason_required', 'Withdrawing a version requires a stated reason.');
    }
    patch.withdrawnAt = new Date();
    patch.withdrawnReason = opts.reason;
  }

  const [row] = await db.update(s.policyInstrumentVersions)
    .set(patch).where(eq(s.policyInstrumentVersions.id, v.id)).returning();

  await writeAudit(db, ctx, {
    entityType: 'policy_instrument_version', entityId: row.id,
    action: to === 'approved' ? 'approve' : 'update',
    oldValue: { state: v.state }, newValue: { state: row.state, approvedOn: row.approvedOn },
  });
  return row;
}

/**
 * Publish an approved version and set the date it takes effect.
 *
 * FOUR REFUSALS, EACH OF WHICH HAS A VICTIM IF IT IS MISSING:
 *
 *  · not approved → publishing a draft puts unapproved text in front of members
 *    as federation policy.
 *  · no approver on the record → nobody can be asked who agreed to it.
 *  · nothing to hash → a "published" version with neither text nor file is a
 *    rule that cannot be read by the people it binds.
 *  · effective date before approval → a rule cannot govern a day on which it
 *    did not exist. Backdating is how a decision already taken gets a rule
 *    written for it afterwards.
 *
 * The predecessor's window is closed AT `effectiveFrom`, exclusive, so the two
 * meet exactly. And the source provisions this version cites become `adopted`
 * here and nowhere else.
 */
export async function publishInstrumentVersion(
  db: DB,
  ctx: AuditContext,
  versionId: number,
  opts: { effectiveFrom: string; effectiveTo?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'policy:publish');
  assertIsoDate(opts.effectiveFrom, 'effectiveFrom');
  if (opts.effectiveTo) assertIsoDate(opts.effectiveTo, 'effectiveTo');
  if (opts.effectiveTo && opts.effectiveTo <= opts.effectiveFrom) {
    throw new PolicyError('bad_window', 'effectiveTo is exclusive and must fall after effectiveFrom.');
  }

  const [v] = await db.select().from(s.policyInstrumentVersions)
    .where(eq(s.policyInstrumentVersions.id, versionId)).limit(1);
  if (!v) throw new PolicyError('no_version', 'That instrument version does not exist.');
  if (v.state !== 'approved') {
    throw new PolicyError(
      'not_approved',
      `Only an approved version may be published. Version ${v.version} is ${v.state}.`
    );
  }
  if (!v.approvedByPersonId || !v.approvedOn) {
    throw new PolicyError('no_approver', 'A version cannot be published without a recorded approver and approval date.');
  }
  const body = v.bodyMarkdown ?? v.fileUrl ?? '';
  if (!body.trim()) {
    throw new PolicyError('nothing_to_publish', 'A version with neither text nor a file cannot be published.');
  }
  if (opts.effectiveFrom < v.approvedOn) {
    throw new PolicyError(
      'backdated',
      `A rule cannot take effect on ${opts.effectiveFrom}, before it was approved on ${v.approvedOn}.`
    );
  }

  // Close whichever version is currently in force for this instrument.
  const siblings = await db.select().from(s.policyInstrumentVersions)
    .where(eq(s.policyInstrumentVersions.instrumentId, v.instrumentId));
  const predecessor = siblings.find(
    (x: any) => x.id !== v.id && isBinding(x.state) && inForceOn(opts.effectiveFrom, x.effectiveFrom, x.effectiveTo)
  );
  if (predecessor) {
    await db.update(s.policyInstrumentVersions)
      .set({ effectiveTo: opts.effectiveFrom, state: 'superseded' })
      .where(eq(s.policyInstrumentVersions.id, predecessor.id));
  }

  const [row] = await db.update(s.policyInstrumentVersions).set({
    state: 'published',
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
    effectiveFrom: opts.effectiveFrom,
    effectiveTo: opts.effectiveTo ?? null,
    supersedesVersionId: predecessor?.id ?? null,
    publishedAt: new Date(),
  }).where(eq(s.policyInstrumentVersions.id, v.id)).returning();

  await db.update(s.policyInstruments)
    .set({ currentVersionId: row.id })
    .where(eq(s.policyInstruments.id, v.instrumentId));

  // The adoption event. This is the ONLY place a source provision reaches
  // `adopted`, which is what makes the status mean "an instrument carrying it
  // became binding" rather than "somebody chose it from a dropdown".
  const cited = await db.select().from(s.policyProvisions)
    .where(and(
      eq(s.policyProvisions.instrumentVersionId, row.id),
      eq(s.policyProvisions.derivation, 'source_derived'),
    ));
  for (const c of cited) {
    if (!c.sourceProvisionId) continue;
    await db.update(s.sourceProvisions)
      .set({ adoptionStatus: 'adopted', updatedAt: new Date() })
      .where(eq(s.sourceProvisions.id, c.sourceProvisionId));
  }

  await writeAudit(db, ctx, {
    entityType: 'policy_instrument_version', entityId: row.id, action: 'finalize',
    oldValue: { state: v.state },
    newValue: {
      state: row.state, effectiveFrom: row.effectiveFrom, sha256: row.bodySha256,
      supersedes: predecessor?.id ?? null, adoptedSources: cited.length,
    },
  });
  return row;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export async function defineRule(
  db: DB,
  ctx: AuditContext,
  input: { code: string; title: string; instrumentId: number; subjectKind: string; description?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const [inst] = await db.select().from(s.policyInstruments)
    .where(eq(s.policyInstruments.id, input.instrumentId)).limit(1);
  if (!inst) {
    throw new PolicyError(
      'no_instrument',
      'A rule must belong to an instrument. A rule with no instrument is a policy nobody approved.'
    );
  }
  try {
    const [row] = await db.insert(s.policyRules).values({
      code: input.code, title: input.title, instrumentId: inst.id,
      subjectKind: input.subjectKind, description: input.description ?? null,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'policy_rule', entityId: row.id, action: 'create',
      newValue: { code: row.code, instrument: inst.code },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_code', `A rule with code ${input.code} already exists.`);
    }
    throw e;
  }
}

export async function draftRuleVersion(
  db: DB,
  ctx: AuditContext,
  input: {
    ruleId: number;
    version: string;
    conditions: RuleCondition[];
    outcomeMet?: Outcome;
    outcomeUnmet?: Outcome;
    actions?: Record<string, unknown> | null;
    refusalReason?: string | null;
    instrumentVersionId?: number | null;
    provisionId?: number | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const conditions = assertConditions(input.conditions);

  if (input.outcomeMet && ['no_rule_in_force', 'not_approved', 'insufficient_facts'].includes(input.outcomeMet)) {
    throw new PolicyError(
      'bad_outcome',
      'no_rule_in_force, not_approved and insufficient_facts are ENGINE states, not outcomes a rule may declare.'
    );
  }

  try {
    const [row] = await db.insert(s.policyRuleVersions).values({
      ruleId: input.ruleId,
      version: input.version,
      state: 'draft',
      conditions,
      outcomeMet: input.outcomeMet ?? 'eligible',
      outcomeUnmet: input.outcomeUnmet ?? 'ineligible',
      actions: input.actions ?? null,
      refusalReason: input.refusalReason ?? null,
      instrumentVersionId: input.instrumentVersionId ?? null,
      provisionId: input.provisionId ?? null,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'policy_rule_version', entityId: row.id, action: 'create',
      newValue: { version: row.version, conditions: conditions.length },
    });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new PolicyError('duplicate_version', `Version ${input.version} of that rule already exists.`);
    }
    throw e;
  }
}

export async function approveRuleVersion(
  db: DB,
  ctx: AuditContext,
  versionId: number,
  opts: { approvedByPersonId: number; approvedOn: string; approvedByCommitteeId?: number | null; approvedUnderResolutionId?: number | null }
) {
  assertCanAnywhere(ctx.principal, 'policy:approve');
  assertIsoDate(opts.approvedOn, 'approvedOn');
  if (!opts.approvedByPersonId) {
    throw new PolicyError('no_approver', 'Approval must name the person who approved it.');
  }

  const [v] = await db.select().from(s.policyRuleVersions)
    .where(eq(s.policyRuleVersions.id, versionId)).limit(1);
  if (!v) throw new PolicyError('no_version', 'That rule version does not exist.');
  if (!DRAFTING_STATES.includes(v.state)) {
    throw new PolicyError('bad_transition', `A rule version that is ${v.state} cannot be approved.`);
  }

  const [row] = await db.update(s.policyRuleVersions).set({
    state: 'approved',
    approvedByPersonId: opts.approvedByPersonId,
    approvedOn: opts.approvedOn,
    approvedByCommitteeId: opts.approvedByCommitteeId ?? null,
    approvedUnderResolutionId: opts.approvedUnderResolutionId ?? null,
  }).where(eq(s.policyRuleVersions.id, v.id)).returning();

  await writeAudit(db, ctx, {
    entityType: 'policy_rule_version', entityId: row.id, action: 'approve',
    oldValue: { state: v.state }, newValue: { state: row.state, approvedOn: row.approvedOn },
  });
  return row;
}

/**
 * Bring an approved rule version into force.
 *
 * The instrument version it cites must ALREADY be binding. A rule cannot be in
 * force under a regulation that has not been published — that combination is a
 * refusal issued under a clause the member could not have read.
 */
export async function publishRuleVersion(
  db: DB,
  ctx: AuditContext,
  versionId: number,
  opts: { effectiveFrom: string; effectiveTo?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'policy:publish');
  assertIsoDate(opts.effectiveFrom, 'effectiveFrom');
  if (opts.effectiveTo) assertIsoDate(opts.effectiveTo, 'effectiveTo');
  if (opts.effectiveTo && opts.effectiveTo <= opts.effectiveFrom) {
    throw new PolicyError('bad_window', 'effectiveTo is exclusive and must fall after effectiveFrom.');
  }

  const [v] = await db.select().from(s.policyRuleVersions)
    .where(eq(s.policyRuleVersions.id, versionId)).limit(1);
  if (!v) throw new PolicyError('no_version', 'That rule version does not exist.');
  if (v.state !== 'approved') {
    throw new PolicyError('not_approved', `Only an approved rule version may be brought into force. This one is ${v.state}.`);
  }
  if (opts.effectiveFrom < (v.approvedOn ?? '9999-12-31')) {
    throw new PolicyError(
      'backdated',
      `A rule cannot take effect on ${opts.effectiveFrom}, before it was approved on ${v.approvedOn}.`
    );
  }

  if (v.instrumentVersionId) {
    const [iv] = await db.select().from(s.policyInstrumentVersions)
      .where(eq(s.policyInstrumentVersions.id, v.instrumentVersionId)).limit(1);
    if (!iv || !isBinding(iv.state)) {
      throw new PolicyError(
        'instrument_not_published',
        'The instrument this rule implements has not been published. A rule cannot be in force under a regulation nobody can read.'
      );
    }
  }

  const siblings = await db.select().from(s.policyRuleVersions)
    .where(eq(s.policyRuleVersions.ruleId, v.ruleId));
  const predecessor = siblings.find(
    (x: any) => x.id !== v.id && isBinding(x.state) && inForceOn(opts.effectiveFrom, x.effectiveFrom, x.effectiveTo)
  );
  if (predecessor) {
    await db.update(s.policyRuleVersions)
      .set({ effectiveTo: opts.effectiveFrom, state: 'superseded' })
      .where(eq(s.policyRuleVersions.id, predecessor.id));
  }

  const [row] = await db.update(s.policyRuleVersions).set({
    state: 'published',
    effectiveFrom: opts.effectiveFrom,
    effectiveTo: opts.effectiveTo ?? null,
    supersedesVersionId: predecessor?.id ?? null,
  }).where(eq(s.policyRuleVersions.id, v.id)).returning();

  await writeAudit(db, ctx, {
    entityType: 'policy_rule_version', entityId: row.id, action: 'finalize',
    oldValue: { state: v.state },
    newValue: { state: row.state, effectiveFrom: row.effectiveFrom, supersedes: predecessor?.id ?? null },
  });
  return row;
}

// ─── Resolution and evaluation ──────────────────────────────────────────────

export type InForceResult =
  | { status: 'unknown_rule' }
  | { status: 'no_version'; }
  | { status: 'not_approved'; version: any }
  | { status: 'in_force'; version: any; rule: any };

/**
 * Which version of a rule governed a given date — resolved by DATE, never by
 * status.
 *
 * The four outcomes are distinct because they are four different facts, and a
 * caller that could not tell them apart would report "you are ineligible" for
 * every one of them.
 *
 * NOT gated. Asking which published rule applies runs on the public intake path
 * where the caller holds nothing; see the note on the Action union in rbac.ts.
 */
export async function ruleInForceOn(db: DB, code: string, on: string = today()): Promise<InForceResult> {
  assertIsoDate(on, 'on');
  const [rule] = await db.select().from(s.policyRules)
    .where(eq(s.policyRules.code, code)).limit(1);
  if (!rule) return { status: 'unknown_rule' };

  const versions = await db.select().from(s.policyRuleVersions)
    .where(eq(s.policyRuleVersions.ruleId, rule.id))
    .orderBy(desc(s.policyRuleVersions.effectiveFrom));

  const covering = versions.filter((v: any) => inForceOn(on, v.effectiveFrom, v.effectiveTo));
  const binding = covering.find((v: any) => isBinding(v.state));
  if (binding) return { status: 'in_force', version: binding, rule };

  // A version whose window contains the date but which nobody has published.
  // Reported as `not_approved` rather than as an absence, because the two mean
  // opposite things to whoever is waiting on the answer.
  if (covering.length) return { status: 'not_approved', version: covering[0] };
  return { status: 'no_version' };
}

export interface Evaluation {
  outcome: Outcome;
  ruleCode: string;
  ruleTitle: string | null;
  ruleVersionId: number | null;
  ruleVersion: string | null;
  instrumentCode: string | null;
  instrumentTitle: string | null;
  instrumentVersionId: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  approvedByPersonId: number | null;
  approvedOn: string | null;
  determinedOn: string;
  reason: string;
  conditions: ConditionResult[];
  actions: Record<string, unknown> | null;
  /** Whether the subject may challenge the result. Always stated. */
  appealable: boolean;
}

/**
 * Evaluate a rule against a set of facts, as of a date.
 *
 * The refusal cases come FIRST and each returns a distinct outcome. Only when a
 * binding version genuinely covers the date do the conditions run at all.
 *
 * A missing fact stops the evaluation at `insufficient_facts` — see rule 3 at
 * the top of this file. It is reported with the conditions attached, so a
 * surface can tell the applicant WHICH fact it still needs rather than telling
 * them they failed.
 */
export async function evaluate(
  db: DB,
  input: { ruleCode: string; facts: Record<string, unknown>; on?: string }
): Promise<Evaluation> {
  const on = input.on ?? today();
  assertIsoDate(on, 'on');

  const base: Evaluation = {
    outcome: 'no_rule_in_force',
    ruleCode: input.ruleCode,
    ruleTitle: null,
    ruleVersionId: null,
    ruleVersion: null,
    instrumentCode: null,
    instrumentTitle: null,
    instrumentVersionId: null,
    effectiveFrom: null,
    effectiveTo: null,
    approvedByPersonId: null,
    approvedOn: null,
    determinedOn: on,
    reason: '',
    conditions: [],
    actions: null,
    appealable: false,
  };

  const resolved = await ruleInForceOn(db, input.ruleCode, on);

  if (resolved.status === 'unknown_rule') {
    return {
      ...base,
      reason: `No rule ${input.ruleCode} exists. MMAKF has approved no regulation on this point.`,
    };
  }
  if (resolved.status === 'no_version') {
    return {
      ...base,
      reason:
        `No version of ${input.ruleCode} was in force on ${on}. This is an absence of policy, ` +
        `not a refusal — nothing may be decided against the subject on this basis.`,
    };
  }
  if (resolved.status === 'not_approved') {
    return {
      ...base,
      outcome: 'not_approved',
      ruleVersionId: resolved.version.id,
      ruleVersion: resolved.version.version,
      effectiveFrom: resolved.version.effectiveFrom,
      effectiveTo: resolved.version.effectiveTo,
      reason:
        `Version ${resolved.version.version} of ${input.ruleCode} covers ${on} but is ` +
        `${resolved.version.state}. An unapproved rule decides nothing.`,
    };
  }

  const { version, rule } = resolved;

  let instrument: any = null;
  let instrumentVersion: any = null;
  if (rule.instrumentId) {
    [instrument] = await db.select().from(s.policyInstruments)
      .where(eq(s.policyInstruments.id, rule.instrumentId)).limit(1);
  }
  if (version.instrumentVersionId) {
    [instrumentVersion] = await db.select().from(s.policyInstrumentVersions)
      .where(eq(s.policyInstrumentVersions.id, version.instrumentVersionId)).limit(1);
  }

  const shell: Evaluation = {
    ...base,
    ruleTitle: rule.title,
    ruleVersionId: version.id,
    ruleVersion: version.version,
    instrumentCode: instrument?.code ?? null,
    instrumentTitle: instrument?.title ?? null,
    instrumentVersionId: instrumentVersion?.id ?? null,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    approvedByPersonId: version.approvedByPersonId ?? null,
    approvedOn: version.approvedOn ?? null,
    actions: (version.actions as Record<string, unknown> | null) ?? null,
    appealable: true,
  };

  const conditions = assertConditions(version.conditions);
  const results = conditions.map((c) => testCondition(c, input.facts ?? {}));

  const missing = results.filter((r) => r.missing);
  if (missing.length) {
    return {
      ...shell,
      outcome: 'insufficient_facts',
      conditions: results,
      // Deliberately NOT a refusal. Not asking for a record and then refusing
      // somebody for not having supplied it is the failure this branch prevents.
      reason:
        `Cannot decide: ${missing.map((m) => m.fact).join(', ')} ` +
        `${missing.length === 1 ? 'was' : 'were'} not supplied.`,
      appealable: false,
    };
  }

  const failed = results.filter((r) => !r.met);
  if (failed.length === 0) {
    return {
      ...shell,
      outcome: version.outcomeMet as Outcome,
      conditions: results,
      reason: `Every condition of ${rule.code} v${version.version} is met.`,
    };
  }

  return {
    ...shell,
    outcome: version.outcomeUnmet as Outcome,
    conditions: results,
    reason:
      version.refusalReason ??
      `Not met: ${failed.map((f) => f.label ?? `${f.fact} ${f.op} ${JSON.stringify(f.value)}`).join('; ')}.`,
  };
}

// ─── Determinations ─────────────────────────────────────────────────────────

/**
 * Record what was decided, about whom, under which version.
 *
 * `ruleVersionId` is copied from the evaluation, so amending the rule later
 * cannot restate this decision. The row is never updated — see supersede below.
 *
 * A determination is refused for the three ENGINE outcomes. `no_rule_in_force`,
 * `not_approved` and `insufficient_facts` are statements about the state of the
 * federation's own policy, not findings about a person, and filing them against
 * somebody's record would put "assessed and failed" where "we had no rule" is
 * the truth.
 */
export async function recordDetermination(
  db: DB,
  ctx: AuditContext,
  input: {
    evaluation: Evaluation;
    subjectType: string;
    subjectId: string | number;
    personId?: number | null;
    facts: Record<string, unknown>;
    classification?: 'public' | 'member' | 'official' | 'confidential' | 'restricted' | 'highly_restricted';
  }
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const e = input.evaluation;

  if (e.outcome === 'no_rule_in_force' || e.outcome === 'not_approved' || e.outcome === 'insufficient_facts') {
    throw new PolicyError(
      'not_a_finding',
      `"${e.outcome}" describes the state of MMAKF's policy, not a finding about a person, ` +
      `and must not be filed against their record.`
    );
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await nextDeterminationRef(db, e.determinedOn.slice(0, 4));
    try {
      const [row] = await db.insert(s.policyDeterminations).values({
        ref,
        ruleCode: e.ruleCode,
        ruleVersionId: e.ruleVersionId,
        instrumentVersionId: e.instrumentVersionId,
        subjectType: input.subjectType,
        subjectId: String(input.subjectId),
        personId: input.personId ?? null,
        facts: input.facts,
        outcome: e.outcome,
        reason: e.reason,
        detail: e.conditions,
        determinedOn: e.determinedOn,
        actorUserId: ctx.principal.userId ?? null,
        actorLabel: ctx.principal.label,
        appealable: e.appealable,
        classification: input.classification ?? 'member',
      }).returning();

      await writeAudit(db, ctx, {
        entityType: 'policy_determination', entityId: row.id, action: 'create',
        newValue: {
          ref: row.ref, rule: row.ruleCode, ruleVersionId: row.ruleVersionId,
          outcome: row.outcome, subject: `${row.subjectType}:${row.subjectId}`,
        },
      });
      return row;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new PolicyError('ref_exhausted', 'Could not allocate a determination reference.');
}

async function nextDeterminationRef(db: DB, year: string): Promise<string> {
  const [row] = await db.select({ n: sql<number>`count(*)` })
    .from(s.policyDeterminations)
    .where(sql`${s.policyDeterminations.ref} like ${`DET-${year}-%`}`);
  const n = Number(row?.n ?? 0) + 1;
  return `DET-${year}-${String(n).padStart(6, '0')}`;
}

/**
 * Replace a determination without erasing it.
 *
 * An appeal that succeeds, or a decision taken on facts that turn out to be
 * wrong, produces a NEW determination and points the old one at it. Editing the
 * original would leave a record that says the federation always thought this,
 * which is exactly what an appeal is supposed to disprove.
 */
export async function supersedeDetermination(
  db: DB,
  ctx: AuditContext,
  originalRef: string,
  replacement: Parameters<typeof recordDetermination>[2]
) {
  assertCanAnywhere(ctx.principal, 'policy:write');
  const [original] = await db.select().from(s.policyDeterminations)
    .where(eq(s.policyDeterminations.ref, originalRef)).limit(1);
  if (!original) throw new PolicyError('no_determination', `No determination ${originalRef}.`);
  if (original.supersededByDeterminationId) {
    throw new PolicyError('already_superseded', `${originalRef} has already been superseded.`);
  }

  const fresh = await recordDetermination(db, ctx, replacement);
  await db.update(s.policyDeterminations)
    .set({ supersededByDeterminationId: fresh.id })
    .where(eq(s.policyDeterminations.id, original.id));

  await writeAudit(db, ctx, {
    entityType: 'policy_determination', entityId: original.id, action: 'update',
    oldValue: { ref: original.ref, outcome: original.outcome },
    newValue: { supersededBy: fresh.ref, outcome: fresh.outcome },
  });
  return fresh;
}

export async function determinationsForPerson(db: DB, principal: Principal, personId: number) {
  assertCanAnywhere(principal, 'policy:read');
  return db.select().from(s.policyDeterminations)
    .where(eq(s.policyDeterminations.personId, personId))
    .orderBy(desc(s.policyDeterminations.determinedOn), desc(s.policyDeterminations.id));
}

/**
 * The whole chain behind one decision.
 *
 * This function is the federation's definition of done, expressed as a query.
 * It answers, for a single determination: what rule applied, which version, what
 * instrument authorised it, who approved that instrument and when it took
 * effect, whether the clause was inherited from the Academy or drafted by MMAKF,
 * and — where it was inherited — the URL, the excerpt and the date somebody read
 * it. If any link is missing, the missing link is named rather than omitted.
 */
export async function provenanceChain(db: DB, principal: Principal, ref: string) {
  assertCanAnywhere(principal, 'policy:read');

  const [det] = await db.select().from(s.policyDeterminations)
    .where(eq(s.policyDeterminations.ref, ref)).limit(1);
  if (!det) throw new PolicyError('no_determination', `No determination ${ref}.`);

  const [ruleVersion] = det.ruleVersionId
    ? await db.select().from(s.policyRuleVersions).where(eq(s.policyRuleVersions.id, det.ruleVersionId)).limit(1)
    : [null];
  const [rule] = await db.select().from(s.policyRules)
    .where(eq(s.policyRules.code, det.ruleCode)).limit(1);
  const [instrumentVersion] = det.instrumentVersionId
    ? await db.select().from(s.policyInstrumentVersions)
        .where(eq(s.policyInstrumentVersions.id, det.instrumentVersionId)).limit(1)
    : [null];
  const [instrument] = instrumentVersion
    ? await db.select().from(s.policyInstruments)
        .where(eq(s.policyInstruments.id, instrumentVersion.instrumentId)).limit(1)
    : [null];

  const provisions = instrumentVersion
    ? await db.select({ provision: s.policyProvisions, source: s.sourceProvisions, document: s.sourceDocuments })
        .from(s.policyProvisions)
        .leftJoin(s.sourceProvisions, eq(s.policyProvisions.sourceProvisionId, s.sourceProvisions.id))
        .leftJoin(s.sourceDocuments, eq(s.sourceProvisions.sourceDocumentId, s.sourceDocuments.id))
        .where(eq(s.policyProvisions.instrumentVersionId, instrumentVersion.id))
        .orderBy(asc(s.policyProvisions.ordinal))
    : [];

  return {
    determination: det,
    rule: rule ?? null,
    ruleVersion: ruleVersion ?? null,
    instrument: instrument ?? null,
    instrumentVersion: instrumentVersion ?? null,
    provisions,
    /** Named absences, so a gap in the chain reads as a gap rather than as nothing. */
    gaps: [
      !ruleVersion ? 'The rule version behind this determination is not on record.' : null,
      !instrumentVersion ? 'No instrument version is linked — the rule cites no approved text.' : null,
      instrumentVersion && !instrumentVersion.approvedByPersonId
        ? 'The instrument version records no approver.' : null,
      instrumentVersion && !instrumentVersion.bodySha256
        ? 'The published text was never checksummed, so it cannot be shown to be unchanged.' : null,
      det.appealable === false
        ? 'This determination was recorded as not appealable.' : null,
    ].filter(Boolean) as string[],
  };
}

// ─── Public register ────────────────────────────────────────────────────────

/**
 * What may be shown on www.mmakf.in/regulations.
 *
 * Filtered on THREE things and not one: the instrument must be MMAKF's own, its
 * classification must be `public`, and the version must be binding on the date
 * asked for. Drafts and internal instruments are excluded by the query rather
 * than by the template, because a template that forgets is a template that
 * publishes an unapproved regulation.
 *
 * Not gated: this is the public portal.
 */
export async function publicRegister(db: DB, on: string = today()) {
  assertIsoDate(on, 'on');
  const rows = await db.select({
    instrument: s.policyInstruments,
    version: s.policyInstrumentVersions,
  })
    .from(s.policyInstrumentVersions)
    .innerJoin(s.policyInstruments, eq(s.policyInstrumentVersions.instrumentId, s.policyInstruments.id))
    .where(and(
      eq(s.policyInstruments.layer, 'mmakf_regulation'),
      eq(s.policyInstruments.classification, 'public'),
      eq(s.policyInstruments.active, true),
      or(
        eq(s.policyInstrumentVersions.state, 'published'),
        eq(s.policyInstrumentVersions.state, 'effective'),
      ),
    ))
    .orderBy(asc(s.policyInstruments.subjectArea), asc(s.policyInstruments.code));

  return rows.filter((r: any) => inForceOn(on, r.version.effectiveFrom, r.version.effectiveTo));
}

export async function listInstruments(db: DB, principal: Principal) {
  assertCanAnywhere(principal, 'policy:read');
  return db.select({
    instrument: s.policyInstruments,
    version: s.policyInstrumentVersions,
  })
    .from(s.policyInstruments)
    .leftJoin(
      s.policyInstrumentVersions,
      eq(s.policyInstruments.currentVersionId, s.policyInstrumentVersions.id)
    )
    .orderBy(asc(s.policyInstruments.subjectArea), asc(s.policyInstruments.code));
}

/**
 * Rules that decide a given kind of subject, with the state each is actually in.
 *
 * Used by the admin Policy Centre to show — honestly — that a workflow it offers
 * is governed by nothing yet. A screen listing an approval step with no rule
 * behind it is how policy ends up hard-coded in the component that renders it.
 */
export async function rulesFor(db: DB, principal: Principal, subjectKind: string, on: string = today()) {
  assertCanAnywhere(principal, 'policy:read');
  const rules = await db.select().from(s.policyRules)
    .where(and(eq(s.policyRules.subjectKind, subjectKind), eq(s.policyRules.active, true)))
    .orderBy(asc(s.policyRules.code));

  const out = [];
  for (const r of rules) out.push({ rule: r, inForce: await ruleInForceOn(db, r.code, on) });
  return out;
}
