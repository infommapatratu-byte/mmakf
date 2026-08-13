// GET /api/health — the endpoint an operator trusts when nothing else answers.
//
// TWO PROPERTIES ARE PINNED HERE, and the first of them was broken:
//
//  1. EVERY DEPENDENCY IS PROBED BEHIND A TIMEOUT. The register used to be
//     awaited with no bound of its own. A peer that REFUSES answers in
//     milliseconds, so the defect was invisible in every ordinary test — but a
//     peer that BLACK-HOLES the packets (a paused project, a withdrawn network
//     route) left the request sitting for postgres.js's ten-second
//     connect_timeout and only then reported the failure. A health check that
//     hangs is how a health check becomes the thing that takes the site down.
//
//     Proven WITHOUT a stopwatch: the dependency here does eventually answer,
//     just far later than a health check may wait, and the fake clock is
//     advanced past both deadlines in turn. An unbounded route therefore fails
//     on the assertion — reporting the late answer as healthy — rather than by
//     hanging the suite.
//
//  2. THE STATUS IS ALWAYS 200 AND THE PAYLOAD IS FLAT. MASTER-SPEC §8.6 makes
//     the constant 200 normative, and both in-repo consumers depend on it:
//     admin/command.astro rejects on `!r.ok` and would blank its System-health
//     table, and application.astro reads a non-2xx as "assume the register was
//     readable". API-ARCHITECTURE.md §12.1 item 2 records the flat shape as
//     deliberate — an envelope would break the parsers already reading it. A
//     richer internal HealthCheck must be mapped back onto the scalars, never
//     emitted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** What each dependency does when the route probes it. Set per test. */
let redisAnswer: () => Promise<boolean> = async () => true;
let databaseAnswer: () => Promise<boolean> = async () => true;
let databaseConfigured = true;

vi.mock('../src/lib/storage', () => ({
  redisHealthy: () => redisAnswer(),
}));

vi.mock('../src/db', () => ({
  isConfigured: () => databaseConfigured,
  databaseHealthy: () => databaseAnswer(),
}));

const route = await import('../src/pages/api/health');

interface Answered {
  status: number;
  body: any;
  headers: Headers;
}

/** The handler reads nothing from its context, so an empty one is complete. */
async function health(): Promise<Answered> {
  const res: Response = await (route.GET as any)({} as any);
  return { status: res.status, body: JSON.parse(await res.text()), headers: res.headers };
}

/**
 * A dependency that DOES answer, only later than a health check may wait.
 *
 * Deliberately not a promise that never settles: a never-settling dependency
 * makes an unbounded route fail by timing the whole suite out, which reads as a
 * broken test rather than as the defect it is.
 */
const answersAfter = (ms: number, value: boolean) => () =>
  new Promise<boolean>((resolve) => setTimeout(() => resolve(value), ms));

beforeEach(() => {
  redisAnswer = async () => true;
  databaseAnswer = async () => true;
  databaseConfigured = true;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});

describe('a dependency can never hold the health endpoint open', () => {
  it('gives up on a register that black-holes the connection, and says so', async () => {
    vi.useFakeTimers();
    databaseAnswer = answersAfter(60_000, true);

    const pending = health();
    // Past probe()'s ceiling: the endpoint must already have given up here.
    await vi.advanceTimersByTimeAsync(3_000);
    // And then past the dependency's own answer, so an unbounded route reports
    // that late answer as health and fails the assertion below.
    await vi.advanceTimersByTimeAsync(60_000);

    const { status, body } = await pending;
    expect(body.database).toBe('error');
    expect(body.ok).toBe(false);
    // Still 200 (MASTER-SPEC §8.6) — the payload carries the outage.
    expect(status).toBe(200);
  });

  it('gives up on an editorial store that black-holes the connection', async () => {
    vi.useFakeTimers();
    redisAnswer = answersAfter(60_000, true);

    const pending = health();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const { status, body } = await pending;
    expect(body.redis).toBe(false);
    expect(body.ok).toBe(false);
    expect(status).toBe(200);
  });

  it('calls a slow-but-answering register reachable, while `ok` says it is not clean', async () => {
    vi.useFakeTimers();
    databaseAnswer = answersAfter(2_000, true); // past half of probe()'s ceiling

    const pending = health();
    await vi.advanceTimersByTimeAsync(2_000);

    const { status, body } = await pending;
    // It answered. Calling it unreachable would send an operator after the
    // wrong fault — the flat field has no third value to say "slow".
    expect(body.database).toBe('ok');
    // ...so `ok` is where reachable-but-degraded becomes visible.
    expect(body.ok).toBe(false);
    expect(status).toBe(200);
  });
});

describe('the payload an operator and a monitor read', () => {
  it('reports a healthy deployment as ok', async () => {
    const { status, body } = await health();
    expect(body).toMatchObject({ ok: true, redis: true, database: 'ok' });
    expect(status).toBe(200);
  });

  it('sets `ok` from the dependencies rather than hardcoding it', async () => {
    // The field used to be the literal `true`, which made it worth nothing to
    // the monitor RUNBOOK.md §26 tells an operator to point at this payload.
    redisAnswer = async () => false;
    const { body } = await health();
    expect(body.ok).toBe(false);
  });

  it('still answers 200 when the editorial store is unreachable', async () => {
    // MASTER-SPEC §8.6: `redis:false` must still return 200, and Scenario D
    // requires UptimeRobot to stay green through an Upstash outage.
    redisAnswer = async () => false;
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.redis).toBe(false);
    expect(body.database).toBe('ok');
  });

  it('reports a register that refuses the connection as an error, not as absent', async () => {
    databaseAnswer = async () => false;
    const { status, body } = await health();
    expect(body.database).toBe('error');
    expect(body.ok).toBe(false);
    expect(status).toBe(200);
  });

  it('treats an unconfigured register as its own state, and never as a failure', async () => {
    // §70: 'not_configured' is a real state. Reporting it as an outage trains
    // an operator to ignore the alert — and this is production's state today.
    databaseConfigured = false;
    let probed = false;
    databaseAnswer = async () => { probed = true; return true; };

    const { status, body } = await health();
    expect(body.database).toBe('not_configured');
    expect(body.ok).toBe(true);
    expect(status).toBe(200);
    expect(probed, 'an unconfigured register must not be dialled').toBe(false);
  });

  it('answers with exactly the four contracted fields — no envelope, no objects', async () => {
    // API-ARCHITECTURE.md §12.1 item 2. command.astro keys its explanations off
    // `String(body.redis)` and `String(body.database)`, so a HealthCheck object
    // in either field renders as '[object Object]' with no meaning beside it.
    const { body } = await health();
    expect(Object.keys(body).sort()).toEqual(['database', 'ok', 'redis', 'version']);
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.redis).toBe('boolean');
    expect(typeof body.database).toBe('string');
  });

  it('names the deployed commit, which is what deploy verification reads', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef';
    expect((await health()).body.version).toBe('0123456789abcdef');
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect((await health()).body.version).toBe('dev');
  });

  it('is never cached — a cached probe reports the last outage, or the last recovery', async () => {
    const { headers } = await health();
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
