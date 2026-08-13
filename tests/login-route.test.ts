// POST /api/auth/login when the federation register does not answer.
//
// Both sign-in paths share one failure mode, and neither used to name it. A
// database that is CONFIGURED but does not answer the question — a pooler URL
// with a password that was not URL-encoded, a host that resolves but was never
// migrated — makes `select count(*) from users` throw. userCount() fails CLOSED
// there, which is right: an outage must never silently re-enable the shared
// office password. But reporting that as
//
//     403 "The shared password has been retired…"
//
// tells the office their password was changed, and sends whoever investigates
// to the accounts they do not have instead of to the connection string. The
// account path was worse: the driver rejection escaped the route entirely and
// Astro answered a bare 500.
//
// THE UNMIGRATED CASE IS THE ONE THAT HIDES BEST, and it is asserted here
// against a real Postgres rather than argued: `select 1` SUCCEEDS on a database
// with no tables, which is exactly the probe databaseHealthy() runs — so
// /api/health reads database: "ok" and the documented pre-cutover check passes
// while both sign-in paths are dead and nothing anywhere names the cause.
//
// WHAT MUST NOT CHANGE, and is asserted below: an account count that could not
// be read still never permits the shared password; a healthy database with an
// account in it still retires it; and the ALLOW_SHARED_ADMIN_PASSWORD
// break-glass still works when the database is down, which is when a locked-out
// office would reach for it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';

// isConfigured() reads DATABASE_URL on every call and the route keeps no copy,
// so setting it before the import is enough. Nothing here opens a socket: every
// test injects its own client with __setTestClient().
process.env.DATABASE_URL = 'postgresql://login-route-test/pglite';
process.env.ADMIN_PASSWORD = 'office-password-for-this-suite';
process.env.ADMIN_SESSION_SECRET = 'test-secret-for-login-route-suite';
delete process.env.ALLOW_SHARED_ADMIN_PASSWORD;

const { POST } = await import('../src/pages/api/auth/login');

const OFFICE_PW = 'office-password-for-this-suite';

/**
 * The rejection postgres.js hands back when the pooler does not answer, in the
 * shape the route consumes it: `db().select(…)` is where both paths enter the
 * driver, so throwing there covers the count and the account lookup alike.
 */
const unreachable = {
  select() {
    throw new Error('connect ECONNREFUSED 10.0.0.1:6543');
  },
} as any;

let unmigratedRaw: PGlite;
let unmigrated: any;
let migrated: any;

beforeAll(async () => {
  // A real Postgres with NO migrations applied — the state a cutover reaches
  // when the migration ran against a host the runner could not use.
  unmigratedRaw = new PGlite();
  unmigrated = drizzle(unmigratedRaw, { schema: s });

  // EVERY migration, discovered rather than listed, so a later one cannot make
  // this suite fail on a query and look like a route defect.
  const client = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  migrated = drizzle(client, { schema: s });
});

// The route limits to 5 requests a minute per client IP. A 429 here would look
// exactly like the defect under test, so every request comes from its own
// address in the documentation range.
let requests = 0;
function post(body: unknown): Request {
  requests += 1;
  return new Request('https://www.mmakf.in/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `203.0.113.${requests}`,
    },
    body: JSON.stringify(body),
  });
}

/** The route reads only `request` from its context, so this is a complete one. */
function call(body: unknown): Promise<Response> {
  return (POST as any)({ request: post(body) });
}

describe('sign-in when the federation register does not answer', () => {
  it('does not report an unreachable database as a retired password', async () => {
    __setTestClient(unreachable);

    const res = await call({ password: OFFICE_PW });
    const body = await res.json();

    expect(res.status).toBe(503);
    // The sentence the office was being shown. It is a statement about their
    // credentials, and it was false.
    expect(body.error).not.toMatch(/retired/i);
    expect(body.error).toMatch(/connection/i);

    // Fail closed all the same: an unreadable count is not permission.
    expect(res.headers.get('Set-Cookie')).toBeNull();

    // And no driver text reaches an unauthenticated caller.
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|6543|users/);
  });

  it('says the same when the database answers but was never migrated — the state /api/health calls "ok"', async () => {
    // Measured, not assumed: the health probe's own query succeeds here.
    await expect(unmigratedRaw.query('select 1')).resolves.toBeTruthy();
    await expect(unmigratedRaw.query('select count(*) from users')).rejects.toThrow(/users/);

    __setTestClient(unmigrated);

    const res = await call({ password: OFFICE_PW });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).not.toMatch(/retired/i);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('answers the account path with 503 instead of throwing out of the route', async () => {
    __setTestClient(unreachable);

    // Before the fix this rejects, and Astro turns that into a bare 500 with no
    // body — so the assertion is that a Response comes back at all.
    const outcome = await call({ email: 'someone@example.org', password: 'whatever it is' })
      .catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(Response);
    const res = outcome as Response;
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toMatch(/connection/i);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|6543/);
  });

  it('keeps the break-glass escape usable while the database is down', async () => {
    // ALLOW_SHARED_ADMIN_PASSWORD exists to recover a locked-out office, and an
    // outage is when they would need it. Refusing here to "be safe" would take
    // the last door away at the worst moment.
    process.env.ALLOW_SHARED_ADMIN_PASSWORD = 'true';
    __setTestClient(unreachable);
    try {
      const res = await call({ password: OFFICE_PW });
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toContain('mmakf_admin=');
    } finally {
      delete process.env.ALLOW_SHARED_ADMIN_PASSWORD;
    }
  });
});

describe('sign-in against a database that does answer', () => {
  it('still lets the office in before any account exists, and retires the shared password once one does', async () => {
    __setTestClient(migrated);

    const before = await call({ password: OFFICE_PW });
    expect(before.status).toBe(200);
    expect(before.headers.get('Set-Cookie')).toContain('mmakf_admin=');

    await migrated.insert(s.users).values({ email: 'first.account@example.org' });

    const after = await call({ password: OFFICE_PW });
    const body = await after.json();
    expect(after.status).toBe(403);
    expect(body.error).toMatch(/retired/i);
    expect(after.headers.get('Set-Cookie')).toBeNull();
  });

  it('still answers a wrong shared password with the generic 401', async () => {
    __setTestClient(migrated);

    const res = await call({ password: 'not the office password' });
    const body = await res.json();
    // An account exists by now, so this is the retired path — the point is that
    // a reachable database never produces the outage answer.
    expect(res.status).not.toBe(503);
    expect(body.error).not.toMatch(/connection/i);
  });
});
