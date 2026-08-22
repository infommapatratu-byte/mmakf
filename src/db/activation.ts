// Payment activates the programme — and everything that comes with it.
//
// THE HOP THIS CLOSES. src/db/entitlements.ts turns a verified capture into a
// membership, a cleared entry or a confirmed booking. None of those is what the
// federation actually sells to a school or a company. It sells a TRAINING
// PROGRAMME, and the federation described what that includes in more detail
// than anything else in the brief:
//
//   · the programme runs, for the period paid for;
//   · participants may be registered against it;
//   · sessions are schedulable and the coach assignment engine may run;
//   · the institution's portal shows the programme, its calendar, its coaches;
//   · the SUPPORTING RESOURCES become reachable for that period — the technical
//     library, live classes, course material.
//
// A boolean cannot carry any of that. So an activated programme is an
// entitlement with TWO DATES on it and a row per resource it makes reachable,
// and every one of the five bullets above is a query against those dates.
//
// ─── THE FOUR RULES THIS FILE IS BUILT AROUND ───────────────────────────────
//
// 1. NOTHING IS INVENTED. MMAKF has published no fee framework and no
//    programme terms. Where the federation has not said how long a programme
//    runs, this module does not decide: the activation is BLOCKED with a reason
//    naming exactly what is missing, the money stays taken, and the finance
//    desk sees it in entitlements.blockedEntitlements(). Twelve months is the
//    obvious default and it is the one thing that must never happen here —
//    a default term is federation policy set by a constant.
//
// 2. ACCESS IS DECIDED AT THE MOMENT OF THE REQUEST, IN SQL. There is no
//    `active` boolean to fall out of date and no nightly sweep to expire
//    anything. resourceAccess() compares today against valid_from/valid_to on
//    every call, so an entitlement stops opening the door the moment it
//    expires — not at the next cron run, not when somebody notices. Every
//    surface calls the same function; there is no second copy of the rule.
//
// 3. THE TRIGGER IS A VERIFIED WEBHOOK, ALWAYS. decideProgram() is reachable
//    only from entitlements.activateForOrder(), which refuses to run without a
//    payment row this system marked `captured` — and confirmPayment() only sets
//    that after checking the provider's own record. There is no exported
//    function here that activates a programme from an id and a promise.
//
// 4. A REFUND REVOKES, AND KEEPS THE RECORD. Grants gain a revoked_at, a reason
//    and nothing else changes. A school that was refunded keeps the history of
//    what it held, which is the only way to answer why the login stopped
//    working.
//
// WHY THE PERIOD LIVES ON THE ENTITLEMENT AND IS COPIED ONTO EACH GRANT. The
// entitlement's dates are what the school bought. A grant's dates start as a
// copy so that a resource can be withdrawn on its own terms — a licence lapsing
// part way through a school year ends the library access and not the training —
// and so the access query never has to reason about which of two periods is
// narrower while a request is waiting.

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from './schema';
// The operations tables — sessions, coach assignments, venues — are NOT
// re-exported from schema.ts (see the note there on what that file is the entry
// point for), so they are imported directly, exactly as src/db/coaches.ts and
// src/db/tasks.ts do.
import * as ops from './operations.schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { zonedDay } from './scheduling';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { publish } from '@/lib/domain-events';
import {
  termEndsOn, termFor, systemEntitlementContext, systemEntitlementPrincipal,
  type Decision, type LineContext,
} from './entitlements';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class ActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ActivationError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isActivationError(err: unknown): err is ActivationError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'ActivationError';
}

/**
 * THE FEDERATION'S OWN DAY, not the server's.
 *
 * Every date in this module is a calendar day — valid_from, valid_to, joined_on,
 * left_on — and every access check turns an INSTANT into one of them. Doing that
 * with toISOString() answers in UTC, which is five and a half hours behind
 * India: a programme whose last day is 30 September went on opening the
 * technical library until 05:29 on 1 October, because until then the server
 * still called it September. That is precisely the "stops the moment it
 * expires" claim failing, by a margin nobody would ever notice and nobody could
 * explain to the school that paid.
 *
 * zonedDay() is src/db/scheduling.ts's, and is used rather than a second
 * +05:30 constant here for the reason the coach clash checks are imported
 * rather than reimplemented: two copies of a rule answer differently the first
 * time one is fixed.
 */
const FEDERATION_TZ = 'Asia/Kolkata';

const isoDate = (v: Date | string | null | undefined): string | null =>
  !v ? null : v instanceof Date ? zonedDay(v, FEDERATION_TZ) : String(v).slice(0, 10);

const today = (at?: Date | null): string => isoDate(at ?? new Date())!;

// ─── What a programme fee includes ──────────────────────────────────────────

export type ResourceKind = (typeof s.entitlementResourceKind.enumValues)[number];

export const RESOURCE_KINDS: readonly ResourceKind[] = s.entitlementResourceKind.enumValues;

/**
 * The two whole-surface grants.
 *
 * `technical_library` and `live_classes` name a surface rather than a row, so
 * they carry no id — and the CHECK constraint in migration 0039 makes the
 * distinction unrepresentable rather than merely conventional. A 'course' grant
 * with no course is NOT "all courses"; it is a row somebody failed to fill in,
 * and the database refuses it before anybody can read it as generosity.
 */
const WHOLE_SURFACE: readonly ResourceKind[] = ['technical_library', 'live_classes'];

/**
 * Which grants satisfy a request for a given resource.
 *
 * The single containment rule: being granted a COURSE includes that course's
 * material. The reverse does not hold — `course_material` exists so the
 * federation can release a course's handouts to a programme without also
 * granting the assessed course itself, which is a distinction MMAKF's own
 * course records already draw (a course has lessons, quizzes and a
 * certificate; its material is only the first).
 */
const SATISFIED_BY: Record<ResourceKind, readonly ResourceKind[]> = {
  technical_library: ['technical_library'],
  live_classes: ['live_classes'],
  course: ['course'],
  course_material: ['course_material', 'course'],
};

export interface ResourceGrant {
  kind: ResourceKind;
  /** Required for 'course' and 'course_material'; forbidden for the rest. */
  resourceId?: number | null;
}

/**
 * Read a configured resource list, refusing anything the vocabulary does not
 * contain.
 *
 * VALIDATED WHEN IT IS CONFIGURED, not when a payment arrives. A typo in a
 * resource name that is only noticed at activation time is a school that paid
 * for library access and silently got none, discovered weeks later by a parent.
 * Refused at the point somebody typed it, it is a form error.
 *
 * Null and an empty list both mean NO SUPPORTING RESOURCES, and that is the
 * safe direction: this function never expands absence into "everything".
 */
export function parseResourceGrants(value: unknown): ResourceGrant[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ActivationError(
      'bad_resources',
      'Resources must be a list, e.g. [{ "kind": "technical_library" }, { "kind": "course", "resourceId": 4 }].'
    );
  }

  const out: ResourceGrant[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const kind = String((raw as any)?.kind ?? '').trim() as ResourceKind;
    if (!RESOURCE_KINDS.includes(kind)) {
      throw new ActivationError(
        'unknown_resource',
        `'${kind || '(missing)'}' is not a resource MMAKF grants. The vocabulary is ${RESOURCE_KINDS.join(', ')}. ` +
        'It is closed on purpose: a grant this system cannot name is a grant nobody approved.'
      );
    }

    const rawId = (raw as any)?.resourceId ?? (raw as any)?.id ?? null;
    const resourceId = rawId == null ? null : Number(rawId);
    const wholeSurface = WHOLE_SURFACE.includes(kind);

    if (wholeSurface && resourceId != null) {
      throw new ActivationError(
        'resource_id_not_allowed',
        `A '${kind}' grant covers the whole surface and names no single record; remove resourceId.`
      );
    }
    if (!wholeSurface && (resourceId == null || !Number.isInteger(resourceId) || resourceId < 1)) {
      throw new ActivationError(
        'resource_id_required',
        `A '${kind}' grant must name which one, as an integer resourceId. ` +
        'A missing id is not "all of them" — it is an unfinished record, and it is refused rather than read as generosity.'
      );
    }

    const key = `${kind}:${resourceId ?? 0}`;
    if (seen.has(key)) continue;      // the same grant twice is one grant
    seen.add(key);
    out.push({ kind, resourceId });
  }
  return out;
}

// ─── The period paid for ────────────────────────────────────────────────────

export type PeriodOutcome =
  | {
      ok: true;
      validFrom: string;
      validTo: string;
      /**
       * `programme_end` is the third source and it is not a third rule: it is
       * the configured term CUT SHORT by the end date the federation recorded
       * on the programme. Named separately so the entitlement's detail says
       * which of the two decided the last day.
       */
      source: 'programme_dates' | 'configured_term' | 'programme_end';
    }
  | { ok: false; reason: string };

export interface PeriodInput {
  /** The day the money was actually taken. */
  paidOn: string;
  programStartsOn: string | null;
  programEndsOn: string | null;
  feeCode: string | null;
  term: { feeCode: string; termMonths: number | null; openEnded: boolean } | null;
}

/**
 * BOTH DATES, or a refusal that names what is missing.
 *
 * Two sources, in this order and for this reason:
 *
 *  1. THE PROGRAMME'S OWN DATES. Where a programme records a start and an end,
 *     those are the delivery window MMAKF agreed with the institution — a term
 *     sheet, a school year, a corporate block — and they beat anything derived
 *     from a fee code. Deriving a period while the agreed one sits on the row
 *     would produce an entitlement that disagreed with the contract.
 *
 *  2. THE CONFIGURED TERM. Where the programme states no window, the term the
 *     federation recorded against the fee code applies, running from the day the
 *     money was taken (or from the programme's start where it has one). A
 *     reconcile sweep three days later must not shorten what was bought.
 *
 * AND THERE IS NO THIRD. No default, no fallback, no "a year seems right". An
 * open-ended term is REFUSED for a programme specifically: open_ended is a real
 * federation decision elsewhere in this system, but a training programme that
 * grants library access with no end date is not a period, and "for the period
 * paid for" is the federation's own phrase for what it sells.
 */
export function programPeriod(input: PeriodInput): PeriodOutcome {
  const startsOn = isoDate(input.programStartsOn);
  const endsOn = isoDate(input.programEndsOn);
  const paidOn = isoDate(input.paidOn)!;

  if (startsOn && endsOn) {
    if (endsOn < startsOn) {
      return {
        ok: false,
        reason: `The programme records a start of ${startsOn} and an end of ${endsOn}, which is not a period. ` +
          'Correct the programme dates and re-run the activation; nothing was issued against an interval that runs backwards.',
      };
    }
    return { ok: true, validFrom: startsOn, validTo: endsOn, source: 'programme_dates' };
  }

  const term = input.term;
  if (!term) {
    return {
      ok: false,
      reason:
        `The programme states no start and end, and no entitlement term is configured for fee code ` +
        `'${input.feeCode ?? '(none)'}'. There are therefore two dates the federation has not stated, and this ` +
        'system will not choose them: a programme that quietly ran for a year because a default said so would be ' +
        'MMAKF policy set by a constant. Record the programme dates, or configure the term for that fee code, and re-run.',
    };
  }

  if (term.openEnded) {
    return {
      ok: false,
      reason:
        `The term configured for '${term.feeCode}' is open-ended, and a training programme cannot be. ` +
        'The federation sells a programme "for the period paid for", and the entitlement has to hold both dates — ' +
        'an open-ended programme would grant the technical library and live classes for ever on the strength of one payment. ' +
        'State a term in whole months, or record the programme\'s own start and end dates.',
    };
  }

  const months = term.termMonths;
  if (!Number.isInteger(months) || (months as number) < 1) {
    return {
      ok: false,
      reason:
        `The term configured for '${term.feeCode}' states no length in months, so there is no end date to record.`,
    };
  }

  const validFrom = startsOn ?? paidOn;
  const derived = termEndsOn(validFrom, months as number);

  // THE STATED END WINS, EVEN ON ITS OWN.
  //
  // The branch above honours the programme's dates only when it carries BOTH,
  // which left the commonest half-filled row — an end date agreed with the
  // school, no start recorded — deriving its end from the fee code and running
  // PAST the day the federation said the programme finishes. A six-month term
  // paid in February against a programme ending on 31 March granted the
  // technical library, live classes and the course material until 31 July: four
  // months of access nobody sold and nobody agreed. The end MMAKF recorded is
  // federation data, and it caps the derived one wherever it is shorter.
  if (endsOn) {
    if (endsOn < validFrom) {
      return {
        ok: false,
        reason: `The programme records an end of ${endsOn}, which is before ${validFrom} — the day this ` +
          `entitlement would have to begin${startsOn ? '' : ', being the day the money was taken'}. ` +
          'That is not a period, and nothing was granted against it. Correct the programme dates and re-run.',
      };
    }
    if (endsOn < derived) {
      return { ok: true, validFrom, validTo: endsOn, source: 'programme_end' };
    }
  }

  return { ok: true, validFrom, validTo: derived, source: 'configured_term' };
}

/**
 * A PERIOD THAT HAD ALREADY RUN OUT WHEN THE MONEY ARRIVED.
 *
 * Not a refusal. A school that trained in the summer term and settled the
 * invoice in August has been delivered exactly what it bought, and blocking
 * that payment would raise a false alarm on every programme paid in arrears.
 *
 * But it is not nothing either: such an entitlement is `active` and opens no
 * door from the moment it is written, and it appears in neither of the two
 * queues a person works — not blockedEntitlements(), which lists money taken
 * against nothing issued, and not expiringPrograms(), which only looks forward.
 * A programme mis-dated by a typo therefore looks exactly like one paid in
 * arrears. So the fact is recorded ON THE ENTITLEMENT, in its detail, where a
 * report can find it and an administrator reading the row can see it, rather
 * than being left to be inferred by comparing three dates.
 */
export function periodElapsedAtPayment(validTo: string | null, paidOn: string): boolean {
  return Boolean(validTo) && (validTo as string) < paidOn;
}

// ─── Activation, called only from the entitlement engine ────────────────────

/**
 * The decision for a programme line.
 *
 * Returned to entitlements.claimAndAct(), which inserts the entitlement row
 * FIRST — claiming the order line through its unique index — and only then runs
 * `act`. That ordering is what makes a replayed webhook safe: the loser of the
 * race never reaches this function's writes at all, because its whole
 * transaction rolls back on the claim.
 *
 * Exported for that caller and for tests. It is NOT an activation entry point:
 * it takes a LineContext, and the only thing that builds one is
 * activateForOrder(), which will not run without a verified capture.
 */
export async function decideProgram(tx: DB, c: LineContext): Promise<Decision> {
  const programId: number | null = c.line.refId ?? null;
  if (!programId) {
    return {
      activate: false,
      reason: 'The order line names no programme, so there is nothing to activate.',
      detail: { orderNo: c.order.orderNo, refType: c.line.refType ?? null },
    };
  }

  const program = (await tx.select().from(s.trainingPrograms)
    .where(eq(s.trainingPrograms.id, programId)).limit(1))[0];
  if (!program) {
    return { activate: false, reason: `Programme ${programId} no longer exists.`, detail: { programId } };
  }

  // A programme the federation has already closed off. Activating over either
  // would put the delivery record at odds with what happened: a cancelled
  // programme has no sessions to schedule, and a completed one is history.
  const CLOSED: string[] = ['cancelled', 'completed'];
  if (CLOSED.includes(program.status)) {
    return {
      activate: false,
      reason: `Programme ${program.code} is ${program.status}; a payment does not reopen it. ` +
        'The money stays taken and needs a person — either the programme is reinstated or the fee is refunded.',
      detail: { programId, code: program.code, status: program.status },
    };
  }

  const term = await termFor(tx, c.line.feeCode);
  const paidOn = isoDate(c.order.paidAt ?? c.payment.capturedAt ?? c.now)!;

  const period = programPeriod({
    paidOn,
    programStartsOn: program.startsOn ?? null,
    programEndsOn: program.endsOn ?? null,
    feeCode: c.line.feeCode ?? null,
    term: term ? { feeCode: term.feeCode, termMonths: term.termMonths, openEnded: term.openEnded } : null,
  });

  if (!period.ok) {
    return {
      activate: false,
      reason: period.reason,
      detail: { programId, code: program.code, feeCode: c.line.feeCode ?? null, paidOn, termConfigured: Boolean(term) },
    };
  }

  // A malformed resource list is a CONFIGURATION fault, and it must not become
  // an exception that rolls back the record of a payment. It is reported as a
  // blocked entitlement, like every other refusal here, so the money is visible
  // and refundable while somebody fixes the term.
  let grants: ResourceGrant[];
  try {
    grants = parseResourceGrants(term?.resources ?? null);
  } catch (err) {
    return {
      activate: false,
      reason: `The resources configured for fee code '${c.line.feeCode ?? '(none)'}' could not be read: ` +
        `${(err as Error).message}`,
      detail: { programId, feeCode: c.line.feeCode ?? null },
    };
  }

  return {
    activate: true,
    validFrom: period.validFrom,
    validTo: period.validTo,
    detail: {
      programId,
      code: program.code,
      institutionId: program.institutionId ?? null,
      validFrom: period.validFrom,
      validTo: period.validTo,
      periodSource: period.source,
      paidOn,
      // See periodElapsedAtPayment(). True means the money was taken after the
      // period it bought had already ended — legitimate for a programme settled
      // in arrears, and a mis-dated programme otherwise. Either way it is on
      // the record rather than inferred.
      periodElapsedAtPayment: periodElapsedAtPayment(period.validTo, paidOn),
      feeCode: c.line.feeCode ?? null,
      // Stated explicitly rather than implied by an empty list, because "the
      // federation configured no supporting resources" and "the federation
      // configured none of them for this fee" are the same row and different
      // facts, and only the report can tell the desk which it is looking at.
      resourcesConfigured: Boolean(term?.resources),
      resources: grants,
    },
    act: async (db: DB, entitlementId: number) => {
      // Record the period ON THE PROGRAMME where it did not already carry one.
      // Only where it is absent: the programme's own dates outrank a derived
      // term, and overwriting them would let a fee-code change silently re-date
      // a signed delivery window.
      const patch: Record<string, unknown> = {};
      if (!program.startsOn) patch.startsOn = period.validFrom;
      if (!program.endsOn) patch.endsOn = period.validTo;
      if (Object.keys(patch).length) {
        patch.updatedAt = c.now;
        await db.update(s.trainingPrograms).set(patch as any)
          .where(eq(s.trainingPrograms.id, program.id));
      }

      await grantResources(db, entitlementId, grants, period.validFrom, period.validTo);

      await writeAudit(db, systemEntitlementContext(), {
        entityType: 'training_program', entityId: program.id, action: 'approve',
        oldValue: { startsOn: program.startsOn ?? null, endsOn: program.endsOn ?? null },
        newValue: {
          code: program.code,
          validFrom: period.validFrom, validTo: period.validTo,
          periodSource: period.source,
          resources: grants.map((g) => `${g.kind}${g.resourceId ? `:${g.resourceId}` : ''}`),
          paidByOrder: c.order.orderNo,
        },
      });

      await publish(db, {
        eventType: 'PROGRAM_ACTIVATED',
        entityType: 'training_program',
        entityId: program.id,
        payload: {
          programId: program.id,
          institutionId: program.institutionId ?? null,
          validFrom: period.validFrom,
          validTo: period.validTo,
          entitlementId,
          resources: grants.map((g) => g.kind),
        },
        // One logical fact. A webhook retry that somehow reached here twice
        // publishes one event, not two.
        correlationId: `program:activated:${entitlementId}`,
        actor: systemEntitlementPrincipal(),
        occurredAt: c.now,
      });

      return program.id;
    },
  };
}

/**
 * Write the grants, idempotently.
 *
 * onConflictDoNothing against `entitlement_resources_uk`. Belt to the
 * entitlement claim's braces: the claim already guarantees one activation per
 * order line, and this guarantees that even a hand-run repair cannot double a
 * grant. Doing nothing on conflict rather than updating is deliberate — an
 * existing grant may have been revoked on its own terms, and a replay must not
 * quietly reinstate it.
 */
async function grantResources(
  db: DB, entitlementId: number, grants: ResourceGrant[], validFrom: string, validTo: string | null
): Promise<void> {
  if (!grants.length) return;
  await db.insert(s.entitlementResources).values(
    grants.map((g) => ({
      entitlementId,
      resourceKind: g.kind,
      resourceId: g.resourceId ?? null,
      validFrom,
      validTo,
      status: 'active' as const,
    }))
  ).onConflictDoNothing();
}

/**
 * A refund reverses the grants. It does not delete them.
 *
 * Called from entitlements.reverseSubject() inside the revocation transaction,
 * so the entitlement and every door it opened close together or not at all.
 * The rows keep their dates, their resource and their entitlement, and gain a
 * timestamp and a reason — which is the only way to answer a parent asking why
 * the videos stopped working.
 */
export async function revokeProgramGrants(
  tx: DB, ctx: AuditContext, entitlementId: number, reason: string, now: Date
): Promise<{ grants: number; enrolments: number }> {
  const revoked = await tx.update(s.entitlementResources).set({
    status: 'revoked', revokedAt: now, reason, updatedAt: now,
  }).where(and(
    eq(s.entitlementResources.entitlementId, entitlementId),
    eq(s.entitlementResources.status, 'active')
  )).returning({
    id: s.entitlementResources.id,
    resourceKind: s.entitlementResources.resourceKind,
    resourceId: s.entitlementResources.resourceId,
  });

  const ent = (await tx.select().from(s.entitlements)
    .where(eq(s.entitlements.id, entitlementId)).limit(1))[0];

  // THE COURSE ENROLMENT IS A SECOND DOOR, AND IT WAS LEFT OPEN.
  //
  // registerParticipant() enrols a pupil onto the programme's granted courses
  // through `enrolments`, because that is the table the academy reads. Revoking
  // the entitlement's grants closed resourceAccess() and nothing else: the
  // enrolment stayed `active` with an expiry set to the programme's original end,
  // and src/db/academy.ts — which checks the enrolment's own status and expiry,
  // not the entitlement — went on letting a refunded school's pupils complete
  // lessons, sit quizzes and finish the course. A refund that leaves the
  // fulfilment running is not a refund.
  //
  // Suspended rather than deleted or withdrawn: the record of what the school
  // held survives, and `suspended` is the enrolment vocabulary's own word for
  // access stopped by the federation rather than by the student.
  const courseIds: number[] = [...new Set<number>(
    revoked
      .filter((r: any) => r.resourceKind === 'course' || r.resourceKind === 'course_material')
      .map((r: any) => r.resourceId)
      .filter((id: any): id is number => Number.isInteger(id))
  )];

  let closed: Array<{ id: number }> = [];
  if (courseIds.length && ent?.orderId != null) {
    closed = await tx.update(s.enrolments).set({ status: 'suspended' }).where(and(
      // ONLY the ones this order bought. An enrolment the family paid for
      // separately is not withdrawn because a school programme was refunded.
      eq(s.enrolments.orderId, ent.orderId),
      inArray(s.enrolments.courseId, courseIds),
      eq(s.enrolments.status, 'active')
    )).returning({ id: s.enrolments.id });

    for (const row of closed) {
      await writeAudit(tx, ctx, {
        entityType: 'enrolment', entityId: row.id, action: 'revoke',
        oldValue: { status: 'active' },
        newValue: { status: 'suspended', reason, entitlementId },
      });
    }
  }

  if (ent?.subjectId) {
    await writeAudit(tx, ctx, {
      entityType: 'training_program', entityId: ent.subjectId, action: 'revoke',
      oldValue: { entitlementId, grants: revoked.length, enrolments: closed.length },
      newValue: { status: 'revoked', reason },
    });
    await publish(tx, {
      eventType: 'PROGRAM_ACCESS_REVOKED',
      entityType: 'training_program',
      entityId: ent.subjectId,
      payload: {
        programId: ent.subjectId, entitlementId,
        grantsRevoked: revoked.length, enrolmentsSuspended: closed.length, reason,
      },
      correlationId: `program:revoked:${entitlementId}`,
      actor: ctx.principal,
      occurredAt: now,
    });
  }

  return { grants: revoked.length, enrolments: closed.length };
}

// ─── Is this programme live right now? ──────────────────────────────────────

export interface ProgramStanding {
  programId: number;
  active: boolean;
  /** Always populated, and always the reason a human would want. */
  reason: string;
  entitlementId: number | null;
  validFrom: string | null;
  validTo: string | null;
  status: string | null;
}

/**
 * THE gate. Everything a paid programme unlocks asks this first.
 *
 * `at` is a real parameter and not a convenience: a session scheduled for next
 * March must be checked against next March, not against today. Scheduling a
 * session beyond the paid period is exactly the error this catches, and it
 * catches it before the coach's diary says otherwise.
 *
 * A programme with no entitlement at all is NOT active. Not "probably fine
 * because somebody set it up" — the whole hop this module exists for is that a
 * programme becomes deliverable because a verified payment said so.
 */
export async function programStanding(db: DB, programId: number, at?: Date): Promise<ProgramStanding> {
  const day = today(at);

  const live = (await db.select().from(s.entitlements).where(and(
    eq(s.entitlements.subject, 'program'),
    eq(s.entitlements.subjectId, programId),
    eq(s.entitlements.status, 'active'),
    lte(s.entitlements.validFrom, day),
    or(isNull(s.entitlements.validTo), gte(s.entitlements.validTo, day))
  )).orderBy(desc(s.entitlements.validTo)).limit(1))[0];

  if (live) {
    return {
      programId, active: true,
      reason: `Paid and active from ${live.validFrom} to ${live.validTo ?? 'no recorded end'}.`,
      entitlementId: live.id, validFrom: live.validFrom ?? null, validTo: live.validTo ?? null,
      status: live.status,
    };
  }

  // Not live. Say WHY, from the record, rather than returning a bare false —
  // "not yet started", "ended in March" and "never paid for" send an
  // administrator to three different places.
  const any = (await db.select().from(s.entitlements).where(and(
    eq(s.entitlements.subject, 'program'),
    eq(s.entitlements.subjectId, programId)
  )).orderBy(desc(s.entitlements.id)).limit(1))[0];

  if (!any) {
    return {
      programId, active: false,
      reason: 'No payment has activated this programme. Nothing may be registered, scheduled or assigned against it.',
      entitlementId: null, validFrom: null, validTo: null, status: null,
    };
  }
  if (any.status === 'revoked') {
    return {
      programId, active: false,
      reason: `This programme's entitlement was revoked${any.revokedAt ? ` on ${isoDate(any.revokedAt)}` : ''}: ${any.reason ?? 'no reason recorded'}`,
      entitlementId: any.id, validFrom: any.validFrom ?? null, validTo: any.validTo ?? null, status: any.status,
    };
  }
  if (any.status === 'blocked') {
    return {
      programId, active: false,
      reason: `The payment for this programme was taken but could not be activated: ${any.reason ?? 'no reason recorded'}`,
      entitlementId: any.id, validFrom: null, validTo: null, status: any.status,
    };
  }
  if (any.validFrom && day < any.validFrom) {
    return {
      programId, active: false,
      reason: `This programme is paid for but does not begin until ${any.validFrom}.`,
      entitlementId: any.id, validFrom: any.validFrom, validTo: any.validTo ?? null, status: any.status,
    };
  }
  return {
    programId, active: false,
    reason: `This programme's paid period ended on ${any.validTo ?? 'an unrecorded date'}.`,
    entitlementId: any.id, validFrom: any.validFrom ?? null, validTo: any.validTo ?? null, status: any.status,
  };
}

export async function assertProgramActive(db: DB, programId: number, at?: Date): Promise<ProgramStanding> {
  const standing = await programStanding(db, programId, at);
  if (!standing.active) throw new ActivationError('program_not_active', standing.reason);
  return standing;
}

// ─── The access check every surface calls ───────────────────────────────────

export interface AccessQuery {
  personId: number;
  kind: ResourceKind;
  /** Required for 'course' and 'course_material'. */
  resourceId?: number | null;
  at?: Date;
}

export interface AccessDecision {
  allowed: boolean;
  /** Never empty. A denial nobody can explain is not one. */
  reason: string;
  entitlementId: number | null;
  programId: number | null;
  grantId: number | null;
  validFrom: string | null;
  validTo: string | null;
}

/** A refusal with nothing behind it. Every field null, so a caller cannot mistake it for a grant. */
function deny(reason: string): AccessDecision {
  return { allowed: false, reason, entitlementId: null, programId: null, grantId: null, validFrom: null, validTo: null };
}

const KIND_LABEL: Record<ResourceKind, string> = {
  technical_library: 'the technical library',
  live_classes: 'live classes',
  course: 'that course',
  course_material: 'that course’s material',
};

/**
 * MAY THIS PERSON REACH THIS RESOURCE, RIGHT NOW?
 *
 * ONE FUNCTION, and every surface calls it. The alternative — each page
 * deciding for itself — is how one page ends up checking the entitlement and
 * another checking the programme's status field, and the second one keeps
 * working for a year after the money stopped.
 *
 * DECIDED IN SQL, AGAINST THE DATES. Not against a cached flag, not against a
 * status column somebody has to remember to update. `at` defaults to now and
 * every predicate below compares against it, so the answer changes the instant
 * the period ends. That is the requirement stated plainly: an expired
 * entitlement stops granting access the moment it expires.
 *
 * FAILS CLOSED, including on the joins. A grant whose entitlement was revoked,
 * a participant who has left the roll, a programme whose valid_from is null
 * because the row predates migration 0039 — every one of those fails the WHERE
 * clause and is denied. There is no branch that says "if we cannot tell, allow".
 */
export async function resourceAccess(db: DB, q: AccessQuery): Promise<AccessDecision> {
  const day = today(q.at);
  const kind = q.kind;
  const label = KIND_LABEL[kind] ?? 'that resource';

  if (!RESOURCE_KINDS.includes(kind)) {
    return deny(`'${kind}' is not a resource MMAKF grants, so nothing grants it.`);
  }

  const wholeSurface = WHOLE_SURFACE.includes(kind);
  const resourceId = q.resourceId == null ? null : Number(q.resourceId);
  if (!wholeSurface && (resourceId == null || !Number.isInteger(resourceId))) {
    return deny(`A '${kind}' check must name which one. Asked without a resourceId, the honest answer is no.`);
  }
  if (!Number.isInteger(q.personId) || q.personId < 1) {
    return deny('No person was named, and access is granted to people rather than to sessions.');
  }

  const target = wholeSurface
    ? isNull(s.entitlementResources.resourceId)
    : eq(s.entitlementResources.resourceId, resourceId as number);

  const rows = await db.select({
    grantId: s.entitlementResources.id,
    grantFrom: s.entitlementResources.validFrom,
    grantTo: s.entitlementResources.validTo,
    entitlementId: s.entitlements.id,
    programId: s.entitlements.subjectId,
    entFrom: s.entitlements.validFrom,
    entTo: s.entitlements.validTo,
  })
    .from(s.entitlementResources)
    .innerJoin(s.entitlements, eq(s.entitlements.id, s.entitlementResources.entitlementId))
    .innerJoin(s.programParticipants, eq(s.programParticipants.programId, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.subject, 'program'),
      eq(s.entitlements.status, 'active'),
      eq(s.entitlementResources.status, 'active'),
      inArray(s.entitlementResources.resourceKind, SATISFIED_BY[kind] as ResourceKind[]),
      target,
      eq(s.programParticipants.personId, q.personId),
      // THE PERIOD, on both records. Null valid_from never matches — a row that
      // does not say when it started cannot say that today is inside it.
      lte(s.entitlements.validFrom, day),
      or(isNull(s.entitlements.validTo), gte(s.entitlements.validTo, day)),
      lte(s.entitlementResources.validFrom, day),
      or(isNull(s.entitlementResources.validTo), gte(s.entitlementResources.validTo, day)),
      // On the roll TODAY. A participant who left in March does not keep the
      // library until the school's year runs out.
      or(isNull(s.programParticipants.joinedOn), lte(s.programParticipants.joinedOn, day)),
      or(isNull(s.programParticipants.leftOn), gte(s.programParticipants.leftOn, day))
    ))
    // The longest cover first, so a person on two programmes is told the date
    // their access actually runs to rather than the earliest of the two.
    .orderBy(desc(s.entitlementResources.validTo))
    .limit(1);

  const hit = rows[0];
  if (hit) {
    return {
      allowed: true,
      reason: `Included in a training programme paid for through ${hit.grantTo ?? 'no recorded end'}.`,
      entitlementId: hit.entitlementId,
      programId: hit.programId ?? null,
      grantId: hit.grantId,
      validFrom: hit.grantFrom ?? null,
      validTo: hit.grantTo ?? null,
    };
  }

  // Denied. Now find out whether it is "you never had this" or "this ran out",
  // because those two send a person to two completely different places and a
  // single "no" sends them to neither.
  const lapsed = await db.select({
    grantId: s.entitlementResources.id,
    grantTo: s.entitlementResources.validTo,
    grantFrom: s.entitlementResources.validFrom,
    status: s.entitlementResources.status,
    entitlementId: s.entitlements.id,
    programId: s.entitlements.subjectId,
  })
    .from(s.entitlementResources)
    .innerJoin(s.entitlements, eq(s.entitlements.id, s.entitlementResources.entitlementId))
    .innerJoin(s.programParticipants, eq(s.programParticipants.programId, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.subject, 'program'),
      inArray(s.entitlementResources.resourceKind, SATISFIED_BY[kind] as ResourceKind[]),
      target,
      eq(s.programParticipants.personId, q.personId)
    ))
    .orderBy(desc(s.entitlementResources.validTo))
    .limit(1);

  const was = lapsed[0];
  if (!was) {
    return deny(`No MMAKF training programme you are on includes ${label}.`);
  }
  if (was.status === 'revoked') {
    return {
      allowed: false,
      reason: `Access to ${label} through your programme was withdrawn when the fee was refunded.`,
      entitlementId: was.entitlementId, programId: was.programId ?? null,
      grantId: was.grantId, validFrom: was.grantFrom ?? null, validTo: was.grantTo ?? null,
    };
  }
  if (was.grantFrom && day < was.grantFrom) {
    return {
      allowed: false,
      reason: `Your programme includes ${label} from ${was.grantFrom}. It has not started yet.`,
      entitlementId: was.entitlementId, programId: was.programId ?? null,
      grantId: was.grantId, validFrom: was.grantFrom, validTo: was.grantTo ?? null,
    };
  }
  return {
    allowed: false,
    reason: `Your programme's access to ${label} ended on ${was.grantTo ?? 'an unrecorded date'}.`,
    entitlementId: was.entitlementId, programId: was.programId ?? null,
    grantId: was.grantId, validFrom: was.grantFrom ?? null, validTo: was.grantTo ?? null,
  };
}

/** The same check, for a caller that would rather not test a boolean. */
export async function assertResourceAccess(db: DB, q: AccessQuery): Promise<AccessDecision> {
  const decision = await resourceAccess(db, q);
  if (!decision.allowed) throw new ActivationError('no_access', decision.reason);
  return decision;
}

/** The technical library — src/db/library.ts's material, for a programme member. */
export const libraryAccess = (db: DB, personId: number, at?: Date) =>
  resourceAccess(db, { personId, kind: 'technical_library', at });

/** Live classes — education.schema.ts `live_classes`. */
export const liveClassAccess = (db: DB, personId: number, at?: Date) =>
  resourceAccess(db, { personId, kind: 'live_classes', at });

/** One course, by id. */
export const courseAccess = (db: DB, personId: number, courseId: number, at?: Date) =>
  resourceAccess(db, { personId, kind: 'course', resourceId: courseId, at });

/** A course's lessons and downloads — satisfied by a course grant too. */
export const courseMaterialAccess = (db: DB, personId: number, courseId: number, at?: Date) =>
  resourceAccess(db, { personId, kind: 'course_material', resourceId: courseId, at });

// ─── Participants ───────────────────────────────────────────────────────────

export interface ParticipantInput {
  programId: number;
  /** A person in the register. Omit for a school cohort the federation holds no record of. */
  personId?: number | null;
  displayName?: string | null;
  ageBand?: string | null;
  joinedOn?: string | null;
}

export interface ParticipantResult {
  participantId: number;
  programId: number;
  personId: number | null;
  /**
   * `replayed` means the person was already on the roll and nothing was
   * doubled. `reinstated` means they had LEFT it and were put back — a
   * different fact, and one an administrator has to be told, because the two
   * used to be reported identically and only one of them restored access.
   */
  status: 'registered' | 'replayed' | 'reinstated';
  enrolments: number[];
}

/**
 * Put somebody on a programme's roll.
 *
 * GATED ON THE PAYMENT, not on the programme's status field. A programme
 * nobody has paid for takes no participants — that is the second bullet of what
 * activation means, and enforcing it anywhere other than here would mean
 * enforcing it in every caller.
 *
 * IDEMPOTENT BY UNIQUE INDEX (migration 0039), not by a SELECT then INSERT: two
 * administrators submitting the same child at the same moment both read "not on
 * the roll yet", and only the database can settle it.
 *
 * COURSE ENROLMENTS FOLLOW. Where the programme's entitlement grants named
 * courses, the participant is enrolled onto them here — through `enrolments`,
 * the table the academy already reads, rather than a second membership of the
 * same course invented for programmes. `onConflictDoNothing`, because an
 * enrolment somebody bought for themselves must not be overwritten by one that
 * comes with a school programme and expires with it.
 */
export async function registerParticipant(
  db: DB, ctx: AuditContext, input: ParticipantInput, at?: Date
): Promise<ParticipantResult> {
  assertCanAnywhere(ctx.principal, 'program:write');

  const now = at ?? new Date();
  const standing = await assertProgramActive(db, input.programId, now);

  const personId = input.personId ?? null;
  const displayName = input.displayName?.trim() || null;
  if (!personId && !displayName) {
    throw new ActivationError(
      'unidentified_participant',
      'A participant needs either a person record or a display name. An anonymous row on a roll is an attendance figure nobody can act on.'
    );
  }
  if (personId) {
    const person = (await db.select({ id: s.persons.id }).from(s.persons)
      .where(eq(s.persons.id, personId)).limit(1))[0];
    if (!person) throw new ActivationError('unknown_person', `Person ${personId} is not in the register.`);
  }

  const joinedOn = isoDate(input.joinedOn ?? now)!;

  let row: any;
  let replayed = false;
  let reinstated = false;
  try {
    [row] = await db.insert(s.programParticipants).values({
      programId: input.programId,
      personId,
      displayName,
      ageBand: input.ageBand ?? null,
      joinedOn,
    }).returning();
  } catch (err) {
    if (!isUniqueViolation(err) || !personId) throw err;
    row = (await db.select().from(s.programParticipants).where(and(
      eq(s.programParticipants.programId, input.programId),
      eq(s.programParticipants.personId, personId)
    )).limit(1))[0];
    if (!row) throw err;
    replayed = true;

    // PUTTING SOMEBODY BACK ON THE ROLL IS NOT A REPLAY.
    //
    // The unique index cannot tell "this pupil is already registered" from
    // "this pupil left in March and the school has asked for them back": both
    // are the same (program_id, person_id) collision. Treating the second as a
    // replay returned success to the administrator and changed nothing, so
    // resourceAccess() — which reads left_on on every call — went on refusing a
    // pupil everybody believed had been re-registered, with no error anywhere
    // to explain it.
    //
    // `left_on` is CLEARED rather than a second row written, because the roll
    // holds one entry per person per programme and the audit row below is where
    // the history of the departure and the return belongs.
    if (row.leftOn) {
      const [back] = await db.update(s.programParticipants)
        .set({ leftOn: null })
        .where(eq(s.programParticipants.id, row.id))
        .returning();
      await writeAudit(db, ctx, {
        entityType: 'program_participant', entityId: row.id, action: 'update',
        oldValue: { leftOn: row.leftOn },
        newValue: {
          leftOn: null, reinstated: true, programId: input.programId, personId,
          entitlementId: standing.entitlementId, coveredUntil: standing.validTo,
        },
      });
      row = back ?? row;
      reinstated = true;
    }
  }

  const enrolments = personId
    ? await enrolInGrantedCourses(db, standing, personId, now)
    : [];

  if (!replayed) {
    await writeAudit(db, ctx, {
      entityType: 'program_participant', entityId: row.id, action: 'create',
      newValue: {
        programId: input.programId, personId, displayName, joinedOn,
        entitlementId: standing.entitlementId, coveredUntil: standing.validTo,
      },
    });
  }

  return {
    participantId: row.id, programId: input.programId, personId,
    status: reinstated ? 'reinstated' : replayed ? 'replayed' : 'registered',
    enrolments,
  };
}

/**
 * Take somebody off the roll.
 *
 * A date, not a deletion — attendance already recorded against them has to keep
 * making sense. Access stops on that date because resourceAccess() reads
 * `left_on` on every call.
 */
export async function removeParticipant(
  db: DB, ctx: AuditContext, participantId: number, leftOn?: string | null, at?: Date
): Promise<{ participantId: number; leftOn: string }> {
  assertCanAnywhere(ctx.principal, 'program:write');
  const day = isoDate(leftOn ?? at ?? new Date())!;

  const [row] = await db.update(s.programParticipants)
    .set({ leftOn: day })
    .where(eq(s.programParticipants.id, participantId))
    .returning();
  if (!row) throw new ActivationError('unknown_participant', `No participant ${participantId}.`);

  await writeAudit(db, ctx, {
    entityType: 'program_participant', entityId: participantId, action: 'update',
    newValue: { leftOn: day, programId: row.programId },
  });
  return { participantId, leftOn: day };
}

/** Enrol a new participant onto whatever named courses the programme includes. */
async function enrolInGrantedCourses(
  db: DB, standing: ProgramStanding, personId: number, now: Date
): Promise<number[]> {
  if (!standing.entitlementId) return [];

  // WHICH ORDER BOUGHT THIS ENROLMENT, recorded on the row.
  //
  // Without it a refund cannot tell an enrolment that came free with a school
  // programme from one the pupil's family bought themselves, and would have to
  // choose between withdrawing both and withdrawing neither. `enrolments.order_id`
  // already exists and already means exactly this (academy.ts reads it as the
  // evidence of payment), so the provenance is written where the rest of the
  // system already looks for it.
  const parent = (await db.select({ orderId: s.entitlements.orderId }).from(s.entitlements)
    .where(eq(s.entitlements.id, standing.entitlementId)).limit(1))[0];

  const day = today(now);
  const grants = await db.select().from(s.entitlementResources).where(and(
    eq(s.entitlementResources.entitlementId, standing.entitlementId),
    eq(s.entitlementResources.status, 'active'),
    inArray(s.entitlementResources.resourceKind, ['course', 'course_material'] as ResourceKind[]),
    lte(s.entitlementResources.validFrom, day),
    or(isNull(s.entitlementResources.validTo), gte(s.entitlementResources.validTo, day))
  ));

  const courseIds = [...new Set(grants.map((g: any) => g.resourceId).filter(Boolean))] as number[];
  if (!courseIds.length) return [];

  const written: number[] = [];
  for (const courseId of courseIds) {
    const expiry = standing.validTo ? new Date(`${standing.validTo}T23:59:59Z`) : null;
    const rows = await db.insert(s.enrolments).values({
      courseId, personId, status: 'active',
      orderId: parent?.orderId ?? null,
      enrolledAt: now,
      // The enrolment ENDS WITH THE PROGRAMME. An enrolment that outlived the
      // fee that bought it is the same defect as an entitlement that does.
      expiresAt: expiry,
    }).onConflictDoNothing().returning({ id: s.enrolments.id });
    if (rows[0]) written.push(rows[0].id);
  }
  return written;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface SessionInput {
  programId: number;
  startsAt: Date;
  endsAt: Date;
  title?: string | null;
  topic?: string | null;
  venueId?: number | null;
  coachPersonId?: number | null;
  seq?: number | null;
}

/**
 * Schedule one session of a programme.
 *
 * CHECKED AGAINST THE SESSION'S OWN DATE, not against today. A programme paid
 * for until March cannot be given a session in April, and the check that would
 * miss that is the one that asks whether the programme is active *now*.
 *
 * The coach and venue clash checks are src/db/coaches.ts's — the same ones a
 * confirmation runs — rather than a second implementation that would answer
 * differently the first time either was fixed.
 */
export async function scheduleSession(
  db: DB, ctx: AuditContext, input: SessionInput
): Promise<any> {
  assertCanAnywhere(ctx.principal, 'program:write');

  const startsAt = input.startsAt instanceof Date ? input.startsAt : new Date(input.startsAt);
  const endsAt = input.endsAt instanceof Date ? input.endsAt : new Date(input.endsAt);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    throw new ActivationError('bad_window', 'A session needs a real start and end.');
  }
  if (endsAt <= startsAt) {
    throw new ActivationError('bad_window', 'A session must end after it starts.');
  }

  // BOTH ENDS inside the paid period. A session that starts on the last day and
  // runs past midnight into an unpaid month is still a session the federation
  // was not paid to deliver.
  const standing = await assertProgramActive(db, input.programId, startsAt);
  await assertProgramActive(db, input.programId, endsAt);

  if (input.coachPersonId) {
    const { coachConflicts } = await import('./coaches');
    const clashes = await coachConflicts(db, input.coachPersonId, startsAt, endsAt);
    if (clashes.length) {
      throw new ActivationError('coach_conflict', `That coach is not free: ${clashes.map((c: any) => c.detail).join(' ')}`);
    }
  }
  if (input.venueId) {
    const { venueConflicts } = await import('./coaches');
    const clashes = await venueConflicts(db, input.venueId, startsAt, endsAt);
    if (clashes.length) {
      throw new ActivationError('venue_conflict', `That venue is not free: ${clashes.map((c: any) => c.detail).join(' ')}`);
    }
  }

  const seq = input.seq ?? await nextSeq(db, input.programId);

  let row: any;
  try {
    [row] = await db.insert(ops.programSessions).values({
      programId: input.programId,
      seq,
      title: input.title ?? null,
      topic: input.topic ?? null,
      startsAt, endsAt,
      venueId: input.venueId ?? null,
      coachPersonId: input.coachPersonId ?? null,
      status: 'scheduled',
    }).returning();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new ActivationError(
      'seq_taken',
      `Session ${seq} of that programme already exists — something else scheduled while this was being written. Try again.`
    );
  }

  await writeAudit(db, ctx, {
    entityType: 'program_session', entityId: row.id, action: 'create',
    newValue: {
      programId: input.programId, seq,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      coachPersonId: input.coachPersonId ?? null, venueId: input.venueId ?? null,
      withinPaidPeriod: `${standing.validFrom} … ${standing.validTo}`,
    },
  });

  await publish(db, {
    eventType: 'PROGRAM_SCHEDULED',
    entityType: 'program_session',
    entityId: row.id,
    payload: {
      programId: input.programId, sessionId: row.id, seq,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    },
    correlationId: `program:session:${row.id}`,
    actor: ctx.principal,
  });

  return row;
}

async function nextSeq(db: DB, programId: number): Promise<number> {
  const [top] = await db.select({ seq: ops.programSessions.seq })
    .from(ops.programSessions)
    .where(eq(ops.programSessions.programId, programId))
    .orderBy(desc(ops.programSessions.seq))
    .limit(1);
  return (top?.seq ?? 0) + 1;
}

// ─── What the institution's portal shows ────────────────────────────────────

export interface PortalView {
  program: any;
  standing: ProgramStanding;
  resources: Array<{ kind: ResourceKind; resourceId: number | null; validFrom: string; validTo: string | null; status: string }>;
  sessions: any[];
  coaches: any[];
  participants: { onRoll: number; departed: number };
}

/**
 * The programme, its calendar and its coaches — one read, for the client's own
 * portal.
 *
 * The standing is returned WHATEVER it says, and the surface renders it. A
 * portal that shows a calendar without saying the programme's paid period ended
 * last month is the failure this whole file exists to prevent, so the fact is
 * carried in the same object as the calendar rather than left to a second call
 * somebody may forget to make.
 */
export async function programPortalView(
  db: DB, principal: Principal, programId: number, at?: Date
): Promise<PortalView> {
  assertCanAnywhere(principal, 'program:read');

  const program = (await db.select().from(s.trainingPrograms)
    .where(eq(s.trainingPrograms.id, programId)).limit(1))[0];
  if (!program) throw new ActivationError('unknown_program', `No programme ${programId}.`);

  const standing = await programStanding(db, programId, at);

  const resources = standing.entitlementId
    ? await db.select({
        kind: s.entitlementResources.resourceKind,
        resourceId: s.entitlementResources.resourceId,
        validFrom: s.entitlementResources.validFrom,
        validTo: s.entitlementResources.validTo,
        status: s.entitlementResources.status,
      }).from(s.entitlementResources)
        .where(eq(s.entitlementResources.entitlementId, standing.entitlementId))
        .orderBy(asc(s.entitlementResources.resourceKind))
    : [];

  const sessions = await db.select().from(ops.programSessions)
    .where(eq(ops.programSessions.programId, programId))
    .orderBy(asc(ops.programSessions.seq));

  const coaches = await db.select({
    assignmentId: ops.coachAssignments.id,
    coachPersonId: ops.coachAssignments.coachPersonId,
    role: ops.coachAssignments.role,
    status: ops.coachAssignments.status,
    fullName: s.persons.fullName,
  })
    .from(ops.coachAssignments)
    .leftJoin(s.persons, eq(s.persons.id, ops.coachAssignments.coachPersonId))
    .where(and(
      eq(ops.coachAssignments.programId, programId),
      inArray(ops.coachAssignments.status, ['confirmed', 'accepted'])
    ))
    .orderBy(asc(ops.coachAssignments.id));

  const [counts] = await db.select({
    onRoll: sql<number>`(count(*) filter (where ${s.programParticipants.leftOn} is null))::int`,
    departed: sql<number>`(count(*) filter (where ${s.programParticipants.leftOn} is not null))::int`,
  }).from(s.programParticipants).where(eq(s.programParticipants.programId, programId));

  return {
    program, standing, resources, sessions, coaches,
    participants: { onRoll: counts?.onRoll ?? 0, departed: counts?.departed ?? 0 },
  };
}

// ─── The queue somebody has to work ─────────────────────────────────────────

/**
 * Programmes whose paid period runs out soon.
 *
 * The counterpart to entitlements.blockedEntitlements(): that one lists money
 * taken for nothing delivered, this one lists delivery about to stop. Both are
 * lists a person works, and neither expires anything by itself — an entitlement
 * ends because its date passed, and this report exists so that is not a surprise.
 */
export async function expiringPrograms(db: DB, principal: Principal, withinDays = 30, at?: Date) {
  assertCanAnywhere(principal, 'program:read');
  const from = today(at);
  // Day arithmetic on a day string, deliberately in UTC: `from` is already the
  // federation's day, and re-zoning a UTC-midnight instant would shift it back.
  const until = new Date(new Date(`${from}T00:00:00Z`).getTime() + withinDays * 86_400_000)
    .toISOString().slice(0, 10);

  return db.select({
    entitlementId: s.entitlements.id,
    programId: s.entitlements.subjectId,
    code: s.trainingPrograms.code,
    title: s.trainingPrograms.title,
    institutionId: s.trainingPrograms.institutionId,
    validFrom: s.entitlements.validFrom,
    validTo: s.entitlements.validTo,
  })
    .from(s.entitlements)
    .innerJoin(s.trainingPrograms, eq(s.trainingPrograms.id, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.subject, 'program'),
      eq(s.entitlements.status, 'active'),
      gte(s.entitlements.validTo, from),
      lte(s.entitlements.validTo, until)
    ))
    .orderBy(asc(s.entitlements.validTo));
}
