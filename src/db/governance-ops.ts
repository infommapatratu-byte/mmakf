// Governance operations — Q-16.
//
// Who held office, under which document, decided at which meeting, and whether
// that meeting was entitled to decide it at all. A federation is believed or
// disbelieved on exactly those four answers, and each of them is a question
// about a DATE IN THE PAST, not about the current state of a row.
//
// FOUR THINGS ARE STRUCTURAL HERE, NOT COSMETIC:
//
//  1. NO OFFICE HOLDER, QUORUM, MAJORITY OR RETENTION RULE IS INVENTED. The
//     quorum is `committees.quorum` and nothing else. When it is unset the
//     headcount is recorded and the result says the quorum was NOT CONFIGURED.
//     It never says the meeting was quorate, and `meetings.quorum_met` stays
//     NULL — because NULL means "unknown" and `false` would be a finding the
//     federation never made.
//
//  2. EVERY "NOTHING FOUND" IS TYPED. "not configured", "vacant", "none
//     declared" and "declared but no match" are four different facts. Returning
//     null or an empty array for all of them turns an absence of evidence into
//     evidence of absence, which is the specific way this subsystem lies.
//
//  3. A PUBLISHED DOCUMENT IS FROZEN BY ITS CHECKSUM. `publishVersion` hashes
//     the exact bytes it publishes, so a file swapped after approval is
//     DETECTABLE rather than merely deniable. A version with nothing to hash
//     cannot be published at all.
//
//  4. HISTORY IS ANSWERED BY DATE, NEVER BY STATUS. A status column only knows
//     what is true now; "who chaired on 12 March 2026" is a question about then.
//     Ended appointments and superseded document versions are therefore never
//     deleted, and the date range — not the status — decides what a past-dated
//     read returns.
//
// AUTHORISATION. `src/lib/rbac.ts` carries no `governance:*` action yet, so
// committee and meeting administration is gated on `unit:write` / `unit:read`
// with the committee's OWN scope (`scopeType`/`scopeId`) as the resource, and
// document publication on `content:write` at national scope. A dedicated action
// pair belongs in that module; until it exists these are the closest existing
// grants and the scope check is still applied rather than skipped.
//
// SCOPE IS ENFORCED IN SQL, NOT AFTER THE FACT. `assertCanAnywhere` only asks
// whether a principal holds an action SOMEWHERE; on its own it hands a
// state-scoped administrator every row in the federation. Every list here pairs
// it with `committeeScopeCondition()` in the WHERE clause, and says in its own
// result whether what it returned was scope-limited.

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import {
  assertCan, assertCanAnywhere, canAnywhere, visibleScopes,
  type Action, type Principal, type Resource,
} from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class GovernanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
  }
}

function today(on: Date = new Date()): string {
  return on.toISOString().slice(0, 10);
}

/** Calendar day before an ISO date — used to close an effective window. */
function dayBefore(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new GovernanceError('bad_date', `${field} must be a calendar date in YYYY-MM-DD form.`);
  }
}

/**
 * A committee's own scope, as an RBAC resource.
 *
 * A national committee resolves to `{}`, which only a national binding can
 * reach — a state administrator must not appoint to a national committee even
 * though they hold `unit:write` in their own state. Fail closed.
 */
function committeeResource(c: { scopeType: string; scopeId: number | null }): Resource {
  switch (c.scopeType) {
    case 'state': return { stateUnitId: c.scopeId };
    case 'district': return { districtUnitId: c.scopeId };
    case 'dojo': return { dojoId: c.scopeId };
    default: return {};
  }
}

/**
 * The SQL scope filter for rows that belong to a committee.
 *
 * Returns null for national reach and `sql`false`` for none, so a caller always
 * filters IN THE QUERY rather than after the rows are already in memory (§53
 * IDOR). Rows whose meeting has NO committee — an AGM, an EGM — are national
 * acts and match only national reach: a state administrator has no business
 * reading the national executive's business, and `assertCanAnywhere` alone
 * would have handed them all of it.
 *
 * Must be used with `leftJoin(s.committees)` in the query it filters.
 */
function committeeScopeCondition(principal: Principal, action: Action) {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const clauses: any[] = [];
  if (scopes.states.length) {
    clauses.push(and(eq(s.committees.scopeType, 'state'), inArray(s.committees.scopeId, scopes.states)));
  }
  if (scopes.districts.length) {
    clauses.push(and(eq(s.committees.scopeType, 'district'), inArray(s.committees.scopeId, scopes.districts)));
  }
  if (scopes.dojos.length) {
    clauses.push(and(eq(s.committees.scopeType, 'dojo'), inArray(s.committees.scopeId, scopes.dojos)));
  }
  if (!clauses.length) return sql`false`;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * Official documents and partner agreements are NATIONAL artefacts: neither
 * table carries a scope column, so there is no state edition of the
 * constitution. `assertCanAnywhere` would let any future state-scoped
 * `content:write` binding publish one; the empty resource requires a national
 * binding. No role holds scoped `content:write` today, and this fails closed on
 * the day one does.
 */
function assertNationalContentWrite(principal: Principal): void {
  assertCan(principal, 'content:write', {});
}

async function loadCommittee(db: DB, committeeId: number) {
  const row = (await db.select().from(s.committees).where(eq(s.committees.id, committeeId)).limit(1))[0];
  if (!row) throw new GovernanceError('unknown_committee', 'Unknown committee');
  return row;
}

// ─── Committees and office ──────────────────────────────────────────────────

export interface NewCommittee {
  code: string;
  name: string;
  kind: string;                       // executive | technical | standing | ad_hoc
  remit?: string | null;
  /** The instrument that created it — a constitution clause, a resolution. */
  constitutedUnder?: string | null;
  scopeType?: 'national' | 'state' | 'district' | 'dojo';
  scopeId?: number | null;
  parentCommitteeId?: number | null;
  /**
   * The quorum the federation has set for this committee, if it has set one.
   * Omitted means UNSET, which is not the same as zero and is never guessed.
   */
  quorum?: number | null;
}

export async function constituteCommittee(db: DB, ctx: AuditContext, input: NewCommittee) {
  const scopeType = input.scopeType ?? 'national';
  assertCan(ctx.principal, 'unit:write', committeeResource({ scopeType, scopeId: input.scopeId ?? null }));

  if (input.quorum != null && (!Number.isInteger(input.quorum) || input.quorum < 1)) {
    throw new GovernanceError('bad_quorum', 'A quorum, when set, must be a whole number of at least one.');
  }

  let row;
  try {
    [row] = await db.insert(s.committees).values({
      code: input.code,
      name: input.name,
      kind: input.kind,
      remit: input.remit ?? null,
      constitutedUnder: input.constitutedUnder ?? null,
      scopeType,
      scopeId: input.scopeId ?? null,
      parentCommitteeId: input.parentCommitteeId ?? null,
      quorum: input.quorum ?? null,
      active: true,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GovernanceError('duplicate_committee', 'A committee with that code already exists.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'committee',
    entityId: row.id,
    action: 'create',
    newValue: { code: row.code, name: row.name, scopeType, scopeId: row.scopeId, quorum: row.quorum },
  });
  return row;
}

/**
 * Set or change a committee's quorum.
 *
 * Separate from constitution because a quorum usually arrives later, with the
 * bye-law that fixes it. Both values are audited: a challenged decision needs to
 * show what the quorum was on the day, not what it is now.
 */
export async function setCommitteeQuorum(
  db: DB,
  ctx: AuditContext,
  input: { committeeId: number; quorum: number | null; authority: string }
) {
  const committee = await loadCommittee(db, input.committeeId);
  assertCan(ctx.principal, 'unit:write', committeeResource(committee));

  if (!input.authority?.trim()) {
    throw new GovernanceError(
      'authority_required',
      'Setting a quorum requires the instrument that fixes it — a bye-law clause or a resolution.'
    );
  }
  if (input.quorum != null && (!Number.isInteger(input.quorum) || input.quorum < 1)) {
    throw new GovernanceError('bad_quorum', 'A quorum, when set, must be a whole number of at least one.');
  }

  await db.update(s.committees).set({ quorum: input.quorum })
    .where(eq(s.committees.id, input.committeeId));

  await writeAudit(db, { ...ctx, authority: input.authority }, {
    entityType: 'committee',
    entityId: input.committeeId,
    action: 'update',
    oldValue: { quorum: committee.quorum },
    newValue: { quorum: input.quorum },
  });
}

export interface AppointmentInput {
  committeeId: number;
  personId: number;
  office: string;                     // chair | secretary | member
  termFrom: string;
  termTo?: string | null;
  appointedUnder?: string | null;     // election, resolution, nomination
}

/**
 * Appoint a person to an office for a dated term.
 *
 * Nothing here limits how many people may hold an office at once, or how long a
 * term may run: both are constitutional matters. The one refusal is a genuine
 * data contradiction — the SAME person recorded in the SAME office on the SAME
 * committee over overlapping dates, which is a duplicate record rather than a
 * governance arrangement, and which would make `officeHoldersAt` return one
 * person twice.
 */
export async function appointToOffice(db: DB, ctx: AuditContext, input: AppointmentInput) {
  const committee = await loadCommittee(db, input.committeeId);
  assertCan(ctx.principal, 'unit:write', committeeResource(committee));

  assertIsoDate(input.termFrom, 'termFrom');
  if (input.termTo) {
    assertIsoDate(input.termTo, 'termTo');
    if (input.termTo < input.termFrom) {
      throw new GovernanceError('bad_dates', 'A term cannot end before it begins.');
    }
  }

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new GovernanceError('unknown_person', 'Unknown person');

  const clash = (await db.select().from(s.committeeAppointments).where(and(
    eq(s.committeeAppointments.committeeId, input.committeeId),
    eq(s.committeeAppointments.personId, input.personId),
    eq(s.committeeAppointments.office, input.office),
    ne(s.committeeAppointments.status, 'void'),
    or(isNull(s.committeeAppointments.termTo), gte(s.committeeAppointments.termTo, input.termFrom)),
    input.termTo ? lte(s.committeeAppointments.termFrom, input.termTo) : undefined,
  )).limit(1))[0];
  if (clash) {
    throw new GovernanceError(
      'overlapping_term',
      `That person already holds ${input.office} on this committee over an overlapping term (from ${clash.termFrom}${clash.termTo ? ` to ${clash.termTo}` : ', open-ended'}).`
    );
  }

  const [row] = await db.insert(s.committeeAppointments).values({
    committeeId: input.committeeId,
    personId: input.personId,
    office: input.office,
    termFrom: input.termFrom,
    termTo: input.termTo ?? null,
    appointedUnder: input.appointedUnder ?? null,
    status: 'active',
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'committee_appointment',
    entityId: row.id,
    action: 'create',
    newValue: {
      committeeId: input.committeeId, personId: input.personId, office: input.office,
      termFrom: input.termFrom, termTo: input.termTo ?? null, appointedUnder: input.appointedUnder ?? null,
    },
  });
  return row;
}

/**
 * End a term. The row is never deleted.
 *
 * Deleting would erase the fact that the person held the office, and every
 * decision they signed while holding it would become unexplainable. The term
 * end date is what a past-dated read uses; the status is only a convenience for
 * present-tense listings.
 */
export async function endAppointment(
  db: DB,
  ctx: AuditContext,
  input: { appointmentId: number; endedOn: string; reason: string }
) {
  const before = (await db.select().from(s.committeeAppointments)
    .where(eq(s.committeeAppointments.id, input.appointmentId)).limit(1))[0];
  if (!before) throw new GovernanceError('unknown_appointment', 'Unknown appointment');

  const committee = await loadCommittee(db, before.committeeId);
  assertCan(ctx.principal, 'unit:write', committeeResource(committee));

  assertIsoDate(input.endedOn, 'endedOn');
  if (!input.reason?.trim()) {
    throw new GovernanceError('reason_required', 'Ending a term requires a reason.');
  }
  // A term is ended ONCE. Re-ending it would move, in place, the very boundary
  // that decides who held office on a given day — every past-dated read would
  // silently change answer and the original date would survive only in the audit
  // log. A genuine correction voids the row (which excludes it at every date)
  // and records the true term afresh, so the correction is visible on the file.
  if (before.status === 'void') {
    throw new GovernanceError(
      'appointment_void',
      'That appointment was recorded in error and voided. A voided record is not given an end date.'
    );
  }
  if (before.status === 'ended') {
    throw new GovernanceError(
      'already_ended',
      `That term already ended on ${before.termTo}. Correct it by voiding the record and recording the true term, so the correction is visible rather than overwritten.`
    );
  }
  if (input.endedOn < before.termFrom) {
    throw new GovernanceError('bad_dates', 'A term cannot end before it began.');
  }

  await db.update(s.committeeAppointments).set({
    termTo: input.endedOn,
    status: 'ended',
    endedReason: input.reason.trim(),
  }).where(eq(s.committeeAppointments.id, input.appointmentId));

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'committee_appointment',
    entityId: input.appointmentId,
    action: 'revoke',
    oldValue: { termTo: before.termTo, status: before.status },
    newValue: { termTo: input.endedOn, status: 'ended' },
  });
}

/**
 * Mark an appointment as never having happened.
 *
 * Distinct from ending a term: an ended term WAS held and must keep answering
 * past-dated questions, whereas a voided row was entered in error and never
 * described reality. Voided rows are excluded from `officeHoldersAt` at every
 * date, and are still not deleted — the correction itself is part of the record.
 */
export async function voidAppointment(
  db: DB,
  ctx: AuditContext,
  input: { appointmentId: number; reason: string }
) {
  const before = (await db.select().from(s.committeeAppointments)
    .where(eq(s.committeeAppointments.id, input.appointmentId)).limit(1))[0];
  if (!before) throw new GovernanceError('unknown_appointment', 'Unknown appointment');

  const committee = await loadCommittee(db, before.committeeId);
  assertCan(ctx.principal, 'unit:write', committeeResource(committee));
  if (!input.reason?.trim()) {
    throw new GovernanceError('reason_required', 'Voiding an appointment requires a reason.');
  }

  await db.update(s.committeeAppointments)
    .set({ status: 'void', endedReason: input.reason.trim() })
    .where(eq(s.committeeAppointments.id, input.appointmentId));

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'committee_appointment',
    entityId: input.appointmentId,
    action: 'delete',
    oldValue: { status: before.status },
    newValue: { status: 'void' },
  });
}

export interface OfficeHolder {
  appointmentId: number;
  personId: number;
  fullName: string;
  federationId: string;
  office: string;
  termFrom: string;
  termTo: string | null;
  appointedUnder: string | null;
  status: string;
}

export interface OfficeHoldersAt {
  /**
   * `not_configured` — no such committee is on record at all.
   * `vacant`         — the committee exists and nobody held office on that date.
   * `filled`         — holders are listed.
   *
   * These are three different facts and a caller must never have to guess which
   * an empty list means.
   */
  status: 'not_configured' | 'vacant' | 'filled';
  asAt: string;
  committee: { id: number; code: string; name: string; kind: string; scopeType: string; scopeId: number | null } | null;
  holders: OfficeHolder[];
  note: string;
}

/**
 * Who held office on ANY date, past or present.
 *
 * The date range is the authority, NOT the status column: a term that ended in
 * 2027 must still answer "who chaired in 2026", and a status of `ended` says
 * nothing about 2026. Only rows explicitly voided as never-having-happened are
 * excluded.
 */
export async function officeHoldersAt(
  db: DB,
  committeeId: number,
  asAt: string = today()
): Promise<OfficeHoldersAt> {
  assertIsoDate(asAt, 'asAt');

  const committee = (await db.select().from(s.committees)
    .where(eq(s.committees.id, committeeId)).limit(1))[0];
  if (!committee) {
    return {
      status: 'not_configured',
      asAt,
      committee: null,
      holders: [],
      note: 'No committee with that identifier is on record. This is not a report that the committee is vacant.',
    };
  }

  const rows = await db
    .select({
      appointmentId: s.committeeAppointments.id,
      personId: s.committeeAppointments.personId,
      fullName: s.persons.fullName,
      federationId: s.persons.federationId,
      office: s.committeeAppointments.office,
      termFrom: s.committeeAppointments.termFrom,
      termTo: s.committeeAppointments.termTo,
      appointedUnder: s.committeeAppointments.appointedUnder,
      status: s.committeeAppointments.status,
    })
    .from(s.committeeAppointments)
    .innerJoin(s.persons, eq(s.committeeAppointments.personId, s.persons.id))
    .where(and(
      eq(s.committeeAppointments.committeeId, committeeId),
      ne(s.committeeAppointments.status, 'void'),
      lte(s.committeeAppointments.termFrom, asAt),
      or(isNull(s.committeeAppointments.termTo), gte(s.committeeAppointments.termTo, asAt)),
    ))
    .orderBy(asc(s.committeeAppointments.office), asc(s.committeeAppointments.termFrom));

  const summary = {
    id: committee.id, code: committee.code, name: committee.name,
    kind: committee.kind, scopeType: committee.scopeType, scopeId: committee.scopeId,
  };

  if (rows.length === 0) {
    return {
      status: 'vacant',
      asAt,
      committee: summary,
      holders: [],
      note: `${committee.name} is on record, and no appointment to it was in force on ${asAt}.`,
    };
  }

  return {
    status: 'filled',
    asAt,
    committee: summary,
    holders: rows as OfficeHolder[],
    note: `${rows.length} office holder(s) in post on ${asAt}.`,
  };
}

/**
 * Every appointment ever made to a committee, current and ended alike.
 *
 * Gated, unlike `officeHoldersAt`, because this carries `endedReason` — and the
 * reason a term ended can be "removed following a disciplinary finding". Who
 * holds office is public; why someone stopped holding it is not.
 */
export async function committeeRoster(db: DB, principal: Principal, committeeId: number) {
  const committee = await loadCommittee(db, committeeId);
  assertCan(principal, 'unit:read', committeeResource(committee));

  return db
    .select({
      appointmentId: s.committeeAppointments.id,
      personId: s.committeeAppointments.personId,
      fullName: s.persons.fullName,
      office: s.committeeAppointments.office,
      termFrom: s.committeeAppointments.termFrom,
      termTo: s.committeeAppointments.termTo,
      status: s.committeeAppointments.status,
      appointedUnder: s.committeeAppointments.appointedUnder,
      endedReason: s.committeeAppointments.endedReason,
    })
    .from(s.committeeAppointments)
    .innerJoin(s.persons, eq(s.committeeAppointments.personId, s.persons.id))
    .where(eq(s.committeeAppointments.committeeId, committeeId))
    .orderBy(desc(s.committeeAppointments.termFrom), asc(s.committeeAppointments.id));
}

// ─── Documents ──────────────────────────────────────────────────────────────

export interface NewDocument {
  code: string;                       // MMAKF-DOC-CONST
  title: string;
  category: string;                   // constitution | byelaw | policy | regulation | form
  summary?: string | null;
  issuingBody?: string;
  classification?: (typeof s.dataClass.enumValues)[number];
}

/** Register the document itself. Versions carry the content; this carries none. */
export async function registerDocument(db: DB, ctx: AuditContext, input: NewDocument) {
  assertNationalContentWrite(ctx.principal);

  let row;
  try {
    [row] = await db.insert(s.officialDocuments).values({
      code: input.code,
      title: input.title,
      category: input.category,
      summary: input.summary ?? null,
      issuingBody: input.issuingBody ?? 'MMAKF',
      classification: input.classification ?? 'public',
      active: true,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GovernanceError('duplicate_document', 'A document with that code is already registered.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'official_document',
    entityId: row.id,
    action: 'create',
    newValue: { code: row.code, title: row.title, category: row.category },
  });
  return row;
}

/**
 * What is being published. One of `bytes` or `bodyMarkdown` is required — the
 * checksum is the point of the exercise, and there is nothing to hash without it.
 */
export interface DocumentContent {
  /** The exact file as published. Hashed byte for byte. */
  bytes?: Uint8Array;
  bodyMarkdown?: string;
  fileUrl?: string | null;
  fileContentType?: string | null;
}

/**
 * SHA-256 over the published artefact.
 *
 * `bytes` wins when both are given: the file is what the reader downloads, and
 * hashing a Markdown transcription of it would certify the wrong thing.
 */
function contentDigest(content: DocumentContent): { sha256: string; sizeBytes: number } | null {
  if (content.bytes && content.bytes.length > 0) {
    const buf = Buffer.from(content.bytes);
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length };
  }
  if (typeof content.bodyMarkdown === 'string' && content.bodyMarkdown.length > 0) {
    const buf = Buffer.from(content.bodyMarkdown, 'utf8');
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length };
  }
  return null;
}

export interface PublishInput {
  documentCode: string;
  version: string;                    // "1.0", "2026-01"
  content: DocumentContent;
  effectiveFrom: string;
  effectiveTo?: string | null;
  approvedByCommitteeId?: number | null;
  approvedByPersonId?: number | null;
  approvedOn?: string | null;
  approvedUnder?: string | null;      // the resolution that adopted it
}

export interface PublishResult {
  version: any;
  sha256: string;
  /** The version this one closed, if any. Its CONTENT was not touched. */
  supersededVersionId: number | null;
  supersededEffectiveTo: string | null;
  note: string;
}

/**
 * Publish a version, hash it, and supersede whatever was in force before it.
 *
 * THE INVARIANT: a published version is never edited and never deleted. What
 * this function writes to the version it supersedes is its `status` and the
 * CLOSING DATE of its effective window — facts about WHEN it applied, not about
 * WHAT IT SAID. Every content column (`bodyMarkdown`, `fileUrl`, `fileSha256`,
 * `fileSizeBytes`) on the older row is left exactly as published, because a
 * rule that applied in 2026 must remain readable in the form it had in 2026.
 *
 * `effectiveFrom` is mandatory: `currentVersion()` resolves by effective date,
 * and a published version without one could never be resolved to any date. It
 * would be a document that exists but never applies.
 */
export async function publishVersion(
  db: DB,
  ctx: AuditContext,
  input: PublishInput,
  now: Date = new Date()
): Promise<PublishResult> {
  assertNationalContentWrite(ctx.principal);

  const doc = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.code, input.documentCode.trim())).limit(1))[0];
  if (!doc) throw new GovernanceError('unknown_document', 'Unknown document code');

  if (!input.effectiveFrom) {
    throw new GovernanceError(
      'effective_from_required',
      'A published version must state the date it takes effect, or it can never be resolved to any date.'
    );
  }
  assertIsoDate(input.effectiveFrom, 'effectiveFrom');
  if (input.effectiveTo) {
    assertIsoDate(input.effectiveTo, 'effectiveTo');
    if (input.effectiveTo < input.effectiveFrom) {
      throw new GovernanceError('bad_dates', 'A version cannot cease to have effect before it takes effect.');
    }
  }

  const digest = contentDigest(input.content);
  if (!digest) {
    throw new GovernanceError(
      'no_content',
      'A version can only be published with the content or the file it publishes. Without it there is nothing to checksum, and the document could later be swapped undetectably.'
    );
  }

  // The version in force immediately before this one takes effect. Superseded
  // rows are included: a chain of past versions is normal, and the newest of
  // them is the one this publication closes.
  const prior = (await db.select().from(s.documentVersions).where(and(
    eq(s.documentVersions.documentId, doc.id),
    inArray(s.documentVersions.status, ['published', 'superseded']),
    isNotNull(s.documentVersions.effectiveFrom),
    lt(s.documentVersions.effectiveFrom, input.effectiveFrom),
  )).orderBy(desc(s.documentVersions.effectiveFrom), desc(s.documentVersions.id)).limit(1))[0];

  // The version that already takes effect AFTER this one. A back-dated
  // publication — a version entered late, with its real effective date — must
  // not be given an open-ended window, or two versions would claim the same
  // dates and "which rule applied" would depend on a tie-break. The window
  // closes the day before the next one begins; an explicit `effectiveTo` is
  // narrowed by this, never widened.
  const next = (await db.select().from(s.documentVersions).where(and(
    eq(s.documentVersions.documentId, doc.id),
    inArray(s.documentVersions.status, ['published', 'superseded']),
    isNotNull(s.documentVersions.effectiveFrom),
    gt(s.documentVersions.effectiveFrom, input.effectiveFrom),
  )).orderBy(asc(s.documentVersions.effectiveFrom), asc(s.documentVersions.id)).limit(1))[0];

  let effectiveTo: string | null = input.effectiveTo ?? null;
  if (next) {
    const closeOn = dayBefore(next.effectiveFrom);
    effectiveTo = effectiveTo && effectiveTo < closeOn ? effectiveTo : closeOn;
  }

  let row;
  try {
    [row] = await db.insert(s.documentVersions).values({
      documentId: doc.id,
      version: input.version,
      status: 'published',
      fileUrl: input.content.fileUrl ?? null,
      fileSizeBytes: digest.sizeBytes,
      fileContentType: input.content.fileContentType ?? (input.content.bytes ? null : 'text/markdown'),
      fileSha256: digest.sha256,
      bodyMarkdown: input.content.bodyMarkdown ?? null,
      effectiveFrom: input.effectiveFrom,
      effectiveTo,
      approvedByCommitteeId: input.approvedByCommitteeId ?? null,
      approvedByPersonId: input.approvedByPersonId ?? null,
      approvedOn: input.approvedOn ?? null,
      approvedUnder: input.approvedUnder ?? null,
      supersedesVersionId: prior?.id ?? null,
      publishedAt: now,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GovernanceError(
        'duplicate_version',
        `Version ${input.version} of ${input.documentCode} already exists. A published version is never re-issued under the same number; publish a new version instead.`
      );
    }
    throw err;
  }

  let supersededEffectiveTo: string | null = null;
  if (prior) {
    const closeOn = dayBefore(input.effectiveFrom);
    // Only narrow the window, never widen it: if the federation already closed
    // that version earlier, that earlier date is the fact of record.
    supersededEffectiveTo = prior.effectiveTo && prior.effectiveTo < closeOn ? prior.effectiveTo : closeOn;
    await db.update(s.documentVersions)
      .set({ status: 'superseded', effectiveTo: supersededEffectiveTo })
      .where(eq(s.documentVersions.id, prior.id));

    await writeAudit(db, ctx, {
      entityType: 'document_version',
      entityId: prior.id,
      action: 'update',
      oldValue: { status: prior.status, effectiveTo: prior.effectiveTo },
      newValue: { status: 'superseded', effectiveTo: supersededEffectiveTo, supersededBy: row.id },
    });
  }

  // `currentVersionId` is a convenience pointer for present-tense reads only.
  // A version dated into the future must not claim it, and neither must a
  // back-dated one that something newer already supersedes: the authoritative
  // answer for any date comes from currentVersion(), which resolves by dates.
  if (input.effectiveFrom <= today(now) && !next) {
    await db.update(s.officialDocuments)
      .set({ currentVersionId: row.id })
      .where(eq(s.officialDocuments.id, doc.id));
  }

  await writeAudit(db, ctx, {
    entityType: 'document_version',
    entityId: row.id,
    action: 'finalize',
    oldValue: prior ? { previousVersion: prior.version, previousVersionId: prior.id } : null,
    newValue: {
      documentCode: doc.code, version: row.version, sha256: digest.sha256,
      effectiveFrom: input.effectiveFrom, approvedUnder: input.approvedUnder ?? null,
    },
  });

  return {
    version: row,
    sha256: digest.sha256,
    supersededVersionId: prior?.id ?? null,
    supersededEffectiveTo,
    note: prior
      ? `Version ${row.version} takes effect ${input.effectiveFrom}. Version ${prior.version} is superseded and remains readable as published.`
      : `Version ${row.version} takes effect ${input.effectiveFrom}. It is the first published version of ${doc.code}.`,
  };
}

/**
 * Gate a read on the document's own classification.
 *
 * `classification` sits on the document for a reason: a restricted procedure
 * must not become readable by an anonymous caller merely because it lives in the
 * same table as the constitution. Public documents — the constitution, the
 * bye-laws, the published policies — stay open to everyone, which is the point
 * of publishing them.
 *
 * The gate is coarse: `content:read`, which every signed-in role holds. A
 * finer mapping from classification to authority belongs with the
 * `governance:read` action that `src/lib/rbac.ts` does not yet have. Coarse and
 * applied beats fine and skipped.
 */
function assertMayReadDocument(
  doc: { classification: string; code: string },
  principal?: Principal | null
): void {
  if (doc.classification === 'public') return;
  assertCanAnywhere(principal ?? null, 'content:read');
}

export interface VersionResolution {
  /**
   * `document_not_registered` — no such document code.
   * `none_in_force`          — the document exists, nothing applied on that date.
   * `in_force`               — the version that governed that date.
   */
  status: 'document_not_registered' | 'none_in_force' | 'in_force';
  documentCode: string;
  asOf: string;
  version: any | null;
  note: string;
}

/**
 * Which version governed a given date.
 *
 * Resolved by effective dates, never by `currentVersionId`, so a question about
 * a past date gets the version that actually applied then — including one long
 * since superseded. That is the whole point of keeping them.
 */
export async function currentVersion(
  db: DB,
  documentCode: string,
  asOfDate: string = today(),
  principal?: Principal | null
): Promise<VersionResolution> {
  assertIsoDate(asOfDate, 'asOfDate');
  const code = documentCode.trim();

  const doc = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.code, code)).limit(1))[0];
  if (doc) assertMayReadDocument(doc, principal);
  if (!doc) {
    return {
      status: 'document_not_registered',
      documentCode: code,
      asOf: asOfDate,
      version: null,
      note: 'No document with that code is registered. This is not a report that the federation has no such rule; it is a report that none is on record here.',
    };
  }

  const row = (await db.select().from(s.documentVersions).where(and(
    eq(s.documentVersions.documentId, doc.id),
    inArray(s.documentVersions.status, ['published', 'superseded']),
    isNotNull(s.documentVersions.effectiveFrom),
    lte(s.documentVersions.effectiveFrom, asOfDate),
    or(isNull(s.documentVersions.effectiveTo), gte(s.documentVersions.effectiveTo, asOfDate)),
  )).orderBy(desc(s.documentVersions.effectiveFrom), desc(s.documentVersions.id)).limit(1))[0];

  if (!row) {
    return {
      status: 'none_in_force',
      documentCode: code,
      asOf: asOfDate,
      version: null,
      note: `${doc.title} is registered, and no version of it was in force on ${asOfDate}.`,
    };
  }

  return {
    status: 'in_force',
    documentCode: code,
    asOf: asOfDate,
    version: row,
    note: `Version ${row.version}, in force from ${row.effectiveFrom}${row.effectiveTo ? ` to ${row.effectiveTo}` : ' with no end date recorded'}.`,
  };
}

/**
 * Every version of a document, newest first. Superseded ones included.
 *
 * A caller WITHOUT `content:read` sees only versions that ever had force. A
 * document being public does not make the federation's unadopted working text
 * public: a `draft` or `under_review` amendment to the constitution is a
 * proposal, and serving it beside the version in force invites it to be read as
 * the rule. Authorised readers see the whole chain, drafts included.
 */
export async function documentHistory(db: DB, documentCode: string, principal?: Principal | null) {
  const doc = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.code, documentCode.trim())).limit(1))[0];
  if (!doc) throw new GovernanceError('unknown_document', 'Unknown document code');
  assertMayReadDocument(doc, principal);

  const privileged = canAnywhere(principal ?? null, 'content:read');
  const where = privileged
    ? eq(s.documentVersions.documentId, doc.id)
    : and(
      eq(s.documentVersions.documentId, doc.id),
      inArray(s.documentVersions.status, ['published', 'superseded', 'withdrawn', 'archived']),
    );

  return db.select().from(s.documentVersions)
    .where(where)
    .orderBy(desc(s.documentVersions.effectiveFrom), desc(s.documentVersions.id));
}

export interface IntegrityResult {
  /**
   * `verified`             — the content presented hashes to what was published.
   * `mismatch`             — it does not. The file has been altered or swapped.
   * `no_checksum_recorded` — nothing to compare against. NOT a pass.
   * `unknown_version`      — no such version.
   */
  status: 'verified' | 'mismatch' | 'no_checksum_recorded' | 'unknown_version';
  versionId: number;
  recordedSha256: string | null;
  computedSha256: string | null;
  note: string;
}

/**
 * Check a file against the checksum stored when it was published.
 *
 * A missing checksum reports as `no_checksum_recorded` and never as verified.
 * Treating "we have nothing to compare against" as a pass is precisely how a
 * swapped document survives an integrity check.
 */
export async function verifyDocumentIntegrity(
  db: DB,
  versionId: number,
  content: DocumentContent,
  principal?: Principal | null
): Promise<IntegrityResult> {
  const row = (await db.select().from(s.documentVersions)
    .where(eq(s.documentVersions.id, versionId)).limit(1))[0];
  if (!row) {
    return {
      status: 'unknown_version', versionId, recordedSha256: null, computedSha256: null,
      note: 'No such document version.',
    };
  }

  // A checksum check is an ORACLE: anyone who may ask "does this text hash to
  // what you published?" can confirm a guess at a confidential document without
  // ever being shown it, and the recorded digest is returned besides. The
  // document's classification therefore gates this exactly as it gates a read.
  const parent = (await db.select().from(s.officialDocuments)
    .where(eq(s.officialDocuments.id, row.documentId)).limit(1))[0];
  if (parent) assertMayReadDocument(parent, principal);

  const digest = contentDigest(content);
  const computed = digest?.sha256 ?? null;

  if (!row.fileSha256) {
    return {
      status: 'no_checksum_recorded', versionId, recordedSha256: null, computedSha256: computed,
      note: `Version ${row.version} carries no checksum, so this file cannot be proved to be the one published. This is not a pass.`,
    };
  }
  if (!computed) {
    return {
      status: 'mismatch', versionId, recordedSha256: row.fileSha256, computedSha256: null,
      note: 'No content was presented to check against the recorded checksum.',
    };
  }

  // Constant-time compare. Both digests are 32 bytes, so the lengths always
  // agree and timingSafeEqual cannot throw here.
  const match = crypto.timingSafeEqual(Buffer.from(row.fileSha256, 'hex'), Buffer.from(computed, 'hex'));

  return {
    status: match ? 'verified' : 'mismatch',
    versionId,
    recordedSha256: row.fileSha256,
    computedSha256: computed,
    note: match
      ? `Version ${row.version} matches the checksum recorded when it was published.`
      : `CHECKSUM MISMATCH. The file presented is not the file published as version ${row.version}.`,
  };
}

// ─── Meetings ───────────────────────────────────────────────────────────────

export interface OpenMeetingInput {
  code: string;
  committeeId?: number | null;
  title: string;
  kind: string;                       // agm | egm | executive | committee
  heldOn: string;
  venue?: string | null;
  chairPersonId?: number | null;
  noticeIssuedOn?: string | null;
}

export interface OpenMeetingResult {
  meeting: any;
  /** False when the committee has no quorum on record. Never guessed at. */
  quorumConfigured: boolean;
  quorumRequired: number | null;
  note: string;
}

/**
 * Open a meeting, freezing the quorum the federation has configured for the
 * committee AS AT the day it is held.
 *
 * Frozen deliberately: if the bye-laws later change the quorum, this meeting
 * must still be judged against the number that applied on the day. When the
 * committee has no quorum on record, `quorumRequired` stays NULL and the result
 * says so — it is not filled in from a plausible-looking default, and it is not
 * silently treated as zero, which would make every meeting quorate.
 */
export async function openMeeting(
  db: DB,
  ctx: AuditContext,
  input: OpenMeetingInput,
  now: Date = new Date()
): Promise<OpenMeetingResult> {
  assertIsoDate(input.heldOn, 'heldOn');

  let committee: any = null;
  if (input.committeeId != null) {
    committee = await loadCommittee(db, input.committeeId);
    assertCan(ctx.principal, 'unit:write', committeeResource(committee));
  } else {
    // A meeting of no committee — an AGM, an EGM — is a national act.
    assertCan(ctx.principal, 'unit:write', {});
  }

  let row;
  try {
    [row] = await db.insert(s.meetings).values({
      code: input.code,
      committeeId: input.committeeId ?? null,
      title: input.title,
      kind: input.kind,
      status: 'held',
      heldOn: input.heldOn,
      startedAt: now,
      venue: input.venue ?? null,
      noticeIssuedOn: input.noticeIssuedOn ?? null,
      quorumRequired: committee?.quorum ?? null,
      chairPersonId: input.chairPersonId ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GovernanceError('duplicate_meeting', 'A meeting with that code already exists.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'meeting',
    entityId: row.id,
    action: 'create',
    newValue: {
      code: row.code, committeeId: row.committeeId, heldOn: row.heldOn,
      quorumRequired: row.quorumRequired,
    },
  });

  const quorumConfigured = row.quorumRequired != null;
  return {
    meeting: row,
    quorumConfigured,
    quorumRequired: row.quorumRequired ?? null,
    note: quorumConfigured
      ? `Quorum for this meeting is ${row.quorumRequired}, as configured for the committee.`
      : 'No quorum is configured for this committee. Attendance will be recorded, and whether the meeting was quorate cannot be determined from the record.',
  };
}

export interface AttendanceInput {
  meetingId: number;
  personId: number;
  role?: string | null;
  present?: boolean;
  apologies?: boolean;
  /** This attendee holds a proxy for someone who is absent. */
  proxyForPersonId?: number | null;
}

/**
 * Record one person's attendance. Re-recording corrects that person's own row
 * and no one else's.
 *
 * Two things this has to get right. The unique key on (meeting, person) forces
 * an in-place upsert, so the AUDIT must carry what the row said before or a
 * correction leaves no trace at all. And a quoracy finding is DERIVED from this
 * sheet: changing the sheet after the room was counted is the one way a stored
 * value in this module can drift away from its own evidence.
 */
export async function recordAttendance(db: DB, ctx: AuditContext, input: AttendanceInput) {
  const meeting = (await db.select().from(s.meetings)
    .where(eq(s.meetings.id, input.meetingId)).limit(1))[0];
  if (!meeting) throw new GovernanceError('unknown_meeting', 'Unknown meeting');

  if (meeting.committeeId != null) {
    assertCan(ctx.principal, 'unit:write', committeeResource(await loadCommittee(db, meeting.committeeId)));
  } else {
    assertCan(ctx.principal, 'unit:write', {});
  }

  const present = input.present ?? true;
  const apologies = input.apologies ?? false;
  if (present && apologies) {
    throw new GovernanceError(
      'contradictory_attendance',
      'A person cannot be recorded as both present and having sent apologies.'
    );
  }
  if (input.proxyForPersonId != null && input.proxyForPersonId === input.personId) {
    throw new GovernanceError('self_proxy', 'A person cannot hold a proxy for themselves.');
  }

  const before = (await db.select().from(s.meetingAttendance).where(and(
    eq(s.meetingAttendance.meetingId, input.meetingId),
    eq(s.meetingAttendance.personId, input.personId),
  )).limit(1))[0] ?? null;

  const [row] = await db.insert(s.meetingAttendance).values({
    meetingId: input.meetingId,
    personId: input.personId,
    role: input.role ?? null,
    present,
    apologies,
    proxyForPersonId: input.proxyForPersonId ?? null,
  }).onConflictDoUpdate({
    target: [s.meetingAttendance.meetingId, s.meetingAttendance.personId],
    set: {
      role: input.role ?? null,
      present,
      apologies,
      proxyForPersonId: input.proxyForPersonId ?? null,
    },
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'meeting_attendance',
    entityId: row.id,
    action: before ? 'update' : 'create',
    oldValue: before
      ? { present: before.present, apologies: before.apologies, proxyForPersonId: before.proxyForPersonId, role: before.role }
      : null,
    newValue: {
      meetingId: input.meetingId, personId: input.personId, present, apologies,
      proxyForPersonId: input.proxyForPersonId ?? null, role: input.role ?? null,
    },
  });

  // The attendance sheet has changed under a quoracy finding that was derived
  // from it. The finding is INVALIDATED rather than silently recomputed:
  // counting the room is a deliberate act by someone who was in it, and
  // recomputing here would let this function quietly declare a meeting quorate.
  // Until someone counts again, `moveResolution` reports quoracy as NOT RECORDED
  // and every resolution is challengeable — fail closed. `quorum_required` is
  // left alone: it is the configuration frozen at the meeting, not a derived
  // value.
  if (meeting.quorumPresent != null || meeting.quorumMet != null) {
    await db.update(s.meetings)
      .set({ quorumPresent: null, quorumMet: null })
      .where(eq(s.meetings.id, input.meetingId));

    await writeAudit(db, ctx, {
      entityType: 'meeting',
      entityId: input.meetingId,
      action: 'update',
      oldValue: { quorumPresent: meeting.quorumPresent, quorumMet: meeting.quorumMet },
      newValue: {
        quorumPresent: null, quorumMet: null,
        invalidatedBecauseAttendanceChangedFor: input.personId,
      },
    });
  }

  return row;
}

export interface QuorumRecord {
  meetingId: number;
  /**
   * `met` / `not_met` — a quorum is configured and the headcount decides.
   * `not_configured`  — no quorum on record. NOT a finding either way.
   */
  status: 'met' | 'not_met' | 'not_configured';
  headcount: number;
  /** Proxies held by those present. Whether they count is not configured here. */
  proxiesHeld: number;
  apologies: number;
  quorumRequired: number | null;
  /** Where the requirement came from, so the figure is explainable. */
  quorumSource: 'meeting' | 'none';
  /**
   * A quorum that IS on record for the committee now but was not when this
   * meeting was opened, and is therefore NOT applied to it. Reported so the
   * refusal to apply it is visible rather than looking like an oversight.
   */
  committeeQuorumNotApplied: number | null;
  note: string;
}

/**
 * Count the room and record whether it was quorate.
 *
 * THE RULE THIS FUNCTION EXISTS FOR: a quorum is CONFIGURATION. When none is
 * configured, the headcount is recorded, `quorum_met` is left NULL, and the
 * result says the quorum was not configured. It does not say the meeting was
 * quorate, and it does not say it was inquorate — neither is known, and NULL is
 * the only honest value.
 *
 * Proxies are counted and reported but NOT added to the headcount. Whether a
 * proxy counts towards quorum is a constitutional question, and adding them
 * would silently answer it.
 */
export async function recordQuorum(
  db: DB,
  ctx: AuditContext,
  meetingId: number
): Promise<QuorumRecord> {
  const meeting = (await db.select().from(s.meetings)
    .where(eq(s.meetings.id, meetingId)).limit(1))[0];
  if (!meeting) throw new GovernanceError('unknown_meeting', 'Unknown meeting');

  const committee = meeting.committeeId != null ? await loadCommittee(db, meeting.committeeId) : null;
  assertCan(ctx.principal, 'unit:write', committee ? committeeResource(committee) : {});

  const attendance = await db.select().from(s.meetingAttendance)
    .where(eq(s.meetingAttendance.meetingId, meetingId));

  const presentRows = attendance.filter((a: any) => a.present);
  const headcount = presentRows.length;
  const proxiesHeld = presentRows.filter((a: any) => a.proxyForPersonId != null).length;
  const apologies = attendance.filter((a: any) => a.apologies).length;

  // ONLY the figure frozen on the meeting can judge it. The committee's current
  // quorum is deliberately NOT used as a fallback: `committees.quorum` carries
  // no date, so a number set today cannot be shown to have applied on the day,
  // and applying it would let a bye-law adopted in August decide whether a
  // meeting held in May was competent — in either direction. That is the same
  // retroactive judgement `openMeeting` freezes the figure to prevent, and an
  // unset quorum on the day stays unset. Unknown remains unknown.
  const quorumRequired: number | null = meeting.quorumRequired ?? null;
  const quorumSource: QuorumRecord['quorumSource'] = quorumRequired != null ? 'meeting' : 'none';
  const committeeQuorumNotApplied =
    quorumRequired == null && committee?.quorum != null ? committee.quorum : null;

  const status: QuorumRecord['status'] =
    quorumRequired == null ? 'not_configured' : headcount >= quorumRequired ? 'met' : 'not_met';

  await db.update(s.meetings).set({
    quorumRequired,
    quorumPresent: headcount,
    // NULL, not false, when unconfigured: false would assert a finding of
    // inquoracy that the federation never made.
    quorumMet: status === 'not_configured' ? null : status === 'met',
  }).where(eq(s.meetings.id, meetingId));

  await writeAudit(db, ctx, {
    entityType: 'meeting',
    entityId: meetingId,
    action: 'update',
    oldValue: { quorumPresent: meeting.quorumPresent, quorumMet: meeting.quorumMet },
    newValue: {
      quorumPresent: headcount, quorumRequired, quorumSource,
      committeeQuorumNotApplied,
      quorumMet: status === 'not_configured' ? null : status === 'met',
    },
  });

  const note =
    status === 'not_configured'
      ? `${headcount} present. No quorum is configured for this meeting, so whether it was quorate is NOT KNOWN — it is not recorded as met.${
        committeeQuorumNotApplied != null
          ? ` A quorum of ${committeeQuorumNotApplied} is now on record for the committee, but it was not when this meeting was opened and is NOT applied to it.`
          : ''
      }`
      : status === 'met'
        ? `${headcount} present against a quorum of ${quorumRequired}. Quorate.`
        : `${headcount} present against a quorum of ${quorumRequired}. NOT quorate — decisions taken are challengeable.`;

  return {
    meetingId, status, headcount, proxiesHeld, apologies,
    quorumRequired, quorumSource, committeeQuorumNotApplied, note,
  };
}

// ─── Resolutions ────────────────────────────────────────────────────────────

export interface MoveResolutionInput {
  meetingId: number;
  number: string;
  text: string;
  outcome: (typeof s.motionOutcome.enumValues)[number];
  movedByPersonId?: number | null;
  secondedByPersonId?: number | null;
  votesFor?: number | null;
  votesAgainst?: number | null;
  abstentions?: number | null;
  effectiveFrom?: string | null;
}

export interface ResolutionResult {
  resolution: any;
  quorum: {
    status: 'met' | 'not_met' | 'not_configured' | 'not_recorded';
    required: number | null;
    present: number | null;
  };
  /** True whenever quoracy is anything other than proven. Fail closed. */
  challengeable: boolean;
  flags: string[];
  note: string;
}

/**
 * Move a resolution and record its outcome.
 *
 * THE OUTCOME IS STATED BY THE MEETING, NOT COMPUTED HERE. Whether a motion
 * carries on a simple majority, a two-thirds majority or the chair's casting
 * vote is constitutional policy; deriving `carried` from `votesFor > votesAgainst`
 * would put an unapproved majority rule into the minute book. What this function
 * does instead is FLAG: it reports where the recorded numbers do not obviously
 * support the recorded outcome, and leaves the judgement to a reader.
 *
 * A resolution passed at an inquorate meeting is flagged, and so is one passed
 * at a meeting whose quoracy was never established. Both are challengeable, and
 * a challengeable decision has to be visible on the record rather than inferred
 * by whoever thinks to check the attendance sheet years later.
 */
export async function moveResolution(
  db: DB,
  ctx: AuditContext,
  input: MoveResolutionInput
): Promise<ResolutionResult> {
  const meeting = (await db.select().from(s.meetings)
    .where(eq(s.meetings.id, input.meetingId)).limit(1))[0];
  if (!meeting) throw new GovernanceError('unknown_meeting', 'Unknown meeting');

  const committee = meeting.committeeId != null ? await loadCommittee(db, meeting.committeeId) : null;
  assertCan(ctx.principal, 'unit:write', committee ? committeeResource(committee) : {});

  if (!input.text?.trim()) {
    throw new GovernanceError('text_required', 'A resolution must record the words that were moved.');
  }
  for (const [field, value] of [
    ['votesFor', input.votesFor], ['votesAgainst', input.votesAgainst], ['abstentions', input.abstentions],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      throw new GovernanceError('bad_votes', `${field} must be a non-negative whole number.`);
    }
  }
  if (input.effectiveFrom) assertIsoDate(input.effectiveFrom, 'effectiveFrom');

  let row;
  try {
    [row] = await db.insert(s.resolutions).values({
      meetingId: input.meetingId,
      number: input.number,
      text: input.text.trim(),
      movedByPersonId: input.movedByPersonId ?? null,
      secondedByPersonId: input.secondedByPersonId ?? null,
      votesFor: input.votesFor ?? null,
      votesAgainst: input.votesAgainst ?? null,
      abstentions: input.abstentions ?? null,
      outcome: input.outcome,
      effectiveFrom: input.effectiveFrom ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GovernanceError('duplicate_resolution', 'That resolution number already exists for this meeting.');
    }
    throw err;
  }

  // Four states, not two. "Nobody counted the room" and "the room was too small"
  // are different failures and a reader has to be able to tell them apart.
  const quorumStatus: ResolutionResult['quorum']['status'] =
    meeting.quorumMet != null ? (meeting.quorumMet ? 'met' : 'not_met')
      : meeting.quorumRequired == null ? 'not_configured'
        : 'not_recorded';

  const flags: string[] = [];
  const carried = input.outcome === 'carried';

  if (quorumStatus === 'not_met') {
    flags.push(carried ? 'PASSED_AT_INQUORATE_MEETING' : 'TAKEN_AT_INQUORATE_MEETING');
  } else if (quorumStatus === 'not_configured') {
    flags.push('QUORUM_NOT_CONFIGURED');
  } else if (quorumStatus === 'not_recorded') {
    flags.push('QUORUM_NOT_RECORDED');
  }

  // An arithmetic observation, not a majority rule: we report that the numbers
  // as recorded do not show more votes for than against, and say nothing about
  // what threshold ought to have applied.
  if (carried && input.votesFor != null && input.votesAgainst != null && input.votesFor <= input.votesAgainst) {
    flags.push('VOTES_DO_NOT_SHOW_A_MAJORITY_FOR');
  }
  if (carried && input.movedByPersonId != null && input.secondedByPersonId == null) {
    flags.push('NO_SECONDER_RECORDED');
  }

  const challengeable = quorumStatus !== 'met';

  await writeAudit(db, ctx, {
    entityType: 'resolution',
    entityId: row.id,
    action: 'create',
    newValue: {
      meetingId: input.meetingId, number: input.number, outcome: input.outcome,
      votesFor: input.votesFor ?? null, votesAgainst: input.votesAgainst ?? null,
      abstentions: input.abstentions ?? null, quorumStatus, flags,
    },
  });

  const note =
    quorumStatus === 'met'
      ? `Resolution ${input.number} recorded as ${input.outcome} at a quorate meeting.`
      : quorumStatus === 'not_met'
        ? `Resolution ${input.number} recorded as ${input.outcome} at a meeting that was NOT quorate (${meeting.quorumPresent} present, ${meeting.quorumRequired} required). This decision is challengeable.`
        : quorumStatus === 'not_configured'
          ? `Resolution ${input.number} recorded as ${input.outcome}. No quorum is configured for this committee, so the meeting's competence to decide it cannot be shown from the record.`
          : `Resolution ${input.number} recorded as ${input.outcome}. Quoracy was never recorded for this meeting, so it cannot be shown from the record.`;

  return {
    resolution: row,
    quorum: { status: quorumStatus, required: meeting.quorumRequired ?? null, present: meeting.quorumPresent ?? null },
    challengeable,
    flags,
    note,
  };
}

// ─── Action items ───────────────────────────────────────────────────────────

export interface ActionItemInput {
  meetingId?: number | null;
  resolutionId?: number | null;
  description: string;
  ownerPersonId?: number | null;
  dueOn?: string | null;
  note?: string | null;
}

/**
 * Raise an action item.
 *
 * It must arise from a meeting or a resolution: an action item with neither has
 * no authority behind it and nobody can say who agreed to it. No default due
 * date and no default owner are supplied — an unowned or undated action is a
 * real and common failure of governance, and `overdueActions()` surfaces it as
 * such rather than hiding it behind a guessed value.
 */
export async function raiseActionItem(db: DB, ctx: AuditContext, input: ActionItemInput) {
  if (!input.description?.trim()) {
    throw new GovernanceError('description_required', 'An action item must say what is to be done.');
  }

  let meetingId = input.meetingId ?? null;
  if (input.resolutionId != null) {
    const res = (await db.select().from(s.resolutions)
      .where(eq(s.resolutions.id, input.resolutionId)).limit(1))[0];
    if (!res) throw new GovernanceError('unknown_resolution', 'Unknown resolution');
    meetingId = meetingId ?? res.meetingId;
  }
  if (meetingId == null) {
    throw new GovernanceError(
      'no_provenance',
      'An action item must arise from a meeting or a resolution, so the record shows who agreed to it.'
    );
  }

  const meeting = (await db.select().from(s.meetings).where(eq(s.meetings.id, meetingId)).limit(1))[0];
  if (!meeting) throw new GovernanceError('unknown_meeting', 'Unknown meeting');

  const committee = meeting.committeeId != null ? await loadCommittee(db, meeting.committeeId) : null;
  assertCan(ctx.principal, 'unit:write', committee ? committeeResource(committee) : {});
  if (input.dueOn) assertIsoDate(input.dueOn, 'dueOn');

  const [row] = await db.insert(s.actionItems).values({
    meetingId,
    resolutionId: input.resolutionId ?? null,
    description: input.description.trim(),
    ownerPersonId: input.ownerPersonId ?? null,
    dueOn: input.dueOn ?? null,
    status: 'open',
    note: input.note ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'action_item',
    entityId: row.id,
    action: 'create',
    newValue: {
      meetingId, resolutionId: input.resolutionId ?? null,
      ownerPersonId: input.ownerPersonId ?? null, dueOn: input.dueOn ?? null,
    },
  });
  return row;
}

export async function completeActionItem(
  db: DB,
  ctx: AuditContext,
  input: { actionItemId: number; completedOn: string; note?: string | null }
) {
  const before = (await db.select().from(s.actionItems)
    .where(eq(s.actionItems.id, input.actionItemId)).limit(1))[0];
  if (!before) throw new GovernanceError('unknown_action_item', 'Unknown action item');

  // SCOPE, not merely authority. `assertCanAnywhere` asks only whether the
  // caller holds `unit:write` somewhere, which every state administrator does —
  // it would let one of them close the national executive's actions. The item's
  // own meeting decides whose action it is.
  const meeting = before.meetingId != null
    ? (await db.select().from(s.meetings).where(eq(s.meetings.id, before.meetingId)).limit(1))[0]
    : null;
  const committee = meeting?.committeeId != null ? await loadCommittee(db, meeting.committeeId) : null;
  assertCan(ctx.principal, 'unit:write', committee ? committeeResource(committee) : {});

  assertIsoDate(input.completedOn, 'completedOn');
  if (before.status === 'completed') {
    throw new GovernanceError('already_completed', `That action was already completed on ${before.completedOn}.`);
  }

  await db.update(s.actionItems).set({
    status: 'completed',
    completedOn: input.completedOn,
    note: input.note ?? before.note,
  }).where(eq(s.actionItems.id, input.actionItemId));

  await writeAudit(db, ctx, {
    entityType: 'action_item',
    entityId: input.actionItemId,
    action: 'update',
    oldValue: { status: before.status },
    newValue: { status: 'completed', completedOn: input.completedOn },
  });
}

export interface OverdueReport {
  asAt: string;
  /**
   * `all`    — national reach; this is every open action in the federation.
   * `scoped` — LIMITED to the committees in the caller's scope. An empty report
   *            means nothing overdue THAT THEY MAY SEE, not nothing overdue.
   * `none`   — no visible scope at all; nothing is returned.
   */
  scope: 'all' | 'scoped' | 'none';
  overdue: Array<Record<string, unknown>>;
  /**
   * Open items with NO due date. They can never be overdue, so they are listed
   * separately rather than omitted — an action nobody dated is not an action
   * nobody has to do.
   */
  undated: Array<Record<string, unknown>>;
  /** Open items, dated or not, with no owner recorded. */
  unowned: Array<Record<string, unknown>>;
  note: string;
}

/**
 * Open action items past their due date, with the two gaps that hide work.
 *
 * An action item's `description` is minute-book text — "respond to the
 * complaint about the national coach" — so the scope filter runs IN SQL. Gating
 * on `assertCanAnywhere` alone and loading every row would hand a district
 * administrator the national executive's business, which is the exact shape of
 * leak this report would otherwise be a bulk export of.
 */
export async function overdueActions(
  db: DB,
  principal: Principal,
  asAt: string = today()
): Promise<OverdueReport> {
  assertCanAnywhere(principal, 'unit:read');
  assertIsoDate(asAt, 'asAt');

  const scopes = visibleScopes(principal, 'unit:read');
  const scope: OverdueReport['scope'] = scopes.kind === 'all' ? 'all' : scopes.kind === 'none' ? 'none' : 'scoped';
  if (scope === 'none') {
    return {
      asAt, scope, overdue: [], undated: [], unowned: [],
      note: 'No committee falls within your scope, so no action item is visible to you. This is not a report that none is outstanding.',
    };
  }

  const open = sql`${s.actionItems.status} NOT IN ('completed', 'cancelled')`;
  const scoped = committeeScopeCondition(principal, 'unit:read');

  const rows = await db
    .select({
      id: s.actionItems.id,
      meetingId: s.actionItems.meetingId,
      resolutionId: s.actionItems.resolutionId,
      description: s.actionItems.description,
      ownerPersonId: s.actionItems.ownerPersonId,
      dueOn: s.actionItems.dueOn,
      status: s.actionItems.status,
      meetingCode: s.meetings.code,
      meetingTitle: s.meetings.title,
    })
    .from(s.actionItems)
    .leftJoin(s.meetings, eq(s.actionItems.meetingId, s.meetings.id))
    .leftJoin(s.committees, eq(s.meetings.committeeId, s.committees.id))
    .where(scoped ? and(open, scoped) : open)
    .orderBy(asc(s.actionItems.dueOn), asc(s.actionItems.id));

  const owners = new Map<number, string>();
  const ownerIds = [...new Set(rows.map((r: any) => r.ownerPersonId).filter((n: any) => n != null))] as number[];
  if (ownerIds.length) {
    const people = await db.select({ id: s.persons.id, fullName: s.persons.fullName })
      .from(s.persons).where(inArray(s.persons.id, ownerIds));
    for (const p of people) owners.set(p.id, p.fullName);
  }

  const decorate = (r: any) => ({
    ...r,
    ownerName: r.ownerPersonId != null ? owners.get(r.ownerPersonId) ?? null : null,
    daysOverdue: r.dueOn
      ? Math.round((Date.parse(`${asAt}T00:00:00Z`) - Date.parse(`${r.dueOn}T00:00:00Z`)) / 86_400_000)
      : null,
  });

  const overdue = rows.filter((r: any) => r.dueOn && r.dueOn < asAt).map(decorate);
  const undated = rows.filter((r: any) => !r.dueOn).map(decorate);
  const unowned = rows.filter((r: any) => r.ownerPersonId == null).map(decorate);

  return {
    asAt,
    scope,
    overdue,
    undated,
    unowned,
    note: `${overdue.length} overdue at ${asAt}; ${undated.length} open with no due date; ${unowned.length} open with no owner.${
      scope === 'scoped' ? ' Limited to the committees within your scope.' : ''
    }`,
  };
}

// ─── Conflict of interest ───────────────────────────────────────────────────

export interface DeclareInterestInput {
  personId: number;
  kind: string;                       // family | coaching | financial | dojo | other
  description: string;
  relatedPersonId?: number | null;
  relatedDojoId?: number | null;
  declaredOn: string;
  validTo?: string | null;
}

/**
 * Record a declared interest.
 *
 * A declaration naming neither a person nor a dojo is accepted — a genuine
 * interest is not always reducible to a foreign key — but it is then treated by
 * `checkConflict` as matching EVERY context, because an interest that cannot be
 * narrowed cannot be ruled out.
 */
export async function declareInterest(db: DB, ctx: AuditContext, input: DeclareInterestInput) {
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new GovernanceError('unknown_person', 'Unknown person');

  assertCan(ctx.principal, 'person:write', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  if (!input.description?.trim()) {
    throw new GovernanceError(
      'description_required',
      'A declaration must describe the interest. A kind alone tells a panel nothing.'
    );
  }
  assertIsoDate(input.declaredOn, 'declaredOn');
  if (input.validTo) {
    assertIsoDate(input.validTo, 'validTo');
    if (input.validTo < input.declaredOn) {
      throw new GovernanceError('bad_dates', 'A declaration cannot expire before it was made.');
    }
  }

  const [row] = await db.insert(s.interestDeclarations).values({
    personId: input.personId,
    kind: input.kind,
    description: input.description.trim(),
    relatedPersonId: input.relatedPersonId ?? null,
    relatedDojoId: input.relatedDojoId ?? null,
    declaredOn: input.declaredOn,
    validTo: input.validTo ?? null,
    active: true,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'interest_declaration',
    entityId: row.id,
    action: 'create',
    newValue: {
      personId: input.personId, kind: input.kind,
      relatedPersonId: input.relatedPersonId ?? null, relatedDojoId: input.relatedDojoId ?? null,
      declaredOn: input.declaredOn,
    },
  });
  return row;
}

/** Withdraw a declaration. Never deleted — a past decision may have relied on it. */
export async function withdrawInterest(
  db: DB,
  ctx: AuditContext,
  input: { declarationId: number; endedOn: string; reason: string }
) {
  const before = (await db.select().from(s.interestDeclarations)
    .where(eq(s.interestDeclarations.id, input.declarationId)).limit(1))[0];
  if (!before) throw new GovernanceError('unknown_declaration', 'Unknown interest declaration');

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, before.personId)).limit(1))[0];
  assertCan(ctx.principal, 'person:write', {
    stateUnitId: person?.stateUnitId, districtUnitId: person?.districtUnitId, dojoId: person?.dojoId,
  });
  if (!input.reason?.trim()) {
    throw new GovernanceError('reason_required', 'Withdrawing a declaration requires a reason.');
  }
  assertIsoDate(input.endedOn, 'endedOn');

  await db.update(s.interestDeclarations)
    .set({ active: false, validTo: input.endedOn })
    .where(eq(s.interestDeclarations.id, input.declarationId));

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'interest_declaration',
    entityId: input.declarationId,
    action: 'revoke',
    oldValue: { active: before.active, validTo: before.validTo },
    newValue: { active: false, validTo: input.endedOn },
  });
}

/** What the decision is about — candidates, athletes, the subject of a case. */
export interface ConflictContext {
  personIds?: number[];
  dojoIds?: number[];
  /** The date of the decision. An interest is judged as at then, not as at now. */
  asAt?: string;
  /** Free text for the record: "examiner assignment", "selection", … */
  purpose?: string;
}

export interface MatchedInterest {
  declarationId: number;
  kind: string;
  description: string;
  relatedPersonId: number | null;
  relatedDojoId: number | null;
  declaredOn: string;
  validTo: string | null;
  /** Why it matched. `unspecific` means it names nothing and cannot be excluded. */
  matchedOn: 'related_person' | 'related_dojo' | 'unspecific';
}

export interface ConflictCheck {
  /**
   * `none_declared`     — this person has declared NOTHING in force at that
   *                       date. That is an ABSENCE OF A DECLARATION. It is not
   *                       a finding that no conflict exists.
   * `declared_no_match` — declarations exist; none touches this decision.
   * `conflict_found`    — the matching interests are returned.
   */
  status: 'none_declared' | 'declared_no_match' | 'conflict_found';
  personId: number;
  asAt: string;
  purpose: string | null;
  /** How many declarations were in force and therefore actually examined. */
  declarationsInForce: number;
  interests: MatchedInterest[];
  note: string;
}

/**
 * Check a person against a decision before they take part in it.
 *
 * Called before appointing an examiner, selecting a squad or seating a
 * disciplinary panel. THREE THINGS MAKE IT USEFUL RATHER THAN DECORATIVE:
 *
 *  · It returns the interests it FOUND, with their text, so a panel can weigh
 *    them. A boolean would tell nobody what the problem was.
 *  · "None declared" is a distinct result from "no conflict". This function can
 *    only ever report on what has been declared; it has no way to know what has
 *    not been. Reporting an empty check as "clear" would convert a person's
 *    silence into a clearance, which is exactly backwards.
 *  · A declaration naming nothing in particular matches everything. It cannot be
 *    ruled out, and an unruleable-out interest is a match. Fail closed.
 */
export async function checkConflict(
  db: DB,
  principal: Principal,
  personId: number,
  context: ConflictContext = {}
): Promise<ConflictCheck> {
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new GovernanceError('unknown_person', 'Unknown person');

  // `person:read_pii`, NOT `person:read`. A declaration is free text about
  // someone's family, money or dojo loyalties — "Parent of the candidate" is
  // precisely what `person:read` was never meant to carry, and that action is
  // held by MEMBER and ATHLETE, so a member could pull the register of anyone
  // their binding reaches. cases.ts makes the same choice for medical and
  // support data while no dedicated action exists.
  assertCan(principal, 'person:read_pii', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  const asAt = context.asAt ?? today();
  assertIsoDate(asAt, 'asAt');
  const purpose = context.purpose ?? null;

  // Dates decide, not `active`. A declaration withdrawn in June still stood in
  // March, and a panel seated in March relied on it — filtering on the `active`
  // flag would make the register lie about every date before the withdrawal.
  // `withdrawInterest` closes `validTo`, which is what makes that work; `active`
  // is only a convenience for present-tense listings. Filtering on dates alone
  // is also the fail-closed choice, since a row left active with a lapsed
  // window would otherwise be silently reinstated.
  const inForce = await db.select().from(s.interestDeclarations).where(and(
    eq(s.interestDeclarations.personId, personId),
    lte(s.interestDeclarations.declaredOn, asAt),
    or(isNull(s.interestDeclarations.validTo), gte(s.interestDeclarations.validTo, asAt)),
  )).orderBy(asc(s.interestDeclarations.declaredOn), asc(s.interestDeclarations.id));

  if (inForce.length === 0) {
    return {
      status: 'none_declared',
      personId,
      asAt,
      purpose,
      declarationsInForce: 0,
      interests: [],
      note: `No interest had been declared by this person as at ${asAt}. This records the ABSENCE OF A DECLARATION and is not a finding that no conflict exists.`,
    };
  }

  const personIds = new Set(context.personIds ?? []);
  const dojoIds = new Set(context.dojoIds ?? []);

  const interests: MatchedInterest[] = [];
  for (const d of inForce) {
    let matchedOn: MatchedInterest['matchedOn'] | null = null;
    if (d.relatedPersonId != null && personIds.has(d.relatedPersonId)) matchedOn = 'related_person';
    else if (d.relatedDojoId != null && dojoIds.has(d.relatedDojoId)) matchedOn = 'related_dojo';
    else if (d.relatedPersonId == null && d.relatedDojoId == null) matchedOn = 'unspecific';
    if (!matchedOn) continue;

    interests.push({
      declarationId: d.id,
      kind: d.kind,
      description: d.description,
      relatedPersonId: d.relatedPersonId,
      relatedDojoId: d.relatedDojoId,
      declaredOn: d.declaredOn,
      validTo: d.validTo,
      matchedOn,
    });
  }

  if (interests.length === 0) {
    return {
      status: 'declared_no_match',
      personId,
      asAt,
      purpose,
      declarationsInForce: inForce.length,
      interests: [],
      note: `${inForce.length} declaration(s) were in force at ${asAt}; none of them names anyone or any dojo involved in this decision. Only declared interests were examined.`,
    };
  }

  const unspecific = interests.filter((i) => i.matchedOn === 'unspecific').length;
  return {
    status: 'conflict_found',
    personId,
    asAt,
    purpose,
    declarationsInForce: inForce.length,
    interests,
    note: `${interests.length} declared interest(s) touch this decision as at ${asAt}${unspecific ? `, of which ${unspecific} name no specific person or dojo and so cannot be ruled out` : ''}.`,
  };
}

// ─── Partners ───────────────────────────────────────────────────────────────

export interface PartnerInput {
  name: string;
  kind: string;                       // sponsor | partner | supplier | institution
  tier?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  agreementFrom?: string | null;
  agreementTo?: string | null;
  deliverables?: unknown;
  status?: string;
  /** A partner appears publicly ONLY when the federation has said it may. */
  published?: boolean;
}

export async function recordPartner(db: DB, ctx: AuditContext, input: PartnerInput) {
  assertNationalContentWrite(ctx.principal);
  if (input.agreementFrom) assertIsoDate(input.agreementFrom, 'agreementFrom');
  if (input.agreementTo) assertIsoDate(input.agreementTo, 'agreementTo');
  if (input.agreementFrom && input.agreementTo && input.agreementTo < input.agreementFrom) {
    throw new GovernanceError('bad_dates', 'An agreement cannot end before it begins.');
  }

  const [row] = await db.insert(s.partners).values({
    name: input.name,
    kind: input.kind,
    tier: input.tier ?? null,
    logoUrl: input.logoUrl ?? null,
    websiteUrl: input.websiteUrl ?? null,
    contactName: input.contactName ?? null,
    contactEmail: input.contactEmail ?? null,
    agreementFrom: input.agreementFrom ?? null,
    agreementTo: input.agreementTo ?? null,
    deliverables: (input.deliverables ?? null) as any,
    status: input.status ?? 'prospective',
    published: input.published ?? false,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: row.id,
    action: 'create',
    newValue: { name: row.name, kind: row.kind, status: row.status, published: row.published },
  });
  return row;
}

/**
 * Partners the federation has agreed to display, whose agreement is in force.
 *
 * Two gates, both required: `published` is the federation's decision, and the
 * agreement dates are the fact. A lapsed sponsor left on a page is a claim the
 * federation is no longer entitled to make, so the date is checked as well as
 * the flag. No contact details are returned.
 */
export async function publishedPartners(db: DB, asAt: string = today()) {
  assertIsoDate(asAt, 'asAt');
  return db
    .select({
      name: s.partners.name, kind: s.partners.kind, tier: s.partners.tier,
      logoUrl: s.partners.logoUrl, websiteUrl: s.partners.websiteUrl,
      agreementFrom: s.partners.agreementFrom, agreementTo: s.partners.agreementTo,
    })
    .from(s.partners)
    .where(and(
      eq(s.partners.published, true),
      or(isNull(s.partners.agreementFrom), lte(s.partners.agreementFrom, asAt)),
      or(isNull(s.partners.agreementTo), gte(s.partners.agreementTo, asAt)),
    ))
    .orderBy(asc(s.partners.name));
}
