// Health probe (MASTER-SPEC §8.6). Used by uptime monitoring and deploy
// verification. Always returns 200 — monitors alert on the payload, and both
// in-repo consumers branch on the HTTP status: admin/command.astro rejects on
// `!r.ok` and would blank its System-health table, and application.astro reads
// a non-2xx as "assume the register was readable". A 503 here would report an
// outage by hiding it.
//
// EVERY DEPENDENCY IS PROBED BEHIND A TIMEOUT. This was awaited unbounded once,
// and the defect was invisible against every peer that REFUSES a connection —
// those answer in milliseconds. Against one that black-holes the packets (a
// paused project, a withdrawn network route) the request instead sat for
// postgres.js's ten-second connect_timeout before reporting anything, which is
// how a health check becomes the thing that takes the site down: the monitor
// calls it, the request pool fills, and every other page stops responding.
// probe() caps each dependency at three seconds.
//
// THE PAYLOAD IS FLAT, DELIBERATELY (API-ARCHITECTURE.md §12.1 item 2): `redis`
// is a boolean and `database` is one of ok | error | not_configured. probe()'s
// richer HealthCheck is mapped back onto those scalars rather than emitted —
// command.astro keys its plain-English explanations off `String(body.redis)`
// and `String(body.database)`, so an object in either field renders as
// '[object Object]' with nothing beside it to explain what it means.

import type { APIRoute } from 'astro';
import { redisHealthy } from '@/lib/storage';
import { isConfigured, databaseHealthy } from '@/db';
import { probe, overallStatus, type HealthCheck } from '@/lib/observability';

export const prerender = false;

/**
 * A probe result as the contracted `database` field.
 *
 * 'degraded' means the register ANSWERED, only slowly, so it maps to 'ok': the
 * flat field has no third value, and calling a reachable register unreachable
 * would send an operator after the wrong fault. The slowness is not lost — it
 * is what turns the top-level `ok` false.
 */
function asRegisterState(check: HealthCheck): 'ok' | 'error' | 'not_configured' {
  if (check.status === 'not_configured') return 'not_configured';
  return check.status === 'down' ? 'error' : 'ok';
}

export const GET: APIRoute = async () => {
  const [redis, database] = await Promise.all([
    // Redis is probed as configured unconditionally because the contracted
    // field is a boolean with no 'not_configured' value to report — and
    // redisHealthy() already answers false when no store is configured.
    probe('redis', true, redisHealthy),
    // Report the federation database honestly (§70): 'not_configured' is a real
    // state, not a failure, and must never be reported as healthy. probe()
    // returns it without dialling anything.
    probe('database', isConfigured(), databaseHealthy),
  ]);

  return new Response(
    JSON.stringify({
      // Was the literal `true`, which made the one field a monitor reads by
      // default worth nothing: it said the site was healthy while the register
      // was unreachable. An unconfigured dependency is still ok — that is a
      // deployment fact, not a fault.
      ok: overallStatus([redis, database]) === 'ok',
      redis: redis.status !== 'down',
      database: asRegisterState(database),
      version: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }
  );
};
