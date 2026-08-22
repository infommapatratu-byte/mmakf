// Affiliation — the lifecycle that makes "affiliated to MMAKF" a checkable fact.
//
// APPLICATION → DOCUMENT REVIEW → TECHNICAL REVIEW → PROVISIONAL → CHARTERED
//             → RENEWAL DUE → LAPSED → SUSPENDED → REVOKED
//
// A parent choosing a club reads one claim on a shutter: "affiliated to MMAKF".
// This module exists so that claim resolves to a charter with a date on it, an
// identified chief instructor who is in the federation's own register, and a
// record of who granted it and why. A dojo whose instructor cannot be found in
// the register is precisely what affiliation exists to prevent, so the register
// lookup is a hard refusal at application time rather than a review note.
//
// TWO DESIGN DECISIONS WORTH KNOWING BEFORE YOU EDIT THIS FILE:
//
//  1. WHERE THE STAGE LIVES. `unit_status` carries six values — draft,
//     provisional, active, suspended, expired, revoked — and the lifecycle has
//     nine stages. The three review stages all sit inside `draft`, and
//     `renewal_due` inside `active`. Rather than widen an enum every other
//     module already reads, the fine-grained stage is kept in an APPEND-ONLY
//     LEDGER in audit_events under entityType 'affiliation', and the status
//     column is maintained as its coarse projection. The ledger is the history;
//     the column is what the rest of the codebase (and every existing query)
//     sees. Both are written in the same operation. A unit with no ledger — a
//     row that predates this module — has its stage derived conservatively from
//     the column, so nothing is ever left in an unknown state.
//
//  2. CRITERIA ARE CONFIGURATION, NOT CODE. There is no minimum student count,
//     no mat area, no insurance requirement and no fee anywhere in this file.
//     MMAKF has published none, and inventing one would fail a real applicant
//     against a threshold nobody approved. `assessAffiliation()` takes the
//     criteria the federation supplies; where none are configured it says so
//     and records that the decision rested entirely with the reviewing officer.

import { and, asc, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import * as s from './schema';
import { allocateFederationId, resolvePlacement, writeAudit, type AuditContext } from './federation';
import { assertCan, can, type Action, type Principal, type Resource } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class AffiliationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AffiliationError';
    this.code = code;
  }
}

// ─── The state machine ──────────────────────────────────────────────────────

export type AffiliationStage =
  | 'application'
  | 'document_review'
  | 'technical_review'
  | 'provisional'
  | 'chartered'
  | 'renewal_due'
  | 'lapsed'
  | 'suspended'
  | 'revoked';

export type UnitKind = 'dojo' | 'district' | 'state';
export type UnitStatus = (typeof s.unitStatus.enumValues)[number];

/** How each lifecycle stage projects onto the `unit_status` column. */
const STAGE_STATUS: Record<AffiliationStage, UnitStatus> = {
  application: 'draft',
  document_review: 'draft',
  technical_review: 'draft',
  provisional: 'provisional',
  chartered: 'active',
  // A renewal notice does not withdraw a charter — the unit is still affiliated
  // until the charter actually expires, so the column stays `active`.
  renewal_due: 'active',
  lapsed: 'expired',
  suspended: 'suspended',
  revoked: 'revoked',
};

/**
 * The only permitted moves. Everything absent from this table is refused.
 *
 * The rule this encodes: an application cannot become chartered without passing
 * BOTH reviews. There is no edge from `application` or `document_review` to
 * `chartered`, so no combination of calls can produce a charter that skipped
 * scrutiny.
 *
 * `revoked` is terminal, and deliberately so: a revocation that could be
 * quietly walked back would not be a revocation. A revoked unit that the
 * federation later re-admits applies again, and the old record stays visible.
 */
const LEGAL_NEXT: Record<AffiliationStage, AffiliationStage[]> = {
  application: ['document_review', 'revoked'],
  // Returned to the applicant when documents are incomplete.
  document_review: ['technical_review', 'application', 'revoked'],
  // Technical review may charter directly or grant a provisional period first;
  // both have passed the same scrutiny.
  technical_review: ['provisional', 'chartered', 'document_review', 'revoked'],
  provisional: ['chartered', 'lapsed', 'suspended', 'revoked'],
  chartered: ['renewal_due', 'lapsed', 'suspended', 'revoked'],
  renewal_due: ['chartered', 'lapsed', 'suspended', 'revoked'],
  // Lapsing is REVERSIBLE by renewal and never deletes.
  lapsed: ['chartered', 'suspended', 'revoked'],
  suspended: ['chartered', 'provisional', 'lapsed', 'revoked'],
  revoked: [],
};

// ─── Unit kinds ─────────────────────────────────────────────────────────────

interface UnitSpec {
  kind: UnitKind;
  table: any;
  /** Property names differ across the three tables; normalise once, here. */
  charteredCol: 'affiliatedOn' | 'charteredOn';
  expiresCol: 'affiliationExpiresOn' | 'charterExpiresOn';
  /** Authority to file or amend an application. */
  writeAction: Action;
  /** Authority to read this unit's own record, including a review assessment. */
  readAction: Action;
  /** Authority to decide — review, charter, suspend, revoke. */
  decideAction: Action;
}

const SPECS: Record<UnitKind, UnitSpec> = {
  dojo: {
    kind: 'dojo',
    table: s.dojos,
    charteredCol: 'affiliatedOn',
    expiresCol: 'affiliationExpiresOn',
    writeAction: 'dojo:write',
    readAction: 'dojo:read',
    decideAction: 'dojo:approve',
  },
  district: {
    kind: 'district',
    table: s.districtUnits,
    charteredCol: 'charteredOn',
    expiresCol: 'charterExpiresOn',
    writeAction: 'unit:write',
    readAction: 'unit:read',
    // Chartering a unit of the federation is a national act, not a state one.
    decideAction: 'unit:charter',
  },
  state: {
    kind: 'state',
    table: s.stateUnits,
    charteredCol: 'charteredOn',
    expiresCol: 'charterExpiresOn',
    writeAction: 'unit:write',
    readAction: 'unit:read',
    decideAction: 'unit:charter',
  },
};

export interface UnitRef {
  kind: UnitKind;
  id: number;
}

interface ResolvedUnit {
  spec: UnitSpec;
  id: number;
  code: string;
  name: string;
  status: UnitStatus;
  charteredOn: string | null;
  validUntil: string | null;
  placement: Resource;
  /** Ledger key — stable across renames and reused as the evidence prefix. */
  key: string;
}

async function resolveUnit(db: DB, ref: UnitRef): Promise<ResolvedUnit> {
  const spec = SPECS[ref.kind];
  if (!spec) throw new AffiliationError('unknown_unit_kind', `Unknown unit kind: ${String(ref.kind)}`);

  const row = (await db.select().from(spec.table).where(eq(spec.table.id, ref.id)).limit(1))[0];
  if (!row) throw new AffiliationError('unknown_unit', `No ${ref.kind} with id ${ref.id}`);

  const placement: Resource =
    ref.kind === 'dojo'
      ? { stateUnitId: row.stateUnitId, districtUnitId: row.districtUnitId, dojoId: row.id }
      : ref.kind === 'district'
        ? { stateUnitId: row.stateUnitId, districtUnitId: row.id }
        : { stateUnitId: row.id };

  return {
    spec,
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    charteredOn: row[spec.charteredCol] ?? null,
    validUntil: row[spec.expiresCol] ?? null,
    placement,
    key: `${ref.kind}:${row.id}`,
  };
}

// ─── The stage ledger ───────────────────────────────────────────────────────

/** entityType under which every affiliation transition is appended. */
const LEDGER = 'affiliation';

/**
 * Derive the stage of a unit that has no ledger entry.
 *
 * Rows predating this module (and rows seeded directly) still have to answer
 * "what stage is this?", and the honest answer is the coarsest one the column
 * supports. `active` resolves to `chartered` rather than `renewal_due` because a
 * renewal notice is a positive act by the federation: absent evidence that one
 * was issued, claiming it was would be an invention.
 */
function stageFromStatus(status: UnitStatus): AffiliationStage {
  switch (status) {
    case 'draft': return 'application';
    case 'provisional': return 'provisional';
    case 'active': return 'chartered';
    case 'suspended': return 'suspended';
    case 'expired': return 'lapsed';
    case 'revoked': return 'revoked';
    // Fail closed: an unknown status grants nothing.
    default: return 'application';
  }
}

export interface StageReading {
  /** The stage this module will act on. */
  stage: AffiliationStage;
  /** What the append-only ledger last recorded, if it holds anything at all. */
  ledgerStage: AffiliationStage | null;
  /**
   * False when the status column no longer matches the ledger's projection of
   * its own last entry — i.e. something outside this module wrote the column.
   */
  consistent: boolean;
}

/**
 * Resolve a unit's stage, and say whether the two records of it agree.
 *
 * The ledger is this module's history; the status column is its coarse
 * projection, and it is what every other module in the codebase reads AND
 * writes. When they disagree, the column has been changed out of band, and
 * believing the ledger would mean acting on a state that is no longer true —
 * offering `renewal_due` as a next step for a unit the federation has already
 * suspended. So the COLUMN wins, the stage is re-derived conservatively from
 * it, and the disagreement is reported rather than silently resolved. Fail
 * closed, and never quietly.
 */
async function readStage(db: DB, unit: ResolvedUnit): Promise<StageReading> {
  const rows = await db
    .select({ newValue: s.auditEvents.newValue })
    .from(s.auditEvents)
    .where(and(eq(s.auditEvents.entityType, LEDGER), eq(s.auditEvents.entityId, unit.key)))
    // Ordered by id, not `at`: several transitions inside one transaction share
    // the same now(), and ties would resolve arbitrarily.
    .orderBy(desc(s.auditEvents.id))
    .limit(1);

  const raw = (rows[0]?.newValue as any)?.stage as AffiliationStage | undefined;
  const ledgerStage = raw && raw in LEGAL_NEXT ? raw : null;

  if (!ledgerStage) return { stage: stageFromStatus(unit.status), ledgerStage: null, consistent: true };
  if (STAGE_STATUS[ledgerStage] !== unit.status) {
    return { stage: stageFromStatus(unit.status), ledgerStage, consistent: false };
  }
  return { stage: ledgerStage, ledgerStage, consistent: true };
}

function driftNote(unit: ResolvedUnit, reading: StageReading): string | null {
  if (reading.consistent) return null;
  return (
    `The status column for this ${unit.spec.kind} reads "${unit.status}", but the affiliation ledger last recorded ` +
    `"${reading.ledgerStage}". The column was changed outside the affiliation lifecycle. The stage reported here is ` +
    `derived from the column, because that is what the rest of the federation acts on; the ledger entry is intact and ` +
    `the disagreement is stated rather than resolved silently.`
  );
}

/** The current lifecycle stage of a unit, with the charter dates behind it. */
export async function affiliationStage(db: DB, ref: UnitRef) {
  const unit = await resolveUnit(db, ref);
  const reading = await readStage(db, unit);
  return {
    kind: unit.spec.kind,
    id: unit.id,
    code: unit.code,
    name: unit.name,
    stage: reading.stage,
    status: unit.status,
    charteredOn: unit.charteredOn,
    validUntil: unit.validUntil,
    nextStages: LEGAL_NEXT[reading.stage],
    ledgerStage: reading.ledgerStage,
    stageConsistent: reading.consistent,
    stageNote: driftNote(unit, reading),
  };
}

/**
 * Every transition this unit has been through, oldest first.
 *
 * Requires audit:read in a scope containing the unit — the trail names the
 * officers who decided, which is not public data.
 */
export async function affiliationHistory(db: DB, principal: Principal, ref: UnitRef) {
  const unit = await resolveUnit(db, ref);
  assertCan(principal, 'audit:read', unit.placement);

  const rows = await db
    .select()
    .from(s.auditEvents)
    .where(and(eq(s.auditEvents.entityType, LEDGER), eq(s.auditEvents.entityId, unit.key)))
    .orderBy(asc(s.auditEvents.id));

  return rows.map((r: any) => ({
    at: r.at,
    actor: r.actorLabel,
    actorRole: r.actorRole,
    from: (r.oldValue as any)?.stage ?? null,
    to: (r.newValue as any)?.stage ?? null,
    reason: r.reason,
    authority: r.authority,
    detail: r.newValue,
  }));
}

/**
 * The one path through which a unit changes stage.
 *
 * Order is deliberate: resolve the unit, then AUTHORISE against its real
 * placement, then check the move is legal. Authorising before the legality
 * check means an unauthorised caller learns nothing about the unit's state from
 * the error they get back.
 */
async function transition(
  db: DB,
  ctx: AuditContext,
  ref: UnitRef,
  to: AffiliationStage,
  opts: {
    reason: string;
    action?: Action;
    /** Column changes that belong with this transition (charter dates, etc.). */
    patch?: Record<string, unknown>;
    /** Recorded in the ledger so the decision is reconstructible. */
    detail?: Record<string, unknown>;
    /**
     * Permit from === to. Only renewal uses this: extending a charter that has
     * not yet lapsed is a real act with a new term and a new audit row, but it
     * is not a change of stage. Left off everywhere else so the machine cannot
     * be no-op'd into hiding a decision.
     */
    selfPermitted?: boolean;
    now?: Date;
  }
) {
  const unit = await resolveUnit(db, ref);
  assertCan(ctx.principal, opts.action ?? unit.spec.decideAction, unit.placement);

  const reason = opts.reason?.trim();
  if (!reason) {
    throw new AffiliationError(
      'reason_required',
      'Every affiliation decision must record the reason it was taken.'
    );
  }

  const from = (await readStage(db, unit)).stage;
  if (!(from === to && opts.selfPermitted) && !LEGAL_NEXT[from].includes(to)) {
    const permitted = LEGAL_NEXT[from].length
      ? LEGAL_NEXT[from].join(', ')
      : 'nothing — this is a terminal state';
    throw new AffiliationError(
      'illegal_transition',
      `An affiliation at ${from.replace(/_/g, ' ')} cannot move to ${to.replace(/_/g, ' ')}. Permitted next: ${permitted}.`
    );
  }

  const now = opts.now ?? new Date();
  await db
    .update(unit.spec.table)
    .set({ status: STAGE_STATUS[to], updatedAt: now, ...(opts.patch ?? {}) })
    .where(eq(unit.spec.table.id, unit.id));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: LEDGER,
    entityId: unit.key,
    action:
      to === 'revoked' ? 'revoke'
        : to === 'chartered' || to === 'provisional' ? 'approve'
          : 'update',
    oldValue: { stage: from, status: unit.status, validUntil: unit.validUntil },
    newValue: { stage: to, status: STAGE_STATUS[to], ...(opts.detail ?? {}) },
  });

  return {
    kind: unit.spec.kind,
    id: unit.id,
    code: unit.code,
    name: unit.name,
    from,
    stage: to,
    status: STAGE_STATUS[to],
    charteredOn: (opts.patch?.[unit.spec.charteredCol] as string | undefined) ?? unit.charteredOn,
    validUntil:
      unit.spec.expiresCol in (opts.patch ?? {})
        ? ((opts.patch as any)[unit.spec.expiresCol] ?? null)
        : unit.validUntil,
    reason,
  };
}

// ─── 1. Application ─────────────────────────────────────────────────────────

/**
 * What the federation requires of a chief instructor — CONFIGURATION, not code.
 *
 * This exists because the requirement it carries was originally hardcoded here
 * as "must hold an active rank", and that is a substantive eligibility rule
 * MMAKF has not published. It refused, at the door, a club whose instructor was
 * graded abroad, or graded under a predecessor body, or whose grade simply had
 * not been keyed into the register yet — against a threshold nobody approved.
 * Refusing a real applicant on an invented rule is the most damaging thing this
 * module could do, so the rule now has to be supplied, and it has to name the
 * instrument that imposes it so a refusal can be defended in writing.
 *
 * Supply nothing and nothing is checked: the instructor's rank standing is
 * measured, reported, and left to the reviewing officer to judge.
 */
export interface ChiefInstructorRequirement {
  /** The bye-law or resolution that imposes this. Quoted verbatim in refusals. */
  instrument: string;
  /** Refuse an application whose chief instructor holds no active rank. */
  requireActiveRank?: boolean;
  /** Refuse below this grade ordinal. Set by the federation, never assumed. */
  minimumGradeOrdinal?: number;
}

export interface AffiliationApplication {
  name: string;
  stateUnitId: number;
  districtUnitId?: number | null;
  /** MUST resolve to a person the federation register can identify. */
  chiefInstructorPersonId: number;
  addressLine?: string | null;
  city?: string | null;
  /** Supply only when the federation has already issued a code. */
  code?: string;
  /**
   * The published requirement for a chief instructor, if MMAKF has one. Absent,
   * no rank threshold is applied and the result says so in words.
   */
  instructorRequirement?: ChiefInstructorRequirement | null;
}

/**
 * File a dojo's application to affiliate.
 *
 * ONE hard door, and it is a matter of identity rather than of policy: the
 * chief instructor must be a person the federation register can identify. A
 * dojo is affiliated TO a named instructor; a row pointing at nobody is not a
 * weak application, it is an unusable record, and no configuration can make it
 * usable.
 *
 * Everything ELSE about that instructor — whether they must hold an active
 * rank, at what grade, with what qualification — is policy, and is applied only
 * when the federation supplies it as `instructorRequirement`. With none
 * supplied, the instructor's rank and qualification standing is measured,
 * returned, and written into the audit record for the reviewing officer to
 * judge; nothing is refused. Whether the federation additionally wants
 * insurance or a minimum membership is criteria, and criteria are likewise
 * configuration (see `assessAffiliation`).
 */
export async function applyForAffiliation(
  db: DB,
  ctx: AuditContext,
  input: AffiliationApplication,
  now: Date = new Date()
) {
  // Validate the hierarchy first, so the authority check below is made against
  // a placement that exists rather than one the applicant asserted.
  const placement = await resolvePlacement(db, {
    stateUnitId: input.stateUnitId,
    districtUnitId: input.districtUnitId ?? null,
  });
  assertCan(ctx.principal, 'dojo:write', placement);

  if (!input.name?.trim()) {
    throw new AffiliationError('name_required', 'An affiliation application must name the dojo.');
  }

  const instructor = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.chiefInstructorPersonId)).limit(1))[0];
  if (!instructor) {
    throw new AffiliationError(
      'chief_instructor_not_registered',
      'The chief instructor named on this application is not in the federation register. A dojo cannot be affiliated to an instructor the federation cannot identify.'
    );
  }

  const ranks = await db.select().from(s.rankRecords).where(and(
    eq(s.rankRecords.personId, instructor.id),
    eq(s.rankRecords.status, 'active')
  ));
  // Reported, not required, unless the federation says otherwise below.
  const quals = await db.select().from(s.instructorQuals).where(and(
    eq(s.instructorQuals.personId, instructor.id),
    eq(s.instructorQuals.status, 'active')
  ));

  const ordinals = ranks
    .map((r: any) => Number(r.gradeOrdinal))
    .filter((n: number) => Number.isFinite(n));
  const highestGradeOrdinal: number | null = ordinals.length ? Math.max(...ordinals) : null;

  // Configured requirements have teeth; unconfigured ones do not exist.
  const rule = input.instructorRequirement ?? null;
  const shortfalls: string[] = [];
  if (rule?.requireActiveRank && ranks.length === 0) {
    shortfalls.push('holds no active rank in the federation register');
  }
  if (rule?.minimumGradeOrdinal != null &&
      (highestGradeOrdinal == null || highestGradeOrdinal < rule.minimumGradeOrdinal)) {
    shortfalls.push(
      `holds no active rank at or above grade ordinal ${rule.minimumGradeOrdinal} (highest on record: ${highestGradeOrdinal ?? 'none'})`
    );
  }
  if (shortfalls.length) {
    throw new AffiliationError(
      'chief_instructor_requirement_unmet',
      `${instructor.fullName} ${shortfalls.join(', and ')}. This requirement is imposed by ${rule!.instrument}.`
    );
  }

  // Stated in words, and stored, so the file shows what was and was not checked.
  const requirementNote = rule
    ? `Checked against ${rule.instrument}.`
    : ranks.length
      ? 'The federation has published no rank or qualification requirement for a chief instructor, so none was applied. The active ranks on record are listed for the reviewing officer.'
      : 'The federation has published no rank or qualification requirement for a chief instructor, so none was applied — and this instructor holds NO active rank on record. That is reported, not refused: there is no approved threshold to refuse against. The reviewing officer must judge it.';

  const code = input.code?.trim() || (await allocateFederationId(db, 'DOJO'));

  let row;
  try {
    [row] = await db.insert(s.dojos).values({
      code,
      name: input.name.trim(),
      stateUnitId: input.stateUnitId,
      districtUnitId: input.districtUnitId ?? null,
      chiefInstructorPersonId: instructor.id,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      // An application is not an affiliation. No dates are set until a charter
      // is granted, so nothing here can read as "affiliated".
      status: STAGE_STATUS.application,
      createdAt: now,
      updatedAt: now,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AffiliationError('duplicate_code', `A unit already exists with the code ${code}.`);
    }
    throw err;
  }

  const chiefInstructor = {
    personId: instructor.id,
    federationId: instructor.federationId,
    fullName: instructor.fullName,
    activeRanks: ranks.map((r: any) => ({ kind: r.kind, grade: r.gradeLabel, awardedOn: r.awardedOn })),
    instructorQualifications: quals.map((q: any) => ({ level: q.level, grantedOn: q.grantedOn, expiresOn: q.expiresOn })),
    hasActiveRank: ranks.length > 0,
    highestGradeOrdinal,
    requirementApplied: rule,
    requirementNote,
  };

  await writeAudit(db, ctx, {
    entityType: LEDGER,
    entityId: `dojo:${row.id}`,
    action: 'create',
    newValue: { stage: 'application', status: STAGE_STATUS.application, code, name: row.name, chiefInstructor },
  });

  return { ...row, stage: 'application' as AffiliationStage, chiefInstructor };
}

// ─── 2. Evidence ────────────────────────────────────────────────────────────

/**
 * Evidence documents are stored in official_documents/document_versions, which
 * carry no unit foreign key. The unit is encoded in the document code so the
 * dossier for a unit is a prefix query — the alternative was a schema change to
 * a table five other modules already write, and the code is unique anyway.
 */
function evidenceCodePrefix(unit: ResolvedUnit): string {
  return `MMAKF-AFFIL-${unit.spec.kind.toUpperCase()}-${unit.id}-`;
}

function slug(text: string): string {
  return text.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'DOC';
}

/**
 * Attach an evidence document to an application.
 *
 * Versioned, never overwritten: a resubmitted insurance certificate is version
 * 2, and version 1 stays readable because a charter granted in 2026 was granted
 * on what was in front of the reviewer in 2026.
 *
 * Classified `official` rather than `public` — an applicant's registration and
 * insurance paperwork is the federation's to hold, not to publish.
 */
export async function submitAffiliationEvidence(
  db: DB,
  ctx: AuditContext,
  input: {
    unit: UnitRef;
    /** The federation's own category name, e.g. the criterion this answers. */
    category: string;
    title: string;
    fileUrl?: string | null;
    fileSha256?: string | null;
    fileSizeBytes?: number | null;
    fileContentType?: string | null;
    bodyMarkdown?: string | null;
    version?: string;
  },
  now: Date = new Date()
) {
  const unit = await resolveUnit(db, input.unit);
  assertCan(ctx.principal, unit.spec.writeAction, unit.placement);

  if (!input.category?.trim()) {
    throw new AffiliationError('category_required', 'Evidence must say which requirement it answers.');
  }

  const code = `${evidenceCodePrefix(unit)}${slug(input.category)}`;
  let doc = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.code, code)).limit(1))[0];

  if (!doc) {
    [doc] = await db.insert(s.officialDocuments).values({
      code,
      title: `${unit.name} — ${input.title}`,
      category: 'affiliation_evidence',
      summary: input.category.trim(),
      issuingBody: unit.name,
      classification: 'official',
    }).returning();
  }

  const existing = await db.select().from(s.documentVersions)
    .where(eq(s.documentVersions.documentId, doc.id));
  const version = input.version?.trim() || String(existing.length + 1);

  let ver;
  try {
    [ver] = await db.insert(s.documentVersions).values({
      documentId: doc.id,
      version,
      // Submitted, not accepted. Acceptance is a separate, authorised act.
      status: 'under_review',
      fileUrl: input.fileUrl ?? null,
      fileSha256: input.fileSha256 ?? null,
      fileSizeBytes: input.fileSizeBytes ?? null,
      fileContentType: input.fileContentType ?? null,
      bodyMarkdown: input.bodyMarkdown ?? null,
      createdAt: now,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AffiliationError('duplicate_version', `Version ${version} of this evidence already exists.`);
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'document_version',
    entityId: ver.id,
    action: 'create',
    newValue: { unit: unit.key, code, category: input.category.trim(), version, status: 'under_review' },
  });

  return { document: doc, version: ver };
}

/** Accept a piece of evidence. Only accepted evidence satisfies a criterion. */
export async function acceptAffiliationEvidence(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; documentVersionId: number; acceptedByPersonId?: number | null; reason: string },
  now: Date = new Date()
) {
  const unit = await resolveUnit(db, input.unit);
  assertCan(ctx.principal, unit.spec.decideAction, unit.placement);

  if (!input.reason?.trim()) {
    throw new AffiliationError('reason_required', 'Accepting evidence must record why it was accepted.');
  }

  const ver = (await db.select().from(s.documentVersions)
    .where(eq(s.documentVersions.id, input.documentVersionId)).limit(1))[0];
  if (!ver) throw new AffiliationError('unknown_evidence', 'Unknown document version');

  const doc = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.id, ver.documentId)).limit(1))[0];
  // Guards against accepting another unit's document into this unit's dossier.
  if (!doc?.code?.startsWith(evidenceCodePrefix(unit))) {
    throw new AffiliationError('evidence_not_for_unit', 'That document is not part of this unit’s affiliation dossier.');
  }

  // An acceptance is an official record: it names the officer who accepted, the
  // date, and the authority relied on. Re-accepting overwrote all three, and the
  // audit row carried only the old STATUS, so the original approver was gone
  // from the database entirely — an official record edited, not superseded.
  // Evidence is versioned precisely so a second look appends instead.
  if (ver.status === 'approved') {
    throw new AffiliationError(
      'evidence_already_accepted',
      'This evidence has already been accepted by a reviewing officer. An acceptance is not re-taken — submit a further version and accept that, so the record shows both.'
    );
  }

  const [updated] = await db.update(s.documentVersions).set({
    status: 'approved',
    approvedByPersonId: input.acceptedByPersonId ?? null,
    approvedOn: now.toISOString().slice(0, 10),
    approvedUnder: input.reason.trim(),
  }).where(eq(s.documentVersions.id, ver.id)).returning();

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'document_version',
    entityId: ver.id,
    action: 'approve',
    oldValue: {
      status: ver.status,
      approvedByPersonId: ver.approvedByPersonId ?? null,
      approvedOn: ver.approvedOn ?? null,
      approvedUnder: ver.approvedUnder ?? null,
    },
    newValue: {
      status: 'approved',
      unit: unit.key,
      approvedByPersonId: input.acceptedByPersonId ?? null,
      approvedOn: now.toISOString().slice(0, 10),
      approvedUnder: input.reason.trim(),
    },
  });

  return updated;
}

/** The dossier held for a unit: every evidence document and its versions. */
export async function affiliationDossier(db: DB, principal: Principal, ref: UnitRef) {
  const unit = await resolveUnit(db, ref);
  assertCan(principal, unit.spec.writeAction, unit.placement);

  const docs = await db.select().from(s.officialDocuments)
    .where(like(s.officialDocuments.code, `${evidenceCodePrefix(unit)}%`));
  if (!docs.length) return [];

  const versions = await db.select().from(s.documentVersions)
    .where(inArray(s.documentVersions.documentId, docs.map((d: any) => d.id)))
    .orderBy(asc(s.documentVersions.id));

  return docs.map((d: any) => ({
    code: d.code,
    title: d.title,
    category: d.summary,
    classification: d.classification,
    versions: versions.filter((v: any) => v.documentId === d.id),
  }));
}

// ─── 3. Criteria — configuration, never code ────────────────────────────────

/**
 * One published affiliation requirement.
 *
 * `measure` names the stored fact that answers it. Only two facts are
 * measurable from the federation's own records; anything else is left to the
 * reviewing officer and reported as undetermined rather than guessed.
 */
export interface AffiliationCriterion {
  key: string;
  label: string;
  /** The requirement as the federation published it, verbatim. */
  requirement: string;
  measure?: 'registered_members' | 'accepted_evidence';
  /** Only meaningful with measure 'registered_members'. */
  minimum?: number;
  /** Only meaningful with measure 'accepted_evidence'. */
  evidenceCategory?: string;
}

export interface AffiliationCriteria {
  /** The instrument these came from — a bye-law, a council resolution. */
  code: string;
  version: string;
  criteria: AffiliationCriterion[];
}

export interface CriteriaCheck {
  key: string;
  label: string;
  requirement: string;
  /** true met · false not met · null cannot be determined from stored records */
  satisfied: boolean | null;
  detail: string;
}

export interface CriteriaAssessment {
  criteriaConfigured: boolean;
  criteriaCode: string | null;
  criteriaVersion: string | null;
  checks: CriteriaCheck[];
  unmet: string[];
  undetermined: string[];
  /** Who the decision actually rests with, stated rather than implied. */
  decisionRestsWith: 'reviewing_officer' | 'published_criteria';
  note: string;
  assessedAt: string;
}

const NO_CRITERIA_NOTE =
  'The federation has published no affiliation criteria for this unit type. Nothing was checked against a threshold, ' +
  'because there is no approved threshold to check against. This decision rests entirely with the reviewing officer, ' +
  'and is recorded as such.';

/**
 * Assess an applicant against the criteria the federation supplies.
 *
 * THE RULE THIS FUNCTION EXISTS TO OBEY: no criterion is invented here. Where
 * MMAKF has published none, the assessment says so, checks nothing, and records
 * that the officer decided on their own judgement. Where a criterion is
 * published but names no threshold and no measurable fact, the measurement is
 * reported and the judgement is left to the officer — reporting "12 members are
 * registered" is a fact; deciding whether 12 is enough is policy.
 */
export async function assessAffiliation(
  db: DB,
  principal: Principal,
  ref: UnitRef,
  criteria?: AffiliationCriteria | null,
  now: Date = new Date()
): Promise<CriteriaAssessment> {
  const unit = await resolveUnit(db, ref);
  // An assessment counts a unit's registered members and discloses which of its
  // evidence an officer has accepted. That is the unit's own record, not public
  // data — so it is gated, through rbac like everything else, never locally.
  assertCan(principal, unit.spec.readAction, unit.placement);
  const list = criteria?.criteria ?? [];

  if (!list.length) {
    return {
      criteriaConfigured: false,
      criteriaCode: criteria?.code ?? null,
      criteriaVersion: criteria?.version ?? null,
      checks: [],
      unmet: [],
      undetermined: [],
      decisionRestsWith: 'reviewing_officer',
      note: NO_CRITERIA_NOTE,
      assessedAt: now.toISOString(),
    };
  }

  const checks: CriteriaCheck[] = [];

  for (const c of list) {
    if (c.measure === 'registered_members') {
      const col =
        unit.spec.kind === 'dojo' ? s.persons.dojoId
          : unit.spec.kind === 'district' ? s.persons.districtUnitId
            : s.persons.stateUnitId;
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.persons)
        .where(and(eq(col, unit.id), eq(s.persons.status, 'active')));
      const n = Number(rows[0]?.n ?? 0);

      if (c.minimum == null) {
        checks.push({
          key: c.key, label: c.label, requirement: c.requirement, satisfied: null,
          detail: `${n} active members are registered to this unit; the federation has set no minimum, so the reviewing officer judges this.`,
        });
      } else {
        checks.push({
          key: c.key, label: c.label, requirement: c.requirement, satisfied: n >= c.minimum,
          detail: `${n} active members registered, ${c.minimum} required.`,
        });
      }
      continue;
    }

    if (c.measure === 'accepted_evidence') {
      const category = c.evidenceCategory ?? c.key;
      const code = `${evidenceCodePrefix(unit)}${slug(category)}`;
      const doc = (await db.select().from(s.officialDocuments)
        .where(eq(s.officialDocuments.code, code)).limit(1))[0];
      const accepted = doc
        ? await db.select().from(s.documentVersions).where(and(
            eq(s.documentVersions.documentId, doc.id),
            eq(s.documentVersions.status, 'approved')
          ))
        : [];
      checks.push({
        key: c.key, label: c.label, requirement: c.requirement, satisfied: accepted.length > 0,
        detail: accepted.length
          ? `accepted: ${category} version ${accepted[accepted.length - 1].version}`
          : doc
            ? `${category} has been submitted but not accepted by a reviewing officer`
            : `no ${category} document is on file`,
      });
      continue;
    }

    checks.push({
      key: c.key, label: c.label, requirement: c.requirement, satisfied: null,
      detail: 'No stored record measures this requirement; the reviewing officer must assess it directly.',
    });
  }

  const unmet = checks.filter((c) => c.satisfied === false).map((c) => c.label);
  const undetermined = checks.filter((c) => c.satisfied === null).map((c) => c.label);

  return {
    criteriaConfigured: true,
    criteriaCode: criteria?.code ?? null,
    criteriaVersion: criteria?.version ?? null,
    checks,
    unmet,
    undetermined,
    decisionRestsWith: 'published_criteria',
    note: undetermined.length
      ? `${undetermined.length} criterion(s) cannot be decided from stored records and rest with the reviewing officer.`
      : 'Every published criterion was measured against the federation’s own records.',
    assessedAt: now.toISOString(),
  };
}

// ─── 4. Review ──────────────────────────────────────────────────────────────

export type ReviewDecision = 'passed' | 'returned' | 'refused';

interface ReviewInput {
  unit: UnitRef;
  decision: ReviewDecision;
  reason: string;
  criteria?: AffiliationCriteria | null;
  /** Pass a configured criterion the applicant does not meet, with reasons. */
  overrideUnmet?: boolean;
  now?: Date;
}

/**
 * Shared body of both review steps.
 *
 * A configured criterion that is not met BLOCKS a pass unless the officer
 * overrides it explicitly — configured rules have teeth, and an override is
 * visible in the ledger rather than indistinguishable from a clean pass. An
 * UNconfigured criterion blocks nothing, because there is nothing to fail.
 */
async function review(
  db: DB,
  ctx: AuditContext,
  input: ReviewInput,
  stages: { pass: AffiliationStage; ret: AffiliationStage }
) {
  const now = input.now ?? new Date();

  // AUTHORISE BEFORE ASSESSING. `transition` authorises as well, but it runs
  // only AFTER the criteria check below — and that check throws a message
  // naming exactly what the applicant fell short on. Without this line an
  // unauthorised caller could pass criteria in and read a club's membership
  // numbers back out of the refusal: learning a unit's state from an error,
  // which is the precise thing the ordering inside `transition` exists to stop.
  const unit = await resolveUnit(db, input.unit);
  assertCan(ctx.principal, unit.spec.decideAction, unit.placement);

  const assessment = await assessAffiliation(db, ctx.principal, input.unit, input.criteria, now);

  if (input.decision === 'passed' && assessment.unmet.length && !input.overrideUnmet) {
    throw new AffiliationError(
      'criteria_unmet',
      `This applicant does not meet published criteria: ${assessment.unmet.join('; ')}. Record an explicit override with reasons to pass regardless.`
    );
  }

  const to =
    input.decision === 'passed' ? stages.pass
      : input.decision === 'returned' ? stages.ret
        : 'revoked';

  const result = await transition(db, ctx, input.unit, to, {
    reason: input.reason,
    detail: {
      review: stages.pass,
      decision: input.decision,
      assessment,
      overrodeUnmetCriteria: Boolean(input.decision === 'passed' && assessment.unmet.length && input.overrideUnmet),
    },
    now,
  });

  return { ...result, assessment };
}

/** Move an application into document review. */
export async function beginDocumentReview(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; reason: string; now?: Date }
) {
  return transition(db, ctx, input.unit, 'document_review', {
    reason: input.reason,
    detail: { review: 'document_review', decision: 'opened' },
    now: input.now,
  });
}

/**
 * Decide document review. `passed` moves to technical review, `returned` sends
 * it back to the applicant, `refused` ends it.
 */
export async function recordDocumentReview(db: DB, ctx: AuditContext, input: ReviewInput) {
  return review(db, ctx, input, { pass: 'technical_review', ret: 'application' });
}

/** Decide technical review. `passed` moves to provisional. */
export async function recordTechnicalReview(db: DB, ctx: AuditContext, input: ReviewInput) {
  const result = await review(db, ctx, input, { pass: 'provisional', ret: 'document_review' });

  // Passing technical review confers PROVISIONAL standing but no term — how
  // long a provisional period runs is policy the federation has not published,
  // so none is invented. The caller is told, because the alternative is a unit
  // sitting publicly "provisionally affiliated" with no start date, no end date
  // and no way for the lapse sweep to ever reach it, discovered by nobody.
  return {
    ...result,
    provisionalTermRecorded: result.stage === 'provisional' ? result.validUntil != null : null,
    termNote:
      result.stage === 'provisional' && result.validUntil == null
        ? 'This unit now holds PROVISIONAL standing with no term recorded against it. Record the period with grantProvisional; the federation has published no default length, so none was assumed and it will not lapse on a schedule.'
        : null,
  };
}

// ─── 5. Charter, renewal, lapse ─────────────────────────────────────────────

/**
 * Grant the charter.
 *
 * `validUntil` is supplied by the federation and never computed here: how long
 * a charter runs is policy, and defaulting it to a year would put an unapproved
 * term on every certificate of affiliation. Omitting it is permitted and
 * recorded — the returned result says the charter carries no expiry, so nothing
 * downstream has to guess.
 */
export async function grantCharter(
  db: DB,
  ctx: AuditContext,
  input: {
    unit: UnitRef;
    charteredOn: string;
    validUntil?: string | null;
    reason: string;
    now?: Date;
  }
) {
  const spec = SPECS[input.unit.kind];
  if (!spec) throw new AffiliationError('unknown_unit_kind', `Unknown unit kind: ${String(input.unit.kind)}`);

  if (input.validUntil && input.validUntil < input.charteredOn) {
    throw new AffiliationError('charter_dates_invalid', 'A charter cannot expire before it starts.');
  }

  const result = await transition(db, ctx, input.unit, 'chartered', {
    reason: input.reason,
    patch: {
      [spec.charteredCol]: input.charteredOn,
      [spec.expiresCol]: input.validUntil ?? null,
    },
    detail: { charteredOn: input.charteredOn, validUntil: input.validUntil ?? null },
    now: input.now,
  });

  return {
    ...result,
    charterHasExpiry: Boolean(input.validUntil),
    note: input.validUntil
      ? null
      : 'The federation has recorded no expiry for this charter, so it will not lapse on a schedule. Renewal terms are policy the federation has not set.',
  };
}

/**
 * Grant a provisional affiliation — real, dated, and visibly not a full charter.
 *
 * Provisional units DO appear in the public directory, marked provisional. A
 * parent is better served by "provisionally affiliated until 30 June" than by
 * silence.
 */
export async function grantProvisional(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; from: string; validUntil?: string | null; reason: string; now?: Date }
) {
  const spec = SPECS[input.unit.kind];
  if (!spec) throw new AffiliationError('unknown_unit_kind', `Unknown unit kind: ${String(input.unit.kind)}`);

  // grantCharter refused this and grantProvisional did not; a provisional term
  // that expires before it begins is no more defensible than a charter that does.
  if (input.validUntil && input.validUntil < input.from) {
    throw new AffiliationError('charter_dates_invalid', 'A provisional affiliation cannot expire before it starts.');
  }

  const result = await transition(db, ctx, input.unit, 'provisional', {
    reason: input.reason,
    patch: { [spec.charteredCol]: input.from, [spec.expiresCol]: input.validUntil ?? null },
    detail: { provisionalFrom: input.from, validUntil: input.validUntil ?? null },
    // Passing technical review ALREADY leaves a unit at `provisional`, with no
    // dates on it. Without this, the one function that can put a term on that
    // standing is refused as a no-op — which left every unit that came through
    // the normal review path provisionally affiliated for ever, unreachable by
    // the lapse sweep, with no supported way to correct it.
    selfPermitted: true,
    now: input.now,
  });

  return {
    ...result,
    termHasExpiry: Boolean(input.validUntil),
    note: input.validUntil
      ? null
      : 'This provisional affiliation records no expiry, so it will not lapse on a schedule. How long a provisional term runs is policy the federation has not set.',
  };
}

/**
 * Where a charter stands today.
 *
 * The renewal window — how far ahead of expiry a charter counts as due — is
 * configuration. With none supplied, no renewal judgement is offered and the
 * result says why, rather than picking 90 days because it sounds right.
 */
export async function charterStanding(
  db: DB,
  ref: UnitRef,
  opts: { on?: Date; renewalWindowDays?: number } = {}
) {
  const unit = await resolveUnit(db, ref);
  const reading = await readStage(db, unit);
  const stage = reading.stage;
  const on = opts.on ?? new Date();
  const today = on.toISOString().slice(0, 10);

  const affiliated = stage === 'chartered' || stage === 'renewal_due' || stage === 'provisional';
  const expired = Boolean(unit.validUntil && unit.validUntil < today);

  let daysRemaining: number | null = null;
  if (unit.validUntil) {
    const ms = Date.parse(`${unit.validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
    daysRemaining = Math.round(ms / 86_400_000);
  }

  const renewalDue =
    opts.renewalWindowDays == null || daysRemaining == null
      ? null
      : daysRemaining <= opts.renewalWindowDays;

  return {
    kind: unit.spec.kind,
    id: unit.id,
    code: unit.code,
    name: unit.name,
    stage,
    affiliated: affiliated && !expired,
    charteredOn: unit.charteredOn,
    validUntil: unit.validUntil,
    daysRemaining,
    expired,
    renewalDue,
    stageConsistent: reading.consistent,
    note:
      [
        driftNote(unit, reading),
        !unit.validUntil
          ? 'No expiry is recorded for this charter.'
          : renewalDue == null
            ? 'The federation has published no renewal window, so no renewal judgement is offered here.'
            : null,
      ]
        .filter(Boolean)
        .join(' ') || null,
    asAt: today,
  };
}

/**
 * Charters expiring within a window, for the renewal notice run.
 *
 * `withinDays` is the caller's — the federation's — and has no default.
 */
export async function dueForRenewal(
  db: DB,
  opts: { withinDays: number; kinds?: UnitKind[]; on?: Date }
) {
  const on = opts.on ?? new Date();
  const today = on.toISOString().slice(0, 10);
  const horizon = new Date(on.getTime() + opts.withinDays * 86_400_000).toISOString().slice(0, 10);

  const out: Array<{ kind: UnitKind; id: number; code: string; name: string; validUntil: string; daysRemaining: number }> = [];
  for (const kind of opts.kinds ?? (['dojo', 'district', 'state'] as UnitKind[])) {
    const spec = SPECS[kind];
    const rows = await db.select().from(spec.table).where(and(
      inArray(spec.table.status, ['active', 'provisional']),
      isNotNull(spec.table[spec.expiresCol]),
      sql`${spec.table[spec.expiresCol]} >= ${today}`,
      sql`${spec.table[spec.expiresCol]} <= ${horizon}`
    ));
    for (const r of rows) {
      out.push({
        kind,
        id: r.id,
        code: r.code,
        name: r.name,
        validUntil: r[spec.expiresCol],
        daysRemaining: Math.round(
          (Date.parse(`${r[spec.expiresCol]}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
        ),
      });
    }
  }
  return out;
}

/** Record that a renewal notice has been issued. Does not withdraw the charter. */
export async function markRenewalDue(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; reason: string; now?: Date }
) {
  return transition(db, ctx, input.unit, 'renewal_due', {
    reason: input.reason,
    detail: { noticeIssued: true },
    now: input.now,
  });
}

/**
 * Renew a charter — including one that has already lapsed.
 *
 * This is what makes lapsing reversible and non-destructive: a lapsed unit is
 * not deleted, it is simply out of charter, and a renewal moves it back to
 * chartered with a new term. The lapse stays in the ledger, so the gap in the
 * unit's affiliation remains visible.
 */
export async function renewCharter(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; renewedOn?: string; validUntil?: string | null; reason: string; now?: Date }
) {
  const spec = SPECS[input.unit.kind];
  if (!spec) throw new AffiliationError('unknown_unit_kind', `Unknown unit kind: ${String(input.unit.kind)}`);

  const patch: Record<string, unknown> = { [spec.expiresCol]: input.validUntil ?? null };
  // The original charter date is NOT overwritten by default: "affiliated since"
  // is part of a dojo's record and a renewal does not restart it.
  if (input.renewedOn) patch[spec.charteredCol] = input.renewedOn;

  const before = await resolveUnit(db, input.unit);
  // Authorise before reading anything back out of the unit: the two checks
  // below quote its charter date and its stage.
  assertCan(ctx.principal, spec.decideAction, before.placement);

  // A RENEWAL renews something. `chartered` is a self-permitted target here, so
  // without this guard renewCharter would take a unit that had only ever been
  // PROVISIONAL and hand it a full charter — a chartering act wearing a
  // renewal's label, landing in the ledger as `renewal: true`, with no charter
  // decision anywhere in the file. grantCharter is the only door to a charter.
  const beforeStage = (await readStage(db, before)).stage;
  const renewable: AffiliationStage[] = ['chartered', 'renewal_due', 'lapsed'];
  // `revoked` is deliberately left to the state machine below, which refuses it
  // as terminal. That is the accurate reason: a revoked affiliation existed and
  // was taken away, and saying "there is nothing to renew" would misdescribe it.
  if (beforeStage !== 'revoked' && !renewable.includes(beforeStage)) {
    throw new AffiliationError(
      'not_a_renewal',
      beforeStage === 'suspended'
        ? `This ${spec.kind}'s affiliation is suspended. Lift the suspension with reinstateAffiliation, which restores the standing that was interrupted; a renewal does not double as one.`
        : `This ${spec.kind} is at ${beforeStage.replace(/_/g, ' ')} and has never held a charter, so there is nothing to renew. A charter is granted, not renewed into existence.`
    );
  }

  const startsOn = input.renewedOn ?? before.charteredOn;
  if (input.validUntil && startsOn && input.validUntil < startsOn) {
    throw new AffiliationError('charter_dates_invalid', 'A renewed charter cannot expire before it starts.');
  }

  const result = await transition(db, ctx, input.unit, 'chartered', {
    reason: input.reason,
    patch,
    detail: { renewal: true, validUntil: input.validUntil ?? null },
    // A charter may be renewed BEFORE it lapses — that is the normal case, and
    // refusing it would force units to let their affiliation expire first.
    selfPermitted: true,
    now: input.now,
  });

  // Same honesty as grantCharter: a renewal with no term recorded leaves an
  // OPEN-ENDED charter, and that must be visible to the caller rather than
  // discovered later when the lapse sweep never picks the unit up.
  return {
    ...result,
    renewed: true,
    charterHasExpiry: Boolean(input.validUntil),
    note: input.validUntil
      ? null
      : 'This renewal records no expiry date, so the charter is now open-ended and will not lapse on a schedule. Renewal terms are policy the federation has not set.',
  };
}

/**
 * Move charters whose validity has run out to lapsed. Safe to run on a schedule.
 *
 * Lapsing is a consequence of a date passing, not a judgement, so it needs no
 * criteria — but it still records an actor and a reason, and it still refuses
 * to touch units outside the caller's scope. Units the caller cannot act on are
 * reported as skipped rather than silently ignored: a state officer running the
 * sweep should be able to see that national units were left alone.
 */
export async function lapseExpiredCharters(
  db: DB,
  ctx: AuditContext,
  opts: { on?: Date; kinds?: UnitKind[]; reason?: string } = {}
) {
  const on = opts.on ?? new Date();
  const today = on.toISOString().slice(0, 10);
  const reason = opts.reason?.trim() || `Charter validity expired on or before ${today}.`;

  const lapsed: Array<{ kind: UnitKind; id: number; code: string; validUntil: string }> = [];
  const skipped: Array<{ kind: UnitKind; id: number; code: string; why: string }> = [];

  for (const kind of opts.kinds ?? (['dojo', 'district', 'state'] as UnitKind[])) {
    const spec = SPECS[kind];
    const rows = await db.select().from(spec.table).where(and(
      inArray(spec.table.status, ['active', 'provisional']),
      isNotNull(spec.table[spec.expiresCol]),
      sql`${spec.table[spec.expiresCol]} < ${today}`
    ));

    for (const r of rows) {
      const unit = await resolveUnit(db, { kind, id: r.id });
      if (!can(ctx.principal, spec.decideAction, unit.placement)) {
        skipped.push({ kind, id: r.id, code: r.code, why: 'outside the caller’s scope' });
        continue;
      }
      const stage = (await readStage(db, unit)).stage;
      if (!LEGAL_NEXT[stage].includes('lapsed')) {
        skipped.push({ kind, id: r.id, code: r.code, why: `stage ${stage} does not lapse` });
        continue;
      }
      await transition(db, ctx, { kind, id: r.id }, 'lapsed', {
        reason,
        detail: { expiredOn: r[spec.expiresCol], sweptAt: on.toISOString() },
        now: on,
      });
      lapsed.push({ kind, id: r.id, code: r.code, validUntil: r[spec.expiresCol] });
    }
  }

  return { asAt: today, lapsed, skipped };
}

// ─── 6. Suspension and revocation ───────────────────────────────────────────

/** Suspend an affiliation. The reason is mandatory and travels with the record. */
export async function suspendAffiliation(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; reason: string; until?: string | null; now?: Date }
) {
  if (!input.reason?.trim()) {
    throw new AffiliationError('reason_required', 'A suspension must record its reason.');
  }
  return transition(db, ctx, input.unit, 'suspended', {
    reason: input.reason,
    detail: { suspendedUntil: input.until ?? null },
    now: input.now,
  });
}

/**
 * What standing this unit held immediately before it was suspended.
 *
 * Read from the append-only ledger, which is the only record of it: the status
 * column was overwritten with `suspended` at the time.
 */
async function stageBeforeSuspension(db: DB, unit: ResolvedUnit): Promise<'chartered' | 'provisional' | null> {
  const rows = await db
    .select({ oldValue: s.auditEvents.oldValue, newValue: s.auditEvents.newValue })
    .from(s.auditEvents)
    .where(and(eq(s.auditEvents.entityType, LEDGER), eq(s.auditEvents.entityId, unit.key)))
    .orderBy(desc(s.auditEvents.id));

  for (const r of rows) {
    if ((r.newValue as any)?.stage !== 'suspended') continue;
    const before = (r.oldValue as any)?.stage as AffiliationStage | undefined;
    // renewal_due projects onto the same status as chartered and is not a legal
    // target out of suspension, so it restores as chartered.
    return before === 'provisional' ? 'provisional' : 'chartered';
  }
  return null;
}

/**
 * Lift a suspension, restoring the standing that was interrupted.
 *
 * The target is NOT defaulted to `chartered`. Lifting a sanction restores what
 * was suspended; it does not confer something better. Defaulting turned every
 * suspend-then-reinstate of a PROVISIONAL unit into a full charter — a charter
 * with no chartering decision behind it, produced by two calls that each looked
 * innocuous, and visible to the public directory as a full affiliation. Where
 * the ledger does not show what was suspended (a row predating this module),
 * the caller must state it: inventing either answer would be worse.
 */
export async function reinstateAffiliation(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; reason: string; to?: 'chartered' | 'provisional'; now?: Date }
) {
  const unit = await resolveUnit(db, input.unit);
  assertCan(ctx.principal, unit.spec.decideAction, unit.placement);

  const restored = await stageBeforeSuspension(db, unit);
  const to = input.to ?? restored;
  if (!to) {
    throw new AffiliationError(
      'reinstatement_standing_unknown',
      'The federation’s records do not show what standing this unit held before it was suspended, so the standing to restore must be stated explicitly.'
    );
  }

  return transition(db, ctx, input.unit, to, {
    reason: input.reason,
    detail: {
      reinstated: true,
      suspendedFrom: restored,
      restoredTo: to,
      // An officer overriding the restored standing is not the same act as
      // simply lifting a suspension, and the ledger must be able to tell them apart.
      restoredByCallerChoice: input.to != null && input.to !== restored,
    },
    now: input.now,
  });
}

/**
 * Revoke an affiliation. NEVER deletes the unit.
 *
 * The record must survive so the public directory can answer the question a
 * parent actually asks — "this club says it is MMAKF affiliated, is it?" — with
 * "it was, from 2024 to 2026, and the affiliation was revoked", rather than
 * with silence. A deleted dojo and a dojo that was never affiliated look
 * identical, and that difference is the whole point.
 */
export async function revokeAffiliation(
  db: DB,
  ctx: AuditContext,
  input: { unit: UnitRef; reason: string; now?: Date }
) {
  if (!input.reason?.trim()) {
    throw new AffiliationError('reason_required', 'A revocation must record its reason.');
  }
  const now = input.now ?? new Date();
  return transition(db, ctx, input.unit, 'revoked', {
    reason: input.reason,
    detail: { revokedOn: now.toISOString().slice(0, 10) },
    now,
  });
}

// ─── 7. Public directory ────────────────────────────────────────────────────

export interface DirectoryEntry {
  kind: UnitKind;
  /**
   * The register row id.
   *
   * SERVER-SIDE ONLY, and the one field here that is not for the reader: it is
   * the key `publishedWeek()` needs to answer "when does this club train?".
   * Never rendered — the public identifier is `code`, which the federation
   * issues and can reissue. Carrying it changes nothing about what this
   * function refuses to publish: still no address, telephone number or email.
   */
  id: number;
  code: string;
  name: string;
  /**
   * The club's own public address — /clubs/<slug> — or null for none.
   *
   * Null for a district and for a state unit: neither has a page of that kind
   * and neither table carries the column. Null too for a dojo nobody has given
   * a slug, and it stays null: `publishableClubs()` publishes only a slug an
   * administrator SET, so no reader of this field may derive one from `name`.
   * A URL built from a name moves the next time a spelling is corrected, and
   * breaks the link a parent bookmarked.
   */
  slug: string | null;
  city: string | null;
  state: string | null;
  district: string | null;
  standing: 'chartered' | 'provisional' | 'lapsed' | 'suspended' | 'revoked';
  affiliated: boolean;
  affiliatedSince: string | null;
  charterValidUntil: string | null;
  charterCurrent: boolean | null;
  note: string | null;
}

const STANDING_NOTE: Record<DirectoryEntry['standing'], string | null> = {
  chartered: null,
  provisional: 'Provisionally affiliated. The full charter has not yet been granted.',
  lapsed: 'This unit was affiliated. Its charter has expired and has not been renewed.',
  suspended: 'This unit’s affiliation is currently suspended.',
  revoked: 'This unit was affiliated. Its affiliation has been revoked.',
};

/**
 * The public directory.
 *
 * Carries no private data: no address line, no email, no telephone number, no
 * date of birth, no applicant. Only units that reached at least provisional
 * affiliation appear — an application is not an affiliation, and listing
 * applicants would let a club advertise on the strength of a form it filed.
 *
 * Charter validity travels with every entry so a parent can see for themselves
 * whether an affiliation is current, rather than trusting a badge.
 */
export async function publicDirectory(
  db: DB,
  opts: {
    kind?: UnitKind;
    stateUnitId?: number;
    /** Include units that WERE affiliated and no longer are. */
    includeFormer?: boolean;
    on?: Date;
    limit?: number;
  } = {}
): Promise<DirectoryEntry[]> {
  const kind = opts.kind ?? 'dojo';
  const spec = SPECS[kind];
  if (!spec) throw new AffiliationError('unknown_unit_kind', `Unknown unit kind: ${String(kind)}`);

  const today = (opts.on ?? new Date()).toISOString().slice(0, 10);
  const current: UnitStatus[] = ['active', 'provisional'];
  const former: UnitStatus[] = ['expired', 'suspended', 'revoked'];
  // 'draft' is never listed under any option: an applicant was never affiliated.
  const statuses = opts.includeFormer ? [...current, ...former] : current;

  const conds: any[] = [inArray(spec.table.status, statuses)];
  if (opts.stateUnitId != null) {
    if (kind === 'state') conds.push(eq(spec.table.id, opts.stateUnitId));
    else conds.push(eq(spec.table.stateUnitId, opts.stateUnitId));
  }

  const rows = await db.select().from(spec.table).where(and(...conds))
    .orderBy(asc(spec.table.name)).limit(opts.limit ?? 500);
  if (!rows.length) return [];

  // A REFUSED APPLICANT IS NOT A FORMER AFFILIATION.
  //
  // Refusing an application at document or technical review lands the unit at
  // `revoked`, and the status column cannot tell that apart from a charter the
  // federation withdrew. So a club whose application was thrown out for forged
  // paperwork was published as "This unit was affiliated. Its affiliation has
  // been revoked" — a claim about an affiliation that never existed, in the one
  // output a parent actually reads, and one the federation could not defend.
  //
  // A row is a former affiliation if it carries an affiliation date, or if the
  // append-only ledger shows it once reached provisional or charter. Neither,
  // and it is not listed at all — which is the contract this function already
  // stated ("only units that reached at least provisional affiliation appear")
  // and that the status column alone could not enforce.
  const affiliatedStages = new Set<AffiliationStage>(['provisional', 'chartered', 'renewal_due']);
  const doubtful = rows.filter((r: any) => former.includes(r.status) && r[spec.charteredCol] == null);
  let listable = rows;
  if (doubtful.length) {
    const seen = await db
      .select({ entityId: s.auditEvents.entityId, newValue: s.auditEvents.newValue })
      .from(s.auditEvents)
      .where(and(
        eq(s.auditEvents.entityType, LEDGER),
        inArray(s.auditEvents.entityId, doubtful.map((r: any) => `${kind}:${r.id}`))
      ));
    const everAffiliated = new Set(
      seen
        .filter((e: any) => affiliatedStages.has((e.newValue as any)?.stage))
        .map((e: any) => e.entityId)
    );
    const never = new Set(
      doubtful.filter((r: any) => !everAffiliated.has(`${kind}:${r.id}`)).map((r: any) => r.id)
    );
    listable = rows.filter((r: any) => !never.has(r.id));
  }
  if (!listable.length) return [];

  // Names of the parent units, so the directory reads as places rather than ids.
  const stateIds = kind === 'state' ? [] : [...new Set(listable.map((r: any) => r.stateUnitId).filter(Boolean))] as number[];
  const districtIds = kind === 'dojo' ? [...new Set(listable.map((r: any) => r.districtUnitId).filter(Boolean))] as number[] : [];
  const states = stateIds.length
    ? await db.select().from(s.stateUnits).where(inArray(s.stateUnits.id, stateIds))
    : [];
  const districts = districtIds.length
    ? await db.select().from(s.districtUnits).where(inArray(s.districtUnits.id, districtIds))
    : [];

  return listable.map((r: any) => {
    const standing: DirectoryEntry['standing'] =
      r.status === 'active' ? 'chartered'
        : r.status === 'provisional' ? 'provisional'
          : r.status === 'expired' ? 'lapsed'
            : r.status === 'suspended' ? 'suspended'
              : 'revoked';

    const validUntil: string | null = r[spec.expiresCol] ?? null;
    const charterCurrent = validUntil == null ? null : validUntil >= today;
    const affiliated =
      (standing === 'chartered' || standing === 'provisional') && charterCurrent !== false;

    return {
      kind,
      id: r.id,
      code: r.code,
      name: r.name,
      // Decided by kind, not by the row: `state_units` and `district_units`
      // carry no slug column at all, so `r.slug` there is undefined rather than
      // null, and only a dojo has a /clubs page to point at anyway.
      slug: kind === 'dojo' ? (r.slug ?? null) : null,
      // City is a location; the address line is where an instructor may live.
      city: kind === 'dojo' ? (r.city ?? null) : (r.hqCity ?? null),
      state: kind === 'state' ? r.state : (states.find((x: any) => x.id === r.stateUnitId)?.state ?? null),
      district: kind === 'district' ? r.district : (districts.find((x: any) => x.id === r.districtUnitId)?.district ?? null),
      standing,
      affiliated,
      affiliatedSince: r[spec.charteredCol] ?? null,
      charterValidUntil: validUntil,
      charterCurrent,
      // A provisional term that has run out is as out of date as a charter that
      // has. Falling through to the generic provisional note would have read as
      // "provisionally affiliated" beside affiliated:false, which is the kind of
      // half-truth this directory exists to remove. And a live affiliation with
      // NO validity date at all is not the same as one that runs to a date: the
      // reader is told which they are looking at rather than left to assume.
      note:
        [
          charterCurrent === false && (standing === 'chartered' || standing === 'provisional')
            ? `This ${standing === 'provisional' ? 'provisional affiliation' : 'charter'}’s validity date has passed and it has not yet been renewed.`
            : STANDING_NOTE[standing],
          validUntil == null && (standing === 'chartered' || standing === 'provisional')
            ? 'The federation has recorded no validity date against this affiliation, so it carries no expiry.'
            : null,
        ]
          .filter(Boolean)
          .join(' ') || null,
    };
  });
}
