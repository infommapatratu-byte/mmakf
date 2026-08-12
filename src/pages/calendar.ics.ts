/**
 * THE SUBSCRIBABLE FEDERATION CALENDAR — /calendar.ics
 *
 * A calendar client fetches this URL on a schedule with no cookies, no session
 * and no way to sign in. That is not a limitation to work around — it is the
 * security model. This feed is ALWAYS ANONYMOUS: it is generated with a null
 * principal, so it can only ever contain what the federation has published.
 *
 * The mistake this file exists to avoid is the tempting one: reading the
 * session cookie so a signed-in official gets "their" calendar. It would work
 * in a browser and then quietly do nothing in the calendar app that actually
 * subscribes — except on the day someone shares the URL, which for a scoped
 * feed would hand over another unit's draft fixtures. A per-user feed needs a
 * per-user secret in the URL and its own revocation story; until the federation
 * asks for that, this is the public calendar and says so.
 *
 * Undated announcements are excluded by toIcs() because iCalendar cannot say
 * "this is happening, the day is not fixed". They remain on /calendar, which
 * can.
 */
import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { federationCalendar, toIcs, todayIso, addMonths, isCalendarError } from '@/lib/calendar';

export const prerender = false;

/** How far ahead the feed reaches. A subscriber wants a season, not a decade. */
const MONTHS_AHEAD = 18;
/** And a short way back, so an event that just happened does not vanish mid-week. */
const MONTHS_BACK = 1;

export const GET: APIRoute = async ({ url }) => {
  if (!isConfigured()) {
    // A calendar client shows an empty subscription as "no events", which is
    // indistinguishable from a quiet season. 503 makes it show an error, which
    // is the truth: this feed is not available, not empty.
    return new Response('The federation calendar is not available: no database is configured.\r\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const today = todayIso();

  try {
    const result = await federationCalendar(db(), null, {
      from: addMonths(today, -MONTHS_BACK),
      to: addMonths(today, MONTHS_AHEAD),
      asAt: today,
      limit: 400,
    });

    const ics = toIcs(result, { origin: url.origin });

    return new Response(ics, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        // Named so a downloaded copy is identifiable, but inline so a browser
        // hands it to the calendar app rather than dropping it in Downloads.
        'content-disposition': 'inline; filename="mmakf-calendar.ics"',
        // Calendar clients poll aggressively. An hour is long enough to spare
        // the database and short enough that a cancellation reaches subscribers
        // the same morning.
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    const detail = isCalendarError(err) ? err.message : 'The calendar could not be generated.';
    return new Response(`${detail}\r\n`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};
