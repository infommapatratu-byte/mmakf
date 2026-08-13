// Public account creation.
//
// REGISTRATION GRANTS NOTHING. src/db/onboarding.ts enforces that — the account
// it creates holds zero role bindings — and this endpoint's job is to be the
// public edge in front of it: rate limited, origin-checked, and careful about
// what its answers disclose.
//
// TWO CALLERS, ONE CORE. `submitRegistration()` below is the whole handler, and
// both entry points call it:
//
//   · POST /api/auth/register — JSON, for the enhanced form.
//   · POST /register          — the page itself handles its own form post, so
//                               the page works with JavaScript switched off.
//
// The second exists because the middleware in src/middleware.ts requires
// `application/json` on every /api/ path — deliberately, since that is what a
// cross-site form cannot send without a preflight. A no-JavaScript form can
// only send `application/x-www-form-urlencoded`, so it must not post to /api/.
// It posts to the page instead, which is still origin-checked by the same
// middleware (the JSON rule is scoped to /api/, the Origin rule is not). What
// it must NOT do is have its own copy of the rate limit, the validation and the
// enumeration wording — two copies is how one of them ends up weaker. This is
// the same construction /application.astro already uses when it calls the GET
// handler of /api/application rather than repeating its checks.
//
// ── WHAT A DUPLICATE EMAIL IS TOLD, AND WHY ────────────────────────────────
//
// The brief asked for a duplicate address to be refused without disclosing
// whether that address already has an account. Three options were on the table.
//
//   1. SAY "that address is taken". This is what registerAccount() throws, and
//      it is right for the module — an administrator calling it by hand needs
//      the truth. At a public, unauthenticated edge it is an oracle: an
//      attacker with a list of addresses learns which of them hold MMAKF
//      accounts, one request at a time, and the federation's people are exactly
//      the population that list would be built against.
//
//   2. SAY "check your inbox". The usual mitigation, and here it would be a
//      lie. No email transport is configured in this project — notifications
//      are queued and marked `queued`, never `sent` — so this would send a real
//      person to wait for a message that is never coming. This codebase treats
//      a plausible-sounding fabrication as the worst possible bug.
//
//   3. ANSWER THE SAME THING EITHER WAY, and make the answer true in both
//      worlds. That is what this does.
//
// The accepted response is byte-identical whether an account was created or
// already existed: same status, same body, same wording, and no Set-Cookie in
// either case (which is why registration deliberately does NOT sign the new
// account in — a session cookie on one branch and not the other would restore
// the oracle in the response headers, whatever the body said). The sentence is
// a disjunction that is true both ways: if the address was free, an account now
// exists with the password just chosen; if it was not, nothing changed and the
// existing password still applies. Either way the next step is the same — go to
// /my and sign in — and the person who does that finds out, by signing in,
// which of the two happened, without an unauthenticated stranger being able to
// ask the same question on their behalf.
//
// The residual cost is stated rather than hidden: someone who already has an
// account and mistypes it as a NEW registration is told to sign in with a
// password that will not work, and must ask the office. That is worse for one
// honest user and much better for everyone whose membership of this federation
// is not a fact they want an attacker to be able to confirm.
//
// TIMING. The duplicate branch does no password hashing, and scrypt at N=2^15
// is ~100ms — plainly visible in a response time. So the duplicate branch pays
// the same cost through equalizeTiming(), the same defence src/lib/password.ts
// already provides for sign-in. This is NOT a claim of constant time: an INSERT
// and an audit write are not a SELECT, and a determined attacker with a clean
// network path may still see a difference. It removes the obvious signal and
// the rate limiter covers the rest.
//
// VALIDATION FAILURES ARE STILL REPORTED PLAINLY. A password that is too short
// is a fact about what the caller typed, not about who holds an account, so it
// discloses nothing and is said out loud. All input validation happens BEFORE
// the address is ever looked up, so no validation path can become a second
// oracle.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { registerAccount, isOnboardingError } from '@/db/onboarding';
import { equalizeTiming, passwordProblem } from '@/lib/password';
import { transportStatus } from '@/lib/notifications';
import { rateLimit } from '@/lib/ratelimit';
import { clientIp } from '@/lib/session';

export const prerender = false;

/** Field lengths a request may not exceed before anything else looks at it. */
const MAX_EMAIL = 254;          // RFC 5321 addr-spec ceiling
const MAX_DISPLAY_NAME = 120;
const MAX_BODY_BYTES = 4096;

/**
 * Five per hour per address family.
 *
 * Account creation is a once-in-a-lifetime action for a real person, so the
 * limit can be tight. It is the control that turns the enumeration cost from
 * "a script over a mailing list" into "a script over a mailing list, at five an
 * hour, from every IP you can find".
 */
const RATE_LIMIT = { bucket: 'register', limit: 5, windowSeconds: 3600 } as const;

export type RegistrationOutcome =
  /** An account exists for this address. Says nothing about whether we made it. */
  | { kind: 'accepted'; email: string; message: string; nextHref: string }
  | { kind: 'invalid'; field: 'email' | 'password' | 'confirm' | null; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export interface RegistrationFields {
  email: string;
  password: string;
  /** The second password box. Omitted (undefined) means "not asked for". */
  confirm?: string;
  /** Optional; recorded for a reviewer to read. Confers nothing. */
  displayName?: string;
}

/** HTTP status for each outcome, in one place so both callers agree. */
export function statusFor(outcome: RegistrationOutcome): number {
  switch (outcome.kind) {
    case 'accepted': return 200;
    case 'invalid': return 400;
    case 'rate_limited': return 429;
    case 'unavailable': return 503;
    case 'failed': return 500;
  }
}

/**
 * What the caller is told about verification.
 *
 * Computed the same way on both branches so the sentence cannot differ between
 * "created" and "already existed" — and computed from the transport that is
 * actually configured, so it is never a promise of an email nobody will send.
 */
function verificationSentence(): string {
  const email = transportStatus().find((t) => t.channel === 'email');
  return email?.configured
    ? 'No verification email is sent for a new account on this system.'
    : 'No verification email has been sent: this deployment has no email transport configured.';
}

/**
 * The one true registration handler.
 *
 * Takes the Request only for the rate limiter and the client IP — never for the
 * fields, which the caller has already read in whatever encoding it speaks.
 */
export async function submitRegistration(
  request: Request,
  fields: RegistrationFields
): Promise<RegistrationOutcome> {
  const rl = await rateLimit(request, RATE_LIMIT.bucket, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!rl.ok) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, rl.retryAfterSeconds),
      message:
        'Too many registration attempts from this connection. Wait a few minutes and try again. ' +
        'If you are on a shared connection at a dojo or an internet cafe, this limit may have been reached by somebody else.',
    };
  }

  const email = String(fields.email ?? '').trim();
  const password = String(fields.password ?? '');
  const displayName = String(fields.displayName ?? '').trim().slice(0, MAX_DISPLAY_NAME) || null;

  // ── Input validation. Nothing below this block may depend on whether the
  //    address exists, and nothing above it touches the database. ───────────
  if (!email) {
    return { kind: 'invalid', field: 'email', message: 'An email address is required.' };
  }
  if (email.length > MAX_EMAIL) {
    return { kind: 'invalid', field: 'email', message: `An email address must be ${MAX_EMAIL} characters or fewer.` };
  }
  // Deliberately shallow. A stricter pattern rejects addresses that genuinely
  // work; the real test of an address is whether its owner can receive at it,
  // and this project sends nothing, so an over-strict rule here would only ever
  // turn away a real person.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    return { kind: 'invalid', field: 'email', message: 'That does not look like an email address.' };
  }

  const problem = passwordProblem(password);
  if (problem) {
    return { kind: 'invalid', field: 'password', message: `${problem}.` };
  }
  if (fields.confirm !== undefined && fields.confirm !== password) {
    return { kind: 'invalid', field: 'confirm', message: 'The two passwords do not match.' };
  }

  if (!isConfigured()) {
    return {
      kind: 'unavailable',
      message:
        'Accounts cannot be created on this deployment: no federation database is configured. ' +
        'Nothing has been recorded. The federation office can be reached at admin@mmakf.in.',
    };
  }

  // Identical for both branches, built once so neither can drift.
  const accepted = (): RegistrationOutcome => ({
    kind: 'accepted',
    email,
    nextHref: '/my',
    message:
      `Your registration for ${email} has been processed. ` +
      'If that address did not already have an MMAKF account, one now exists and the password you just chose is its password. ' +
      'If it did, that account is unchanged and its existing password still applies — nothing has been altered. ' +
      `${verificationSentence()} ` +
      'Sign in to continue. An account on its own carries no authority in the federation: it can read its own record and nothing else, ' +
      'until MMAKF approves an application.',
  });

  try {
    const result = await registerAccount(db(), {
      email,
      password,
      displayName,
      ip: clientIp(request),
      requestId: request.headers.get('x-request-id'),
    });

    // The module returns the literal 0 here and the type would fail to compile
    // if that ever changed. Checked at runtime too, because a registration that
    // handed out authority must not reach a user while a type says it cannot.
    if (result.roleBindingCount !== 0) {
      console.error('[register] registerAccount returned a non-zero binding count — refusing to report success');
      return {
        kind: 'failed',
        message: 'Registration could not be completed. The fault has been logged for the federation office.',
      };
    }

    return accepted();
  } catch (err: any) {
    if (isOnboardingError(err) && err.code === 'email_taken') {
      // The one branch this whole file is about. Same answer, same shape, and
      // the same scrypt cost paid so the response time does not answer the
      // question the wording refuses to.
      await equalizeTiming(password);
      console.warn('[register] registration attempt against an address that already has an account');
      return accepted();
    }

    // Anything else is a fact about the server, not about the caller. The
    // message may carry a driver detail or a constraint name, so it is logged
    // and summarised rather than echoed. Every input fault was caught above, so
    // reaching here genuinely is a server-side problem.
    console.error('[register] registration refused', err);
    return {
      kind: 'failed',
      message:
        'Registration could not be completed. Nothing has been created. ' +
        'The fault has been logged for the federation office; please try again, or write to admin@mmakf.in.',
    };
  }
}

/** JSON entry point. The page posts to itself; this serves the enhanced form. */
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'Request too large' }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: 'Invalid request' }, 400);
  }

  const outcome = await submitRegistration(request, {
    email: typeof body.email === 'string' ? body.email : '',
    password: typeof body.password === 'string' ? body.password : '',
    // `undefined` means the caller did not ask for confirmation, which is a
    // different thing from an empty second box.
    confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
  });

  const status = statusFor(outcome);
  const headers: Record<string, string> = {};
  if (outcome.kind === 'rate_limited') headers['Retry-After'] = String(outcome.retryAfterSeconds);

  if (outcome.kind === 'accepted') {
    return json(
      {
        ok: true,
        email: outcome.email,
        message: outcome.message,
        next: outcome.nextHref,
        // Returned so no caller has to assume it. It is always zero.
        roleBindingCount: 0,
      },
      status,
      headers
    );
  }

  return json(
    { ok: false, error: outcome.message, field: outcome.kind === 'invalid' ? outcome.field : null },
    status,
    headers
  );
};

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}
