// Change your own password.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS ROUTE HAD TO EXIST
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/users.ts has carried changePassword() — verifying the current
// password, refusing reuse, clearing must_change_password and revoking every
// other session — and NOTHING CALLED IT. No page under src/pages matched
// `password`, and the flag the login route returns was written to sessionStorage
// and read by nobody.
//
// So an account created by scripts/create-user.ts was flagged "must change this
// password on first use" and given no way to comply. The only rotation the
// federation had was another CLI reset by somebody with the connection string,
// which means a credential generated in a terminal, read aloud or pasted, could
// never be replaced by one only its holder knows.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT KEEPS YOU SIGNED IN, AND THAT IS NOT LAXITY
// ─────────────────────────────────────────────────────────────────────────────
//
// changePassword() bumps session_epoch, which invalidates EVERY cookie for the
// account — including the one that just made this request. That is correct:
// changing a password is what somebody does when they think another session is
// not theirs. But signing the operator out at the moment they comply turns the
// safe act into a punishment, and a console that logs you out for doing the
// right thing is one people stop doing the right thing in.
//
// So a fresh cookie is minted at the NEW epoch and returned with the response.
// Every other session stays dead; only the caller's continues.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { createUserSessionCookie } from '@/lib/auth';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { changePassword } from '@/db/users';
import { isConfigured, db } from '@/db';
import * as s from '@/db/schema';
import { eq } from 'drizzle-orm';

export const prerender = false;

function json(body: unknown, status: number, cookie?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

export const POST: APIRoute = async ({ request }) => {
  // The current password is submitted here, so this is a guessing surface like
  // sign-in and is limited like one.
  const rl = await rateLimit(request, 'change-password', 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Unauthorized' }, 401);

  // A SHARED CREDENTIAL HAS NO OWNER TO CHANGE IT. The legacy office password
  // and the unit access codes live in configuration, not in the register: there
  // is no row to update and no one person whose credential it is. Saying so is
  // better than a generic refusal, because the operator's next step is
  // different — they need an account, not a different button.
  if (identity.via !== 'user' || identity.userId == null) {
    return json(
      {
        error:
          'This is a shared credential, not a personal account, so there is no password here to change. ' +
          'Ask a federation officer to create an account for you with npm run user:create.',
      },
      403
    );
  }

  if (!isConfigured()) {
    return json({ error: 'The federation register is not available on this deployment' }, 503);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!currentPassword || !newPassword) {
    return json({ error: 'Both your current and your new password are required' }, 400);
  }

  try {
    await changePassword(
      db(),
      { principal: identity.principal, ip: clientIp(request) },
      identity.userId,
      currentPassword,
      newPassword
    );
  } catch (err: any) {
    // changePassword() throws sentences meant for the person typing — the
    // current password being wrong, the new one being too short, the new one
    // being the old one. They are safe to show: the caller has already proved
    // who they are, so nothing here discloses anything to a stranger.
    const message = String(err?.message ?? 'The password could not be changed');
    const known =
      /current password is incorrect|must be at least|characters or fewer|only whitespace|different from the current/i
        .test(message);
    if (!known) console.error('change-password: unexpected failure', err);
    return json({ error: known ? message : 'The password could not be changed' }, known ? 400 : 500);
  }

  // Re-read rather than assume the arithmetic: the epoch the cookie carries has
  // to be the one the register now holds, or the very next request signs the
  // caller out and this route looks broken.
  let epoch = 0;
  try {
    const row = (await db()
      .select({ e: s.users.sessionEpoch })
      .from(s.users)
      .where(eq(s.users.id, identity.userId))
      .limit(1))[0];
    epoch = Number(row?.e ?? 0);
  } catch (err) {
    // The password DID change. Reporting a failure now would have them change
    // it again; instead they are signed out and sign in with the new one.
    console.error('change-password: could not re-read the session epoch', err);
    return json({ ok: true, signedOut: true }, 200);
  }

  return json(
    { ok: true, signedOut: false },
    200,
    createUserSessionCookie({ userId: identity.userId, epoch })
  );
};
