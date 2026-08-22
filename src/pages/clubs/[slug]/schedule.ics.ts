/**
 * A CLUB'S SUBSCRIBABLE TIMETABLE — /clubs/[slug]/schedule.ics
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALWAYS ANONYMOUS, FOR THE SAME REASON /calendar.ics IS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A calendar client fetches this URL on a schedule with no cookies, no session
 * and no way to sign in. That is the security model rather than a limitation.
 * src/pages/calendar.ics.ts sets out the trap this avoids: reading the session
 * cookie so a signed-in member gets "their" calendar works in a browser and
 * then quietly does nothing in the app that actually subscribes — except on the
 * day somebody shares the URL, which for a scoped feed hands over data that was
 * never theirs to share.
 *
 * So this feed carries EXACTLY what the club's public page carries: the
 * published class occurrences, and the days the club is closed. A PERSONAL
 * calendar — "my classes", "my bookings" — needs a per-user secret in the URL
 * and its own revocation story, and until the federation asks for that it does
 * not exist. /my/schedule is where a member reads their own.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS IN AN EVENT, AND WHAT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The class, the time, the room and whether it is online. NOT the instructor's
 * name against every occurrence: a year of class events naming one coach is a
 * movement pattern for a named person, published to anyone with the URL, and
 * the club page already says who teaches at the club without saying who is in
 * which building at 18:00 next Thursday.
 *
 * NOT the reason a day is closed, either. A closure appears as an all-day event
 * carrying its KIND — 'Holiday', 'Grading' — because the same free text is
 * redacted on every other public read of it.
 *
 * NOT how many places are left. A number that was true when the calendar client
 * last polled is a number that is wrong by the time somebody reads it, and a
 * member acting on "3 places left" from a cached feed is worse served than one
 * who opens the page.
 *
 * A CANCELLED SESSION IS PUBLISHED AS CANCELLED, with STATUS:CANCELLED, rather
 * than dropped. A subscriber who already has the event needs it to change; one
 * that simply vanished leaves the old entry sitting in their calendar for ever.
 */
import type { APIRoute } from 'astro';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { isConfigured, db } from '@/db';
import * as sch from '@/db/scheduling.schema';
import * as ops from '@/db/operations.schema';
import { clubProfile } from '@/db/clubs';
import { todayIso, addDays, publicExceptionsBetween } from '@/db/scheduling';
import { SITE_ORIGIN } from '@/lib/seo';

export const prerender = false;

/** How far ahead the feed reaches. A subscriber wants a term, not a decade. */
const DAYS_AHEAD = 120;
/** And a short way back, so a class that just happened does not vanish mid-week. */
const DAYS_BACK = 14;

const fold = (line: string): string => {
  // RFC 5545 §3.1: no content line over 75 octets. Folding is a continuation
  // line beginning with a single space.
  if (line.length <= 73) return line;
  const parts: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join('\r\n');
};

const esc = (v: string): string =>
  String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

const stampUtc = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const stampDate = (iso: string): string => iso.replace(/-/g, '');

const EXCEPTION_WORDS: Record<string, string> = {
  holiday: 'Holiday', closure: 'Closed', extended_hours: 'Extended hours',
  reduced_hours: 'Reduced hours', competition: 'Competition', seminar: 'Seminar',
  camp: 'Training camp', maintenance: 'Maintenance', private_booking: 'Private booking',
  examination: 'Examination', grading: 'Grading', special_training: 'Special training',
};

export const GET: APIRoute = async ({ params, url }) => {
  const slug = String(params.slug ?? '');

  if (!isConfigured()) {
    // A calendar client shows an empty subscription as "no events", which is
    // indistinguishable from a quiet term. 503 makes it show an error, which is
    // the truth: this feed is not available, not empty.
    return new Response('This club calendar is not available: no database is configured.\r\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const database = db();
  const profile = await clubProfile(database, slug);
  if (!profile) {
    return new Response('No such club, or the club is not currently affiliated.\r\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const origin = (url?.origin || SITE_ORIGIN).replace(/\/$/, '');
  const from = addDays(todayIso(), -DAYS_BACK);
  const to = addDays(todayIso(), DAYS_AHEAD);
  const now = new Date();

  const classIds = profile.classes.map((c) => c.id);
  const sessions = classIds.length
    ? await database.select({ session: sch.classSessions, klass: sch.dojoClasses })
        .from(sch.classSessions)
        .innerJoin(sch.dojoClasses, eq(sch.dojoClasses.id, sch.classSessions.classId))
        .where(and(
          inArray(sch.classSessions.classId, classIds),
          gte(sch.classSessions.localDate, from),
          lte(sch.classSessions.localDate, to)
        ))
        .orderBy(asc(sch.classSessions.startsAt))
    : [];

  const venueNames = new Map(profile.venues.map((v) => [v.id, v.name]));

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MMAKF//Club Timetable//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${profile.club.name} — MMAKF timetable`)}`,
    `X-WR-TIMEZONE:${esc(profile.club.timezone)}`,
    `X-WR-CALDESC:${esc(`Published class timings for ${profile.club.name}, an MMAKF-affiliated club. Times are local to ${profile.club.timezone}.`)}`,
  ];

  for (const row of sessions) {
    const session = row.session;
    const venue = session.venueId ? venueNames.get(session.venueId) ?? null : null;
    const where = session.mode === 'online'
      ? 'Online'
      : [venue, profile.club.city].filter(Boolean).join(', ');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${session.ref}@mmakf.in`);
    lines.push(`DTSTAMP:${stampUtc(now)}`);
    lines.push(`DTSTART:${stampUtc(new Date(session.startsAt))}`);
    lines.push(`DTEND:${stampUtc(new Date(session.endsAt))}`);
    lines.push(`SUMMARY:${esc(`${row.klass.name} — ${profile.club.name}`)}`);
    if (where) lines.push(`LOCATION:${esc(where)}`);
    lines.push(`URL:${origin}/clubs/${profile.club.slug}`);
    lines.push(`STATUS:${session.status === 'cancelled' || session.status === 'rescheduled' ? 'CANCELLED' : 'CONFIRMED'}`);
    if (session.status === 'cancelled') {
      // The FACT, not the reason. Same redaction as every other public read.
      lines.push(`DESCRIPTION:${esc('This class has been cancelled. Check the club page for details.')}`);
    } else if (session.status === 'rescheduled') {
      lines.push(`DESCRIPTION:${esc('This class has moved to a new time. The replacement appears separately in this calendar.')}`);
    } else if (row.klass.summary) {
      lines.push(`DESCRIPTION:${esc(row.klass.summary)}`);
    }
    lines.push('END:VEVENT');
  }

  // Closures and altered days, as all-day events. A club that is shut on the
  // 15th is a thing a member needs in their calendar quite as much as a class.
  // TWO RESOLUTIONS AND ONE SELECT, not one full day-resolution per day.
  //
  // This called publicTimetable() across the whole 134-day window and then used
  // nothing from it but `day.exceptions`. timetable() resolves day by day —
  // re-walking the inheritance chain, the seasons and the rules for each — so a
  // single fetch of this feed issued somewhere between nine hundred and two
  // thousand sequential queries to emit a handful of all-day events, on a
  // public endpoint that calendar clients re-poll on their own schedule.
  const exceptions = await publicExceptionsBetween(
    database, { purpose: 'training', dojoId: profile.club.id }, from, to
  );
  for (const { date, exception } of exceptions) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:exception-${exception.id}@mmakf.in`);
    lines.push(`DTSTAMP:${stampUtc(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${stampDate(date)}`);
    lines.push(`DTEND;VALUE=DATE:${stampDate(addDays(date, 1))}`);
    lines.push(`SUMMARY:${esc(`${profile.club.name}: ${EXCEPTION_WORDS[exception.kind] ?? exception.kind}`)}`);
    lines.push(`URL:${origin}/clubs/${profile.club.slug}`);
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return new Response(`${lines.map(fold).join('\r\n')}\r\n`, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="${profile.club.slug}-timetable.ics"`,
      // A timetable changes rarely and a calendar client polls often. An hour
      // is short enough that a cancellation reaches subscribers the same
      // morning, and long enough that a thousand clients are not a load.
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
