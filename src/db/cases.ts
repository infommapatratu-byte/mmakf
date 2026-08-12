// Cases — safeguarding, disciplinary, medical and support. Q-17.
//
// THIS IS THE MOST SENSITIVE MODULE IN THE SYSTEM. A leak here is not a bug, it
// is a harm. Three rules shape every function below.
//
//  1. READS ARE BUILT, NEVER FILTERED. Every projection a non-handler sees is
//     assembled field by field from an allowlist. Deleting fields from a row is
//     the opposite discipline: the day someone adds a column to
//     `safeguarding_cases`, a delete-list quietly starts leaking it and an
//     allowlist quietly does not.
//
//  2. THE GATES ARE NAMED ONCE. Each domain has a single exported-in-spirit
//     assert helper at the top of its section. No function re-derives who may
//     read a case, because the second copy is the one that drifts.
//
//  3. REPORTING IS NEVER GATED. A person who cannot log in, cannot be
//     identified, or holds no role at all must still be able to raise a
//     safeguarding concern. A permission check on the reporting path is a
//     child-protection failure wearing the costume of a security control.
//
// Nothing here decides federation policy. There is no pass mark for a
// disciplinary sanction, no retention period, no service standard, no rule that
// an injury lapses a clearance. Where MMAKF has not configured a rule, the rule
// is NOT APPLIED and the result says so.

import { and, desc, eq, sql } from 'drizzle-orm';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan, assertCanAnywhere, canAnywhere, type Action, type Principal } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class CaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CaseError';
    this.code = code;
  }
}

type DataClass = (typeof s.dataClass.enumValues)[number];
export type CaseKind = 'safeguarding' | 'disciplinary';

function today(on: Date = new Date()): string {
  return on.toISOString().slice(0, 10);
}

function isoOf(at: unknown): string {
  return at instanceof Date ? at.toISOString() : String(at ?? '');
}

function required(value: string | null | undefined, code: string, message: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new CaseError(code, message);
  return trimmed;
}

// Duplicated from grading.ts rather than exported from it: that module's copy is
// private, and cases.ts must not force a change to a file another workflow owns.
async function nextRef(db: DB, prefix: string, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix, year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, prefix), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF-${prefix}-${year}-${String((rows[0]?.next ?? 1) - 1).padStart(6, '0')}`;
}

// ─── The gates ──────────────────────────────────────────────────────────────
//
// `src/lib/rbac.ts` is the single policy choke point and is not this module's to
// edit, so each domain is gated on the closest EXISTING action. Where that is a
// stand-in it is named here, once, with the reasoning — never inlined at a call
// site where the next reader would take it for a considered choice.

/**
 * Safeguarding. `safeguarding:read` is held by SUPER_ADMIN and
 * SAFEGUARDING_OFFICER and by nobody else — deliberately, and including no
 * FEDERATION_ADMIN. National administrative authority is not child-protection
 * authority, and conflating them is how a case file ends up in an admin list.
 */
function assertSafeguardingRead(principal: Principal | null | undefined): void {
  // Safeguarding cases carry NO state/district/dojo columns, because a case may
  // concern someone who belongs to no unit. Scope therefore cannot narrow them,
  // so the gate is "holds it anywhere" and the role is granted nationally.
  assertCanAnywhere(principal, 'safeguarding:read');
}

function assertSafeguardingWrite(principal: Principal | null | undefined): void {
  assertCanAnywhere(principal, 'safeguarding:write');
}

/**
 * Disciplinary. No `discipline:*` action exists yet. Rather than invent one,
 * casework is gated on `membership:revoke` — the existing authority to withdraw
 * a member's standing, which is exactly what a sanction does. It is held only by
 * SUPER_ADMIN, FEDERATION_ADMIN and GENERAL_SECRETARY, so this errs narrow
 * rather than wide. Replace with a dedicated action when rbac.ts gains one.
 */
const DISCIPLINE: Action = 'membership:revoke';

/**
 * Medical. No `medical:*` action exists. Reads are gated on `person:read_pii`
 * and writes on `person:write`, both SCOPE-CHECKED against the subject's own
 * unit, so a dojo administrator reaches their own members and nobody else's.
 *
 * BE CLEAR ABOUT WHAT THIS STAND-IN DOES NOT DO. Scoping only binds the roles
 * that are scoped. `person:read_pii` is held NATIONALLY by FEDERATION_ADMIN,
 * GENERAL_SECRETARY and SAFEGUARDING_OFFICER, so today every one of them can
 * read any member's clinical record — which is precisely what a `medical:read`
 * action would exist to prevent. This is the one gate in this module that errs
 * WIDE, and it cannot be narrowed from here without re-implementing policy
 * locally, which is the thing rbac.ts exists to stop. It needs a real
 * `medical:read` / `medical:write` pair in rbac.ts, withheld from national
 * administration. Escalated, not worked around.
 */
const MEDICAL_READ: Action = 'person:read_pii';
const MEDICAL_WRITE: Action = 'person:write';

/**
 * The support desk. Tickets carry a contact email and phone, so handling one is
 * handling personal data; `person:read_pii` is the existing action that says so.
 * Raising a ticket is not gated — see raiseTicket.
 */
const SUPPORT_DESK: Action = 'person:read_pii';

async function subjectScope(db: DB, personId: number | null | undefined) {
  if (personId == null) return null;
  const p = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!p) throw new CaseError('unknown_person', 'Unknown person');
  return { stateUnitId: p.stateUnitId, districtUnitId: p.districtUnitId, dojoId: p.dojoId };
}

/** Is this principal the person the record is about? */
async function isSelf(db: DB, principal: Principal | null | undefined, personId: number | null): Promise<boolean> {
  if (!principal?.userId || personId == null) return false;
  const u = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, principal.userId)).limit(1))[0];
  return Boolean(u && u.personId === personId);
}

// ─── Case notes — APPEND-ONLY across every case kind ────────────────────────
//
// There is no editCaseNote and no deleteCaseNote in this module, and there must
// never be one. A case file whose notes can be rewritten cannot evidence what
// was known and when, which is the only reason the file exists. A correction is
// a NEW note that supersedes in narrative, never an edit.
//
// Absence of a code path is enforcement by convention. The database-level belt
// and braces — REVOKE UPDATE, DELETE ON case_notes — belongs in a migration and
// is flagged to the owner of drizzle/.

/** Notes at these classifications may be shown to a case subject. Nothing else. */
const SUBJECT_SHAREABLE: readonly DataClass[] = ['public', 'member'];

function assertNoteAccess(principal: Principal | null | undefined, caseKind: CaseKind): void {
  if (caseKind === 'safeguarding') assertSafeguardingRead(principal);
  else assertCanAnywhere(principal, DISCIPLINE);
}

export async function addCaseNote(
  db: DB,
  ctx: AuditContext,
  input: {
    caseKind: CaseKind | 'support';
    caseId: number;
    note: string;
    /** Defaults to `confidential`. Sharing with a subject requires marking it. */
    classification?: DataClass;
    authorPersonId?: number | null;
  },
  now: Date = new Date()
) {
  // The case must EXIST before anything is appended to its file. `case_id` is a
  // bare integer with no foreign key, so an unchecked write parks a note on an
  // id that nothing occupies yet — and `serial` hands that id out later, at
  // which point a brand new case is born already holding notes written before
  // it. In a child-protection file, "what was known and when" is the whole
  // point, so a note that predates its own case is not a tidiness problem.
  if (input.caseKind === 'safeguarding') {
    assertSafeguardingWrite(ctx.principal);
    await loadSafeguardingCase(db, input.caseId);
  } else if (input.caseKind === 'disciplinary') {
    assertCanAnywhere(ctx.principal, DISCIPLINE);
    await loadDisciplinaryCase(db, input.caseId);
  } else {
    // A support note is scoped like the ticket it hangs off, or it becomes the
    // way round assertTicketDesk.
    assertCanAnywhere(ctx.principal, SUPPORT_DESK);
    await assertTicketDesk(db, ctx.principal, await loadTicket(db, input.caseId));
  }

  const note = required(input.note, 'note_required', 'A case note cannot be empty.');

  const [row] = await db.insert(s.caseNotes).values({
    caseKind: input.caseKind,
    caseId: input.caseId,
    note,
    classification: input.classification ?? 'confidential',
    authorPersonId: input.authorPersonId ?? null,
    authorUserId: ctx.principal.userId ?? null,
    at: now,
  }).returning();

  return row;
}

export async function listCaseNotes(
  db: DB,
  principal: Principal,
  caseKind: CaseKind,
  caseId: number
) {
  assertNoteAccess(principal, caseKind);
  return db.select().from(s.caseNotes)
    .where(and(eq(s.caseNotes.caseKind, caseKind), eq(s.caseNotes.caseId, caseId)))
    .orderBy(s.caseNotes.at, s.caseNotes.id);
}

// ─── Safeguarding ───────────────────────────────────────────────────────────

/**
 * The principal an anonymous report is attributed to. Carries no user id, no
 * bindings and therefore no role — see the audit note in reportConcern.
 */
const ANONYMOUS_REPORTER: Principal = { userId: null, label: 'anonymous-reporter', bindings: [] };

/** The receipt a reporter gets. It contains no reporter data of any kind. */
export interface ConcernReceipt {
  id: number;
  caseNo: string;
  status: string;
  receivedOn: string;
  reporterAnonymous: boolean;
  note: string;
}

/**
 * Raise a safeguarding concern.
 *
 * DELIBERATELY UNGATED. There is no assertCan here and there must not be one:
 * the reporter may be a parent, a spectator, a child, or someone with no account
 * at all, and a concern refused for want of a role is a concern that does not
 * get raised.
 *
 * The subject is NOT required to be a member. `subjectDescription` carries a
 * free-text description precisely so a case can concern a child, a parent or an
 * unknown person who will never have a `persons` row.
 *
 * Anonymity is honoured at the point of storage, not at the point of display.
 * When `reporterAnonymous` is set, the name and contact are never written, and
 * the audit record is attributed to an anonymous actor rather than to the signed
 * in user — otherwise `audit_events.actor_user_id` would deanonymise a reporter
 * who was promised anonymity, and the promise would be a lie told in good faith.
 */
export async function reportConcern(
  db: DB,
  ctx: AuditContext,
  input: {
    concernSummary: string;
    concernKind?: string | null;
    receivedOn?: string;
    receivedVia?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
    reporterAnonymous?: boolean;
    subjectDescription?: string | null;
    subjectIsMinor?: boolean | null;
    subjectPersonId?: number | null;
    aboutPersonId?: number | null;
  },
  now: Date = new Date()
): Promise<ConcernReceipt> {
  const concernSummary = required(
    input.concernSummary,
    'summary_required',
    'A safeguarding concern must say what the concern is.'
  );

  const anonymous = input.reporterAnonymous === true;
  const receivedOn = input.receivedOn ?? today(now);
  const caseNo = await nextRef(db, 'SG', Number(receivedOn.slice(0, 4)));

  let row;
  try {
    [row] = await db.insert(s.safeguardingCases).values({
      caseNo,
      status: 'received',
      classification: 'highly_restricted',
      concernSummary,
      concernKind: input.concernKind ?? null,
      receivedOn,
      receivedVia: input.receivedVia ?? null,
      // An anonymous report stores NOTHING that identifies the reporter. A
      // reporter who needs to be contactable must choose not to be anonymous;
      // storing a contact behind an "anonymous" flag is the leak.
      reporterName: anonymous ? null : (input.reporterName ?? null),
      reporterContact: anonymous ? null : (input.reporterContact ?? null),
      reporterAnonymous: anonymous,
      subjectDescription: input.subjectDescription ?? null,
      subjectIsMinor: input.subjectIsMinor ?? null,
      subjectPersonId: input.subjectPersonId ?? null,
      aboutPersonId: input.aboutPersonId ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaseError('case_no_conflict', 'A case with that reference already exists.');
    }
    throw err;
  }

  // Anonymity is not only the actor id. `writeAudit` also stores a hash of the
  // caller's IP, the request id and the role off their first binding — and it
  // writes the SAME ip hash on every other action that person takes, so a single
  // self-join on `actor_ip_hash` names an "anonymous" reporter without breaking
  // the hash at all. The role narrows them further: "the only EXAMINER who filed
  // that week" is an identification.
  //
  // So the anonymous context is BUILT, not spread from `ctx`. Spreading carries
  // over every field the caller happened to set, including ones added to
  // AuditContext next year that nobody re-examines here.
  const auditCtx: AuditContext = anonymous ? { principal: ANONYMOUS_REPORTER } : ctx;

  await writeAudit(db, auditCtx, {
    entityType: 'safeguarding_case',
    entityId: row.id,
    action: 'create',
    // The concern text itself is not copied into the audit spine: audit is read
    // under `audit:read`, which is a far wider grant than `safeguarding:read`.
    newValue: { caseNo, status: 'received', receivedOn, reporterAnonymous: anonymous },
  });

  return {
    id: row.id,
    caseNo: row.caseNo,
    status: row.status,
    receivedOn: row.receivedOn,
    reporterAnonymous: anonymous,
    note: anonymous
      ? 'This concern was recorded without any reporter identity. It cannot be traced back to you, and you cannot be contacted about it.'
      : 'This concern has been recorded and will be handled by the federation’s safeguarding officer.',
  };
}

async function loadSafeguardingCase(db: DB, caseId: number) {
  const row = (await db.select().from(s.safeguardingCases)
    .where(eq(s.safeguardingCases.id, caseId)).limit(1))[0];
  if (!row) throw new CaseError('unknown_case', 'Unknown safeguarding case');
  return row;
}

/** Read a whole case file. `safeguarding:read` holders only. */
export async function getSafeguardingCase(db: DB, principal: Principal, caseId: number) {
  assertSafeguardingRead(principal);
  return loadSafeguardingCase(db, caseId);
}

/**
 * List cases for the safeguarding console.
 *
 * A summary, not the file: no concern text and no reporter identity, so an
 * over-the-shoulder view of a worklist discloses nothing about a child.
 */
export async function listSafeguardingCases(db: DB, principal: Principal, limit = 100) {
  assertSafeguardingRead(principal);
  const rows = await db.select().from(s.safeguardingCases)
    .orderBy(desc(s.safeguardingCases.receivedOn), desc(s.safeguardingCases.id))
    .limit(limit);
  return rows.map((r: any) => ({
    id: r.id,
    caseNo: r.caseNo,
    status: r.status,
    concernKind: r.concernKind,
    receivedOn: r.receivedOn,
    subjectIsMinor: r.subjectIsMinor,
    assignedOfficerPersonId: r.assignedOfficerPersonId,
    referredToAuthority: r.referredToAuthority,
    closedOn: r.closedOn,
    reviewDueOn: r.reviewDueOn,
  }));
}

export async function assignOfficer(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; officerPersonId: number },
  now: Date = new Date()
) {
  assertSafeguardingWrite(ctx.principal);
  const before = await loadSafeguardingCase(db, input.caseId);

  const officer = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.officerPersonId)).limit(1))[0];
  if (!officer) throw new CaseError('unknown_person', 'Unknown person: cannot assign as officer.');

  const [row] = await db.update(s.safeguardingCases).set({
    assignedOfficerPersonId: input.officerPersonId,
    status: before.status === 'received' ? 'triage' : before.status,
    updatedAt: now,
  }).where(eq(s.safeguardingCases.id, input.caseId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'safeguarding_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { assignedOfficerPersonId: before.assignedOfficerPersonId, status: before.status },
    newValue: { assignedOfficerPersonId: input.officerPersonId, status: row.status },
  });
  return row;
}

/**
 * Record an action taken on a case.
 *
 * The note is the record; `actionsTaken` is an APPENDED log line, never a
 * rewrite, so the column and the notes can never tell different stories.
 */
export async function recordAction(
  db: DB,
  ctx: AuditContext,
  input: {
    caseId: number;
    action: string;
    /** Marking a note shareable is what lets the subject ever see it. */
    noteClassification?: DataClass;
    authorPersonId?: number | null;
    on?: string;
  },
  now: Date = new Date()
) {
  assertSafeguardingWrite(ctx.principal);
  const before = await loadSafeguardingCase(db, input.caseId);
  if (before.closedOn) {
    throw new CaseError('case_closed', 'This case is closed. Reopen it before recording further action.');
  }

  const action = required(input.action, 'action_required', 'An action must say what was done.');
  const on = input.on ?? today(now);

  await addCaseNote(db, ctx, {
    caseKind: 'safeguarding',
    caseId: input.caseId,
    note: action,
    classification: input.noteClassification ?? 'confidential',
    authorPersonId: input.authorPersonId ?? null,
  }, now);

  const line = `${on} — ${action}`;
  const [row] = await db.update(s.safeguardingCases).set({
    actionsTaken: before.actionsTaken ? `${before.actionsTaken}\n${line}` : line,
    status: before.status === 'received' || before.status === 'triage'
      ? 'under_investigation'
      : before.status,
    updatedAt: now,
  }).where(eq(s.safeguardingCases.id, input.caseId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'safeguarding_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { status: before.status },
    // The action text stays out of the audit spine: `audit:read` is a much wider
    // grant than `safeguarding:read`.
    newValue: { status: row.status, actionRecordedOn: on },
  });
  return row;
}

/**
 * Record that the case was referred to an external authority.
 *
 * A body working with children must be able to EVIDENCE that it referred when it
 * should have. This is the only place that fact is set, it names who was
 * referred to, and — like everything else in a case file — it is never unset.
 * There is no rule here about WHEN a referral is required; that is statutory and
 * policy ground the federation states, not something this module decides.
 */
export async function referToAuthority(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; referredTo: string; referredOn?: string; note?: string | null },
  now: Date = new Date()
) {
  assertSafeguardingWrite(ctx.principal);
  const before = await loadSafeguardingCase(db, input.caseId);

  const referredTo = required(
    input.referredTo,
    'authority_required',
    'A referral must name the authority it was made to.'
  );
  const referredOn = input.referredOn ?? today(now);

  if (before.referredToAuthority) {
    throw new CaseError(
      'already_referred',
      `This case was already referred to ${before.referredTo ?? 'an authority'} on ${before.referredOn}. Record any further contact as an action.`
    );
  }

  await addCaseNote(db, ctx, {
    caseKind: 'safeguarding',
    caseId: input.caseId,
    note: input.note?.trim() || `Referred to ${referredTo} on ${referredOn}.`,
    classification: 'confidential',
  }, now);

  const [row] = await db.update(s.safeguardingCases).set({
    referredToAuthority: true,
    referredOn,
    referredTo,
    updatedAt: now,
  }).where(eq(s.safeguardingCases.id, input.caseId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'safeguarding_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { referredToAuthority: false },
    newValue: { referredToAuthority: true, referredTo, referredOn },
  });
  return row;
}

/**
 * Close a case with a stated outcome.
 *
 * `reviewDueOn` is CONFIGURATION. MMAKF has published no review interval, so
 * none is calculated: if the closing officer does not set a date, there is no
 * review date and the result says so rather than inventing six months.
 */
export async function closeCase(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; outcome: string; reviewDueOn?: string | null; closedOn?: string },
  now: Date = new Date()
) {
  assertSafeguardingWrite(ctx.principal);
  const before = await loadSafeguardingCase(db, input.caseId);
  if (before.closedOn) throw new CaseError('already_closed', `This case was closed on ${before.closedOn}.`);

  const outcome = required(input.outcome, 'outcome_required', 'Closing a case requires a stated outcome.');
  const closedOn = input.closedOn ?? today(now);

  const [row] = await db.update(s.safeguardingCases).set({
    status: 'closed',
    outcome,
    closedOn,
    reviewDueOn: input.reviewDueOn ?? null,
    updatedAt: now,
  }).where(eq(s.safeguardingCases.id, input.caseId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'safeguarding_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { status: before.status, closedOn: null },
    newValue: { status: 'closed', closedOn, referredToAuthority: row.referredToAuthority },
  });

  return {
    ...row,
    reviewNote: input.reviewDueOn
      ? null
      : 'No review date was set. The federation has not configured a review interval, so none has been applied.',
  };
}

// ─── Disciplinary ───────────────────────────────────────────────────────────

async function loadDisciplinaryCase(db: DB, caseId: number) {
  const row = (await db.select().from(s.disciplinaryCases)
    .where(eq(s.disciplinaryCases.id, caseId)).limit(1))[0];
  if (!row) throw new CaseError('unknown_case', 'Unknown disciplinary case');
  return row;
}

/** Every disciplinary step records who and why; the why is not optional. */
function disciplinaryReason(ctx: AuditContext, step: string): string {
  return required(
    ctx.reason,
    'reason_required',
    `A disciplinary ${step} must record the reason for it.`
  );
}

export async function getDisciplinaryCase(db: DB, principal: Principal, caseId: number) {
  assertCanAnywhere(principal, DISCIPLINE);
  return loadDisciplinaryCase(db, caseId);
}

export async function raiseCase(
  db: DB,
  ctx: AuditContext,
  input: {
    summary: string;
    allegedBreachOf?: string | null;
    subjectPersonId?: number | null;
    subjectDojoId?: number | null;
    complainantPersonId?: number | null;
    anonymousComplainant?: boolean;
    receivedOn?: string;
  },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, DISCIPLINE);

  const summary = required(input.summary, 'summary_required', 'A disciplinary case must state the allegation.');
  const anonymous = input.anonymousComplainant === true;
  const receivedOn = input.receivedOn ?? today(now);
  const caseNo = await nextRef(db, 'DC', Number(receivedOn.slice(0, 4)));

  let row;
  try {
    [row] = await db.insert(s.disciplinaryCases).values({
      caseNo,
      status: 'received',
      classification: 'confidential',
      summary,
      allegedBreachOf: input.allegedBreachOf ?? null,
      receivedOn,
      subjectPersonId: input.subjectPersonId ?? null,
      subjectDojoId: input.subjectDojoId ?? null,
      complainantPersonId: anonymous ? null : (input.complainantPersonId ?? null),
      anonymousComplainant: anonymous,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaseError('case_no_conflict', 'A case with that reference already exists.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'disciplinary_case',
    entityId: row.id,
    action: 'create',
    newValue: { caseNo, receivedOn, subjectPersonId: row.subjectPersonId, allegedBreachOf: row.allegedBreachOf },
  });
  return row;
}

export async function investigate(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; investigatorPersonId: number; note?: string | null },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, DISCIPLINE);
  const reason = disciplinaryReason(ctx, 'appointment');
  const before = await loadDisciplinaryCase(db, input.caseId);

  const investigator = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.investigatorPersonId)).limit(1))[0];
  if (!investigator) throw new CaseError('unknown_person', 'Unknown person: cannot appoint as investigator.');

  // A person cannot investigate a case about themselves. This is not federation
  // policy being invented — it is the conflict rule the interest-declaration
  // table exists for, applied at the one point where it is unarguable.
  if (before.subjectPersonId != null && before.subjectPersonId === input.investigatorPersonId) {
    throw new CaseError('conflict_of_interest', 'The subject of a case cannot be its investigator.');
  }

  if (input.note?.trim()) {
    await addCaseNote(db, ctx, {
      caseKind: 'disciplinary', caseId: input.caseId, note: input.note, classification: 'confidential',
    }, now);
  }

  const [row] = await db.update(s.disciplinaryCases).set({
    investigatorPersonId: input.investigatorPersonId,
    status: 'under_investigation',
    updatedAt: now,
  }).where(eq(s.disciplinaryCases.id, input.caseId)).returning();

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'disciplinary_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { status: before.status, investigatorPersonId: before.investigatorPersonId },
    newValue: { status: 'under_investigation', investigatorPersonId: input.investigatorPersonId },
  });
  return row;
}

export async function scheduleHearing(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; hearingOn: string; panelCommitteeId?: number | null },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, DISCIPLINE);
  const reason = disciplinaryReason(ctx, 'hearing');
  const before = await loadDisciplinaryCase(db, input.caseId);

  const hearingOn = required(input.hearingOn, 'hearing_date_required', 'A hearing must have a date.');
  if (before.decidedOn) {
    throw new CaseError('already_decided', `This case was decided on ${before.decidedOn}.`);
  }

  const [row] = await db.update(s.disciplinaryCases).set({
    hearingOn,
    panelCommitteeId: input.panelCommitteeId ?? before.panelCommitteeId ?? null,
    status: 'hearing_scheduled',
    updatedAt: now,
  }).where(eq(s.disciplinaryCases.id, input.caseId)).returning();

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'disciplinary_case',
    entityId: input.caseId,
    action: 'update',
    oldValue: { status: before.status, hearingOn: before.hearingOn },
    newValue: { status: 'hearing_scheduled', hearingOn },
  });
  return row;
}

/**
 * Record the decision, and any sanction that follows from it.
 *
 * TWO REFUSALS ARE THE POINT OF THIS FUNCTION:
 *  · a sanction with no decision behind it — a punishment nobody decided;
 *  · a decision with no hearing date — a punishment nobody was heard on.
 *
 * What the decision SHOULD be, and what sanction fits it, is stated by the
 * deciding body. Nothing here scores a case or picks a tariff.
 */
export async function decide(
  db: DB,
  ctx: AuditContext,
  input: {
    caseId: number;
    decision: string;
    sanction?: string | null;
    sanctionFrom?: string | null;
    sanctionTo?: string | null;
    decidedByCommitteeId?: number | null;
    decidedOn?: string;
  },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, DISCIPLINE);
  const reason = disciplinaryReason(ctx, 'decision');
  const before = await loadDisciplinaryCase(db, input.caseId);

  const sanction = input.sanction?.trim() || null;
  const decision = (input.decision ?? '').trim();

  if (!decision) {
    throw new CaseError(
      sanction ? 'sanction_without_decision' : 'decision_required',
      sanction
        ? 'A sanction cannot be recorded without the decision that imposed it.'
        : 'A decision must state what was decided.'
    );
  }
  if (!before.hearingOn) {
    throw new CaseError(
      'no_hearing',
      'No hearing date is recorded for this case. A decision cannot be entered before the case has been heard.'
    );
  }
  if (before.decidedOn) {
    throw new CaseError('already_decided', `This case was decided on ${before.decidedOn}.`);
  }
  if (sanction && input.sanctionFrom && input.sanctionTo && input.sanctionTo < input.sanctionFrom) {
    throw new CaseError('bad_sanction_period', 'A sanction cannot end before it starts.');
  }

  const decidedOn = input.decidedOn ?? today(now);
  const [row] = await db.update(s.disciplinaryCases).set({
    decision,
    sanction,
    sanctionFrom: sanction ? (input.sanctionFrom ?? decidedOn) : null,
    sanctionTo: sanction ? (input.sanctionTo ?? null) : null,
    decidedOn,
    decidedByCommitteeId: input.decidedByCommitteeId ?? before.panelCommitteeId ?? null,
    status: 'decided',
    updatedAt: now,
  }).where(eq(s.disciplinaryCases.id, input.caseId)).returning();

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'disciplinary_case',
    entityId: input.caseId,
    action: 'approve',
    oldValue: { status: before.status, decision: before.decision, sanction: before.sanction },
    newValue: { status: 'decided', decision, sanction, decidedOn, hearingOn: before.hearingOn },
  });
  return row;
}

/**
 * Lodge an appeal, and later record its outcome.
 *
 * An appeal against nothing is not an appeal, so a decision must exist first.
 * The appeal WINDOW is configuration MMAKF has not published, so lateness is not
 * assessed here: the lodging date is recorded and the deciding body applies
 * whatever window the federation's rules state.
 */
export async function appeal(
  db: DB,
  ctx: AuditContext,
  input: { caseId: number; lodgedOn?: string; outcome?: string | null; decidedOn?: string },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, DISCIPLINE);
  const reason = disciplinaryReason(ctx, 'appeal');
  const before = await loadDisciplinaryCase(db, input.caseId);

  if (!before.decidedOn) {
    throw new CaseError('nothing_to_appeal', 'This case has no decision on record to appeal against.');
  }
  // `decide` refuses to decide twice; this refused nothing, so a second call
  // silently overwrote the appeal outcome in place. An appeal determination is
  // an official record: it supersedes, it is not edited.
  if (before.appealDecidedOn || before.appealOutcome) {
    throw new CaseError(
      'appeal_already_decided',
      `This appeal was already determined on ${before.appealDecidedOn ?? 'record'} as “${before.appealOutcome}”. Record any further step as a new case or a case note.`
    );
  }

  const outcome = input.outcome?.trim() || null;
  const lodgedOn = before.appealLodgedOn ?? input.lodgedOn ?? today(now);

  if (outcome && !before.appealLodgedOn && !input.lodgedOn) {
    throw new CaseError('appeal_not_lodged', 'An appeal outcome requires the date the appeal was lodged.');
  }

  const [row] = await db.update(s.disciplinaryCases).set({
    appealLodgedOn: lodgedOn,
    appealOutcome: outcome ?? before.appealOutcome ?? null,
    appealDecidedOn: outcome ? (input.decidedOn ?? today(now)) : (before.appealDecidedOn ?? null),
    status: outcome ? 'appeal_heard' : 'appealed',
    updatedAt: now,
  }).where(eq(s.disciplinaryCases.id, input.caseId)).returning();

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'disciplinary_case',
    entityId: input.caseId,
    action: outcome ? 'approve' : 'update',
    oldValue: { status: before.status, appealLodgedOn: before.appealLodgedOn, appealOutcome: before.appealOutcome },
    newValue: { status: row.status, appealLodgedOn: lodgedOn, appealOutcome: outcome },
  });
  return row;
}

// ─── Medical ────────────────────────────────────────────────────────────────
//
// Medical data NEVER travels through a general athlete read. It is not joined
// into `publicAthleteProfile` or `athletePassport`, and this module offers
// exactly two reads: a fitness VERDICT that carries no clinical text, and one
// clearly named history function that does. Separating them by FUNCTION rather
// than by a `includeMedical` flag is deliberate — a flag defaulting the wrong
// way puts an injury record in a public profile; two functions cannot.

async function assertMedicalWrite(db: DB, principal: Principal, personId: number) {
  const scope = await subjectScope(db, personId);
  assertCan(principal, MEDICAL_WRITE, scope ?? {});
}

async function assertMedicalRead(db: DB, principal: Principal, personId: number) {
  const scope = await subjectScope(db, personId);
  assertCan(principal, MEDICAL_READ, scope ?? {});
}

async function insertMedical(
  db: DB,
  ctx: AuditContext,
  values: Record<string, unknown>,
  personId: number
) {
  const [row] = await db.insert(s.medicalRecords).values({
    ...values,
    personId,
    classification: 'restricted',
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'medical_record',
    entityId: row.id,
    action: 'create',
    // Kind and date only. The audit spine is read under `audit:read`, which
    // FINANCE_OFFICER and PRESIDENT hold; a clinical summary must not land there.
    newValue: { personId, kind: row.kind, recordedOn: row.recordedOn },
  });
  return row;
}

export async function recordClearance(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    clearanceStatus: 'cleared' | 'restricted' | 'not_cleared';
    recordedOn?: string;
    clearanceValidTo?: string | null;
    summary?: string | null;
    recordedByPersonId?: number | null;
    documentUrl?: string | null;
  },
  now: Date = new Date()
) {
  await assertMedicalWrite(db, ctx.principal, input.personId);

  if (!['cleared', 'restricted', 'not_cleared'].includes(input.clearanceStatus)) {
    throw new CaseError('bad_clearance_status', 'A clearance must be cleared, restricted or not_cleared.');
  }

  return insertMedical(db, ctx, {
    kind: 'clearance',
    clearanceStatus: input.clearanceStatus,
    clearanceValidTo: input.clearanceValidTo ?? null,
    recordedOn: input.recordedOn ?? today(now),
    summary: input.summary ?? null,
    recordedByPersonId: input.recordedByPersonId ?? null,
    documentUrl: input.documentUrl ?? null,
  }, input.personId);
}

export async function recordInjury(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    injurySite?: string | null;
    injuryOccurredOn?: string | null;
    recordedOn?: string;
    summary?: string | null;
    eventId?: number | null;
    recordedByPersonId?: number | null;
  },
  now: Date = new Date()
) {
  await assertMedicalWrite(db, ctx.principal, input.personId);
  const recordedOn = input.recordedOn ?? today(now);

  return insertMedical(db, ctx, {
    kind: 'injury',
    recordedOn,
    injurySite: input.injurySite ?? null,
    injuryOccurredOn: input.injuryOccurredOn ?? recordedOn,
    summary: input.summary ?? null,
    eventId: input.eventId ?? null,
    recordedByPersonId: input.recordedByPersonId ?? null,
  }, input.personId);
}

export async function recordReturnToPlay(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    returnToPlayOn: string;
    recordedOn?: string;
    summary?: string | null;
    recordedByPersonId?: number | null;
  },
  now: Date = new Date()
) {
  await assertMedicalWrite(db, ctx.principal, input.personId);
  const returnToPlayOn = required(
    input.returnToPlayOn,
    'return_date_required',
    'A return to play must record the date the person may resume.'
  );

  return insertMedical(db, ctx, {
    kind: 'return_to_play',
    recordedOn: input.recordedOn ?? today(now),
    returnToPlayOn,
    summary: input.summary ?? null,
    recordedByPersonId: input.recordedByPersonId ?? null,
  }, input.personId);
}

/**
 * What MMAKF has configured for a fitness question. Every field is optional and
 * an omitted field means the rule is NOT APPLIED, and the result says so.
 */
export interface FitnessConfig {
  /**
   * Does an injury recorded after a clearance, with no return to play, lapse
   * that clearance? MMAKF has published no answer, so nothing supplies this.
   */
  injuryLapsesClearance?: boolean | null;
}

export interface FitnessResult {
  status: 'cleared' | 'not_cleared' | 'no_record' | 'undetermined';
  /** Actionable, and reconstructible from the stored records alone. */
  reason: string;
  asAt: string;
  clearanceRecordedOn: string | null;
  clearanceValidTo: string | null;
  checks: Array<{ rule: string; passed: boolean; detail: string }>;
}

/**
 * Is this person cleared to compete AS AT a date?
 *
 * Returns a VERDICT, never a record. There is no injury site, no clinical
 * summary and no document link in the result — an entry official needs to know
 * whether a person may take the floor, and nothing else.
 *
 * FOUR states, and only one of them is a clearance:
 *  · `cleared`      — the records say so;
 *  · `not_cleared`  — the records, or a CONFIGURED rule, say so;
 *  · `no_record`    — nothing is on file. The federation has not published a
 *                     rule requiring clearance to compete, so a missing record
 *                     is not reported as a refusal; the caller decides what an
 *                     absent clearance means under MMAKF's own rules;
 *  · `undetermined` — the records raise a question that only a rule MMAKF has
 *                     not configured could answer. Nothing is granted.
 *
 * Callers must treat anything other than `cleared` as "not cleared to take the
 * floor". The distinction between the four is for the human reading the reason.
 */
export async function fitnessToCompete(
  db: DB,
  principal: Principal,
  personId: number,
  asAt: string,
  config: FitnessConfig = {}
): Promise<FitnessResult> {
  await assertMedicalRead(db, principal, personId);

  const checks: FitnessResult['checks'] = [];
  const rows = await db.select().from(s.medicalRecords)
    .where(eq(s.medicalRecords.personId, personId))
    .orderBy(desc(s.medicalRecords.recordedOn), desc(s.medicalRecords.id));

  const upTo = rows.filter((r: any) => String(r.recordedOn) <= asAt);
  const clearance = upTo.find((r: any) => r.kind === 'clearance');

  if (!clearance) {
    checks.push({ rule: 'clearance_on_record', passed: false, detail: `no clearance recorded on or before ${asAt}` });
    return {
      status: 'no_record',
      reason: 'No medical clearance is recorded for this person. The federation has not configured whether one is required, so no fitness decision has been made.',
      asAt,
      clearanceRecordedOn: null,
      clearanceValidTo: null,
      checks,
    };
  }

  checks.push({
    rule: 'clearance_on_record',
    passed: true,
    detail: `clearance recorded ${clearance.recordedOn} as ${clearance.clearanceStatus}`,
  });

  const base = {
    asAt,
    clearanceRecordedOn: String(clearance.recordedOn),
    clearanceValidTo: clearance.clearanceValidTo ? String(clearance.clearanceValidTo) : null,
  };

  if (clearance.clearanceStatus !== 'cleared') {
    checks.push({
      rule: 'clearance_unrestricted',
      passed: false,
      detail: `clearance status is ${clearance.clearanceStatus}`,
    });
    return {
      ...base,
      status: 'not_cleared',
      reason: `The most recent clearance, recorded on ${clearance.recordedOn}, is ${String(clearance.clearanceStatus).replace(/_/g, ' ')}.`,
      checks,
    };
  }
  checks.push({ rule: 'clearance_unrestricted', passed: true, detail: 'clearance is unrestricted' });

  if (clearance.clearanceValidTo && String(clearance.clearanceValidTo) < asAt) {
    checks.push({
      rule: 'clearance_in_date',
      passed: false,
      detail: `valid to ${clearance.clearanceValidTo}, asked as at ${asAt}`,
    });
    return {
      ...base,
      status: 'not_cleared',
      reason: `The clearance expired on ${clearance.clearanceValidTo}, before ${asAt}.`,
      checks,
    };
  }
  checks.push({
    rule: 'clearance_in_date',
    passed: true,
    detail: clearance.clearanceValidTo ? `valid to ${clearance.clearanceValidTo}` : 'no expiry recorded',
  });

  // AN INJURY AFTER A CLEARANCE IS A FACT. WHAT IT MEANS IS FEDERATION POLICY.
  //
  // This function used to answer `not_cleared` here on its own authority. That
  // was an invented rule — "a recorded injury lapses a clearance until a return
  // to play is recorded" is a medical policy, a defensible one, and MMAKF's to
  // write. It also has teeth: it bars an athlete from competing.
  //
  // So the FACT is always reported in `checks`, and the RULE is applied only
  // when the federation supplies it. Unconfigured, the answer is `undetermined`
  // — not `cleared`, because the records do not support that claim, and not
  // `not_cleared`, because that is a finding under a rule nobody wrote.
  const laterInjury = upTo.find(
    (r: any) => r.kind === 'injury' && String(r.recordedOn) > String(clearance.recordedOn)
  );
  if (laterInjury) {
    const returned = upTo.some(
      (r: any) => r.kind === 'return_to_play' && String(r.recordedOn) >= String(laterInjury.recordedOn)
    );
    const seen = `injury recorded ${laterInjury.recordedOn} after the clearance of ${clearance.recordedOn}`;

    if (returned) {
      checks.push({
        rule: 'no_unresolved_injury',
        passed: true,
        detail: `${seen}, return to play recorded`,
      });
    } else if (config.injuryLapsesClearance == null) {
      checks.push({
        rule: 'no_unresolved_injury',
        passed: false,
        detail: `${seen}, no return to play recorded; whether an injury lapses a clearance is not configured, so no rule was applied`,
      });
      return {
        ...base,
        status: 'undetermined',
        reason: `An injury was recorded on ${laterInjury.recordedOn}, after the clearance of ${clearance.recordedOn}, and no return to play has been recorded. The federation has not configured whether an injury lapses a clearance, so that rule has not been applied and no fitness decision has been made. Refer this to the medical adviser.`,
        checks,
      };
    } else if (config.injuryLapsesClearance === true) {
      checks.push({
        rule: 'no_unresolved_injury',
        passed: false,
        detail: `${seen}, no return to play recorded; the federation's rule that an injury lapses a clearance was applied`,
      });
      return {
        ...base,
        status: 'not_cleared',
        reason: `An injury was recorded on ${laterInjury.recordedOn}, after the clearance of ${clearance.recordedOn}, and no return to play has been recorded.`,
        checks,
      };
    } else {
      checks.push({
        rule: 'no_unresolved_injury',
        passed: true,
        detail: `${seen}, no return to play recorded; the federation has configured that an injury does not itself lapse a clearance`,
      });
    }
  } else {
    checks.push({ rule: 'no_unresolved_injury', passed: true, detail: 'no injury recorded since the clearance' });
  }

  return {
    ...base,
    status: 'cleared',
    reason: clearance.clearanceValidTo
      ? `Cleared on ${clearance.recordedOn}, valid to ${clearance.clearanceValidTo}.`
      : `Cleared on ${clearance.recordedOn}; no expiry was recorded.`,
    checks,
  };
}

/**
 * The medical history, with clinical detail.
 *
 * The ONLY function in the system that returns it. Named so that no caller can
 * reach it by accident, and gated in the subject's own scope.
 */
export async function medicalHistory(db: DB, principal: Principal, personId: number) {
  await assertMedicalRead(db, principal, personId);
  return db.select().from(s.medicalRecords)
    .where(eq(s.medicalRecords.personId, personId))
    .orderBy(desc(s.medicalRecords.recordedOn), desc(s.medicalRecords.id));
}

// ─── Support tickets ────────────────────────────────────────────────────────

export interface ServiceStandard {
  configured: boolean;
  slaDueAt: string | null;
  note: string;
}

const NO_SERVICE_STANDARD =
  'No service standard configured — the federation has not published a response time for this category, so no response deadline has been set.';

/**
 * Raise a support ticket.
 *
 * UNGATED, like reporting a concern: a person who cannot log in is exactly the
 * person most likely to need the help desk.
 *
 * `slaHours` IS CONFIGURATION. MMAKF publishes no service standard, so nothing
 * supplies it today and `slaDueAt` stays null. A ticket with no deadline reports
 * that no standard is configured; it does not silently acquire a plausible
 * 48 hours that no one at the federation ever agreed to.
 */
export async function raiseTicket(
  db: DB,
  ctx: AuditContext,
  input: {
    category: string;
    subject: string;
    body: string;
    priority?: string;
    raisedByPersonId?: number | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    confidential?: boolean;
    department?: string | null;
    /** Supplied by the federation's published service standard, or omitted. */
    slaHours?: number | null;
  },
  now: Date = new Date()
): Promise<{ ticket: any; serviceStandard: ServiceStandard }> {
  const category = required(input.category, 'category_required', 'A ticket needs a category.');
  const subject = required(input.subject, 'subject_required', 'A ticket needs a subject.');
  const body = required(input.body, 'body_required', 'A ticket needs a message.');

  let slaDueAt: Date | null = null;
  if (input.slaHours != null) {
    if (!Number.isInteger(input.slaHours) || input.slaHours <= 0) {
      throw new CaseError('bad_sla', 'A service standard must be a positive whole number of hours.');
    }
    slaDueAt = new Date(now.getTime() + input.slaHours * 3_600_000);
  }

  const ticketNo = await nextRef(db, 'TKT', now.getFullYear());

  let ticket;
  try {
    [ticket] = await db.insert(s.supportTickets).values({
      ticketNo,
      category,
      subject,
      body,
      priority: input.priority ?? 'normal',
      raisedByPersonId: input.raisedByPersonId ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      confidential: input.confidential === true,
      department: input.department ?? null,
      status: 'open',
      slaDueAt,
      createdAt: now,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaseError('ticket_no_conflict', 'A ticket with that reference already exists.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'support_ticket',
    entityId: ticket.id,
    action: 'create',
    newValue: { ticketNo, category, slaConfigured: slaDueAt != null },
  });

  return {
    ticket,
    serviceStandard: {
      configured: slaDueAt != null,
      slaDueAt: slaDueAt ? slaDueAt.toISOString() : null,
      note: slaDueAt ? `A response is due by ${slaDueAt.toISOString()}.` : NO_SERVICE_STANDARD,
    },
  };
}

/**
 * The desk gate for ONE ticket.
 *
 * `assertCanAnywhere` alone was the leak: `person:read_pii` is held by every
 * DOJO_ADMIN in the country, so "holds it somewhere" handed a single dojo's
 * administrator every confidential ticket nationally — contact email, phone and
 * body included — with no filter anywhere. The ticket's scope is its raiser's
 * unit, checked in the same way a medical record's is.
 *
 * A ticket with no resolvable raiser (a non-member, or an unauthenticated
 * report) has NO scope, and an empty resource is reachable only from a national
 * binding. That is the fail-closed direction: the national desk handles what no
 * unit can claim.
 */
async function assertTicketDesk(db: DB, principal: Principal, ticket: { raisedByPersonId: number | null }) {
  const scope = await subjectScope(db, ticket.raisedByPersonId);
  assertCan(principal, SUPPORT_DESK, scope ?? {});
}

async function loadTicket(db: DB, ticketId: number) {
  const row = (await db.select().from(s.supportTickets)
    .where(eq(s.supportTickets.id, ticketId)).limit(1))[0];
  if (!row) throw new CaseError('unknown_ticket', 'Unknown support ticket');
  return row;
}

export async function assignTicket(
  db: DB,
  ctx: AuditContext,
  input: { ticketId: number; assignedToUserId: number; department?: string | null },
  now: Date = new Date()
) {
  // Holds the desk action at all, before an id is allowed to probe existence...
  assertCanAnywhere(ctx.principal, SUPPORT_DESK);
  const before = await loadTicket(db, input.ticketId);
  // ...and holds it in THIS ticket's scope.
  await assertTicketDesk(db, ctx.principal, before);

  const [row] = await db.update(s.supportTickets).set({
    assignedToUserId: input.assignedToUserId,
    department: input.department ?? before.department ?? null,
    status: before.status === 'open' ? 'in_progress' : before.status,
  }).where(eq(s.supportTickets.id, input.ticketId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'support_ticket',
    entityId: input.ticketId,
    action: 'update',
    oldValue: { assignedToUserId: before.assignedToUserId, status: before.status },
    newValue: { assignedToUserId: input.assignedToUserId, status: row.status },
  });
  return row;
}

/**
 * Record a response. `firstResponseAt` is set ONCE and never moved — it is the
 * measurement a service standard would be assessed against, and a measurement
 * that can be rewritten measures nothing.
 */
export async function respondToTicket(
  db: DB,
  ctx: AuditContext,
  input: { ticketId: number; response: string; awaitingMember?: boolean },
  now: Date = new Date()
) {
  // Holds the desk action at all, before an id is allowed to probe existence...
  assertCanAnywhere(ctx.principal, SUPPORT_DESK);
  const before = await loadTicket(db, input.ticketId);
  // ...and holds it in THIS ticket's scope.
  await assertTicketDesk(db, ctx.principal, before);
  const response = required(input.response, 'response_required', 'A response cannot be empty.');

  await addCaseNote(db, ctx, {
    caseKind: 'support',
    caseId: input.ticketId,
    note: response,
    // A response is written TO the person who raised the ticket, so it is theirs
    // to see; internal handling notes are added separately at 'confidential'.
    classification: 'member',
  }, now);

  const [row] = await db.update(s.supportTickets).set({
    firstResponseAt: before.firstResponseAt ?? now,
    status: input.awaitingMember ? 'awaiting_member' : (before.status === 'open' ? 'in_progress' : before.status),
  }).where(eq(s.supportTickets.id, input.ticketId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'support_ticket',
    entityId: input.ticketId,
    action: 'update',
    oldValue: { status: before.status, firstResponseAt: before.firstResponseAt },
    newValue: { status: row.status, firstResponseAt: row.firstResponseAt },
  });
  return row;
}

export async function resolveTicket(
  db: DB,
  ctx: AuditContext,
  input: { ticketId: number; resolution: string },
  now: Date = new Date()
) {
  // Holds the desk action at all, before an id is allowed to probe existence...
  assertCanAnywhere(ctx.principal, SUPPORT_DESK);
  const before = await loadTicket(db, input.ticketId);
  // ...and holds it in THIS ticket's scope.
  await assertTicketDesk(db, ctx.principal, before);
  if (before.resolvedAt) throw new CaseError('already_resolved', 'This ticket is already resolved.');

  const resolution = required(
    input.resolution,
    'resolution_required',
    'Resolving a ticket requires a statement of how it was resolved.'
  );

  const [row] = await db.update(s.supportTickets).set({
    status: 'resolved',
    resolution,
    resolvedAt: now,
    firstResponseAt: before.firstResponseAt ?? now,
  }).where(eq(s.supportTickets.id, input.ticketId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'support_ticket',
    entityId: input.ticketId,
    action: 'update',
    oldValue: { status: before.status },
    newValue: { status: 'resolved', resolvedAt: now.toISOString() },
  });
  return row;
}

/**
 * How this ticket stands against its service standard.
 *
 * `met` is null — not false — when no standard is configured. Reporting an
 * unmeasured ticket as a breach would be a statistic about a rule that does not
 * exist.
 */
export async function ticketStanding(
  db: DB,
  principal: Principal,
  ticketId: number,
  now: Date = new Date()
): Promise<{ ticketNo: string; status: string; met: boolean | null; note: string }> {
  assertCanAnywhere(principal, SUPPORT_DESK);
  const t = await loadTicket(db, ticketId);
  await assertTicketDesk(db, principal, t);

  if (!t.slaDueAt) {
    return { ticketNo: t.ticketNo, status: t.status, met: null, note: NO_SERVICE_STANDARD };
  }
  const due = t.slaDueAt instanceof Date ? t.slaDueAt : new Date(t.slaDueAt);
  const responded = t.firstResponseAt instanceof Date ? t.firstResponseAt : (t.firstResponseAt ? new Date(t.firstResponseAt) : null);

  if (!responded) {
    // A ticket nobody has answered has not MET the standard — it has not
    // breached it yet. Reporting `met: true` here would let every unanswered
    // ticket in the country count as a success in any "standard met %" built on
    // this function, which is a figure that describes work that did not happen.
    const overdue = now.getTime() > due.getTime();
    return {
      ticketNo: t.ticketNo,
      status: t.status,
      met: overdue ? false : null,
      note: overdue
        ? `No response, and the deadline of ${due.toISOString()} has passed.`
        : `No response recorded yet. The deadline of ${due.toISOString()} has not passed, so the standard is neither met nor breached.`,
    };
  }
  const met = responded.getTime() <= due.getTime();
  return {
    ticketNo: t.ticketNo,
    status: t.status,
    met,
    note: `First responded ${responded.toISOString()} against a deadline of ${due.toISOString()}.`,
  };
}

// ─── What a case subject may see of their own case ──────────────────────────

export interface SubjectCaseView {
  caseKind: CaseKind;
  caseNo: string;
  status: string;
  receivedOn: string;
  closedOn: string | null;
  /** The outcome, or the decision — the thing the subject is owed. */
  outcome: string | null;
  hearingOn: string | null;
  sanction: { sanction: string; from: string | null; to: string | null } | null;
  referredToAuthority: boolean | null;
  sharedNotes: Array<{ at: string; note: string }>;
  /** Named, not silent. A person is owed the fact that material is withheld. */
  withheld: string[];
}

/**
 * Build the projection a case subject may see.
 *
 * A PURE function, and it BUILDS the permitted shape rather than deleting fields
 * from the row. That direction matters more than it looks: with a delete-list, a
 * column added to `safeguarding_cases` next year starts appearing in a subject
 * disclosure the moment it is added, and nobody notices. With an allowlist it
 * cannot appear until someone writes the line that lets it.
 *
 * Withheld, always and without exception:
 *  · the reporter's or complainant's identity, and anything about them;
 *  · the concern text and the allegation as recorded by the reporter;
 *  · every note not explicitly classified as shareable;
 *  · the assigned officer and investigator.
 */
export function redactForSubject(
  caseKind: CaseKind,
  row: Record<string, any>,
  notes: Array<Record<string, any>> = []
): SubjectCaseView {
  const shared = notes.filter((n) => SUBJECT_SHAREABLE.includes(n.classification));
  const withheld: string[] = [
    'the identity of anyone who reported the matter or gave information about it',
    'internal case notes and investigation material',
  ];
  const hiddenNotes = notes.length - shared.length;
  if (hiddenNotes > 0) {
    withheld.push(`${hiddenNotes} case note(s) not marked for disclosure`);
  }

  const sanction = row.sanction
    ? { sanction: String(row.sanction), from: row.sanctionFrom ?? null, to: row.sanctionTo ?? null }
    : null;

  return {
    caseKind,
    caseNo: String(row.caseNo),
    status: String(row.status),
    receivedOn: String(row.receivedOn),
    closedOn: row.closedOn ?? null,
    outcome: (caseKind === 'safeguarding' ? row.outcome : row.decision) ?? null,
    hearingOn: caseKind === 'disciplinary' ? (row.hearingOn ?? null) : null,
    sanction,
    // Whether a referral was made is disclosed; who it went to and why is not.
    referredToAuthority: caseKind === 'safeguarding' ? Boolean(row.referredToAuthority) : null,
    sharedNotes: shared.map((n) => ({ at: isoOf(n.at), note: String(n.note) })),
    withheld,
  };
}

/**
 * The subject's own view of their case.
 *
 * Openable by the subject themselves, or by a case handler producing the
 * disclosure. A case whose subject is not a member has no self to authenticate,
 * so only a handler can produce it — which is correct, since it must then be
 * given to them by hand.
 */
export async function subjectCaseView(
  db: DB,
  principal: Principal,
  caseKind: CaseKind,
  caseId: number
): Promise<SubjectCaseView> {
  const assertHandler = () => {
    if (caseKind === 'safeguarding') assertSafeguardingRead(principal);
    else assertCanAnywhere(principal, DISCIPLINE);
  };

  // Whether the case EXISTS is itself disclosure. Loading first and letting
  // `unknown_case` escape hands a stranger an oracle: walk the id space, and the
  // ids that answer "unknown" tell you which ones do not. A caller who is not a
  // handler therefore gets the same refusal either way, and only a handler is
  // told a case is missing.
  const row = await (caseKind === 'safeguarding'
    ? loadSafeguardingCase(db, caseId)
    : loadDisciplinaryCase(db, caseId)
  ).catch((err: unknown) => {
    if (err instanceof CaseError && err.code === 'unknown_case') { assertHandler(); }
    throw err;
  });

  // THE SUBJECT IS THE PERSON THE CASE IS FOR, NEVER THE PERSON IT IS ABOUT.
  //
  // `aboutPersonId` on a safeguarding case is the person whose conduct was
  // complained of. Handing them a self-service window onto the case would tell
  // them a concern exists, what stage it is at, and — through
  // `referredToAuthority` — that the authorities have been informed, which is
  // exactly the disclosure that gets evidence destroyed and a child pressured.
  // Whether and when they are told is the safeguarding officer's decision under
  // MMAKF's own procedure; a handler can produce a disclosure for them by hand.
  const subjectPersonId: number | null = row.subjectPersonId ?? null;

  if (!(await isSelf(db, principal, subjectPersonId))) {
    // Not the subject — then it must be a handler, gated exactly as the case
    // file itself is. Deny by default: no third route exists.
    assertHandler();
  }

  const notes = await db.select().from(s.caseNotes)
    .where(and(eq(s.caseNotes.caseKind, caseKind), eq(s.caseNotes.caseId, caseId)))
    .orderBy(s.caseNotes.at, s.caseNotes.id);

  return redactForSubject(caseKind, row, notes);
}

/** Does this principal hold safeguarding access at all? For console gating. */
export function hasSafeguardingAccess(principal: Principal | null | undefined): boolean {
  return canAnywhere(principal, 'safeguarding:read');
}
