// The federation calendar (Q-22).
//
// A national federation runs three kinds of dated thing — championships,
// gradings, and courses — and until now each lived in its own table with its own
// surface. An athlete planning a season had to check three places and reconcile
// them by hand, which is how a member ends up entering a championship the week
// of their grading.
//
// FOUR RULES SHAPE THIS MODULE.
//
//  1. AN EVENT WITH NO DATE IS NOT PLACED ON ONE. `startsOn` is nullable in the
//     schema because the federation genuinely announces events before fixing a
//     date. Such an event is returned in `undated` and never guessed onto a day.
//     A calendar that invents a date is worse than one with a gap in it: the gap
//     is visibly a gap, and the invention is not.
//
//  2. SANCTION IS PART OF THE ENTRY. A championship that is not sanctioned is
//     not a federation event (competition.schema.ts). It still appears — a
//     member searching for it should find it — but carrying `sanctioned: false`
//     so no surface can render it as though the federation stood behind it.
//
//  3. THE REGISTRATION WINDOW IS ANSWERED AS AT A DATE, never "now". Planning a
//     season in March means asking whether entries are open on the day of the
//     event in August. `asAt` is a parameter, exactly as it is in officials.ts,
//     and the answer names the date it was computed for.
//
//  4. SCOPE IS APPLIED IN SQL, from the caller's own bindings. A state
//     secretary sees their state's calendar plus everything national; they do
//     not see another state's draft fixtures. Anonymous callers get published
//     records only, gated before any query runs.
//
// AND ONE THING THIS MODULE WILL NOT DO: it will not decide which grading
// events are public. `PUBLIC_GRADING_STATUSES` lists the statuses whose
// existence the federation already publishes by scheduling them. A grading in
// `draft` is a plan, not a fixture, and does not leave the office.

import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';

type DB = any;

export class CalendarError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

/**
 * Why not `instanceof`: it compares constructor identity, and a bundler that
 * resolves the module under two specifiers hands this file a DIFFERENT
 * CalendarError class from the one that was thrown. The check then silently
 * fails and the caller loses the actual reason — "from must be an ISO date"
 * becomes "something went wrong". Every error this module raises carries a
 * `code`, so that is what is checked.
 */
export function isCalendarError(err: unknown): err is CalendarError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'CalendarError';
}

// ─── What appears ───────────────────────────────────────────────────────────

export type EntryKind = 'competition' | 'grading' | 'course';

/**
 * Competition statuses whose existence the federation has published. Duplicated
 * from search.ts's PUBLIC_EVENT_STATUSES deliberately and for the same reason
 * given there: both are read-only views of a federation decision, and coupling
 * them means a change to one silently changes the other. If the federation
 * changes which statuses are public, BOTH lists move.
 */
export const PUBLIC_EVENT_STATUSES = [
  'published', 'registration_open', 'registration_closed',
  'check_in', 'live', 'results_pending', 'results_final', 'archived',
] as const;

/**
 * Grading statuses that are public. `draft` is deliberately absent: a draft
 * grading is a plan inside the office, and publishing plans as fixtures is how
 * a member travels 200km to an examination that was never confirmed.
 */
export const PUBLIC_GRADING_STATUSES = [
  'scheduled', 'registration_open', 'registration_closed',
  'in_progress', 'scoring', 'awaiting_approval', 'approved', 'locked',
] as const;

/** Statuses that mean the thing is not happening as listed. */
export const CANCELLED_STATUSES = ['cancelled', 'postponed'] as const;

export type RegistrationState =
  | 'not_open_yet'
  | 'open'
  | 'closed'
  | 'no_window_recorded';

export interface CalendarEntry {
  kind: EntryKind;
  /** The record's immutable code — MMAKF-EVT-…, MMAKF-GRD-…. Entries bind to this. */
  ref: string;
  id: number;
  title: string;
  /** The event's own sub-type, as the federation recorded it. Never inferred. */
  category: string | null;
  status: string;
  /** ISO date, or null. A null date is NEVER filled in. */
  startsOn: string | null;
  endsOn: string | null;
  venue: string | null;
  city: string | null;
  stateUnitId: number | null;
  districtUnitId: number | null;
  /**
   * Whether the federation has sanctioned this event. Null for kinds where
   * sanction is not the governing concept (a grading is authorised by its
   * syllabus version and chief examiner, not by a sanction reference).
   */
  sanctioned: boolean | null;
  sanctionReference: string | null;
  /** Registration as at the requested date, with the date it was answered for. */
  registration: { state: RegistrationState; asAt: string };
  cancelled: boolean;
  url: string | null;
}

export interface CalendarResult {
  /** The window asked for. Echoed so a caller can label what it is showing. */
  from: string;
  to: string;
  asAt: string;
  /** Dated entries, earliest first. */
  entries: CalendarEntry[];
  /**
   * Announced but not yet dated. These are REAL federation events; they are
   * separated because placing them on a day would be an invention, and dropping
   * them would hide announcements the federation has actually made.
   */
  undated: CalendarEntry[];
  /** Sources that contributed nothing, and why. A silent gap is unexplainable. */
  skipped: Array<{ kind: EntryKind; reason: SkipReason }>;
}

export type SkipReason = 'not_authorised' | 'no_visible_scope' | 'not_requested';

export interface CalendarOptions {
  /** Restrict to these sources. Omitted means all; an EMPTY ARRAY means none. */
  kinds?: EntryKind[];
  /** Inclusive ISO date bounds. Defaults to a twelve-month window from `asAt`. */
  from?: string;
  to?: string;
  /** The date the registration question is answered for. Defaults to today. */
  asAt?: string;
  /** Hard cap per source, so one busy season cannot produce an unbounded page. */
  limit?: number;
}

export const MAX_LIMIT = 400;
const DEFAULT_LIMIT = 200;

// ─── Dates ──────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date, or a refusal. Coercing a malformed date silently shifts the whole
 * window — `new Date('2026-13-01')` is Invalid, and an invalid bound quietly
 * became "everything" more than once in this codebase's history.
 */
export function requireDate(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new CalendarError('bad_date', `${field} must be an ISO date (YYYY-MM-DD).`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new CalendarError('bad_date', `${field} is not a real date.`);
  }
  return value;
}

/** Today in ISO form, in UTC. The federation's dates are dates, not instants. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  // Refuse rather than propagate. An invalid date reaches toISOString() below
  // as NaN and throws a RangeError from deep inside this helper, which reaches
  // the caller as an unexplainable crash instead of "that is not a date".
  if (Number.isNaN(d.getTime())) {
    throw new CalendarError('bad_date', `${iso} is not an ISO date (YYYY-MM-DD).`);
  }
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp: 31 January + 1 month is the last day of February, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// ─── Registration window ────────────────────────────────────────────────────

/**
 * Answered AS AT A DATE. "No window recorded" is not "open": a missing window
 * may be deliberate or may be an omission, and only the office can tell.
 * Rendering it as an unqualified "entries open" would be the system inventing a
 * federation decision.
 */
export function registrationState(
  opens: string | Date | null | undefined,
  closes: string | Date | null | undefined,
  asAt: string
): RegistrationState {
  const o = toIso(opens);
  const c = toIso(closes);
  if (!o && !c) return 'no_window_recorded';
  if (o && asAt < o) return 'not_open_yet';
  if (c && asAt > c) return 'closed';
  // Open when we are past an opening date, or before a closing date with no
  // opening recorded — the federation published a deadline and nothing else.
  return 'open';
}

function toIso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ─── Query ──────────────────────────────────────────────────────────────────

function requestedKinds(kinds: EntryKind[] | undefined): EntryKind[] {
  const ALL: EntryKind[] = ['competition', 'grading', 'course'];
  if (kinds === undefined) return ALL;
  if (!Array.isArray(kinds)) {
    throw new CalendarError('bad_kinds', 'kinds must be an array of calendar sources.');
  }
  for (const k of kinds) {
    if (!ALL.includes(k)) throw new CalendarError('bad_kinds', `Unknown calendar source: ${k}`);
  }
  // An empty array means NONE. Reading it as "everything" is the fail-open
  // reading and produces a calendar nobody asked for.
  return kinds;
}

function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new CalendarError('bad_limit', 'limit must be a finite number.');
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/**
 * A scope predicate, or null when the caller sees everything, or the string
 * 'none' when they can see nothing. Three outcomes, because collapsing "sees
 * everything" and "sees nothing" into a nullable predicate is how a scope
 * filter gets dropped.
 */
function scopePredicate(
  principal: Principal | null,
  action: Parameters<typeof visibleScopes>[1],
  stateCol: any,
  districtCol: any
): SQL | null | 'none' {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return 'none';
  const parts: SQL[] = [];
  if (scopes.states.length) parts.push(inArray(stateCol, scopes.states) as SQL);
  if (scopes.districts.length) parts.push(inArray(districtCol, scopes.districts) as SQL);
  // A national fixture belongs to no state; someone with a state binding still
  // needs to see the national championship they are selecting athletes for.
  parts.push(and(isNull(stateCol), isNull(districtCol)) as SQL);
  if (!parts.length) return 'none';
  return or(...parts) as SQL;
}

/**
 * The federation calendar.
 *
 * Anonymous callers reach published records only, filtered before any query
 * runs. Signed-in callers additionally see what their own scopes allow, applied
 * as a SQL predicate — nothing is fetched and then filtered, because a
 * post-query filter is one refactor away from being deleted and by then the
 * rows are in memory.
 */
export async function federationCalendar(
  db: DB,
  principal: Principal | null,
  opts: CalendarOptions = {}
): Promise<CalendarResult> {
  const caller: Principal | null =
    principal && Array.isArray(principal.bindings) && principal.bindings.length ? principal : null;
  const anonymous = !caller;

  const asAt = requireDate(opts.asAt, todayIso(), 'asAt');
  const from = requireDate(opts.from, asAt, 'from');
  const to = requireDate(opts.to, addMonths(from, 12), 'to');
  if (to < from) {
    throw new CalendarError('bad_window', 'The end of the window is before its start.');
  }

  const kinds = requestedKinds(opts.kinds);
  const limit = boundLimit(opts.limit);

  const entries: CalendarEntry[] = [];
  const undated: CalendarEntry[] = [];
  const skipped: CalendarResult['skipped'] = [];
  const push = (e: CalendarEntry) => (e.startsOn ? entries : undated).push(e);

  // — Competitions —
  if (!kinds.includes('competition')) {
    skipped.push({ kind: 'competition', reason: 'not_requested' });
  } else {
    const where: SQL[] = [];
    if (anonymous) {
      where.push(inArray(s.competitionEvents.status, PUBLIC_EVENT_STATUSES as any) as SQL);
    } else if (!canAnywhere(caller, 'competition:read')) {
      // Signed in without the action is not less than anonymous: they still see
      // what the public sees.
      where.push(inArray(s.competitionEvents.status, PUBLIC_EVENT_STATUSES as any) as SQL);
    } else {
      const pred = scopePredicate(
        caller, 'competition:read',
        s.competitionEvents.stateUnitId, s.competitionEvents.districtUnitId
      );
      if (pred === 'none') {
        skipped.push({ kind: 'competition', reason: 'no_visible_scope' });
      } else if (pred) {
        // In scope: everything. Out of scope: the published record only.
        where.push(
          or(pred, inArray(s.competitionEvents.status, PUBLIC_EVENT_STATUSES as any)) as SQL
        );
      }
    }

    if (!skipped.some((x) => x.kind === 'competition')) {
      // An undated event has no start to compare, so the window cannot exclude
      // it — `isNull` keeps announcements that have not been scheduled yet.
      where.push(
        or(
          isNull(s.competitionEvents.startsOn),
          and(gte(s.competitionEvents.startsOn, from), lte(s.competitionEvents.startsOn, to))
        ) as SQL
      );

      const rows = await db.select().from(s.competitionEvents)
        .where(and(...where))
        .orderBy(asc(s.competitionEvents.startsOn), asc(s.competitionEvents.code))
        .limit(limit);

      for (const r of rows) {
        push({
          kind: 'competition',
          ref: r.code,
          id: r.id,
          title: r.title,
          category: r.kind,
          status: r.status,
          startsOn: toIso(r.startsOn),
          endsOn: toIso(r.endsOn),
          venue: r.venue ?? null,
          city: r.city ?? null,
          stateUnitId: r.stateUnitId ?? null,
          districtUnitId: r.districtUnitId ?? null,
          // Sanction is a fact about the record, not a rendering choice.
          sanctioned: Boolean(r.sanctionedAt),
          sanctionReference: r.sanctionReference ?? null,
          registration: {
            state: registrationState(r.registrationOpensAt, r.registrationClosesAt, asAt),
            asAt,
          },
          cancelled: (CANCELLED_STATUSES as readonly string[]).includes(r.status),
          url: `/competitions?event=${encodeURIComponent(r.code)}`,
        });
      }
    }
  }

  // — Gradings —
  if (!kinds.includes('grading')) {
    skipped.push({ kind: 'grading', reason: 'not_requested' });
  } else {
    const where: SQL[] = [];
    let blocked = false;
    if (anonymous || !canAnywhere(caller, 'grading:read')) {
      where.push(inArray(s.gradingEvents.status, PUBLIC_GRADING_STATUSES as any) as SQL);
    } else {
      const pred = scopePredicate(
        caller, 'grading:read',
        s.gradingEvents.stateUnitId, s.gradingEvents.districtUnitId
      );
      if (pred === 'none') {
        skipped.push({ kind: 'grading', reason: 'no_visible_scope' });
        blocked = true;
      } else if (pred) {
        where.push(
          or(pred, inArray(s.gradingEvents.status, PUBLIC_GRADING_STATUSES as any)) as SQL
        );
      }
    }

    if (!blocked) {
      where.push(
        or(
          isNull(s.gradingEvents.heldOn),
          and(gte(s.gradingEvents.heldOn, from), lte(s.gradingEvents.heldOn, to))
        ) as SQL
      );

      const rows = await db.select().from(s.gradingEvents)
        .where(and(...where))
        .orderBy(asc(s.gradingEvents.heldOn), asc(s.gradingEvents.code))
        .limit(limit);

      for (const r of rows) {
        push({
          kind: 'grading',
          ref: r.code,
          id: r.id,
          title: r.title,
          category: 'grading',
          status: r.status,
          startsOn: toIso(r.heldOn),
          endsOn: toIso(r.heldOn),
          venue: r.venue ?? null,
          city: null,
          stateUnitId: r.stateUnitId ?? null,
          districtUnitId: r.districtUnitId ?? null,
          // A grading is authorised by its syllabus version and chief examiner,
          // not by a sanction reference. Reporting `false` would say the
          // federation withheld something it never had a field for.
          sanctioned: null,
          sanctionReference: null,
          registration: {
            state: registrationState(r.registrationOpensOn, r.registrationClosesOn, asAt),
            asAt,
          },
          cancelled: r.status === 'cancelled',
          url: null,
        });
      }
    }
  }

  // — Courses —
  if (!kinds.includes('course')) {
    skipped.push({ kind: 'course', reason: 'not_requested' });
  } else {
    const rows = await db.select().from(s.courses)
      .where(eq(s.courses.status, 'published'))
      .orderBy(asc(s.courses.slug))
      .limit(limit);

    for (const r of rows) {
      // A course is available rather than scheduled. It has no date, so it goes
      // where undated things go rather than being pinned to the day it was
      // published — which would be a date about the record, not about the event.
      undated.push({
        kind: 'course',
        // Courses are keyed by slug, not by a federation code — they are
        // published material rather than a sanctioned fixture.
        ref: r.slug,
        id: r.id,
        title: r.title,
        category: r.level ?? r.category ?? null,
        status: r.status,
        startsOn: null,
        endsOn: null,
        venue: null,
        city: null,
        stateUnitId: null,
        districtUnitId: null,
        sanctioned: null,
        sanctionReference: null,
        registration: { state: 'no_window_recorded', asAt },
        cancelled: false,
        url: '/academy',
      });
    }
  }

  entries.sort((a, b) => (a.startsOn! < b.startsOn! ? -1 : a.startsOn! > b.startsOn! ? 1 : a.ref < b.ref ? -1 : 1));
  undated.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  return { from, to, asAt, entries, undated, skipped };
}

// ─── iCalendar feed ─────────────────────────────────────────────────────────

/**
 * RFC 5545 escaping. Backslash first, or every escape this function adds gets
 * escaped again by the later rules.
 */
export function icsEscape(text: string): string {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 §3.1: lines are folded at 75 OCTETS, not characters. A Devanagari
 * event title is three bytes per character, so folding on character count
 * produces lines that are legal-looking and over the limit — and some clients
 * truncate rather than complain. A fold must also never split a multi-byte
 * character, hence the byte-walk.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Walk back off a continuation byte (10xxxxxx) so a character stays whole.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;                       // continuation lines carry a leading space
  }
  return out.join('\r\n ');
}

function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** DATE-time stamp in UTC, as DTSTAMP requires. */
function icsStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface IcsOptions {
  /** Absolute site origin, for the URL property. No trailing slash. */
  origin?: string;
  /** Fixed stamp, so a test does not race the clock. */
  now?: Date;
  calendarName?: string;
}

/**
 * An iCalendar feed of the DATED entries.
 *
 * Undated entries are DELIBERATELY EXCLUDED. iCalendar has no way to say "this
 * is happening but we have not fixed the day", and every workaround — today's
 * date, the first of the month, a year-long all-day block — asserts something
 * the federation has not decided. They stay on the web page, which can say it.
 *
 * Cancelled events are included with STATUS:CANCELLED rather than dropped: a
 * subscriber who already has the event in their calendar needs the update to
 * remove it, and an event that simply vanishes from the feed stays in their
 * diary forever.
 */
export function toIcs(result: CalendarResult, opts: IcsOptions = {}): string {
  const origin = (opts.origin || 'https://www.mmakf.in').replace(/\/$/, '');
  const stamp = icsStamp(opts.now ?? new Date());
  const name = opts.calendarName || 'MMAKF Federation Calendar';

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MMAKF//Federation Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
  ];

  for (const e of result.entries) {
    if (!e.startsOn) continue;                    // unreachable; the type allows it
    // DTEND is EXCLUSIVE for all-day events (RFC 5545 §3.8.2.2). A one-day
    // event ending on its own start date renders as zero-length or vanishes.
    const endSource = e.endsOn && e.endsOn >= e.startsOn ? e.endsOn : e.startsOn;
    const dtEnd = new Date(`${endSource}T00:00:00Z`);
    dtEnd.setUTCDate(dtEnd.getUTCDate() + 1);

    const where = [e.venue, e.city].filter(Boolean).join(', ');
    const description: string[] = [`Federation reference: ${e.ref}`];
    if (e.sanctioned === false) {
      // Said plainly in the feed, because a calendar entry travels far from the
      // page that would otherwise carry the caveat.
      description.push('NOT SANCTIONED by the federation.');
    } else if (e.sanctionReference) {
      description.push(`Sanction: ${e.sanctionReference}`);
    }
    if (e.registration.state === 'no_window_recorded') {
      description.push('No registration window has been recorded.');
    }

    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.kind}-${icsEscape(e.ref)}@mmakf.in`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.startsOn)}`,
      `DTEND;VALUE=DATE:${icsDate(dtEnd.toISOString().slice(0, 10))}`,
      `SUMMARY:${icsEscape(e.title)}`,
      `DESCRIPTION:${icsEscape(description.join(' '))}`,
      `CATEGORIES:${icsEscape(e.category || e.kind)}`,
      `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    );
    if (where) lines.push(`LOCATION:${icsEscape(where)}`);
    if (e.url) lines.push(`URL:${origin}${e.url}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // CRLF is required by RFC 5545 §3.1, and clients do reject bare LF.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
