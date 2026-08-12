// GET /api/stream/<channel> — the federation's Server-Sent Events endpoint.
//
// A thin shell, in the same shape as the other API routes here: it identifies
// the caller, applies the limits, asks `src/lib/realtime.ts` whether the channel
// may be had, and hands back the stream. It contains no authorisation logic and
// no knowledge of what a channel carries — putting either here is how a second,
// divergent copy of a rule gets created (§75).
//
// THE ORDER OF THE CHECKS BELOW IS DELIBERATE and each step is cheaper than
// the one it protects:
//
//   1. rate limit          — before any database work, because an unauthenticated
//                            flood must cost as little as possible;
//   2. configuration       — 503 before `identify()`, which cannot verify a user
//                            session without the database anyway;
//   3. identify            — one place a request becomes an identity;
//   4. authorise           — the channel decides, not the subscriber;
//   5. concurrency slot    — taken only once the subscription is going to happen,
//                            so a refused caller cannot exhaust the slots;
//   6. resume position     — Last-Event-ID, else "from now".
//
// WHAT A NON-200 MEANS TO AN `EventSource`, because it changes what a page must
// do: on any status other than 200 (with the right content type) the browser
// FAILS THE CONNECTION AND DOES NOT RECONNECT. So a 503 here does not produce a
// retry storm — it produces one error event and silence. That is exactly why the
// 503 body says live updates are unavailable in plain words: the page has to
// notice and start polling, and SAY it is polling, rather than sit on a dead
// EventSource looking live.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import {
  authoriseChannel, acquireStreamSlot, openStream, resolveCursor, STREAM_LIMITS,
} from '@/lib/realtime';

export const prerender = false;

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/**
 * The concurrency key. Hashed, so a raw address is never held in memory for the
 * life of a stream (DPDP minimisation, same treatment as `rateLimit()`).
 * An unidentifiable client shares one bucket — which is stricter than giving
 * each anonymous caller its own, and that is the right way round.
 */
function clientKey(request: Request): string {
  const ip = clientIp(request) ?? 'unknown';
  return crypto.createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

export const GET: APIRoute = async ({ params, request, url }) => {
  const channelName = String(params.channel ?? '');

  // 30 opens a minute. A legitimate subscriber opens one connection and then one
  // more every four minutes when the duration cap recycles it; 30 leaves room
  // for a page reloading, several tabs and a flaky network without leaving room
  // for a script. Redis-backed, so unlike the concurrency cap this one holds
  // across function instances.
  const rl = await rateLimit(request, 'stream-open', 30, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // §70, no fake features. Live updates read the domain event feed, the feed
  // lives in the federation database, and this deployment may not have one.
  if (!isConfigured()) {
    return json(
      {
        error:
          'Live updates are unavailable on this deployment: the federation database is not configured, ' +
          'so there is no event feed to stream. Refresh the page periodically instead — and say that ' +
          'is what is happening rather than showing it as live.',
        code: 'database_not_configured',
        fallback: 'polling',
      },
      503
    );
  }

  const identity = await identify(request.headers.get('cookie'));

  let auth;
  try {
    auth = await authoriseChannel(db(), channelName, identity);
  } catch (err) {
    // A failure to DECIDE is not a refusal, and must not be reported as one:
    // "forbidden" would send an operator looking at role bindings for a database
    // that was simply unreachable.
    console.error('[stream] authorisation failed', { channel: channelName, error: String(err) });
    return json({ error: 'The subscription could not be set up.', code: 'unavailable' }, 503);
  }

  if (!auth.ok) {
    return json({ error: auth.message, code: auth.code, channel: channelName }, auth.status);
  }

  const release = acquireStreamSlot(clientKey(request));
  if (!release) {
    return json(
      {
        error:
          `Too many live connections are already open from this client (limit ${STREAM_LIMITS.maxStreamsPerClient}). ` +
          'Close another tab, or refresh the page instead of streaming.',
        code: 'too_many_streams',
      },
      429,
      { 'Retry-After': String(STREAM_LIMITS.pollSeconds) }
    );
  }

  try {
    const cursor = await resolveCursor(
      db(),
      request.headers.get('last-event-id'),
      url.searchParams.get('lastEventId')
    );

    return openStream(db(), auth.grant, {
      cursor,
      release,
      // Closing the tab aborts the request; the loop stops and the slot is
      // returned instead of being held until the duration cap.
      signal: request.signal ?? null,
    });
  } catch (err) {
    release();
    console.error('[stream] could not open', { channel: channelName, error: String(err) });
    return json({ error: 'Live updates could not be started.', code: 'unavailable', fallback: 'polling' }, 503);
  }
};
