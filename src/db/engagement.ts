// Leads, institutions and training requests.
//
// This is the front door: somebody arrives from a search, a YouTube video or a
// QR code on a poster, and says what they want. What happens in the next few
// milliseconds decides whether the federation's records stay usable.
//
// THE RULE THAT SHAPES THE MODULE: AN ENQUIRY DOES NOT CREATE A CUSTOMER.
//
// The obvious implementation inserts a row per submission. Then the same school
// enquires in March, June and September; three "customers" exist; three
// different administrators quote three different figures; and the federation
// discovers it has been negotiating with itself. Every capture path here
// therefore RESOLVES first and inserts only when resolution genuinely fails.
//
// AND THE CORRESPONDING RESTRAINT: a lead is NOT a person.
//
// A principal booking karate for their school has not joined MMAKF. Creating a
// `persons` row for every enquiry fills the federation's own member register
// with people who never trained, and that register is the thing /verify
// answers from. A lead is promoted to a canonical Person or Institution only
// when somebody identifies it — deliberately, as an act.
//
// FIRST TOUCH AND LAST TOUCH ARE BOTH KEPT. The campaign that introduced
// somebody and the one that brought them back are different facts. Overwriting
// the first with the second loses the one that did the work, which is exactly
// the attribution the federation needs to decide where to put its effort.

import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';

type DB = any;

export class EngagementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngagementError';
    this.code = code;
  }
}

export function isEngagementError(err: unknown): err is EngagementError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'EngagementError';
}

export type Audience =
  | 'individual' | 'family' | 'school' | 'university' | 'corporate'
  | 'government' | 'ngo' | 'club' | 'community' | 'other';

export const AUDIENCES: readonly Audience[] = [
  'individual', 'family', 'school', 'university', 'corporate',
  'government', 'ngo', 'club', 'community', 'other',
];

export type LeadSource =
  | 'organic_search' | 'paid_search' | 'social' | 'youtube' | 'referral'
  | 'event' | 'qr' | 'campaign' | 'direct' | 'partner' | 'unknown';

export const LEAD_SOURCES: readonly LeadSource[] = [
  'organic_search', 'paid_search', 'social', 'youtube', 'referral',
  'event', 'qr', 'campaign', 'direct', 'partner', 'unknown',
];

/** Leads in these states are finished; a new enquiry starts a new one. */
const CLOSED_STATUSES = ['won', 'lost', 'disqualified'] as const;

// ─── Normalisation ──────────────────────────────────────────────────────────

/**
 * How two enquiries are recognised as the same person.
 *
 * Lower-cased and trimmed, nothing more. Deliberately NOT gmail dot-stripping
 * or plus-address folding: those are true of one provider's rules and false of
 * others, and a matcher that is wrong about an address merges two different
 * people — which is worse than failing to merge one person twice.
 */
export function normaliseEmail(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase();
  return t.includes('@') && t.length <= 254 ? t : null;
}

/**
 * Digits only, and the last ten of them.
 *
 * An Indian mobile arrives as 9876543210, +91 98765 43210, 09876543210 and
 * 0091-9876543210. All four are one number, and comparing the raw strings
 * makes four leads out of one person.
 */
export function normalisePhone(v: string | null | undefined): string | null {
  const digits = (v ?? '').replace(/\D+/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * For matching an institution by name: case, punctuation and spacing folded.
 *
 * APOSTROPHES ARE REMOVED, not turned into separators. Everything else becomes
 * one. That distinction is the whole function: an apostrophe JOINS a word and a
 * full stop SEPARATES one, so "St. Xavier's School" must fold to
 * "st xaviers school" — the same as "St Xaviers School", which is how the same
 * school is typed by the next person who enquires. Treating the apostrophe as a
 * separator gives "st xavier s school", the two never match, and the federation
 * ends up with two clients that are one school.
 */
export function normaliseName(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .replace(/['’ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ─── Capturing a lead ───────────────────────────────────────────────────────

export interface CaptureInput {
  audience: Audience;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  institutionName?: string | null;
  city?: string | null;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  source?: LeadSource;
  landingPath?: string | null;
  utm?: Record<string, unknown> | null;
}

export interface CaptureResult {
  leadId: number;
  ref: string;
  /** True when this enquiry was folded into a lead that already existed. */
  matchedExisting: boolean;
  /** How it was matched, for the record and for the test that proves it. */
  matchedOn: 'email' | 'phone' | 'none';
}

/**
 * Record an enquiry, folding it into an existing open lead where one exists.
 *
 * A capture with NEITHER an email nor a phone is refused. Such a lead can never
 * be matched to anything, can never be contacted, and accumulates as noise that
 * makes the pipeline unreadable — and an unreadable pipeline is one nobody
 * works, which costs the federation the enquiries that were real.
 */
export async function captureLead(
  db: DB,
  ctx: AuditContext | { principal: Principal | null },
  input: CaptureInput
): Promise<CaptureResult> {
  if (!AUDIENCES.includes(input.audience)) {
    throw new EngagementError('bad_audience', `Unknown audience: ${String(input.audience)}.`);
  }
  const email = normaliseEmail(input.contactEmail);
  const phone = normalisePhone(input.contactPhone);
  if (!email && !phone) {
    throw new EngagementError(
      'no_contact',
      'An enquiry needs an email address or a telephone number. Without one it cannot be answered, ' +
      'cannot be matched to a later enquiry from the same person, and only makes the pipeline harder to read.'
    );
  }

  const source: LeadSource = LEAD_SOURCES.includes(input.source as LeadSource)
    ? (input.source as LeadSource)
    : 'unknown';

  // Resolve BEFORE inserting. An open lead from the same contact is the same
  // conversation continuing, not a new customer.
  const predicates: SQL[] = [];
  if (email) predicates.push(eq(s.leads.contactEmail, email) as SQL);
  if (phone) predicates.push(eq(s.leads.contactPhone, phone) as SQL);

  const existing = await db.select().from(s.leads)
    .where(and(or(...predicates), sql`${s.leads.status} NOT IN ('won','lost','disqualified')`))
    .orderBy(desc(s.leads.createdAt))
    .limit(1);

  if (existing.length) {
    const lead = existing[0];
    await db.update(s.leads)
      .set({
        // Last touch moves. First touch NEVER does.
        lastSource: source,
        contactName: lead.contactName ?? input.contactName ?? null,
        contactEmail: lead.contactEmail ?? email,
        contactPhone: lead.contactPhone ?? phone,
        city: lead.city ?? input.city ?? null,
        stateUnitId: lead.stateUnitId ?? input.stateUnitId ?? null,
        districtUnitId: lead.districtUnitId ?? input.districtUnitId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(s.leads.id, lead.id));

    await db.insert(s.leadActivities).values({
      leadId: lead.id,
      kind: 'enquiry',
      summary: `Returned via ${source}${input.landingPath ? ` on ${input.landingPath}` : ''}`,
      detail: { source, landingPath: input.landingPath ?? null, utm: input.utm ?? null },
    });

    return {
      leadId: lead.id,
      ref: lead.ref,
      matchedExisting: true,
      matchedOn: email && lead.contactEmail === email ? 'email' : 'phone',
    };
  }

  const ref = await allocateFederationId(db, 'LEAD', new Date().getUTCFullYear());
  const [created] = await db.insert(s.leads).values({
    ref,
    audience: input.audience as any,
    status: 'new',
    contactName: input.contactName ?? null,
    contactEmail: email,
    contactPhone: phone,
    firstSource: source as any,
    lastSource: source as any,
    firstLandingPath: input.landingPath ?? null,
    utm: (input.utm ?? null) as any,
    city: input.city ?? null,
    stateUnitId: input.stateUnitId ?? null,
    districtUnitId: input.districtUnitId ?? null,
  }).returning();

  await db.insert(s.leadActivities).values({
    leadId: created.id,
    kind: 'enquiry',
    summary: `New enquiry via ${source}${input.landingPath ? ` on ${input.landingPath}` : ''}`,
    detail: { source, landingPath: input.landingPath ?? null, utm: input.utm ?? null },
  });

  return { leadId: created.id, ref: created.ref, matchedExisting: false, matchedOn: 'none' };
}

// ─── Institutions ───────────────────────────────────────────────────────────

/**
 * Find the institution this enquiry is about, or create it.
 *
 * Matched on normalised name WITHIN a city, because "St Xavier's School" exists
 * in a dozen cities and they are a dozen different clients. Matching on name
 * alone would merge them; matching on nothing would produce a new row for every
 * enquiry, which is the failure this module exists to prevent.
 */
export async function resolveInstitution(
  db: DB,
  ctx: AuditContext,
  input: {
    name: string;
    kind: Audience;
    city?: string | null;
    stateUnitId?: number | null;
    districtUnitId?: number | null;
    campusCount?: number | null;
    populationCount?: number | null;
  }
): Promise<{ institutionId: number; created: boolean }> {
  assertCan(ctx.principal, 'engagement:write', {
    stateUnitId: input.stateUnitId ?? null,
    districtUnitId: input.districtUnitId ?? null,
  });

  const name = (input.name ?? '').trim();
  if (!name) throw new EngagementError('no_name', 'An institution needs a name.');

  const wanted = normaliseName(name);
  const candidates = await db.select().from(s.institutions)
    .where(eq(s.institutions.kind, input.kind as any));

  const match = candidates.find((c: any) =>
    normaliseName(c.name) === wanted &&
    normaliseName(c.city ?? '') === normaliseName(input.city ?? '')
  );
  if (match) return { institutionId: match.id, created: false };

  const code = await allocateFederationId(db, 'INST', new Date().getUTCFullYear());
  const [created] = await db.insert(s.institutions).values({
    code,
    name,
    kind: input.kind as any,
    status: 'prospect',
    city: input.city ?? null,
    stateUnitId: input.stateUnitId ?? null,
    districtUnitId: input.districtUnitId ?? null,
    campusCount: input.campusCount ?? null,
    populationCount: input.populationCount ?? null,
  }).returning({ id: s.institutions.id });

  await writeAudit(db, ctx, {
    entityType: 'institution', entityId: created.id, action: 'create',
    newValue: { code, name, kind: input.kind },
  });
  return { institutionId: created.id, created: true };
}

/**
 * Attach a lead to a canonical institution.
 *
 * This is the IDENTIFICATION step the module's opening rule describes: until
 * somebody does this deliberately, a lead is an enquiry and nothing more.
 */
export async function identifyLead(
  db: DB, ctx: AuditContext, leadId: number,
  target: { institutionId?: number; personId?: number }
) {
  assertCan(ctx.principal, 'engagement:write', {});
  if (!target.institutionId && !target.personId) {
    throw new EngagementError('no_target', 'Identify a lead against an institution or a person.');
  }
  const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, leadId)).limit(1);
  if (!lead) throw new EngagementError('unknown_lead', 'No such lead.');

  await db.update(s.leads).set({
    institutionId: target.institutionId ?? lead.institutionId,
    personId: target.personId ?? lead.personId,
    status: lead.status === 'new' ? 'qualifying' : lead.status,
    updatedAt: new Date(),
  }).where(eq(s.leads.id, leadId));

  await db.insert(s.leadActivities).values({
    leadId, kind: 'status_change',
    byUserId: ctx.principal.userId ?? null,
    summary: 'Identified against a canonical record',
    detail: target as any,
  });
  return { leadId, ...target };
}

// ─── Acting on a lead ───────────────────────────────────────────────────────
//
// /admin/leads could read the whole pipeline and change nothing in it. Every
// enquiry the federation had ever received sat at the status the capture path
// gave it — `new`, almost always — because the only two functions that could
// move one were captureLead(), which sets it on the way in, and identifyLead(),
// which nudges `new` to `qualifying` as a side effect of attaching a record.
//
// So the pipeline board showed one column. A screen that shows work and cannot
// record that the work was done teaches its users to keep the real state
// somewhere else, and the somewhere else is a spreadsheet the federation cannot
// audit.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE IS RE-DERIVED FROM THE STORED ROW, NOT TAKEN FROM THE CALLER
// ─────────────────────────────────────────────────────────────────────────────
//
// Each of these loads the lead FIRST and then asserts against the placement on
// that row, exactly as leadDetail() does. A lead id in a form body therefore
// buys nothing: posting another state's lead id reaches the same refusal as
// opening it would.
//
// This is deliberately stricter than identifyLead() above, which asserts with an
// empty scope object and so checks only that the caller holds engagement:write
// SOMEWHERE. That is a hole — a district administrator can identify a lead
// belonging to another district — and it is left alone here rather than changed
// silently, because narrowing it changes who can do something that has been
// permitted since the function was written. It is recorded in
// docs/IMPLEMENTATION-QUEUE.md instead, where a decision can be taken about it.

/**
 * The transitions a lead may make, and the ones it may not.
 *
 * NOT a free enum assignment. `won` and `lost` are terminal commercial facts,
 * and a pipeline that lets somebody walk a lead back out of `won` to
 * `qualifying` is a pipeline whose conversion figures cannot be trusted — the
 * row would count in the numerator today and not at all tomorrow, with nothing
 * recording that it changed its mind.
 *
 * `dormant` is the one legitimate way back: an enquiry that went quiet and
 * later returns is the same enquiry, and forcing a new lead for it would break
 * the first-touch attribution the whole module is built to preserve.
 *
 * `disqualified` is terminal and separate from `lost` on purpose. Lost means
 * MMAKF competed and did not win; disqualified means the enquiry was never one
 * the federation could serve. Counting them together would make the federation
 * look worse at converting than it is.
 */
export const LEAD_TRANSITIONS: Record<string, readonly string[]> = {
  new: ['qualifying', 'disqualified', 'dormant'],
  qualifying: ['qualified', 'disqualified', 'dormant', 'lost'],
  qualified: ['quoted', 'dormant', 'lost'],
  quoted: ['proposed', 'won', 'lost', 'dormant'],
  proposed: ['won', 'lost', 'dormant'],
  dormant: ['qualifying', 'qualified', 'disqualified'],
  won: [],
  lost: [],
  disqualified: [],
};

/** The statuses that end a lead's life in the pipeline. */
export const TERMINAL_LEAD_STATUSES: readonly string[] = ['won', 'lost', 'disqualified'];

/**
 * Move a lead along the pipeline.
 *
 * A REASON IS REQUIRED FOR EVERY TRANSITION, not only the unhappy ones. "Why is
 * this qualified?" is the question a second administrator asks three weeks
 * later, and the answer being absent is what makes a pipeline board an argument
 * rather than a record. It is written to the activity trail AND carried into
 * the audit context, so it survives in both places the federation looks.
 *
 * `lostReason` is stored on the lead itself only for the statuses where the
 * column means something. Writing the reason for `qualified` into a column
 * named `lost_reason` would put a sentence in a field every report reads as
 * "why we did not win".
 */
export async function setLeadStatus(
  db: DB,
  ctx: AuditContext,
  input: { leadId: number; status: string; reason: string }
) {
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new EngagementError(
      'reason_required',
      'Moving a lead requires a recorded reason. It is written to the lead’s activity trail and to the audit.'
    );
  }

  const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, input.leadId)).limit(1);
  if (!lead) throw new EngagementError('unknown_lead', 'No such lead.');

  // Authority over a lead is authority over where the lead is placed.
  assertCan(ctx.principal, 'engagement:write', {
    stateUnitId: lead.stateUnitId,
    districtUnitId: lead.districtUnitId,
  });

  if (lead.status === input.status) {
    throw new EngagementError('no_change', `This lead is already ${input.status}.`);
  }

  const allowed = LEAD_TRANSITIONS[lead.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw new EngagementError(
      'bad_transition',
      TERMINAL_LEAD_STATUSES.includes(lead.status)
        ? `This lead is ${lead.status}, which is final. Record the new enquiry rather than reopening the old one — `
          + 'reopening would lose the fact that this one closed, and the first-touch attribution with it.'
        : `A lead at ${lead.status} can move to ${allowed.join(', ') || 'nothing'} — not to ${input.status}.`
    );
  }

  const isLoss = input.status === 'lost' || input.status === 'disqualified';

  await db.update(s.leads).set({
    status: input.status as any,
    lostReason: isLoss ? reason : lead.lostReason,
    updatedAt: new Date(),
  }).where(eq(s.leads.id, input.leadId));

  await db.insert(s.leadActivities).values({
    leadId: input.leadId,
    kind: 'status_change',
    byUserId: ctx.principal.userId ?? null,
    summary: `${lead.status} → ${input.status}`,
    detail: { from: lead.status, to: input.status, reason } as any,
  });

  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: input.leadId,
    action: 'update',
    oldValue: { status: lead.status },
    newValue: { status: input.status },
  });

  return { leadId: input.leadId, from: lead.status, to: input.status };
}

/**
 * Give a lead an owner, or take one away.
 *
 * THE OWNER MUST BE A REAL, ACTIVE USER. `leads.owner_user_id` is a foreign key,
 * so a bad id would be refused by the database — but as a driver error rendered
 * as a 500, which tells the administrator nothing about what they typed. It is
 * checked here so the refusal is a sentence.
 *
 * IT DOES NOT CHECK WHAT THE OWNER MAY SEE, and that is deliberate rather than
 * an omission. Assignment is how work is handed to somebody, and a federation
 * that could only assign a lead to people who already had authority over it
 * could never hand one to a newly appointed officer. What the owner may actually
 * OPEN is decided by leadDetail() at the moment they open it, which is the only
 * place that decision stays correct as roles change.
 */
export async function assignLeadOwner(
  db: DB,
  ctx: AuditContext,
  input: { leadId: number; ownerUserId: number | null; reason?: string }
) {
  const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, input.leadId)).limit(1);
  if (!lead) throw new EngagementError('unknown_lead', 'No such lead.');

  assertCan(ctx.principal, 'engagement:write', {
    stateUnitId: lead.stateUnitId,
    districtUnitId: lead.districtUnitId,
  });

  let ownerLabel: string | null = null;
  if (input.ownerUserId != null) {
    // `users` carries no name of its own — the name is on the person the account
    // belongs to, and an account may have no person attached at all (the
    // bootstrap operator does not). The email is the fallback label, because a
    // lead assigned to "user 41" tells the next administrator nothing.
    const [owner] = await db
      .select({
        id: s.users.id,
        email: s.users.email,
        status: s.users.status,
        name: s.persons.fullName,
      })
      .from(s.users)
      .leftJoin(s.persons, eq(s.persons.id, s.users.personId))
      .where(eq(s.users.id, input.ownerUserId))
      .limit(1);
    if (!owner) throw new EngagementError('unknown_user', 'No such user, so the lead was not assigned.');
    if (owner.status !== 'active') {
      throw new EngagementError(
        'inactive_user',
        `That account is ${owner.status}. Assigning work to it would file the enquiry somewhere nobody is looking.`
      );
    }
    ownerLabel = owner.name ?? owner.email ?? null;
  }

  if ((lead.ownerUserId ?? null) === (input.ownerUserId ?? null)) {
    throw new EngagementError('no_change', input.ownerUserId == null
      ? 'This lead already has no owner.'
      : 'This lead is already assigned to that person.');
  }

  await db.update(s.leads).set({
    ownerUserId: input.ownerUserId,
    updatedAt: new Date(),
  }).where(eq(s.leads.id, input.leadId));

  await db.insert(s.leadActivities).values({
    leadId: input.leadId,
    kind: 'status_change',
    byUserId: ctx.principal.userId ?? null,
    summary: input.ownerUserId == null
      ? 'Owner removed'
      : `Assigned to ${ownerLabel ?? `user ${input.ownerUserId}`}`,
    detail: { from: lead.ownerUserId ?? null, to: input.ownerUserId ?? null, reason: input.reason ?? null } as any,
  });

  await writeAudit(db, ctx, {
    entityType: 'lead',
    entityId: input.leadId,
    action: 'update',
    oldValue: { ownerUserId: lead.ownerUserId ?? null },
    newValue: { ownerUserId: input.ownerUserId },
  });

  return { leadId: input.leadId, ownerUserId: input.ownerUserId };
}

/** The kinds of contact an administrator can record by hand. */
export const LEAD_ACTIVITY_KINDS: readonly string[] = ['note', 'call', 'email', 'meeting'];

/**
 * Record something that happened.
 *
 * `status_change` is NOT in the list above, and cannot be written through this
 * function. The activity trail is the evidence that a status moved; letting
 * somebody hand-write a `status_change` row would let them file a transition
 * that never happened, against a lead whose status column disagrees. Those rows
 * are written only by the functions that actually move the status.
 *
 * NO AUDIT ROW. A note is not a change to the federation's record of anything —
 * it is somebody writing down that they telephoned a school. The activity trail
 * already carries who wrote it and when, and copying every note into the audit
 * would bury the acts that matter under the correspondence.
 */
export async function addLeadActivity(
  db: DB,
  ctx: AuditContext,
  input: { leadId: number; kind: string; summary: string }
) {
  const summary = String(input.summary ?? '').trim();
  if (!summary) throw new EngagementError('empty_note', 'A note needs something in it.');
  if (summary.length > 2000) {
    throw new EngagementError(
      'note_too_long',
      'A note is limited to 2000 characters. Attach the detail elsewhere and summarise it here.'
    );
  }
  if (!LEAD_ACTIVITY_KINDS.includes(input.kind)) {
    throw new EngagementError(
      'bad_kind',
      `A recorded contact is one of ${LEAD_ACTIVITY_KINDS.join(', ')}. A status change is written by the act that changes it, never by hand.`
    );
  }

  const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, input.leadId)).limit(1);
  if (!lead) throw new EngagementError('unknown_lead', 'No such lead.');

  assertCan(ctx.principal, 'engagement:write', {
    stateUnitId: lead.stateUnitId,
    districtUnitId: lead.districtUnitId,
  });

  const [row] = await db.insert(s.leadActivities).values({
    leadId: input.leadId,
    kind: input.kind,
    byUserId: ctx.principal.userId ?? null,
    summary,
  }).returning({ id: s.leadActivities.id });

  // The lead has been touched, and the board orders on updatedAt. A note that
  // did not move the row would leave a lead somebody worked on today sitting at
  // the bottom of the list under leads nobody has opened in a month.
  await db.update(s.leads)
    .set({ updatedAt: new Date() })
    .where(eq(s.leads.id, input.leadId));

  return { activityId: row?.id ?? null, leadId: input.leadId };
}

// ─── Training requests ──────────────────────────────────────────────────────

/**
 * The questions each audience must answer.
 *
 * Required because a request that cannot be priced is a request somebody has to
 * telephone about, and the whole point of the intake is that most of them
 * should not need a telephone call. Deliberately SHORT: every field added here
 * is a field a real school administrator has to fill in on a phone.
 */
export const REQUIRED_PARAMETERS: Record<Audience, readonly string[]> = {
  individual: ['participants'],
  family: ['participants'],
  school: ['participants', 'ageGroups'],
  university: ['participants'],
  corporate: ['participants'],
  government: ['participants'],
  ngo: ['participants'],
  club: ['participants'],
  community: ['participants'],
  other: [],
};

export interface RequestInput {
  audience: Audience;
  leadId?: number | null;
  institutionId?: number | null;
  personId?: number | null;
  serviceId?: number | null;
  mode?: 'on_site' | 'at_dojo' | 'online' | 'hybrid' | null;
  parameters: Record<string, unknown>;
  preferredStartOn?: string | null;
  notes?: string | null;
}

/**
 * Record a structured training request.
 *
 * `parameters` is stored as given and NEVER edited afterwards by the quoting
 * path — a quote freezes its own copy (see src/db/fees.ts). That separation is
 * what lets an administrator correct a request without silently altering a
 * quotation somebody has already been sent.
 */
export async function submitTrainingRequest(
  db: DB,
  ctx: AuditContext | { principal: Principal | null },
  input: RequestInput
) {
  if (!AUDIENCES.includes(input.audience)) {
    throw new EngagementError('bad_audience', `Unknown audience: ${String(input.audience)}.`);
  }
  const params = input.parameters ?? {};
  const missing = REQUIRED_PARAMETERS[input.audience].filter(
    (k) => params[k] === undefined || params[k] === null || params[k] === ''
  );
  if (missing.length) {
    throw new EngagementError(
      'missing_parameters',
      `This request cannot be priced without: ${missing.join(', ')}.`
    );
  }

  // A participant count that is not a positive number would produce a quote
  // computed from nonsense, and the engine's per-unit rules would silently skip
  // rather than fail — so it is caught here, where it can still be explained.
  if (params.participants !== undefined) {
    const n = Number(params.participants);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      throw new EngagementError('bad_participants', 'Participants must be a whole number greater than zero.');
    }
  }

  const ref = await allocateFederationId(db, 'REQ', new Date().getUTCFullYear());
  const [row] = await db.insert(s.trainingRequests).values({
    ref,
    leadId: input.leadId ?? null,
    institutionId: input.institutionId ?? null,
    personId: input.personId ?? null,
    audience: input.audience as any,
    status: 'submitted',
    serviceId: input.serviceId ?? null,
    mode: (input.mode ?? null) as any,
    parameters: params as any,
    preferredStartOn: input.preferredStartOn ?? null,
    notes: input.notes ?? null,
  }).returning();

  if (input.leadId) {
    await db.insert(s.leadActivities).values({
      leadId: input.leadId, kind: 'request',
      summary: `Training request ${ref} submitted`,
      detail: { requestRef: ref, audience: input.audience } as any,
    });
    await db.update(s.leads)
      .set({ status: 'qualifying', updatedAt: new Date() })
      .where(and(eq(s.leads.id, input.leadId), eq(s.leads.status, 'new')));
  }

  return row;
}

// ─── Reading the pipeline ───────────────────────────────────────────────────

export interface PipelineOptions {
  status?: string[];
  audience?: Audience[];
  limit?: number;
}

/**
 * The lead pipeline, scoped to what the caller may see.
 *
 * A lead with no unit attached yet is visible only NATIONALLY. That is the
 * fail-closed reading: an unlocated enquiry could belong to any state, and
 * showing it to every state administrator would disclose one state's
 * prospective clients to another.
 */
export async function leadPipeline(
  db: DB, principal: Principal, opts: PipelineOptions = {}
) {
  if (!canAnywhere(principal, 'engagement:read')) {
    throw new EngagementError('forbidden', 'Reading the lead pipeline requires engagement:read.');
  }
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const where: SQL[] = [];

  if (opts.status?.length) where.push(inArray(s.leads.status, opts.status as any) as SQL);
  if (opts.audience?.length) where.push(inArray(s.leads.audience, opts.audience as any) as SQL);

  const scopes = visibleScopes(principal, 'engagement:read');
  if (scopes.kind === 'none') return { rows: [], truncated: false, scope: 'none' as const };
  if (scopes.kind === 'scoped') {
    const parts: SQL[] = [];
    if (scopes.states.length) parts.push(inArray(s.leads.stateUnitId, scopes.states) as SQL);
    if (scopes.districts.length) parts.push(inArray(s.leads.districtUnitId, scopes.districts) as SQL);
    if (!parts.length) return { rows: [], truncated: false, scope: 'none' as const };
    where.push(or(...parts) as SQL);
  }

  const found = await db.select().from(s.leads)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.leads.updatedAt))
    .limit(limit + 1);

  return {
    rows: found.slice(0, limit),
    truncated: found.length > limit,
    scope: scopes.kind,
  };
}

/** Everything recorded against one lead, newest activity first. */
export async function leadDetail(db: DB, principal: Principal, leadId: number) {
  if (!canAnywhere(principal, 'engagement:read')) {
    throw new EngagementError('forbidden', 'Reading a lead requires engagement:read.');
  }
  const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, leadId)).limit(1);
  if (!lead) throw new EngagementError('unknown_lead', 'No such lead.');

  assertCan(principal, 'engagement:read', {
    stateUnitId: lead.stateUnitId,
    districtUnitId: lead.districtUnitId,
  });

  const activities = await db.select().from(s.leadActivities)
    .where(eq(s.leadActivities.leadId, leadId))
    .orderBy(desc(s.leadActivities.at));
  const requests = await db.select().from(s.trainingRequests)
    .where(eq(s.trainingRequests.leadId, leadId))
    .orderBy(desc(s.trainingRequests.createdAt));

  return { lead, activities, requests };
}

/**
 * Attribution, counted.
 *
 * FIRST touch, deliberately. Counting last touch tells you which channel was
 * open when somebody finally acted; counting first touch tells you which one
 * introduced them, and that is the one the federation is deciding whether to
 * keep paying for.
 */
export async function sourceAttribution(db: DB, principal: Principal) {
  if (!canAnywhere(principal, 'engagement:read')) {
    throw new EngagementError('forbidden', 'Reading attribution requires engagement:read.');
  }
  const rows = await db
    .select({
      source: s.leads.firstSource,
      total: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${s.leads.status} = 'won')::int`,
    })
    .from(s.leads)
    .groupBy(s.leads.firstSource)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r: any) => ({
    ...r,
    // Reported as a fraction with its denominator, never as a bare percentage:
    // "1 of 1" and "340 of 340" are both 100% and mean entirely different things.
    wonOf: `${r.won} of ${r.total}`,
  }));
}
