// Officials — referees, judges, examiners, instructors, coaches and technical
// delegates: licensing, validity, CPD and appointment.
//
// Q-12. The rule this module exists to enforce: AN EXPIRED LICENCE MUST NEVER
// SILENTLY PRODUCE A VALID OFFICIAL ACT. A referee whose licence lapsed in March
// scoring a national final in June is not a paperwork problem — every result
// they touched becomes challengeable, and the federation cannot defend any of
// them.
//
// So validity is always asked AS AT A DATE, never "is it valid now", and every
// appointment freezes the licence it relied on.
//
// What is NOT here, deliberately: no CPD hour requirement, no licence duration,
// no renewal window, no level progression. Those are federation policy. The
// module reports what is configured and says plainly when nothing is.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan, assertCanAnywhere, type Principal } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class OfficialsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfficialsError';
    this.code = code;
  }
}

/** The registries a person can hold a credential in. Each is a separate table. */
export type Registry = 'instructor' | 'examiner' | 'official';

const TABLES = {
  instructor: s.instructorQuals,
  examiner: s.examinerQuals,
  official: s.officialQuals,
} as const;

function today(on: Date = new Date()): string {
  return on.toISOString().slice(0, 10);
}

// ─── Validity ───────────────────────────────────────────────────────────────

export interface LicenceValidity {
  valid: boolean;
  /** Why, in terms a person can act on — not a boolean nobody can argue with. */
  reason: string;
  registry: Registry;
  qualificationId?: number;
  level?: string | null;
  scope?: string | null;
  expiresOn?: string | null;
  /** Days until expiry; negative when already lapsed. Null when open-ended. */
  daysRemaining?: number | null;
}

/**
 * Is this person licensed in this registry AS AT a date?
 *
 * The date matters and is never defaulted away. Appointing an official for a
 * championship three months out must check validity ON THE DAY OF THE EVENT, not
 * today — otherwise a licence that lapses in between is appointed anyway, and
 * nobody notices until a result is challenged.
 */
export async function licenceValidity(
  db: DB,
  personId: number,
  registry: Registry,
  asAt: string
): Promise<LicenceValidity> {
  const table = TABLES[registry];
  if (!table) throw new OfficialsError('unknown_registry', `Unknown registry: ${registry}`);

  const rows = await db.select().from(table).where(eq(table.personId, personId));

  if (rows.length === 0) {
    return { valid: false, reason: `Holds no ${registry} qualification.`, registry };
  }

  // Sort so the strongest claim is considered first: active before anything
  // else, then the latest expiry.
  const ranked = [...rows].sort((a: any, b: any) => {
    if ((a.status === 'active') !== (b.status === 'active')) return a.status === 'active' ? -1 : 1;
    return String(b.expiresOn ?? '9999-12-31').localeCompare(String(a.expiresOn ?? '9999-12-31'));
  });

  for (const q of ranked) {
    if (q.status !== 'active') continue;
    if (q.grantedOn && q.grantedOn > asAt) continue;          // not yet in force
    if (q.expiresOn && q.expiresOn < asAt) continue;          // lapsed by that date

    const daysRemaining = q.expiresOn
      ? Math.round((Date.parse(`${q.expiresOn}T00:00:00Z`) - Date.parse(`${asAt}T00:00:00Z`)) / 86_400_000)
      : null;

    return {
      valid: true,
      reason: q.expiresOn
        ? `Licensed at ${asAt}; valid to ${q.expiresOn}.`
        : `Licensed at ${asAt}; no expiry recorded.`,
      registry,
      qualificationId: q.id,
      level: q.level ?? null,
      scope: (q as any).scope ?? (q as any).kind ?? null,
      expiresOn: q.expiresOn ?? null,
      daysRemaining,
    };
  }

  // Nothing valid — say precisely why, using the best candidate.
  const best = ranked[0];
  const reason =
    best.status !== 'active'
      ? `Qualification is ${best.status}.`
      : best.expiresOn && best.expiresOn < asAt
        ? `Qualification expired on ${best.expiresOn}, before ${asAt}.`
        : best.grantedOn && best.grantedOn > asAt
          ? `Qualification does not take effect until ${best.grantedOn}, after ${asAt}.`
          : 'No valid qualification at that date.';

  return {
    valid: false,
    reason,
    registry,
    qualificationId: best.id,
    level: best.level ?? null,
    expiresOn: best.expiresOn ?? null,
  };
}

/**
 * Assert validity, or throw with the reason.
 *
 * Every path that produces an official act should go through this rather than
 * checking a status column, because a status column does not know what date the
 * act happens on.
 */
export async function assertLicensed(
  db: DB,
  personId: number,
  registry: Registry,
  asAt: string
): Promise<LicenceValidity> {
  const validity = await licenceValidity(db, personId, registry, asAt);
  if (!validity.valid) {
    throw new OfficialsError('not_licensed', `Cannot proceed: ${validity.reason}`);
  }
  return validity;
}

// ─── Granting and withdrawal ────────────────────────────────────────────────

export interface GrantInput {
  personId: number;
  registry: Registry;
  level: string;
  /** Examiner: which grades they may examine. Official: referee | judge | … */
  scope?: string;
  kind?: string;
  grantedOn: string;
  expiresOn?: string | null;
  authorityPersonId?: number | null;
  cpdDueOn?: string | null;
}

/**
 * Grant a licence.
 *
 * No default expiry is applied. A licence duration is federation policy, and
 * quietly stamping one on would either expire someone the federation intended to
 * license indefinitely, or leave a licence open-ended that was meant to lapse.
 * An absent expiry is recorded as absent, and `licenceStanding()` reports it so
 * the office can see which licences carry no review date.
 */
export async function grantLicence(db: DB, ctx: AuditContext, input: GrantInput) {
  assertCanAnywhere(ctx.principal, 'user:write');

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new OfficialsError('unknown_person', 'Unknown person');

  if (input.expiresOn && input.expiresOn <= input.grantedOn) {
    throw new OfficialsError('bad_dates', 'A licence cannot expire on or before the date it was granted.');
  }

  let row;
  try {
    if (input.registry === 'instructor') {
      [row] = await db.insert(s.instructorQuals).values({
        personId: input.personId, level: input.level,
        grantedOn: input.grantedOn, expiresOn: input.expiresOn ?? null,
        status: 'active', authorityUserId: ctx.principal.userId ?? null,
      }).returning();
    } else if (input.registry === 'examiner') {
      if (!input.scope) {
        throw new OfficialsError('scope_required', 'An examiner licence must state which grades it covers.');
      }
      [row] = await db.insert(s.examinerQuals).values({
        personId: input.personId, level: input.level, scope: input.scope,
        grantedOn: input.grantedOn, expiresOn: input.expiresOn ?? null, status: 'active',
      }).returning();
    } else {
      if (!input.kind) {
        throw new OfficialsError('kind_required', 'An officiating licence must state its kind (referee, judge, …).');
      }
      [row] = await db.insert(s.officialQuals).values({
        personId: input.personId, kind: input.kind, level: input.level,
        grantedOn: input.grantedOn, expiresOn: input.expiresOn ?? null,
        cpdDueOn: input.cpdDueOn ?? null, status: 'active',
      }).returning();
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OfficialsError('duplicate', 'That licence already exists for this person.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: `${input.registry}_qualification`,
    entityId: row.id,
    action: 'create',
    newValue: { personId: input.personId, level: input.level, grantedOn: input.grantedOn, expiresOn: input.expiresOn ?? null },
  });
  return row;
}

/**
 * Withdraw a licence. Never deletes — status moves and the reason is recorded.
 *
 * Deleting would erase the fact that the person was ever licensed, which matters
 * because acts they performed while licensed remain valid. A withdrawn licence
 * must still explain a past appointment.
 */
export async function withdrawLicence(
  db: DB,
  ctx: AuditContext,
  input: { registry: Registry; qualificationId: number; status: 'suspended' | 'revoked' | 'expired'; reason: string }
) {
  assertCanAnywhere(ctx.principal, 'user:write');
  if (!input.reason?.trim()) {
    throw new OfficialsError('reason_required', 'Withdrawing a licence requires a reason.');
  }

  const table = TABLES[input.registry];
  const before = (await db.select().from(table).where(eq(table.id, input.qualificationId)).limit(1))[0];
  if (!before) throw new OfficialsError('unknown_licence', 'Unknown licence');

  await db.update(table).set({ status: input.status }).where(eq(table.id, input.qualificationId));

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: `${input.registry}_qualification`,
    entityId: input.qualificationId,
    action: 'revoke',
    oldValue: { status: before.status },
    newValue: { status: input.status },
  });
}

// ─── CPD ────────────────────────────────────────────────────────────────────

/**
 * Record continuing professional development.
 *
 * Stored as an enrolment against a course, because CPD IS course attendance —
 * modelling it separately would create a second, divergent record of the same
 * fact. `cpdDueOn` on the licence is the review date; whether a given course
 * satisfies it is a federation judgement, so this records the activity and does
 * not silently clear the due date.
 */
export async function recordCpd(
  db: DB,
  ctx: AuditContext,
  input: { personId: number; courseId: number; completedOn: string; note?: string }
) {
  assertCanAnywhere(ctx.principal, 'user:write');

  const [enrolment] = await db.insert(s.enrolments).values({
    courseId: input.courseId,
    personId: input.personId,
    status: 'completed',
    completedAt: new Date(`${input.completedOn}T00:00:00Z`),
    progressPercent: 100,
  }).onConflictDoUpdate({
    target: [s.enrolments.courseId, s.enrolments.personId],
    set: { status: 'completed', completedAt: new Date(`${input.completedOn}T00:00:00Z`), progressPercent: 100 },
  }).returning();

  await writeAudit(db, { ...ctx, reason: input.note ?? null }, {
    entityType: 'cpd',
    entityId: enrolment.id,
    action: 'create',
    newValue: { personId: input.personId, courseId: input.courseId, completedOn: input.completedOn },
  });
  return enrolment;
}

// ─── Standing report ────────────────────────────────────────────────────────

export interface Standing {
  personId: number;
  fullName: string;
  federationId: string;
  registries: Array<{
    registry: Registry;
    level: string | null;
    status: string;
    grantedOn: string | null;
    expiresOn: string | null;
    daysRemaining: number | null;
    /** Present when the federation has recorded no expiry for this licence. */
    openEnded: boolean;
    cpdDueOn?: string | null;
  }>;
}

/**
 * Every licence a person holds, with its standing at a date.
 *
 * `openEnded` is surfaced rather than hidden: a licence with no expiry may be
 * intentional or may be an omission, and only the office can tell. Presenting it
 * as "valid" without qualification would hide the question.
 */
export async function licenceStanding(db: DB, personId: number, asAt: string = today()): Promise<Standing | null> {
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) return null;

  const registries: Standing['registries'] = [];

  for (const registry of ['instructor', 'examiner', 'official'] as Registry[]) {
    const table = TABLES[registry];
    const rows = await db.select().from(table).where(eq(table.personId, personId));
    for (const q of rows) {
      registries.push({
        registry,
        level: q.level ?? null,
        status: q.status,
        grantedOn: q.grantedOn ?? null,
        expiresOn: q.expiresOn ?? null,
        daysRemaining: q.expiresOn
          ? Math.round((Date.parse(`${q.expiresOn}T00:00:00Z`) - Date.parse(`${asAt}T00:00:00Z`)) / 86_400_000)
          : null,
        openEnded: !q.expiresOn,
        cpdDueOn: (q as any).cpdDueOn ?? null,
      });
    }
  }

  return {
    personId: person.id,
    fullName: person.fullName,
    federationId: person.federationId,
    registries,
  };
}

/**
 * Licences lapsing within a window — what the office needs to act on.
 *
 * Deliberately includes ALREADY-LAPSED licences too, because those are the
 * dangerous ones: a lapsed official still appearing on an appointment list is
 * how an invalid act happens.
 */
export async function expiringLicences(db: DB, principal: Principal, withinDays = 90, asAt: string = today()) {
  assertCanAnywhere(principal, 'user:read');

  const horizon = new Date(Date.parse(`${asAt}T00:00:00Z`) + withinDays * 86_400_000)
    .toISOString().slice(0, 10);

  const out: Array<Record<string, unknown>> = [];

  for (const registry of ['instructor', 'examiner', 'official'] as Registry[]) {
    const table = TABLES[registry];
    const rows = await db
      .select({
        id: table.id,
        personId: table.personId,
        level: table.level,
        status: table.status,
        expiresOn: table.expiresOn,
        fullName: s.persons.fullName,
        federationId: s.persons.federationId,
      })
      .from(table)
      .innerJoin(s.persons, eq(table.personId, s.persons.id))
      .where(and(
        eq(table.status, 'active'),
        sql`${table.expiresOn} IS NOT NULL`,
        sql`${table.expiresOn} <= ${horizon}`
      ));

    for (const r of rows) {
      out.push({
        ...r,
        registry,
        lapsed: Boolean(r.expiresOn && r.expiresOn < asAt),
        daysRemaining: r.expiresOn
          ? Math.round((Date.parse(`${r.expiresOn}T00:00:00Z`) - Date.parse(`${asAt}T00:00:00Z`)) / 86_400_000)
          : null,
      });
    }
  }

  // Already-lapsed first, then soonest to lapse.
  return out.sort((a: any, b: any) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
}

// ─── Appointment ────────────────────────────────────────────────────────────

/**
 * Appoint an official to an event, verifying the licence AS AT the event date
 * and freezing it.
 *
 * The frozen snapshot is what lets the federation answer, years later, "was this
 * referee licensed when they officiated that final?" — from the record, without
 * relying on a licence table that has moved on since.
 */
export async function appointOfficial(
  db: DB,
  ctx: AuditContext,
  input: { eventId: number; personId: number; role: string; mat?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'competition:write');

  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, input.eventId)).limit(1))[0];
  if (!event) throw new OfficialsError('unknown_event', 'Unknown event');

  const asAt = event.startsOn ?? today();

  // Which registry the role draws its authority from.
  const registry: Registry | null =
    ['referee', 'judge', 'technical_delegate', 'tatami_manager'].includes(input.role) ? 'official'
      : input.role === 'examiner' ? 'examiner'
        : input.role === 'coach' ? 'instructor'
          : null;

  let snapshot: unknown = null;
  if (registry) {
    // Checked against the EVENT date, not today.
    const validity = await assertLicensed(db, input.personId, registry, asAt);
    snapshot = { asAt, validity };
  } else {
    // Medical, media and volunteer roles carry no federation licence; recorded
    // as such rather than silently treated as licensed.
    snapshot = { asAt, validity: { valid: true, reason: 'Role carries no federation licence requirement.' } };
  }

  let row;
  try {
    [row] = await db.insert(s.eventOfficials).values({
      eventId: input.eventId,
      personId: input.personId,
      role: input.role,
      mat: input.mat ?? null,
      licenceSnapshot: snapshot as any,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OfficialsError('already_appointed', 'That person is already appointed to this event in that role.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'event_official',
    entityId: row.id,
    action: 'create',
    newValue: { eventId: input.eventId, personId: input.personId, role: input.role, asAt },
  });
  return row;
}

/**
 * Record an evaluation of an official's performance at an event.
 *
 * Kept on the appointment rather than on the licence, because an evaluation is
 * about one occasion. Aggregating them into a licence-level judgement is a
 * federation decision, not an arithmetic one.
 */
export async function evaluateOfficial(
  db: DB,
  ctx: AuditContext,
  input: { appointmentId: number; evaluatorPersonId: number; ratings: Record<string, number>; comment?: string }
) {
  assertCanAnywhere(ctx.principal, 'competition:write');

  const before = (await db.select().from(s.eventOfficials)
    .where(eq(s.eventOfficials.id, input.appointmentId)).limit(1))[0];
  if (!before) throw new OfficialsError('unknown_appointment', 'Unknown appointment');

  const evaluation = {
    evaluatorPersonId: input.evaluatorPersonId,
    ratings: input.ratings,
    comment: input.comment ?? null,
    at: new Date().toISOString(),
  };

  await db.update(s.eventOfficials)
    .set({ evaluation: evaluation as any })
    .where(eq(s.eventOfficials.id, input.appointmentId));

  await writeAudit(db, ctx, {
    entityType: 'event_official',
    entityId: input.appointmentId,
    action: 'update',
    newValue: { evaluated: true },
  });
  return evaluation;
}

// ─── Public directory ───────────────────────────────────────────────────────

/**
 * Publicly listable officials.
 *
 * A tournament organiser needs to know who is licensed. They do not need contact
 * details, and this returns none.
 */
export async function publicOfficialsDirectory(db: DB, registry: Registry, asAt: string = today()) {
  const table = TABLES[registry];
  const rows = await db
    .select({
      fullName: s.persons.fullName,
      federationId: s.persons.federationId,
      stateUnitId: s.persons.stateUnitId,
      level: table.level,
      grantedOn: table.grantedOn,
      expiresOn: table.expiresOn,
    })
    .from(table)
    .innerJoin(s.persons, eq(table.personId, s.persons.id))
    .where(and(eq(table.status, 'active'), eq(s.persons.status, 'active')));

  return rows
    .filter((r: any) => !r.expiresOn || r.expiresOn >= asAt)
    .map((r: any) => ({ ...r, registry, currentAt: asAt }));
}
