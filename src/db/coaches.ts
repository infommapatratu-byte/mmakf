// Coach management — application, screening, approval, assignment, calendar.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO RULES THAT SHAPE THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. THE ENGINE RECOMMENDS; A PERSON DECIDES.
//
//    The federation asked for automatic coach assignment. What it gets is
//    automatic SHORTLISTING: rankCandidates() scores who is eligible and why,
//    writes them as 'recommended', and stops. Only confirmAssignment() — which
//    takes a principal and writes an audit row — can reach 'confirmed'.
//
//    This is not timidity. An assignment is somebody's Saturday, their travel,
//    and their income. A system that allocates those without a human in the
//    loop is a system that will one day allocate them wrongly at scale, and
//    PART W says in as many words: do not create unfair automated employment
//    decisions.
//
// 2. AN ABSENT CLEARANCE IS NOT A CLEARANCE.
//
//    `safeguardingClearedOn` is nullable, and NULL means NOT CLEARED. A coach
//    with no recorded child-protection clearance is excluded from any programme
//    involving minors — not warned about, excluded. The alternative reading,
//    "we have no record so it is probably fine", is how the wrong person ends up
//    in a room with children.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import * as o from './operations.schema';
import * as e from './engagement.schema';
import * as s from './schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import {
  assertCanAnywhere, canAnywhere, visibleScopes,
  type Principal,
} from '@/lib/rbac';

type DB = any;

export class CoachError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoachError';
    this.code = code;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isCoachError(err: unknown): err is CoachError {
  return !!err && typeof err === 'object' && (err as any).name === 'CoachError'
    && typeof (err as any).code === 'string';
}

export const COACH_STATUSES = [
  'candidate', 'screening', 'interview', 'technical_review', 'document_check',
  'approved', 'active', 'suspended', 'inactive', 'withdrawn', 'rejected',
] as const;
export type CoachStatus = (typeof COACH_STATUSES)[number];

/**
 * The lifecycle, as the federation described it.
 *
 * Backward steps are allowed where they are real — an interview that raises a
 * technical doubt sends the candidate back to technical_review — because
 * pretending recruitment is a straight line means recording an outcome that did
 * not happen. What is NOT allowed is skipping: a candidate cannot go from
 * 'candidate' straight to 'approved', because then nothing was screened and the
 * record would say otherwise.
 */
const COACH_TRANSITIONS: Record<CoachStatus, CoachStatus[]> = {
  candidate: ['screening', 'withdrawn', 'rejected'],
  screening: ['interview', 'technical_review', 'withdrawn', 'rejected'],
  interview: ['technical_review', 'screening', 'withdrawn', 'rejected'],
  technical_review: ['document_check', 'interview', 'withdrawn', 'rejected'],
  document_check: ['approved', 'technical_review', 'withdrawn', 'rejected'],
  approved: ['active', 'withdrawn'],
  active: ['suspended', 'inactive'],
  suspended: ['active', 'inactive'],
  inactive: ['active'],
  withdrawn: [],
  rejected: [],
};

const TERMINAL: CoachStatus[] = ['withdrawn', 'rejected'];

// ─── Applying ───────────────────────────────────────────────────────────────

export interface CoachApplyInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  danGrade?: string | null;
  gradeAwardedBy?: string | null;
  teachingYears?: number | null;
  competitionExperience?: string | null;
  qualificationsSummary?: string | null;
  preferredPrograms?: string[] | null;
  preferredLocations?: string[] | null;
  availabilityNote?: string | null;
  languages?: string[] | null;
  referees?: Array<{ name: string; relationship?: string; contact?: string }> | null;
  userId?: number | null;
  source?: Record<string, unknown> | null;
  now?: Date;
}

/**
 * A candidate applies. Public, unauthenticated.
 *
 * Creates a CANDIDATE RECORD and nothing else. No person record, no role
 * binding, no coach profile — those are consequences of being approved, and
 * minting them at application time would put every applicant into the
 * federation's own register of people.
 */
export async function applyAsCoach(db: DB, input: CoachApplyInput) {
  const now = input.now ?? new Date();
  const fullName = (input.fullName ?? '').trim();
  if (!fullName) throw new CoachError('no_name', 'A name is needed.');

  const email = (input.email ?? '').trim().toLowerCase() || null;
  const phone = (input.phone ?? '').replace(/[^\d+]/g, '') || null;
  if (!email && !phone) {
    throw new CoachError(
      'no_contact',
      'An email address or a telephone number is needed — otherwise MMAKF cannot tell you the outcome.'
    );
  }

  // An open application from the same person is returned rather than duplicated.
  // Someone who submits twice because the first page did not obviously succeed
  // should not become two candidates in the pipeline.
  if (email) {
    const [existing] = await db.select().from(o.coachApplications)
      .where(and(
        eq(o.coachApplications.email, email),
        inArray(o.coachApplications.status, ['candidate', 'screening', 'interview', 'technical_review', 'document_check'])
      )).limit(1);
    if (existing) return { ...existing, deduplicated: true };
  }

  const ref = await allocateFederationId(db, 'CA', now.getFullYear());

  const [row] = await db.insert(o.coachApplications).values({
    ref,
    fullName,
    email,
    phone,
    city: input.city ?? null,
    stateUnitId: input.stateUnitId ?? null,
    districtUnitId: input.districtUnitId ?? null,
    danGrade: input.danGrade ?? null,
    gradeAwardedBy: input.gradeAwardedBy ?? null,
    teachingYears: input.teachingYears ?? null,
    competitionExperience: input.competitionExperience ?? null,
    qualificationsSummary: input.qualificationsSummary ?? null,
    preferredPrograms: (input.preferredPrograms ?? null) as any,
    preferredLocations: (input.preferredLocations ?? null) as any,
    availabilityNote: input.availabilityNote ?? null,
    languages: (input.languages ?? null) as any,
    referees: (input.referees ?? null) as any,
    userId: input.userId ?? null,
    status: 'candidate',
    payload: (input as any),
    source: (input.source ?? null) as any,
    submittedAt: now,
  }).returning();

  await db.insert(o.coachStageEvents).values({
    applicationId: row.id, at: now,
    fromStatus: null, toStatus: 'candidate',
    outcome: 'submitted', note: 'Application received.',
  });

  return { ...row, deduplicated: false };
}

// ─── The pipeline ───────────────────────────────────────────────────────────

export async function advanceCoachApplication(
  db: DB,
  ctx: AuditContext,
  applicationId: number,
  to: CoachStatus,
  opts: { outcome?: string | null; note?: string | null; reason?: string | null } = {},
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'coach:review');

  const [app] = await db.select().from(o.coachApplications)
    .where(eq(o.coachApplications.id, applicationId)).limit(1);
  if (!app) throw new CoachError('not_found', `No coach application ${applicationId}.`);

  const from = app.status as CoachStatus;
  if (TERMINAL.includes(from)) {
    throw new CoachError('closed', `This application is already ${from}.`);
  }
  if (!COACH_TRANSITIONS[from]?.includes(to)) {
    throw new CoachError(
      'bad_transition',
      `A candidate cannot go from ${from} to ${to}. The recorded stages exist so that an approval means the stages before it actually happened.`
    );
  }
  if (to === 'rejected' && !opts.reason?.trim()) {
    throw new CoachError('reason_required', 'Say why the candidate is being turned down. They may ask.');
  }

  const [updated] = await db.update(o.coachApplications).set({
    status: to,
    decidedAt: TERMINAL.includes(to) || to === 'approved' ? now : app.decidedAt,
    decidedByUserId: TERMINAL.includes(to) || to === 'approved' ? (ctx.principal.userId ?? null) : app.decidedByUserId,
    decisionReason: opts.reason ?? app.decisionReason,
    updatedAt: now,
  }).where(and(eq(o.coachApplications.id, applicationId), eq(o.coachApplications.status, from)))
    .returning();

  if (!updated) throw new CoachError('conflict', 'The application changed while you were working on it.');

  // Append-only. A rejection that can be edited afterwards is a record of the
  // current opinion, not of the decision that was taken.
  await db.insert(o.coachStageEvents).values({
    applicationId, at: now,
    fromStatus: from, toStatus: to,
    outcome: opts.outcome ?? null,
    note: opts.note ?? opts.reason ?? null,
    actorUserId: ctx.principal.userId ?? null,
  });

  await writeAudit(db, { ...ctx, reason: opts.reason ?? ctx.reason }, {
    entityType: 'coach_application', entityId: applicationId,
    action: to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'update',
    oldValue: { status: from }, newValue: { status: to },
  });

  return updated;
}

/**
 * Turn an approved candidate into a coach the federation can assign.
 *
 * Requires a `personId`: the coach must exist in the federation's own register
 * of people first. Creating one here from the application would let the
 * recruitment queue write into the member register, which is the exact
 * separation that keeps applicants out of it.
 */
export async function activateCoach(
  db: DB,
  ctx: AuditContext,
  applicationId: number,
  personId: number,
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'coach:write');

  const [app] = await db.select().from(o.coachApplications)
    .where(eq(o.coachApplications.id, applicationId)).limit(1);
  if (!app) throw new CoachError('not_found', `No coach application ${applicationId}.`);
  if (app.status !== 'approved') {
    throw new CoachError('not_approved', `The candidate is ${app.status}, not approved.`);
  }

  const [person] = await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1);
  if (!person) throw new CoachError('no_person', `No person record ${personId}.`);

  const [profile] = await db.insert(o.coachProfiles).values({
    personId,
    status: 'active',
    danGrade: app.danGrade,
    languages: app.languages,
    programCodes: app.preferredPrograms,
    stateUnitId: app.stateUnitId,
    districtUnitId: app.districtUnitId,
    baseCity: app.city,
    approvedAt: now,
    approvedByUserId: ctx.principal.userId ?? null,
  }).onConflictDoUpdate({
    target: o.coachProfiles.personId,
    set: { status: 'active', approvedAt: now, approvedByUserId: ctx.principal.userId ?? null, updatedAt: now },
  }).returning();

  await db.update(o.coachApplications)
    .set({ coachProfileId: profile.id, personId, status: 'active', updatedAt: now })
    .where(eq(o.coachApplications.id, applicationId));

  await db.insert(o.coachStageEvents).values({
    applicationId, at: now, fromStatus: 'approved', toStatus: 'active',
    outcome: 'onboarded', note: `Coach profile ${profile.id} created.`,
    actorUserId: ctx.principal.userId ?? null,
  });

  await writeAudit(db, ctx, {
    entityType: 'coach_profile', entityId: profile.id, action: 'create',
    newValue: { personId, fromApplication: app.ref },
  });

  return profile;
}

export async function coachPipeline(
  db: DB, principal: Principal,
  opts: { status?: CoachStatus | CoachStatus[]; limit?: number } = {}
) {
  assertCanAnywhere(principal, 'coach:read');
  const scopes = visibleScopes(principal, 'coach:read');
  if (scopes.kind === 'none') return [];

  const where: any[] = [];
  if (scopes.kind === 'scoped') {
    const clauses: any[] = [];
    if (scopes.states.length) clauses.push(inArray(o.coachApplications.stateUnitId, scopes.states));
    if (scopes.districts.length) clauses.push(inArray(o.coachApplications.districtUnitId, scopes.districts));
    if (!clauses.length) return [];
    where.push(or(...clauses));
  }
  if (opts.status) {
    where.push(Array.isArray(opts.status)
      ? inArray(o.coachApplications.status, opts.status)
      : eq(o.coachApplications.status, opts.status));
  }

  const q = db.select().from(o.coachApplications);
  return (where.length ? q.where(and(...where)) : q)
    .orderBy(desc(o.coachApplications.submittedAt))
    .limit(Math.min(opts.limit ?? 100, 200));
}

export async function coachApplicationDetail(db: DB, principal: Principal, applicationId: number) {
  assertCanAnywhere(principal, 'coach:read');
  const [app] = await db.select().from(o.coachApplications)
    .where(eq(o.coachApplications.id, applicationId)).limit(1);
  if (!app) throw new CoachError('not_found', `No coach application ${applicationId}.`);

  const stages = await db.select().from(o.coachStageEvents)
    .where(eq(o.coachStageEvents.applicationId, applicationId))
    .orderBy(asc(o.coachStageEvents.at));

  // Documents are HR-sensitive by default. A coach manager sees that they
  // exist and were verified; only 'hr:read' sees where they are stored.
  const mayReadFiles = canAnywhere(principal, 'hr:read');
  const documents = await db.select().from(o.coachDocuments)
    .where(eq(o.coachDocuments.applicationId, applicationId));

  return {
    application: app,
    stages,
    documents: documents.map((d: any) =>
      mayReadFiles ? d : { ...d, storageKey: null, filename: d.filename ? '(held)' : null }
    ),
  };
}

// ─── Qualifications ─────────────────────────────────────────────────────────

export async function recordQualification(
  db: DB, ctx: AuditContext,
  input: {
    coachProfileId: number; kind: string; title: string;
    issuedBy?: string | null; issuedOn?: string | null; expiresOn?: string | null;
    referenceNo?: string | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'coach:write');
  const [row] = await db.insert(o.coachQualifications).values({
    coachProfileId: input.coachProfileId,
    kind: input.kind,
    title: input.title,
    issuedBy: input.issuedBy ?? null,
    issuedOn: input.issuedOn ?? null,
    expiresOn: input.expiresOn ?? null,
    referenceNo: input.referenceNo ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'coach_qualification', entityId: row.id, action: 'create',
    newValue: { coachProfileId: input.coachProfileId, kind: input.kind, title: input.title },
  });
  return row;
}

/**
 * Qualifications about to lapse, so somebody is told before they do.
 *
 * Expiry with no warning means a coach turns up to a school with an out-of-date
 * clearance and cannot work, which is a wasted journey for them and a cancelled
 * session for the school.
 *
 * SCOPED, like coachPipeline above. assertCanAnywhere() answers "may this
 * principal read coaches at all"; it does not answer "which ones", and this
 * query used to skip the second question entirely. The effect was that every
 * holder of coach:read — a district coach manager included — got a NATIONAL
 * list of names and child-protection clearances on /admin/coaches, for units
 * they have no standing in. The predicate belongs in the WHERE clause and not
 * in a filter over the result, so that the rows are never read in the first
 * place.
 */
export async function expiringQualifications(db: DB, principal: Principal, withinDays = 60, now = new Date()) {
  assertCanAnywhere(principal, 'coach:read');
  const scopes = visibleScopes(principal, 'coach:read');
  if (scopes.kind === 'none') return [];

  const horizon = new Date(now.getTime() + withinDays * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const where: any[] = [
    isNotNull(o.coachQualifications.expiresOn),
    lte(o.coachQualifications.expiresOn, horizon),
    gte(o.coachQualifications.expiresOn, today),
  ];

  if (scopes.kind === 'scoped') {
    // The coach's own unit, on the profile — the same two columns coachPipeline
    // scopes its candidates by.
    const clauses: any[] = [];
    if (scopes.states.length) clauses.push(inArray(o.coachProfiles.stateUnitId, scopes.states));
    if (scopes.districts.length) clauses.push(inArray(o.coachProfiles.districtUnitId, scopes.districts));
    // A scoped principal holding no unit sees nobody rather than everybody:
    // an empty scope list is an empty answer, never an absent filter.
    if (!clauses.length) return [];
    where.push(or(...clauses));
  }

  return db.select({
    qualification: o.coachQualifications,
    coachProfileId: o.coachProfiles.id,
    personId: o.coachProfiles.personId,
    fullName: s.persons.fullName,
  })
    .from(o.coachQualifications)
    .innerJoin(o.coachProfiles, eq(o.coachProfiles.id, o.coachQualifications.coachProfileId))
    .innerJoin(s.persons, eq(s.persons.id, o.coachProfiles.personId))
    .where(and(...where))
    .orderBy(asc(o.coachQualifications.expiresOn))
    .limit(200);
}

// ─── Availability and collision ─────────────────────────────────────────────

export interface Conflict {
  kind: 'booking' | 'session' | 'unavailable';
  ref: string;
  startsAt: Date;
  endsAt: Date;
  detail: string;
}

/**
 * Everything that stops a coach working a given interval.
 *
 * Overlap is `startsAt < otherEnd AND endsAt > otherStart` — half-open, so a
 * session ending at 17:00 does NOT collide with one starting at 17:00. Using
 * closed intervals here makes every back-to-back school timetable unbookable,
 * which is the shape most institutional work actually takes.
 *
 * `coachAvailability` rows of kind 'available' and 'tentative' are NOT
 * conflicts — they are the opposite. Only 'unavailable', 'leave' and 'travel'
 * block.
 */
export async function coachConflicts(
  db: DB, personId: number, startsAt: Date, endsAt: Date, ignoreBookingId?: number | null
): Promise<Conflict[]> {
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date)
      || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new CoachError('bad_interval', 'Both ends of the interval must be real dates.');
  }
  if (endsAt <= startsAt) {
    throw new CoachError('bad_interval', 'The interval ends before it starts.');
  }

  const conflicts: Conflict[] = [];

  const bookingRows = await db.select().from(e.bookings)
    .where(and(
      eq(e.bookings.coachPersonId, personId),
      inArray(e.bookings.status, ['proposed', 'confirmed', 'rescheduled']),
      sql`${e.bookings.startsAt} < ${endsAt}`,
      sql`${e.bookings.endsAt} > ${startsAt}`,
      ignoreBookingId ? sql`${e.bookings.id} <> ${ignoreBookingId}` : sql`true`
    ));
  for (const b of bookingRows) {
    conflicts.push({
      kind: 'booking', ref: b.ref,
      startsAt: b.startsAt, endsAt: b.endsAt,
      detail: `Already booked: ${b.kind}.`,
    });
  }

  const sessionRows = await db.select().from(o.programSessions)
    .where(and(
      eq(o.programSessions.coachPersonId, personId),
      inArray(o.programSessions.status, ['scheduled', 'rescheduled']),
      sql`${o.programSessions.startsAt} < ${endsAt}`,
      sql`${o.programSessions.endsAt} > ${startsAt}`
    ));
  for (const r of sessionRows) {
    conflicts.push({
      kind: 'session', ref: `session-${r.id}`,
      startsAt: r.startsAt, endsAt: r.endsAt,
      detail: 'Already teaching a programme session.',
    });
  }

  const blocks = await db.select().from(e.coachAvailability)
    .where(and(
      eq(e.coachAvailability.personId, personId),
      inArray(e.coachAvailability.kind, ['unavailable', 'leave', 'travel']),
      sql`${e.coachAvailability.startsAt} < ${endsAt}`,
      sql`${e.coachAvailability.endsAt} > ${startsAt}`
    ));
  for (const b of blocks) {
    conflicts.push({
      kind: 'unavailable', ref: `availability-${b.id}`,
      startsAt: b.startsAt, endsAt: b.endsAt,
      // `reason` is deliberately NOT included. It is private to the coach — the
      // scheduler needs to know somebody is away, not that it is a funeral.
      detail: b.kind === 'leave' ? 'On leave.' : b.kind === 'travel' ? 'Travelling.' : 'Unavailable.',
    });
  }

  return conflicts;
}

/** The same question about a venue. */
export async function venueConflicts(
  db: DB, venueId: number, startsAt: Date, endsAt: Date
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];

  const sessions = await db.select().from(o.programSessions)
    .where(and(
      eq(o.programSessions.venueId, venueId),
      inArray(o.programSessions.status, ['scheduled', 'rescheduled']),
      sql`${o.programSessions.startsAt} < ${endsAt}`,
      sql`${o.programSessions.endsAt} > ${startsAt}`
    ));
  for (const r of sessions) {
    conflicts.push({
      kind: 'session', ref: `session-${r.id}`,
      startsAt: r.startsAt, endsAt: r.endsAt,
      detail: 'The venue is already in use.',
    });
  }

  const blackouts = await db.select().from(o.venueBlackouts)
    .where(and(
      eq(o.venueBlackouts.venueId, venueId),
      sql`${o.venueBlackouts.startsAt} < ${endsAt}`,
      sql`${o.venueBlackouts.endsAt} > ${startsAt}`
    ));
  for (const b of blackouts) {
    conflicts.push({
      kind: 'unavailable', ref: `blackout-${b.id}`,
      startsAt: b.startsAt, endsAt: b.endsAt,
      detail: b.reason ?? 'The venue is closed.',
    });
  }

  return conflicts;
}

// ─── The assignment engine ──────────────────────────────────────────────────

export interface CandidateCriteria {
  startsAt: Date;
  endsAt: Date;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  city?: string | null;
  /** True when any participant is under 18 — turns safeguarding into a filter. */
  involvesMinors?: boolean;
  requiredLanguage?: string | null;
  programCode?: string | null;
  minDanGrade?: number | null;
}

export interface RankedCandidate {
  coachProfileId: number;
  personId: number;
  fullName: string;
  score: number;
  /** Every component, so a human can disagree with the ranking. */
  reasons: string[];
  conflicts: Conflict[];
  eligible: boolean;
  /** Why not, when not. Stated plainly because somebody will ask. */
  exclusions: string[];
}

function danToNumber(grade: string | null | undefined): number | null {
  if (!grade) return null;
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  const m = String(grade).toUpperCase().match(/\b(X|IX|VIII|VII|VI|V|IV|III|II|I)\b/);
  if (m && roman[m[1]]) return roman[m[1]];
  const d = String(grade).match(/(\d+)\s*dan/i);
  return d ? Number(d[1]) : null;
}

/**
 * Who could take this work, and how well each fits.
 *
 * ELIGIBILITY IS A HARD FILTER; SCORE IS ADVICE. An ineligible coach is
 * returned with `eligible: false` and the reason, rather than being dropped —
 * an administrator asking "why isn't Vikas on this list?" deserves an answer,
 * and a silently shorter list does not give one.
 */
export async function rankCandidates(
  db: DB, principal: Principal, criteria: CandidateCriteria
): Promise<RankedCandidate[]> {
  assertCanAnywhere(principal, 'coach:read');

  const profiles = await db.select({
    profile: o.coachProfiles,
    fullName: s.persons.fullName,
  })
    .from(o.coachProfiles)
    .innerJoin(s.persons, eq(s.persons.id, o.coachProfiles.personId))
    .where(eq(o.coachProfiles.status, 'active'))
    .limit(500);

  const today = (criteria.startsAt ?? new Date()).toISOString().slice(0, 10);
  const out: RankedCandidate[] = [];

  for (const { profile, fullName } of profiles) {
    const reasons: string[] = [];
    const exclusions: string[] = [];
    let score = 0;

    // ── Hard filters ──
    const conflicts = await coachConflicts(db, profile.personId, criteria.startsAt, criteria.endsAt);
    if (conflicts.length) exclusions.push(`Not free: ${conflicts[0].detail}`);

    if (criteria.involvesMinors) {
      // NULL is not clearance. See the header note.
      if (!profile.safeguardingClearedOn) {
        exclusions.push('No safeguarding clearance on record, and this programme involves children.');
      } else if (profile.safeguardingExpiresOn && profile.safeguardingExpiresOn < today) {
        exclusions.push(`Safeguarding clearance lapsed on ${profile.safeguardingExpiresOn}.`);
      } else {
        score += 20;
        reasons.push('safeguarding clearance current (+20)');
      }
    }

    if (criteria.minDanGrade != null) {
      const held = danToNumber(profile.danGrade);
      if (held == null) {
        exclusions.push('No Dan grade recorded, and this programme states a minimum.');
      } else if (held < criteria.minDanGrade) {
        exclusions.push(`Holds ${profile.danGrade}; the programme asks for ${criteria.minDanGrade} Dan or above.`);
      } else {
        const bonus = Math.min(15, (held - criteria.minDanGrade) * 5 + 5);
        score += bonus;
        reasons.push(`${profile.danGrade} (+${bonus})`);
      }
    }

    // ── Soft scoring ──
    if (criteria.districtUnitId != null && profile.districtUnitId === criteria.districtUnitId) {
      score += 25; reasons.push('based in the same district (+25)');
    } else if (criteria.stateUnitId != null && profile.stateUnitId === criteria.stateUnitId) {
      score += 15; reasons.push('based in the same state (+15)');
    } else if (profile.travelRadiusKm != null && profile.travelRadiusKm >= 100) {
      score += 5; reasons.push('willing to travel (+5)');
    } else {
      reasons.push('no geographic match recorded (+0)');
    }

    if (criteria.city && profile.baseCity
        && String(profile.baseCity).trim().toLowerCase() === criteria.city.trim().toLowerCase()) {
      score += 10; reasons.push('same city (+10)');
    }

    if (criteria.requiredLanguage) {
      const langs = Array.isArray(profile.languages) ? profile.languages.map((l: any) => String(l).toLowerCase()) : [];
      if (langs.includes(criteria.requiredLanguage.toLowerCase())) {
        score += 10; reasons.push(`speaks ${criteria.requiredLanguage} (+10)`);
      } else if (langs.length) {
        exclusions.push(`Does not speak ${criteria.requiredLanguage}, which this programme requires.`);
      }
    }

    if (criteria.programCode) {
      const codes = Array.isArray(profile.programCodes) ? profile.programCodes.map(String) : [];
      if (codes.includes(criteria.programCode)) {
        score += 15; reasons.push('cleared for this programme (+15)');
      }
    }

    // ── Load ──
    // Counted, not guessed. A coach already at their stated weekly maximum is
    // excluded rather than merely scored down: the limit is something they told
    // the federation, not a preference to be traded off.
    if (profile.maxSessionsPerWeek != null) {
      const weekStart = new Date(criteria.startsAt.getTime() - 3 * 86_400_000);
      const weekEnd = new Date(criteria.startsAt.getTime() + 4 * 86_400_000);
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(o.programSessions)
        .where(and(
          eq(o.programSessions.coachPersonId, profile.personId),
          inArray(o.programSessions.status, ['scheduled', 'rescheduled']),
          gte(o.programSessions.startsAt, weekStart),
          lte(o.programSessions.startsAt, weekEnd)
        ));
      if (n >= profile.maxSessionsPerWeek) {
        exclusions.push(`Already at their stated limit of ${profile.maxSessionsPerWeek} sessions that week.`);
      } else {
        const headroom = profile.maxSessionsPerWeek - n;
        score += Math.min(10, headroom * 2);
        reasons.push(`${headroom} session(s) of headroom that week (+${Math.min(10, headroom * 2)})`);
      }
    }

    out.push({
      coachProfileId: profile.id,
      personId: profile.personId,
      fullName,
      score: Math.min(100, score),
      reasons,
      conflicts,
      eligible: exclusions.length === 0,
      exclusions,
    });
  }

  return out.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.fullName.localeCompare(b.fullName)
  );
}

/**
 * Write the shortlist as 'recommended' rows for a human to act on.
 *
 * Recommends the top `take` ELIGIBLE candidates and no one else. The ineligible
 * are returned to the caller for display but never written as recommendations —
 * a recommendation row is a suggestion the federation has made, and suggesting
 * an uncleared coach for a children's programme is not a suggestion the
 * federation should make even with a caveat attached.
 */
export async function recommendCoaches(
  db: DB, ctx: AuditContext,
  input: { programId: number; criteria: CandidateCriteria; take?: number },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'coach:assign');

  const ranked = await rankCandidates(db, ctx.principal, input.criteria);
  const eligible = ranked.filter((c) => c.eligible).slice(0, input.take ?? 3);

  const written: any[] = [];
  for (const c of eligible) {
    const [existing] = await db.select().from(o.coachAssignments)
      .where(and(
        eq(o.coachAssignments.programId, input.programId),
        eq(o.coachAssignments.coachPersonId, c.personId),
        inArray(o.coachAssignments.status, ['recommended', 'proposed', 'accepted', 'confirmed'])
      )).limit(1);
    if (existing) { written.push(existing); continue; }

    const [row] = await db.insert(o.coachAssignments).values({
      programId: input.programId,
      coachPersonId: c.personId,
      coachProfileId: c.coachProfileId,
      status: 'recommended',
      score: c.score,
      rationale: { reasons: c.reasons, criteria: { ...input.criteria, startsAt: input.criteria.startsAt.toISOString(), endsAt: input.criteria.endsAt.toISOString() } } as any,
      recommendedAt: now,
    }).returning();
    written.push(row);
  }

  await writeAudit(db, ctx, {
    entityType: 'coach_assignment', entityId: input.programId, action: 'create',
    newValue: { programId: input.programId, recommended: written.map((w) => w.coachPersonId) },
  });

  return { recommended: written, considered: ranked };
}

/**
 * A human confirms an assignment.
 *
 * Re-checks conflicts AT CONFIRMATION TIME. The recommendation may be hours or
 * days old, and the coach may have been booked for something else since — a
 * confirmation that trusts a stale shortlist is how two schools are promised
 * the same person on the same morning.
 */
export async function confirmAssignment(
  db: DB, ctx: AuditContext, assignmentId: number,
  window: { startsAt: Date; endsAt: Date },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'coach:assign');

  const [assignment] = await db.select().from(o.coachAssignments)
    .where(eq(o.coachAssignments.id, assignmentId)).limit(1);
  if (!assignment) throw new CoachError('not_found', `No assignment ${assignmentId}.`);
  if (assignment.status === 'confirmed') return assignment;
  if (['declined', 'withdrawn', 'completed'].includes(assignment.status)) {
    throw new CoachError('closed', `That assignment is ${assignment.status}.`);
  }

  const conflicts = await coachConflicts(db, assignment.coachPersonId, window.startsAt, window.endsAt);
  if (conflicts.length) {
    throw new CoachError(
      'conflict',
      `That coach is no longer free: ${conflicts.map((c) => c.detail).join(' ')}`
    );
  }

  const [updated] = await db.update(o.coachAssignments).set({
    status: 'confirmed',
    decidedAt: now,
    decidedByUserId: ctx.principal.userId ?? null,
  }).where(and(eq(o.coachAssignments.id, assignmentId), eq(o.coachAssignments.status, assignment.status)))
    .returning();

  if (!updated) throw new CoachError('conflict', 'The assignment changed while you were working on it.');

  await writeAudit(db, ctx, {
    entityType: 'coach_assignment', entityId: assignmentId, action: 'approve',
    oldValue: { status: assignment.status }, newValue: { status: 'confirmed' },
  });

  return updated;
}

export async function declineAssignment(
  db: DB, ctx: AuditContext, assignmentId: number, reason: string, now = new Date()
) {
  if (!reason?.trim()) throw new CoachError('reason_required', 'Say why the assignment is declined.');
  const [updated] = await db.update(o.coachAssignments).set({
    status: 'declined', decidedAt: now,
    decidedByUserId: ctx.principal.userId ?? null,
    declineReason: reason,
  }).where(eq(o.coachAssignments.id, assignmentId)).returning();
  if (!updated) throw new CoachError('not_found', `No assignment ${assignmentId}.`);
  return updated;
}

// ─── The coach's calendar ───────────────────────────────────────────────────

export interface CalendarEntry {
  kind: 'booking' | 'session' | 'leave' | 'travel' | 'unavailable' | 'tentative';
  ref: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  venue?: string | null;
  institutionId?: number | null;
  status?: string | null;
}

/**
 * One coach's diary between two instants.
 *
 * PART AC: "Coach A cannot access Coach B's private calendar." So this refuses
 * unless the caller IS that coach, or holds 'coach:read' — and even then the
 * `reason` on an availability block is never returned, because a manager
 * needing to know somebody is away does not need to know why.
 */
export async function coachCalendar(
  db: DB, principal: Principal, personId: number, from: Date, to: Date
): Promise<CalendarEntry[]> {
  const isSelf = await personBelongsToUser(db, personId, principal.userId);
  if (!isSelf) assertCanAnywhere(principal, 'coach:read');

  if (!(from instanceof Date) || !(to instanceof Date)
      || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new CoachError('bad_range', 'Both ends of the range must be real dates.');
  }
  if (to <= from) throw new CoachError('bad_range', 'The range ends before it starts.');

  const entries: CalendarEntry[] = [];

  const bookingRows = await db.select().from(e.bookings)
    .where(and(
      eq(e.bookings.coachPersonId, personId),
      sql`${e.bookings.startsAt} < ${to}`,
      sql`${e.bookings.endsAt} > ${from}`,
      inArray(e.bookings.status, ['proposed', 'confirmed', 'rescheduled', 'completed'])
    ));
  for (const b of bookingRows) {
    entries.push({
      kind: 'booking', ref: b.ref, title: b.kind,
      startsAt: b.startsAt, endsAt: b.endsAt,
      venue: b.venue, institutionId: b.institutionId, status: b.status,
    });
  }

  const sessions = await db.select({
    session: o.programSessions,
    programTitle: e.trainingPrograms.title,
    institutionId: e.trainingPrograms.institutionId,
    venueName: o.venues.name,
  })
    .from(o.programSessions)
    .leftJoin(e.trainingPrograms, eq(e.trainingPrograms.id, o.programSessions.programId))
    .leftJoin(o.venues, eq(o.venues.id, o.programSessions.venueId))
    .where(and(
      eq(o.programSessions.coachPersonId, personId),
      sql`${o.programSessions.startsAt} < ${to}`,
      sql`${o.programSessions.endsAt} > ${from}`
    ));
  for (const r of sessions) {
    entries.push({
      kind: 'session', ref: `session-${r.session.id}`,
      title: r.session.title ?? r.programTitle ?? 'Programme session',
      startsAt: r.session.startsAt, endsAt: r.session.endsAt,
      venue: r.venueName, institutionId: r.institutionId, status: r.session.status,
    });
  }

  const availability = await db.select().from(e.coachAvailability)
    .where(and(
      eq(e.coachAvailability.personId, personId),
      sql`${e.coachAvailability.startsAt} < ${to}`,
      sql`${e.coachAvailability.endsAt} > ${from}`
    ));
  for (const a of availability) {
    if (a.kind === 'available') continue;   // the default; nothing to draw
    entries.push({
      kind: a.kind as CalendarEntry['kind'],
      ref: `availability-${a.id}`,
      // The coach sees their own note; nobody else does.
      title: isSelf ? (a.reason ?? a.kind) : a.kind,
      startsAt: a.startsAt, endsAt: a.endsAt,
    });
  }

  return entries.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
}

async function personBelongsToUser(db: DB, personId: number, userId: number | null | undefined): Promise<boolean> {
  if (userId == null) return false;
  const [row] = await db.select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.id, userId), eq(s.users.personId, personId)))
    .limit(1);
  return !!row;
}

/** Record when a coach is unavailable. The coach themselves, or their manager. */
export async function setAvailability(
  db: DB, ctx: AuditContext,
  input: { personId: number; kind: 'available' | 'unavailable' | 'leave' | 'travel' | 'tentative'; startsAt: Date; endsAt: Date; reason?: string | null }
) {
  const isSelf = await personBelongsToUser(db, input.personId, ctx.principal.userId);
  if (!isSelf) assertCanAnywhere(ctx.principal, 'coach:write');

  if (input.endsAt <= input.startsAt) {
    throw new CoachError('bad_interval', 'The interval ends before it starts.');
  }

  // Marking yourself unavailable over a confirmed booking is refused rather
  // than silently accepted: the booking has a school expecting somebody, and
  // the right action is to cancel or reassign it, not to make the diary
  // disagree with the commitment.
  if (input.kind !== 'available' && input.kind !== 'tentative') {
    const clashes = await coachConflicts(db, input.personId, input.startsAt, input.endsAt);
    const committed = clashes.filter((c) => c.kind === 'booking' || c.kind === 'session');
    if (committed.length) {
      throw new CoachError(
        'committed',
        `There is already a commitment in that period (${committed[0].detail}). Cancel or reassign it first.`
      );
    }
  }

  const [row] = await db.insert(e.coachAvailability).values({
    personId: input.personId,
    kind: input.kind,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    reason: input.reason ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  return row;
}
