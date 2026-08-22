/**
 * ONE PERSON'S SUBSCRIBABLE DIARY — /my/calendar/[secret].ics
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECRET IN THE PATH IS THE WHOLE AUTHORISATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no cookie here and there cannot be: a calendar client fetches on its
 * own schedule with no session. src/pages/calendar.ics.ts named the requirement
 * — "a per-user feed needs a per-user secret in the URL and its own revocation
 * story" — and src/lib/calendar-feed.ts is both halves. This route is the
 * consumer.
 *
 * WHAT FOLLOWS FROM THAT, AND IS NOT OPTIONAL:
 *
 *   · `Cache-Control: private, no-store`. A shared cache that kept this would
 *     serve one member's diary to the next person through the same proxy.
 *   · `X-Robots-Tag: noindex, nofollow`. A crawler that found the URL in a
 *     referrer log must not put it in an index.
 *   · 404, never 403, for a token that does not resolve — and the SAME 404 for
 *     unknown, revoked and malformed. A distinguishable refusal is a way to
 *     enumerate live tokens.
 *   · No `Link` header, no HTML, nothing that could carry the secret onward.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO SCOPES, AND THE SECOND ONE DELIBERATELY SAYS LESS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 'own_classes' is the member's own bookings: the class, the time, the room.
 * That is theirs and it is what they asked for.
 *
 * 'coach_diary' is BUSY. Opaque blocks reading "MMAKF (busy)" with no class
 * name, no venue and no student, because an instructor's calendar is routinely
 * shared with a family or an employer and often visible on a laptop in a staff
 * room. "Kids Program, Ramgarh hall, Thursday 18:00", published to whoever holds
 * the URL, is a movement pattern for a named adult who works with children. The
 * federation asked for BUSY / AVAILABLE and this is it.
 *
 * A CANCELLED SESSION IS PUBLISHED AS CANCELLED, not dropped. A subscriber who
 * already has the event needs it to change; one that simply vanished leaves the
 * old entry sitting in their calendar for ever, and they turn up.
 */
import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { resolveFeed } from '@/lib/calendar-feed';
import { personalSchedule, todayIso, addDays } from '@/db/scheduling';
import { SITE_ORIGIN } from '@/lib/seo';

export const prerender = false;

/** A subscriber wants a term behind and a term ahead, not a decade. */
const DAYS_AHEAD = 180;
const DAYS_BACK = 30;

const HEADERS_PRIVATE = {
  'content-type': 'text/calendar; charset=utf-8',
  // PRIVATE and NO-STORE. This body belongs to one person.
  'cache-control': 'private, no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
} as const;

const fold = (line: string): string => {
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

/** The same 404 for every kind of failure — see the header note. */
const notFound = () =>
  new Response('No calendar is published at this address.\r\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });

export const GET: APIRoute = async ({ params, url }) => {
  if (!isConfigured()) {
    // A calendar client renders an empty subscription as "no events", which is
    // indistinguishable from a quiet month. 503 makes it show an error, which is
    // the truth: this feed is unavailable, not empty.
    return new Response('This calendar is not available: no database is configured.\r\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const secret = String(params.secret ?? '');
  const database = db();
  const feed = await resolveFeed(database, secret);
  if (!feed) return notFound();

  const from = addDays(todayIso(), -DAYS_BACK);
  const to = addDays(todayIso(), DAYS_AHEAD);
  const now = new Date();
  const origin = (url?.origin || SITE_ORIGIN).replace(/\/$/, '');

  const sessions = await personalSchedule(database, feed.personId, from, to);
  const busy = feed.scope === 'coach_diary';

  // A coach's feed carries what they TEACH. A member's carries what they attend
  // and what they teach — their own diary is their own diary.
  const relevant = busy ? sessions.filter((x) => x.role === 'teaching') : sessions;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MMAKF//Personal Diary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(busy ? 'MMAKF teaching (busy)' : 'MMAKF training')}`,
    `X-WR-CALDESC:${esc(
      busy
        ? 'Busy blocks for the classes you teach. Deliberately carries no class name, venue or student — a teaching calendar is often shared.'
        : 'Your MMAKF classes. Cancelled and moved sessions appear as cancelled so your calendar changes rather than going stale.'
    )}`,
  ];

  for (const x of relevant) {
    const cancelled = x.status === 'cancelled' || x.status === 'rescheduled';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${x.ref}@mmakf.in`);
    lines.push(`DTSTAMP:${stampUtc(now)}`);
    lines.push(`DTSTART:${stampUtc(x.startsAt)}`);
    lines.push(`DTEND:${stampUtc(x.endsAt)}`);

    if (busy) {
      // The block, and nothing about it.
      lines.push(`SUMMARY:${esc('MMAKF (busy)')}`);
      lines.push('TRANSP:OPAQUE');
      lines.push('CLASS:PRIVATE');
    } else {
      lines.push(`SUMMARY:${esc(`${x.className}${x.role === 'teaching' ? ' (you teach)' : ''}`)}`);
      const where = x.mode === 'online' ? 'Online' : (x.venueName ?? '');
      if (where) lines.push(`LOCATION:${esc(where)}`);
      if (x.mode === 'online' && x.onlineUrl) lines.push(`URL:${x.onlineUrl}`);
      else lines.push(`URL:${origin}/my/schedule`);
      lines.push('CLASS:PRIVATE');
    }

    lines.push(`STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`);
    if (x.status === 'cancelled') {
      // The FACT, never the reason — the same redaction every other read applies.
      lines.push(`DESCRIPTION:${esc('This class was cancelled. Your place was released.')}`);
    } else if (x.status === 'rescheduled') {
      lines.push(`DESCRIPTION:${esc('This class moved. The new time appears separately in this calendar.')}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return new Response(`${lines.map(fold).join('\r\n')}\r\n`, {
    status: 200,
    headers: { ...HEADERS_PRIVATE },
  });
};
