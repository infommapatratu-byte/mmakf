// Sign-in.
//
// Two paths, and the second is on its way out:
//
//   1. EMAIL + PASSWORD against a real user account. Every action taken in this
//      session is attributable to a named person in the audit trail.
//   2. The legacy shared office password, retained only so the office is not
//      locked out before accounts exist. `sharedPasswordAllowed()` retires it
//      automatically once the first account is created.
//
// Failures are deliberately indistinguishable to the caller: a wrong password,
// an unknown email and a disabled account all return the same 401 with the same
// message and comparable timing. Only a lockout is disclosed, because the user
// must be told why waiting is required.
//
// AN OUTAGE IS NOT A CREDENTIAL ANSWER. Both paths ask the database a question,
// and a database that is configured but does not answer must not be reported as
// a decision about the caller's password. See `userCount()` and the 503s below.

import type { APIRoute } from 'astro';
import { checkPassword, createSessionCookie, createUserSessionCookie, sharedPasswordAllowed } from '@/lib/auth';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { clientIp } from '@/lib/session';
import { isConfigured, db } from '@/db';
import { signIn } from '@/db/users';
import { writeAudit } from '@/db/federation';
import * as s from '@/db/schema';
import { sql } from 'drizzle-orm';

export const prerender = false;

const GENERIC = 'Invalid email or password';

// Said when the register could not be asked at all. It names the class of fault
// and nothing else: no host, no port, no driver text, no table name — the
// caller here may be anyone. /api/health already reports `database` publicly,
// so this discloses no state that was not already visible.
const UNREACHABLE =
  'The federation register did not answer, so sign-in cannot be checked. ' +
  'This is a database connection problem, not a password problem.';

function json(body: unknown, status: number, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * How many accounts exist — or that the question could not be answered.
 *
 * "Could not ask" is kept SEPARATE from "there are accounts". Collapsing the
 * two into 1 was safe (an outage never re-enabled the shared password) but it
 * made the route state something false: the office was told their password had
 * been retired in favour of accounts that had never been created, and the
 * operator was sent to the register instead of to the connection string.
 *
 * The unreachable case is not the only one. On a database that answers but has
 * not been migrated, `select 1` succeeds — so /api/health reports `ok` and the
 * pre-cutover check passes — while this query fails with 42P01. Both arrive
 * here, and both must be reported as what they are.
 */
type AccountCount = { known: true; count: number } | { known: false };

async function userCount(): Promise<AccountCount> {
  if (!isConfigured()) return { known: true, count: 0 };
  try {
    const rows = await db().select({ n: sql<number>`count(*)::int` }).from(s.users);
    return { known: true, count: Number(rows[0]?.n ?? 0) };
  } catch (err) {
    // Logged because nothing else will name it: the caller gets a sentence with
    // no internals in it, and this is the only place the real fault is written.
    console.error('login: could not count accounts', err);
    return { known: false };
  }
}

export const POST: APIRoute = async ({ request }) => {
  // Two limiters: per-IP against spraying, and the account lockout inside
  // signIn() against guessing one account.
  const rl = await rateLimit(request, 'admin-login', 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = clientIp(request);

  // ── Path 1: a real account ────────────────────────────────────────────────
  if (email) {
    if (!isConfigured()) {
      return json({ error: 'Account sign-in is not available yet on this deployment' }, 503);
    }

    // src/db/users.ts does not swallow driver errors, and should not — a failed
    // lookup is not a failed password. Without this catch the rejection left the
    // route and Astro answered a bare 500 with no body, which reads as a broken
    // deployment rather than a database that did not answer.
    let result: Awaited<ReturnType<typeof signIn>>;
    try {
      result = await signIn(db(), email, password);
    } catch (err) {
      console.error('login: account lookup failed', err);
      return json({ error: UNREACHABLE }, 503);
    }

    if (!result.ok) {
      if (result.reason === 'locked') {
        return json(
          { error: 'This account is temporarily locked after repeated failed attempts. Try again in 15 minutes.' },
          423
        );
      }
      return json({ error: GENERIC }, 401);
    }

    await writeAudit(
      db(),
      { principal: { userId: result.user.id, label: result.user.email, bindings: [] }, ip },
      { entityType: 'user', entityId: result.user.id, action: 'login', newValue: { via: 'password' } }
    );

    return json(
      { ok: true, email: result.user.email, mustChangePassword: result.user.mustChangePassword },
      200,
      createUserSessionCookie({ userId: result.user.id, epoch: result.user.sessionEpoch })
    );
  }

  // ── Path 2: the legacy shared office password ─────────────────────────────
  //
  // NFR-SEC-2: the development default must never function in production.
  if (import.meta.env.PROD && (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET)) {
    console.error('ADMIN_PASSWORD / ADMIN_SESSION_SECRET not configured — refusing logins');
    return json({ error: 'Server not configured' }, 500);
  }

  // Fail closed first, explain second. An unknown count counts as "accounts
  // exist", so an outage still cannot re-enable the shared password — and the
  // ALLOW_SHARED_ADMIN_PASSWORD break-glass still opens, which is the whole
  // point of it: a locked-out office needs that door most when the database is
  // the thing that is down. Only once the answer is "refused" does the reason
  // decide which refusal to send.
  const accounts = await userCount();
  const assumed = accounts.known ? accounts.count : 1;

  if (!sharedPasswordAllowed(assumed, isConfigured())) {
    if (!accounts.known) return json({ error: UNREACHABLE }, 503);
    return json(
      { error: 'The shared password has been retired. Sign in with your own email address and password.' },
      403
    );
  }

  if (!checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 400));   // damp online guessing
    return json({ error: GENERIC }, 401);
  }

  return json({ ok: true, shared: true }, 200, createSessionCookie());
};
