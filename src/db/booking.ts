// Coach availability, real slots, and bookings that actually hold the time.
//
// WHAT THIS MODULE EXISTS TO PREVENT.
//
// The default shape of a federation booking page is a contact form: pick a day,
// type a message, and receive "your request has been submitted, someone will
// call you". That is not a booking. It holds nothing, it can be sent twice for
// the same hour, and the person who answers the phone three days later is the
// one who discovers the coach was in Ranchi that morning. MMAKF was explicit:
// never render that unless it genuinely IS the workflow.
//
// So a slot returned by availableSlots() is one the coach published, is not
// already taken, and is not inside anybody's travel buffer — and book() takes
// it TRANSACTIONALLY, so the second person asking for it is refused rather than
// quietly given the same hour.
//
// THE RULE THAT MATTERS MOST: TWO PEOPLE MUST NOT GET THE SAME SLOT.
//
// "Check for an overlap, then insert" is a race with a name. Two requests both
// read "free", both insert, and the coach finds out on the day. The check and
// the insert here therefore happen inside ONE transaction that begins by taking
// `pg_advisory_xact_lock(BOOKING_LOCK_NAMESPACE, coachPersonId)` — a lock that
// covers exactly one coach's diary, is released by COMMIT or ROLLBACK with no
// unlock path to forget, and needs no row and no extension.
//
// Why that and not the alternatives:
//
//  · SELECT ... FOR UPDATE on the coach's `persons` row would work, and is what
//    src/lib/approvals.ts does for its own mutex. It is rejected here because
//    the coach's person row is edited by unrelated administration — a change of
//    address must not block a booking, and a booking must not block a change of
//    address. The lock belongs to the DIARY, not to the person record.
//
//  · A SERIALIZABLE transaction with a retry would also work, but it converts a
//    contended booking into a serialisation failure the caller must be written
//    to retry, and it makes every other statement in the transaction pay for a
//    guarantee only two of them need.
//
//  · An EXCLUSION CONSTRAINT over `tstzrange` is the right answer in the
//    database and is not available: it needs btree_gist, which the deployment
//    target may not carry (PGlite lists no available extensions at all), and it
//    needs a migration this run is forbidden to write. The schema note on
//    `bookingResources` already says so. See NOT PROVEN below.
//
// NOT PROVEN, AND SAID OUT LOUD. tests/booking.test.ts fires N simultaneous
// bookings for one slot and exactly one survives — measured, not asserted. But
// the tests run on PGlite, whose transactions are serialised by a mutex inside
// the engine (in-process) and by the socket server's query queue (over the
// wire: it will not dequeue another connection's message while a transaction is
// open). So those tests prove the TRANSACTION BOUNDARY is load-bearing — remove
// it and they fail with N bookings — and they do NOT prove the advisory lock
// excludes two real backends. Nothing in this repository can prove that; it
// needs two connections to a server Postgres. Do not read the green suite as
// evidence for the lock.
//
// WHAT THIS MODULE REFUSES TO DECIDE.
//
// Session length, notice period, cancellation window, cancellation fee, and how
// far ahead booking opens are FEDERATION POLICY and MMAKF has not set any of
// them. None has a default here. `durationMinutes` is a required parameter with
// no fallback; cancel() applies no window and no charge and says so in what it
// returns. A plausible default — "sessions are an hour", "cancel 24 hours
// ahead" — would be an invented rule that reads as though the federation made
// it, which is the one failure this project treats as unforgivable.
//
// PRIVACY. `coach_availability.reason` is why a coach is away. It is redacted
// from every read except the coach's own and a caller holding `person:read_pii`
// in the coach's scope, and it never appears in a slot search at all: a slot
// search returns the COMPLEMENT of the diary — free time — and free time cannot
// disclose a funeral. Where it is withheld the reader is told it was withheld,
// rather than being shown an empty field that reads as "no reason given".

import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, can, type Principal } from '@/lib/rbac';

type DB = any;

export class BookingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isBookingError(err: unknown): err is BookingError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'BookingError';
}

// ─── Time, and the day it actually is ───────────────────────────────────────

/**
 * India Standard Time, as a fixed offset.
 *
 * India has observed no daylight saving since 1945 and has one civil timezone,
 * so +05:30 is EXACT rather than an approximation — no timezone database is
 * needed and none is guessed at. If MMAKF ever schedules outside India this
 * becomes wrong, and it becomes wrong loudly here rather than silently in
 * twenty call sites.
 */
export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a wall-clock time on an IST calendar day begins.
 *
 * THIS IS THE FUNCTION THAT STOPS TUESDAY BECOMING MONDAY. `new Date('2026-09-15')`
 * is midnight UTC, which is 05:30 on the 15th in Patratu — so a search built on
 * it silently drops the first five and a half hours of the day the member asked
 * about and silently includes the last five and a half hours of the day before.
 * A 07:00 class would be missing from Tuesday and present on Monday, and the
 * only symptom is a member who cannot find a slot they were told exists.
 */
export function istInstant(dayIso: string, timeHHMM = '00:00'): Date {
  if (typeof dayIso !== 'string' || !ISO_DATE.test(dayIso)) {
    throw new BookingError('bad_date', `Expected an ISO date (YYYY-MM-DD); received ${JSON.stringify(dayIso)}.`);
  }
  if (typeof timeHHMM !== 'string' || !HHMM.test(timeHHMM)) {
    throw new BookingError('bad_time', `Expected a 24-hour time (HH:MM); received ${JSON.stringify(timeHHMM)}.`);
  }
  const utcMidnight = Date.parse(`${dayIso}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) {
    throw new BookingError('bad_date', `${dayIso} is not a real date.`);
  }
  const [h, m] = timeHHMM.split(':').map(Number);
  return new Date(utcMidnight + h * 3_600_000 + m * 60_000 - IST_OFFSET_MS);
}

/** Which IST calendar day an instant falls on. The inverse of istInstant(). */
export function istDayOf(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST wall-clock time of an instant, as HH:MM. */
export function istTimeOf(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * The half-open instant range covering whole IST days `from`..`to` INCLUSIVE.
 *
 * `to` is inclusive because that is what a person means by "Monday to Friday",
 * and a range that quietly stops at midnight on Thursday is the same off-by-one
 * as the one above wearing a different hat.
 */
export function istDayRange(fromDayIso: string, toDayIso: string): { from: Date; to: Date } {
  const from = istInstant(fromDayIso);
  const to = new Date(istInstant(toDayIso).getTime() + 86_400_000);
  if (to.getTime() <= from.getTime()) {
    throw new BookingError('bad_range', `The window ${fromDayIso}..${toDayIso} ends before it starts.`);
  }
  return { from, to };
}

// ─── Interval algebra ───────────────────────────────────────────────────────

export interface Interval {
  start: Date;
  end: Date;
}

type Span = { s: number; e: number };

const span = (i: Interval): Span => ({ s: i.start.getTime(), e: i.end.getTime() });
const unspan = (x: Span): Interval => ({ start: new Date(x.s), end: new Date(x.e) });

/** Overlap is HALF-OPEN: [10:00,11:00) and [11:00,12:00) do not overlap. */
function overlaps(a: Span, b: Span): boolean {
  return a.s < b.e && b.s < a.e;
}

/** Union, with touching spans joined, so the result has no seams to trip over. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const spans = list.map(span).filter((x) => x.e > x.s).sort((a, b) => a.s - b.s);
  const out: Span[] = [];
  for (const x of spans) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out.map(unspan);
}

/** Everything in `base` that is not in any of `cut`. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const cuts = mergeIntervals(cut).map(span);
  let pieces = mergeIntervals(base).map(span);
  for (const c of cuts) {
    const next: Span[] = [];
    for (const p of pieces) {
      if (!overlaps(p, c)) { next.push(p); continue; }
      if (p.s < c.s) next.push({ s: p.s, e: c.s });
      if (c.e < p.e) next.push({ s: c.e, e: p.e });
    }
    pieces = next;
  }
  return pieces.map(unspan);
}

/** The parts of `base` inside the window. */
export function clipIntervals(base: Interval[], window: Interval): Interval[] {
  const w = span(window);
  return mergeIntervals(base)
    .map(span)
    .map((p) => ({ s: Math.max(p.s, w.s), e: Math.min(p.e, w.e) }))
    .filter((p) => p.e > p.s)
    .map(unspan);
}

// ─── Statuses ───────────────────────────────────────────────────────────────

export type BookingKind =
  | 'consultation' | 'class' | 'personal_coaching' | 'institutional_session'
  | 'seminar' | 'assessment' | 'other';

export const BOOKING_KINDS: readonly BookingKind[] = [
  'consultation', 'class', 'personal_coaching', 'institutional_session',
  'seminar', 'assessment', 'other',
];

export type AvailabilityKind = 'available' | 'unavailable' | 'leave' | 'travel' | 'tentative';

export const AVAILABILITY_KINDS: readonly AvailabilityKind[] =
  ['available', 'unavailable', 'leave', 'travel', 'tentative'];

/**
 * The statuses that consume a coach's time.
 *
 * `completed` and `no_show` are in the list because the time WAS consumed: the
 * coach stood in the hall either way, and freeing that hour afterwards would
 * let the record show two sessions running at once. Only `cancelled` and
 * `expired` give the slot back, because only those mean the session never
 * happened.
 */
export const BLOCKING_STATUSES = [
  'requested', 'qualification_required', 'proposed',
  'confirmed', 'rescheduled', 'completed', 'no_show',
] as const;

export const RELEASING_STATUSES = ['cancelled', 'expired'] as const;

/**
 * Kinds that make a coach unavailable.
 *
 * `tentative` is here — it does NOT yield bookable time. Whether time a coach
 * marked "tentative" may be booked is a federation decision nobody has taken,
 * and the fail-closed reading is the only one that cannot produce a member
 * travelling to a session the coach never agreed to. availableSlots() reports
 * the tentative windows it set aside so a surface can say so out loud.
 */
const BLOCKING_AVAILABILITY: AvailabilityKind[] = ['unavailable', 'leave', 'travel', 'tentative'];

// ─── Identity and authority ─────────────────────────────────────────────────

/**
 * The caller's OWN person id, from their own user row.
 *
 * Never from the request. This is the only way this module learns who the
 * caller is, which is what makes myBookings() incapable of being asked for
 * somebody else's diary.
 */
async function ownPersonId(db: DB, principal: Principal | null | undefined): Promise<number | null> {
  if (!principal || principal.userId == null) return null;
  const row = (
    await db.select({ personId: s.users.personId }).from(s.users)
      .where(eq(s.users.id, principal.userId)).limit(1)
  )[0];
  return row?.personId ?? null;
}

async function loadPerson(db: DB, personId: number, what = 'person') {
  if (!Number.isInteger(personId) || personId <= 0) {
    throw new BookingError('bad_id', `${what} id must be a positive integer.`);
  }
  const row = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!row) throw new BookingError('unknown_person', `No ${what} exists with id ${personId}.`);
  return row;
}

const scopeOf = (person: any) => ({
  stateUnitId: person.stateUnitId,
  districtUnitId: person.districtUnitId,
  dojoId: person.dojoId,
});

/**
 * May this caller write into this coach's diary?
 *
 * Two ways in, and no third: the coach themselves, or an administrator holding
 * `engagement:write` in the coach's own scope. There is no `booking:*` action in
 * src/lib/rbac.ts and this run may not add one — see the note in the stream
 * report. `engagement:write` is the closest existing authority and it is the
 * right one by meaning: bookings live in the engagement schema alongside the
 * leads and training requests they come from.
 */
async function assertMayManageDiary(db: DB, principal: Principal, coach: any): Promise<'self' | 'admin'> {
  const me = await ownPersonId(db, principal);
  if (me != null && me === coach.id) return 'self';
  assertCan(principal, 'engagement:write', scopeOf(coach));
  return 'admin';
}

/** May this caller READ this coach's raw diary, reasons aside? */
async function assertMayReadDiary(db: DB, principal: Principal, coach: any): Promise<'self' | 'admin'> {
  const me = await ownPersonId(db, principal);
  if (me != null && me === coach.id) return 'self';
  assertCan(principal, 'engagement:read', scopeOf(coach));
  return 'admin';
}

// ─── Availability ───────────────────────────────────────────────────────────

export interface SetAvailabilityInput {
  coachPersonId: number;
  kind: AvailabilityKind;
  startsAt: Date;
  endsAt: Date;
  /** PRIVATE. Redacted from every reader except the coach and `person:read_pii`. */
  reason?: string | null;
}

function requireInstant(v: unknown, field: string): Date {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw new BookingError('bad_instant', `${field} must be a Date or an ISO instant; received ${JSON.stringify(v)}.`);
  }
  return d;
}

/**
 * Record a window of a coach's diary.
 *
 * Windows are stored as intervals rather than a weekly pattern with exceptions,
 * for the reason the schema gives: the question this table exists to answer is
 * "is he free on the 14th?", and a pattern can only answer it by rebuilding the
 * exception list first.
 *
 * Overlapping windows are ALLOWED and are resolved at read time — an
 * `available` Monday-to-Friday block with a `leave` day inside it is the normal
 * way to say what a coach means, and refusing it would force the office to
 * split the block by hand.
 */
export async function setAvailability(
  db: DB,
  ctx: AuditContext,
  input: SetAvailabilityInput
): Promise<{ id: number }> {
  if (!AVAILABILITY_KINDS.includes(input.kind)) {
    throw new BookingError('bad_kind', `Unknown availability kind ${JSON.stringify(input.kind)}.`);
  }
  const startsAt = requireInstant(input.startsAt, 'startsAt');
  const endsAt = requireInstant(input.endsAt, 'endsAt');
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new BookingError('bad_range', 'An availability window must end after it starts.');
  }

  const coach = await loadPerson(db, input.coachPersonId, 'coach');
  await assertMayManageDiary(db, ctx.principal, coach);

  const rows = await db.insert(s.coachAvailability).values({
    personId: coach.id,
    kind: input.kind,
    startsAt,
    endsAt,
    reason: input.reason ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning({ id: s.coachAvailability.id });

  // The reason is deliberately NOT in the audit payload. An audit trail is read
  // by more people than the diary is, and copying a private reason into it
  // would defeat the redaction three functions below.
  await writeAudit(db, ctx, {
    entityType: 'coach_availability',
    entityId: rows[0].id,
    action: 'create',
    newValue: {
      coachPersonId: coach.id,
      kind: input.kind,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reasonRecorded: Boolean(input.reason),
    },
  });

  return rows[0];
}

export interface AvailabilityRow {
  id: number;
  kind: AvailabilityKind;
  startsAt: Date;
  endsAt: Date;
  /** IST wall clock, so a surface never has to do the offset itself and get it wrong. */
  istDay: string;
  istStart: string;
  istEnd: string;
  /** Null when the coach recorded none OR when this reader may not see it. */
  reason: string | null;
  /** True when a reason EXISTS and was withheld. Never conflated with "none given". */
  reasonWithheld: boolean;
}

/**
 * A coach's own diary, for the coach and for the office.
 *
 * `reason` survives to the caller only for the coach themselves and for a
 * caller holding `person:read_pii` in the coach's scope. Everybody else is told
 * that a reason exists and was withheld, which is a different fact from "no
 * reason was recorded" and is kept different on purpose: an administrator
 * chasing a gap in the schedule needs to know whether to ask.
 */
export async function listAvailability(
  db: DB,
  principal: Principal,
  coachPersonId: number,
  window: { from: Date; to: Date }
): Promise<AvailabilityRow[]> {
  const coach = await loadPerson(db, coachPersonId, 'coach');
  const who = await assertMayReadDiary(db, principal, coach);
  const mayReadReason = who === 'self' || can(principal, 'person:read_pii', scopeOf(coach));

  const from = requireInstant(window?.from, 'window.from');
  const to = requireInstant(window?.to, 'window.to');

  const rows = await db.select().from(s.coachAvailability)
    .where(and(
      eq(s.coachAvailability.personId, coach.id),
      lt(s.coachAvailability.startsAt, to),
      gte(s.coachAvailability.endsAt, from),
    ))
    .orderBy(asc(s.coachAvailability.startsAt));

  return rows.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    istDay: istDayOf(r.startsAt),
    istStart: istTimeOf(r.startsAt),
    istEnd: istTimeOf(r.endsAt),
    reason: mayReadReason ? (r.reason ?? null) : null,
    reasonWithheld: !mayReadReason && Boolean(r.reason),
  }));
}

// ─── The diary, resolved ────────────────────────────────────────────────────

/** Every booking that consumes the coach's time in the window, with buffers applied. */
async function busyIntervals(
  db: DB,
  coachPersonId: number,
  window: { from: Date; to: Date },
  excludeBookingId?: number | null
): Promise<Interval[]> {
  // A coach can be attached to a booking as its `coachPersonId` or as a
  // `booking_resources` row — a seminar with two instructors has one of each,
  // and reading only the column would let the second instructor be double-booked.
  const resourceBookingIds = db
    .select({ id: s.bookingResources.bookingId })
    .from(s.bookingResources)
    .where(and(
      eq(s.bookingResources.personId, coachPersonId),
      eq(s.bookingResources.resourceKind, 'coach'),
    ));

  const rows = await db.select({
    id: s.bookings.id,
    startsAt: s.bookings.startsAt,
    endsAt: s.bookings.endsAt,
    before: s.bookings.bufferBeforeMinutes,
    after: s.bookings.bufferAfterMinutes,
  }).from(s.bookings)
    .where(and(
      inArray(s.bookings.status, BLOCKING_STATUSES as any),
      or(
        eq(s.bookings.coachPersonId, coachPersonId),
        sql`${s.bookings.id} in ${resourceBookingIds}`,
      ),
      // Padded, so a booking whose SESSION is outside the window but whose
      // buffer reaches into it is still counted. Two hours is far more than any
      // buffer this system has seen; it costs one index scan and it removes an
      // entire class of edge case at the window boundary.
      lt(s.bookings.startsAt, new Date(window.to.getTime() + 7_200_000)),
      gte(s.bookings.endsAt, new Date(window.from.getTime() - 7_200_000)),
    ));

  return rows
    .filter((r: any) => excludeBookingId == null || r.id !== excludeBookingId)
    .map((r: any) => ({
      start: new Date(new Date(r.startsAt).getTime() - (r.before ?? 0) * 60_000),
      end: new Date(new Date(r.endsAt).getTime() + (r.after ?? 0) * 60_000),
    }));
}

/** The coach's published working time in the window, less leave, travel and tentative. */
async function openWindows(
  db: DB,
  coachPersonId: number,
  window: { from: Date; to: Date }
): Promise<{ open: Interval[]; tentative: Interval[] }> {
  const rows = await db.select().from(s.coachAvailability)
    .where(and(
      eq(s.coachAvailability.personId, coachPersonId),
      lt(s.coachAvailability.startsAt, window.to),
      gte(s.coachAvailability.endsAt, window.from),
    ));

  const asInterval = (r: any): Interval => ({ start: new Date(r.startsAt), end: new Date(r.endsAt) });
  const available = rows.filter((r: any) => r.kind === 'available').map(asInterval);
  const blocked = rows.filter((r: any) => BLOCKING_AVAILABILITY.includes(r.kind)).map(asInterval);
  const tentative = rows.filter((r: any) => r.kind === 'tentative').map(asInterval);

  const open = clipIntervals(subtractIntervals(available, blocked), { start: window.from, end: window.to });
  return { open, tentative: clipIntervals(tentative, { start: window.from, end: window.to }) };
}

// ─── Slot search ────────────────────────────────────────────────────────────

export interface SlotSearch {
  coachPersonId: number;
  /** IST calendar days, inclusive both ends. */
  from: string;
  to: string;
  /** REQUIRED, and with no default: MMAKF has not published a session length. */
  durationMinutes: number;
  /** Buffers the NEW booking would need. Zero means none recorded, not none needed. */
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** Candidate spacing. Defaults to the duration — slots laid end to end. */
  stepMinutes?: number;
  /** Injected clock. Slots already in the past are dropped; this is arithmetic, not a notice period. */
  now?: Date;
  limit?: number;
}

export interface SlotSearchResult {
  coachPersonId: number;
  /** The window that was actually searched, echoed so a cached page cannot lie about it. */
  from: string;
  to: string;
  durationMinutes: number;
  slots: Array<{ startsAt: Date; endsAt: Date; istDay: string; istStart: string; istEnd: string }>;
  /**
   * Windows the coach marked tentative and this search therefore refused to
   * offer. Reported rather than dropped, so the surface can say what it did.
   */
  tentativeExcluded: Array<{ istDay: string; istStart: string; istEnd: string }>;
  /** One sentence a surface may print verbatim when `slots` is empty. */
  note: string;
}

/**
 * Real slots: published availability, MINUS bookings, MINUS their buffers.
 *
 * The output is the COMPLEMENT of the coach's private diary — free time only.
 * It carries no reason, no other member's name, no booking reference and no
 * indication of WHY an hour is missing. That is what makes it safe to show to
 * the person who wants to book, and it is why this function gates on being
 * identified rather than on `engagement:read`: requiring an administrator's
 * authority to see free time would mean only administrators could ever book,
 * which is not a booking system.
 */
export async function availableSlots(
  db: DB,
  principal: Principal,
  search: SlotSearch
): Promise<SlotSearchResult> {
  if (!principal) throw new BookingError('not_identified', 'A slot search must be made by an identified caller.');

  const duration = search.durationMinutes;
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new BookingError(
      'duration_required',
      'durationMinutes is required and has no default: MMAKF has not published a session length, and this system will not invent one.'
    );
  }
  const step = search.stepMinutes ?? duration;
  if (!Number.isInteger(step) || step <= 0) {
    throw new BookingError('bad_step', 'stepMinutes must be a positive whole number of minutes.');
  }
  const bufBefore = search.bufferBeforeMinutes ?? 0;
  const bufAfter = search.bufferAfterMinutes ?? 0;
  if (bufBefore < 0 || bufAfter < 0) throw new BookingError('bad_buffer', 'Buffers cannot be negative.');

  const coach = await loadPerson(db, search.coachPersonId, 'coach');
  const window = istDayRange(search.from, search.to);
  const now = search.now ?? new Date();
  const limit = search.limit ?? 500;

  const { open, tentative } = await openWindows(db, coach.id, window);
  const busy = mergeIntervals(await busyIntervals(db, coach.id, window));

  const durationMs = duration * 60_000;
  const stepMs = step * 60_000;
  const slots: SlotSearchResult['slots'] = [];

  for (const w of open) {
    for (let start = w.start.getTime(); start + durationMs <= w.end.getTime(); start += stepMs) {
      if (slots.length >= limit) break;
      const end = start + durationMs;
      if (start < now.getTime()) continue;

      // The occupancy the booking would need, not merely the session. A slot
      // that fits the hour but not the travel time either side is not a slot.
      const occupied: Span = { s: start - bufBefore * 60_000, e: end + bufAfter * 60_000 };
      if (busy.map(span).some((b) => overlaps(occupied, b))) continue;

      slots.push({
        startsAt: new Date(start),
        endsAt: new Date(end),
        istDay: istDayOf(new Date(start)),
        istStart: istTimeOf(new Date(start)),
        istEnd: istTimeOf(new Date(end)),
      });
    }
  }

  const note = slots.length
    ? `${slots.length} slot${slots.length === 1 ? '' : 's'} of ${duration} minutes, from availability the coach published.`
    : open.length
      ? 'The coach has published availability in this window, but every slot of this length is already taken or falls inside a buffer.'
      : 'The coach has published no available time in this window. That is not a refusal — it is an empty diary.';

  return {
    coachPersonId: coach.id,
    from: search.from,
    to: search.to,
    durationMinutes: duration,
    slots,
    tentativeExcluded: tentative.map((t) => ({
      istDay: istDayOf(t.start), istStart: istTimeOf(t.start), istEnd: istTimeOf(t.end),
    })),
    note,
  };
}

// ─── Booking ────────────────────────────────────────────────────────────────

/**
 * The advisory-lock namespace for coach diaries.
 *
 * An arbitrary but FIXED integer. It exists so that a lock taken here cannot
 * collide with an advisory lock taken by anything else in this database; the
 * second argument is the coach's person id, so two coaches never contend.
 */
export const BOOKING_LOCK_NAMESPACE = 42_710;

async function lockCoachDiary(tx: DB, coachPersonId: number): Promise<void> {
  // Casts are explicit: pg_advisory_xact_lock is overloaded on (bigint) and
  // (int4,int4), and an untyped parameter leaves Postgres to guess which.
  await tx.execute(
    sql`select pg_advisory_xact_lock(${BOOKING_LOCK_NAMESPACE}::int4, ${coachPersonId}::int4)`
  );
}

export interface BookInput {
  kind: BookingKind;
  coachPersonId: number;
  startsAt: Date;
  endsAt: Date;
  /** Who the session is for. A member may only book for themselves. */
  personId?: number | null;
  institutionId?: number | null;
  requestId?: number | null;
  programId?: number | null;
  dojoId?: number | null;
  venue?: string | null;
  mode?: 'on_site' | 'at_dojo' | 'online' | 'hybrid' | null;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  capacity?: number | null;
  notes?: string | null;
}

export interface BookingRecord {
  id: number;
  ref: string;
  kind: BookingKind;
  status: string;
  coachPersonId: number | null;
  personId: number | null;
  institutionId: number | null;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  istDay: string;
  istStart: string;
  istEnd: string;
  venue: string | null;
  dojoId: number | null;
  notes: string | null;
  cancelledReason: string | null;
}

function shape(r: any): BookingRecord {
  return {
    id: r.id,
    ref: r.ref,
    kind: r.kind,
    status: r.status,
    coachPersonId: r.coachPersonId ?? null,
    personId: r.personId ?? null,
    institutionId: r.institutionId ?? null,
    startsAt: new Date(r.startsAt),
    endsAt: new Date(r.endsAt),
    bufferBeforeMinutes: r.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: r.bufferAfterMinutes ?? 0,
    istDay: istDayOf(r.startsAt),
    istStart: istTimeOf(r.startsAt),
    istEnd: istTimeOf(r.endsAt),
    venue: r.venue ?? null,
    dojoId: r.dojoId ?? null,
    notes: r.notes ?? null,
    cancelledReason: r.cancelledReason ?? null,
  };
}

/**
 * Inside the lock: is this exact interval still bookable?
 *
 * Called with the diary already locked, so what it reads cannot change under
 * it. Every refusal names the reason, because "unavailable" is useless to the
 * person who was looking at that slot ten seconds ago.
 */
async function assertSlotIsFree(
  tx: DB,
  coachPersonId: number,
  startsAt: Date,
  endsAt: Date,
  bufBefore: number,
  bufAfter: number,
  excludeBookingId?: number | null
): Promise<void> {
  const window = {
    from: new Date(startsAt.getTime() - bufBefore * 60_000),
    to: new Date(endsAt.getTime() + bufAfter * 60_000),
  };

  const { open } = await openWindows(tx, coachPersonId, {
    from: new Date(window.from.getTime() - 86_400_000),
    to: new Date(window.to.getTime() + 86_400_000),
  });

  const session: Span = { s: startsAt.getTime(), e: endsAt.getTime() };
  const inside = open.map(span).some((w) => w.s <= session.s && session.e <= w.e);
  if (!inside) {
    throw new BookingError(
      'outside_availability',
      'The coach has not published that time as available, or has since marked it leave, travel or tentative. Nothing was booked.'
    );
  }

  const busy = mergeIntervals(await busyIntervals(tx, coachPersonId, window, excludeBookingId)).map(span);
  const occupied: Span = { s: window.from.getTime(), e: window.to.getTime() };
  const clash = busy.find((b) => overlaps(occupied, b));
  if (clash) {
    const sessionClash = busy.some((b) => overlaps(session, b));
    throw new BookingError(
      'slot_taken',
      sessionClash
        ? 'That slot has already been booked. Nothing was booked twice.'
        : 'That slot is free but the travel and setup buffer either side of it is not. Nothing was booked.'
    );
  }
}

/**
 * Take a slot. Really take it.
 *
 * The whole check-and-insert runs in ONE transaction that starts by locking the
 * coach's diary, so the sequence two callers cannot interleave is the sequence
 * that decides. The booking is created CONFIRMED: the coach published the time,
 * the time was free, and it is now held. If MMAKF later decides a class of
 * booking must be qualified by the office first, `qualification_required` is
 * already in the status enum — but that is a decision for the federation to
 * record, not a default to be helpful with here.
 */
export async function book(db: DB, ctx: AuditContext, input: BookInput): Promise<BookingRecord> {
  if (!BOOKING_KINDS.includes(input.kind)) {
    throw new BookingError('bad_kind', `Unknown booking kind ${JSON.stringify(input.kind)}.`);
  }
  const startsAt = requireInstant(input.startsAt, 'startsAt');
  const endsAt = requireInstant(input.endsAt, 'endsAt');
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new BookingError('bad_range', 'A booking must end after it starts.');
  }
  const bufBefore = input.bufferBeforeMinutes ?? 0;
  const bufAfter = input.bufferAfterMinutes ?? 0;
  if (bufBefore < 0 || bufAfter < 0) throw new BookingError('bad_buffer', 'Buffers cannot be negative.');

  const coach = await loadPerson(db, input.coachPersonId, 'coach');

  // WHO MAY BOOK. Three ways, and the first is what makes the member-facing
  // surface possible without handing every member `engagement:write`:
  //   · booking for yourself — input.personId is YOUR OWN person id;
  //   · you are the coach, filling your own diary;
  //   · you hold engagement:write in the coach's scope.
  // A member passing somebody else's personId falls through to the third and is
  // refused, so the id in the request buys nothing.
  const me = await ownPersonId(db, ctx.principal);
  const forSelf = input.personId != null && me != null && input.personId === me;
  const isCoach = me != null && me === coach.id;
  if (!forSelf && !isCoach) {
    assertCan(ctx.principal, 'engagement:write', scopeOf(coach));
  }
  if (input.personId != null && !forSelf && !isCoach) {
    // Booking on behalf of somebody requires authority over THEM too, not only
    // over the coach — otherwise a state administrator could put a member of
    // another state into a session without ever touching that state.
    const subject = await loadPerson(db, input.personId, 'attendee');
    assertCan(ctx.principal, 'engagement:write', scopeOf(subject));
  }

  const created = await db.transaction(async (tx: DB) => {
    await lockCoachDiary(tx, coach.id);
    await assertSlotIsFree(tx, coach.id, startsAt, endsAt, bufBefore, bufAfter);

    const ref = await allocateFederationId(tx, 'BKG', Number(istDayOf(startsAt).slice(0, 4)));

    const rows = await tx.insert(s.bookings).values({
      ref,
      kind: input.kind,
      status: 'confirmed',
      programId: input.programId ?? null,
      requestId: input.requestId ?? null,
      institutionId: input.institutionId ?? null,
      personId: input.personId ?? null,
      coachPersonId: coach.id,
      dojoId: input.dojoId ?? null,
      venue: input.venue ?? null,
      mode: input.mode ?? null,
      startsAt,
      endsAt,
      bufferBeforeMinutes: bufBefore,
      bufferAfterMinutes: bufAfter,
      capacity: input.capacity ?? null,
      notes: input.notes ?? null,
      createdByUserId: ctx.principal.userId ?? null,
    }).returning();

    const booking = rows[0];

    // The resource rows. The coach is written here as well as onto the booking
    // because a session can need a second instructor and a hall, and
    // double-booking has to be detectable PER RESOURCE — see the schema note.
    const resources: any[] = [
      { bookingId: booking.id, resourceKind: 'coach', personId: coach.id, label: coach.fullName },
    ];
    if (input.dojoId != null) {
      resources.push({ bookingId: booking.id, resourceKind: 'venue', dojoId: input.dojoId, label: input.venue ?? null });
    } else if (input.venue) {
      resources.push({ bookingId: booking.id, resourceKind: 'venue', label: input.venue });
    }
    await tx.insert(s.bookingResources).values(resources);

    return booking;
  });

  await writeAudit(db, ctx, {
    entityType: 'booking',
    entityId: created.id,
    action: 'create',
    newValue: {
      ref: created.ref, kind: created.kind, coachPersonId: coach.id,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      bufferBeforeMinutes: bufBefore, bufferAfterMinutes: bufAfter,
    },
  });

  return shape(created);
}

// ─── Moving and ending a booking ────────────────────────────────────────────

async function loadBooking(db: DB, bookingId: number) {
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new BookingError('bad_id', 'A booking id must be a positive integer.');
  }
  const row = (await db.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1))[0];
  if (!row) throw new BookingError('unknown_booking', `No booking exists with id ${bookingId}.`);
  return row;
}

/**
 * May this caller act on this booking?
 *
 * The attendee, the coach, or an administrator with `engagement:write` in the
 * coach's scope. A booking with neither an attendee person nor a coach the
 * caller owns is administrative only.
 */
async function assertMayActOnBooking(db: DB, principal: Principal, booking: any): Promise<void> {
  const me = await ownPersonId(db, principal);
  if (me != null && (me === booking.personId || me === booking.coachPersonId)) return;
  const coach = booking.coachPersonId != null
    ? await loadPerson(db, booking.coachPersonId, 'coach')
    : null;
  assertCan(principal, 'engagement:write', coach ? scopeOf(coach) : {});
}

const TERMINAL = new Set(['cancelled', 'completed', 'no_show', 'expired']);

/**
 * Move a booking to a different time.
 *
 * The same lock, the same check, and the booking EXCLUDES ITSELF from the
 * overlap test — without that, moving a session forward by fifteen minutes
 * would clash with the copy of itself it is being moved from, and the operation
 * could never succeed.
 */
export async function reschedule(
  db: DB,
  ctx: AuditContext,
  bookingId: number,
  to: { startsAt: Date; endsAt: Date; bufferBeforeMinutes?: number; bufferAfterMinutes?: number }
): Promise<BookingRecord> {
  const booking = await loadBooking(db, bookingId);
  await assertMayActOnBooking(db, ctx.principal, booking);

  if (TERMINAL.has(booking.status)) {
    throw new BookingError(
      'not_reschedulable',
      `This booking is ${booking.status.replace(/_/g, ' ')}. A finished booking is not moved — a new one is made, so the record keeps both.`
    );
  }
  if (booking.coachPersonId == null) {
    throw new BookingError('no_coach', 'This booking has no coach, so there is no diary to move it within.');
  }

  const startsAt = requireInstant(to.startsAt, 'startsAt');
  const endsAt = requireInstant(to.endsAt, 'endsAt');
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new BookingError('bad_range', 'A booking must end after it starts.');
  }
  const bufBefore = to.bufferBeforeMinutes ?? booking.bufferBeforeMinutes ?? 0;
  const bufAfter = to.bufferAfterMinutes ?? booking.bufferAfterMinutes ?? 0;

  const moved = await db.transaction(async (tx: DB) => {
    await lockCoachDiary(tx, booking.coachPersonId);
    await assertSlotIsFree(tx, booking.coachPersonId, startsAt, endsAt, bufBefore, bufAfter, booking.id);

    const rows = await tx.update(s.bookings).set({
      startsAt, endsAt,
      bufferBeforeMinutes: bufBefore,
      bufferAfterMinutes: bufAfter,
      status: 'rescheduled',
      updatedAt: new Date(),
    }).where(eq(s.bookings.id, booking.id)).returning();
    return rows[0];
  });

  await writeAudit(db, ctx, {
    entityType: 'booking',
    entityId: booking.id,
    action: 'update',
    oldValue: { startsAt: new Date(booking.startsAt).toISOString(), endsAt: new Date(booking.endsAt).toISOString(), status: booking.status },
    newValue: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), status: 'rescheduled' },
  });

  return shape(moved);
}

export interface CancelResult {
  booking: BookingRecord;
  /**
   * What the federation has NOT decided, printed alongside every cancellation
   * so no surface has to guess. A cancellation window and a cancellation fee
   * are policy; MMAKF has published neither, and this system applies neither.
   */
  policyNote: string;
}

/** Cancel, with a reason. The reason is required — an unexplained cancellation is a mystery to whoever reads the record next. */
export async function cancel(
  db: DB,
  ctx: AuditContext,
  bookingId: number,
  reason: string
): Promise<CancelResult> {
  const booking = await loadBooking(db, bookingId);
  await assertMayActOnBooking(db, ctx.principal, booking);

  const text = (reason ?? '').trim();
  if (!text) {
    throw new BookingError('reason_required', 'A cancellation must record why. It is read months later by somebody who was not there.');
  }
  if (booking.status === 'cancelled') {
    throw new BookingError('already_cancelled', 'This booking is already cancelled.');
  }
  if (TERMINAL.has(booking.status)) {
    throw new BookingError('not_cancellable', `This booking is ${booking.status.replace(/_/g, ' ')} and cannot be cancelled after the fact.`);
  }

  const rows = await db.update(s.bookings)
    .set({ status: 'cancelled', cancelledReason: text, updatedAt: new Date() })
    .where(eq(s.bookings.id, booking.id))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'booking',
    entityId: booking.id,
    action: 'update',
    oldValue: { status: booking.status },
    newValue: { status: 'cancelled', cancelledReason: text },
  });

  return {
    booking: shape(rows[0]),
    policyNote:
      'The slot is released. MMAKF has not published a cancellation window or a cancellation fee, so none has been applied and none is owed by this record.',
  };
}

/** Mark a session as delivered. Takes the clock so it can be tested without waiting for one. */
export async function complete(
  db: DB,
  ctx: AuditContext,
  bookingId: number,
  opts: { outcome?: string | null; now?: Date } = {}
): Promise<BookingRecord> {
  const booking = await loadBooking(db, bookingId);
  await assertMayActOnBooking(db, ctx.principal, booking);
  const now = opts.now ?? new Date();

  if (TERMINAL.has(booking.status)) {
    throw new BookingError('not_completable', `This booking is ${booking.status.replace(/_/g, ' ')}.`);
  }
  // Not a policy: a session that has not started cannot have been delivered.
  if (new Date(booking.startsAt).getTime() > now.getTime()) {
    throw new BookingError(
      'not_yet_started',
      'This session has not started yet. Recording it as delivered would put a fact in the register that has not happened.'
    );
  }

  const rows = await db.update(s.bookings)
    .set({ status: 'completed', updatedAt: now })
    .where(eq(s.bookings.id, booking.id))
    .returning();

  if (opts.outcome) {
    const existing = (await db.select({ id: s.consultations.id }).from(s.consultations)
      .where(eq(s.consultations.bookingId, booking.id)).limit(1))[0];
    if (existing) {
      await db.update(s.consultations).set({ outcome: opts.outcome }).where(eq(s.consultations.id, existing.id));
    } else {
      await db.insert(s.consultations).values({ bookingId: booking.id, outcome: opts.outcome });
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'booking', entityId: booking.id, action: 'update',
    oldValue: { status: booking.status }, newValue: { status: 'completed' },
  });

  return shape(rows[0]);
}

/**
 * Record that the session was held and nobody came.
 *
 * A DIFFERENT FACT FROM A CANCELLATION, and kept different: a cancellation is a
 * decision somebody took in advance, a no-show is what happened on the day.
 * Collapsing them would let a member who never turned up be indistinguishable
 * from one who gave notice, which is precisely the distinction the federation
 * would need if it ever set a policy about either.
 */
export async function markNoShow(
  db: DB,
  ctx: AuditContext,
  bookingId: number,
  opts: { note?: string | null; now?: Date } = {}
): Promise<BookingRecord> {
  const booking = await loadBooking(db, bookingId);
  await assertMayActOnBooking(db, ctx.principal, booking);
  const now = opts.now ?? new Date();

  if (TERMINAL.has(booking.status)) {
    throw new BookingError('not_markable', `This booking is ${booking.status.replace(/_/g, ' ')}.`);
  }
  if (new Date(booking.startsAt).getTime() > now.getTime()) {
    throw new BookingError(
      'not_yet_started',
      'This session has not started yet, so nobody has failed to attend it.'
    );
  }

  const rows = await db.update(s.bookings)
    .set({ status: 'no_show', notes: opts.note ?? booking.notes, updatedAt: now })
    .where(eq(s.bookings.id, booking.id))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'booking', entityId: booking.id, action: 'update',
    oldValue: { status: booking.status }, newValue: { status: 'no_show' },
  });

  return shape(rows[0]);
}

// ─── The caller's own diary ─────────────────────────────────────────────────

export interface MyBooking extends BookingRecord {
  /** Which side of the session the caller is on. */
  role: 'coach' | 'attendee';
  coachName: string | null;
}

/**
 * The CALLER's bookings. Takes no person id, and there is nowhere to put one.
 *
 * The same structural guarantee as /my: the request cannot express "whose
 * bookings?", so no check made afterwards can be forgotten or bypassed. A
 * shared credential resolves to no person and is told so rather than being
 * shown an empty list it might read as "you have none".
 */
export async function myBookings(
  db: DB,
  principal: Principal,
  opts: { from?: Date; to?: Date; includeFinished?: boolean; limit?: number } = {}
): Promise<MyBooking[]> {
  const me = await ownPersonId(db, principal);
  if (me == null) {
    throw new BookingError(
      'no_person',
      'This account is not linked to a person record, so it has no bookings of its own. The federation office links an account to its member record.'
    );
  }

  const conds: any[] = [or(eq(s.bookings.personId, me), eq(s.bookings.coachPersonId, me))];
  if (opts.from) conds.push(gte(s.bookings.endsAt, opts.from));
  if (opts.to) conds.push(lte(s.bookings.startsAt, opts.to));
  if (!opts.includeFinished) {
    conds.push(inArray(s.bookings.status, ['requested', 'qualification_required', 'proposed', 'confirmed', 'rescheduled'] as any));
  }

  const rows = await db.select({
    b: s.bookings,
    coachName: s.persons.fullName,
  }).from(s.bookings)
    .leftJoin(s.persons, eq(s.persons.id, s.bookings.coachPersonId))
    .where(and(...conds))
    .orderBy(asc(s.bookings.startsAt))
    .limit(opts.limit ?? 200);

  return rows.map((r: any) => ({
    ...shape(r.b),
    role: r.b.coachPersonId === me ? 'coach' : 'attendee',
    coachName: r.coachName ?? null,
  }));
}
