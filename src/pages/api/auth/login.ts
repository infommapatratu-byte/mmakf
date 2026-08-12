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

function json(body: unknown, status: number, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

async function userCount(): Promise<number> {
  if (!isConfigured()) return 0;
  try {
    const rows = await db().select({ n: sql<number>`count(*)::int` }).from(s.users);
    return Number(rows[0]?.n ?? 0);
  } catch {
    // A database that is configured but unreachable must not silently re-enable
    // the shared password, so report accounts as existing.
    return 1;
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

    const result = await signIn(db(), email, password);

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

  if (!sharedPasswordAllowed(await userCount(), isConfigured())) {
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
