// MMAKF session auth — signed-cookie sessions, no JWT library.
//
// Cookie value = base64url(payload) + "." + base64url(HMAC-SHA256(payload, key))
//
// SECURITY (P0-1, fixed 2026-08-11): admin and unit sessions are separate
// *audiences*. Two independent defences prevent a low-privilege unit token from
// being replayed as a national-admin token:
//   1. the payload carries an audience claim `k` which the verifier must match;
//   2. each audience signs with its own derived key (HMAC domain separation),
//      so a token minted for one audience cannot validate under the other even
//      if the claim check were bypassed.
// Legacy tokens (no `k` claim) are rejected — holders simply sign in again.

import crypto from 'node:crypto';

const ADMIN_COOKIE = 'mmakf_admin';
const UNIT_COOKIE = 'mmakf_unit';
const USER_COOKIE = 'mmakf_user';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

type Audience = 'admin' | 'unit' | 'user';

/**
 * Is this a production runtime?
 *
 * Astro/Vite replaces `import.meta.env.PROD` at build time, which is what the
 * deployed function sees. NODE_ENV covers the plain-node paths — scripts and
 * tests — where `import.meta.env` does not exist, and matches how attrs()
 * below already decides whether to set `Secure`.
 */
function isProductionRuntime(): boolean {
  if (typeof import.meta.env !== 'undefined' && import.meta.env.PROD) return true;
  return process.env.NODE_ENV === 'production';
}

/**
 * The secret every audience key is derived from.
 *
 * The development fallback is a literal published in this repository, so a
 * production deployment that fell back to it could be impersonated by anyone
 * who can read the source: they derive keyFor('admin') on their own machine,
 * mint a cookie and are a national administrator without touching the login
 * route, its rate limit or its audit trail. The boot guard at
 * src/pages/api/auth/login.ts only refuses to MINT — nothing there is consulted
 * when a cookie is VERIFIED — so production has to refuse at the key itself.
 *
 * Throwing here fails closed in both directions: minting raises (an
 * unconfigured deployment cannot hand out cookies) and verify() turns the throw
 * into "no session" (an unconfigured deployment signs everyone out rather than
 * trusting a key the whole world holds).
 */
function getSecret(): string {
  const configured = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!configured && isProductionRuntime()) {
    throw new Error('ADMIN_SESSION_SECRET is not set — refusing to sign or verify sessions');
  }
  const s = configured || 'dev-secret-change-me';
  if (s.length < 8) throw new Error('ADMIN_SESSION_SECRET too short');
  return s;
}

/** Per-audience signing key: HMAC(secret, "mmakf:session:<audience>:v2"). */
function keyFor(aud: Audience): Buffer {
  return crypto.createHmac('sha256', getSecret()).update(`mmakf:session:${aud}:v2`).digest();
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload: string, aud: Audience): string {
  return crypto.createHmac('sha256', keyFor(aud)).update(payload).digest('base64url');
}

function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((c) => {
      const [k, ...rest] = c.trim().split('=');
      return [k, rest.join('=')];
    })
  );
}

function attrs(): string {
  return `Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

function clearAttrs(): string {
  return `Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

/** Verify a token for an audience and return its payload object, or null. */
function verify(token: string | undefined, aud: Audience): any | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  // No usable signing key means no verifiable session. Returning null makes an
  // unconfigured deployment signed-out; letting the throw escape would make
  // every page a 500, and any caller that treats an error as "carry on" would
  // turn a misconfiguration into the escalation this guard exists to stop.
  let expected: string;
  try {
    expected = sign(payload, aud);
  } catch {
    return null;
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (claims.k !== aud) return null;                      // audience must match
    if (!claims.t || typeof claims.t !== 'number') return null;
    if (Date.now() - claims.t > MAX_AGE * 1000) return null; // expiry
    return claims;
  } catch {
    return null;
  }
}

// ─── Admin sessions ───

export function createSessionCookie(): string {
  const payload = b64url(JSON.stringify({ k: 'admin', t: Date.now() }));
  return `${ADMIN_COOKIE}=${payload}.${sign(payload, 'admin')}; ${attrs()}`;
}

export function clearSessionCookie(): string {
  return `${ADMIN_COOKIE}=; ${clearAttrs()}`;
}

export function isAuthenticated(cookieHeader: string | null | undefined): boolean {
  return verify(parseCookies(cookieHeader)[ADMIN_COOKIE], 'admin') !== null;
}

// ─── Unit portal sessions (state / district / club) ───

export interface UnitSession {
  name: string;
  level: string;
  state: string;
  /** Set for District-level codes. Absent means the code has no district. */
  district?: string;
}

export function createUnitSessionCookie(u: UnitSession): string {
  const payload = b64url(JSON.stringify({
    k: 'unit', t: Date.now(), n: u.name, l: u.level, s: u.state, d: u.district ?? null,
  }));
  return `${UNIT_COOKIE}=${payload}.${sign(payload, 'unit')}; ${attrs()}`;
}

export function clearUnitSessionCookie(): string {
  return `${UNIT_COOKIE}=; ${clearAttrs()}`;
}

export function getUnitSession(cookieHeader: string | null | undefined): UnitSession | null {
  const c = verify(parseCookies(cookieHeader)[UNIT_COOKIE], 'unit');
  if (!c || !c.n || !c.l || !c.s) return null;
  return {
    name: String(c.n),
    level: String(c.l),
    state: String(c.s),
    district: c.d ? String(c.d) : undefined,
  };
}

// ─── User sessions (per-person accounts, §65) ───
//
// The cookie carries only the user id and the session epoch it was minted
// under. Roles are NOT embedded: they are loaded from role_bindings on every
// request (see src/db/users.ts resolvePrincipal) so that withdrawing someone's
// authority takes effect immediately rather than whenever their cookie expires.
//
// Bumping users.session_epoch invalidates every cookie for that user at once —
// the "sign out everywhere" lever, used on compromise or on withdrawal.

export interface UserSessionClaims {
  userId: number;
  epoch: number;
}

export function createUserSessionCookie(c: UserSessionClaims): string {
  const payload = b64url(JSON.stringify({ k: 'user', t: Date.now(), u: c.userId, e: c.epoch }));
  return `${USER_COOKIE}=${payload}.${sign(payload, 'user')}; ${attrs()}`;
}

export function clearUserSessionCookie(): string {
  return `${USER_COOKIE}=; ${clearAttrs()}`;
}

/**
 * Read the user session claims. This proves the cookie is authentic and
 * unexpired — it does NOT prove the account still exists or holds any
 * authority. Callers must pass the claims to resolvePrincipal() against the
 * database before permitting anything.
 */
export function getUserSession(cookieHeader: string | null | undefined): UserSessionClaims | null {
  const c = verify(parseCookies(cookieHeader)[USER_COOKIE], 'user');
  if (!c || typeof c.u !== 'number' || typeof c.e !== 'number') return null;
  return { userId: c.u, epoch: c.e };
}

// ─── Password ───

/**
 * The legacy shared office password.
 *
 * Superseded by per-person accounts (src/db/users.ts). It remains only as the
 * bootstrap path: without it, provisioning a database would lock the office out
 * of its own admin panel entirely. `sharedPasswordAllowed()` is the gate that
 * retires it, and must be consulted before calling this.
 */
export function checkPassword(submitted: string): boolean {
  const target = process.env.ADMIN_PASSWORD || 'mmakf2025';
  if (!submitted) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(target);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * May the shared office password still be used to sign in?
 *
 * It is retired automatically once real accounts exist, so the federation
 * cannot end up with per-person accountability on paper while a shared password
 * quietly remains a way around it. Two escapes, both deliberate:
 *  · no database configured — there are no accounts to sign in with yet;
 *  · ALLOW_SHARED_ADMIN_PASSWORD=true — an explicit, auditable break-glass for
 *    recovering a locked-out office.
 */
export function sharedPasswordAllowed(userCount: number, databaseConfigured: boolean): boolean {
  if (!databaseConfigured) return true;
  if (process.env.ALLOW_SHARED_ADMIN_PASSWORD === 'true') return true;
  return userCount === 0;
}
