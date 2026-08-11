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
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

type Audience = 'admin' | 'unit';

function getSecret(): string {
  const s = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-secret-change-me';
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

  const expected = sign(payload, aud);
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
}

export function createUnitSessionCookie(u: UnitSession): string {
  const payload = b64url(JSON.stringify({ k: 'unit', t: Date.now(), n: u.name, l: u.level, s: u.state }));
  return `${UNIT_COOKIE}=${payload}.${sign(payload, 'unit')}; ${attrs()}`;
}

export function clearUnitSessionCookie(): string {
  return `${UNIT_COOKIE}=; ${clearAttrs()}`;
}

export function getUnitSession(cookieHeader: string | null | undefined): UnitSession | null {
  const c = verify(parseCookies(cookieHeader)[UNIT_COOKIE], 'unit');
  if (!c || !c.n || !c.l || !c.s) return null;
  return { name: String(c.n), level: String(c.l), state: String(c.s) };
}

// ─── Password ───

export function checkPassword(submitted: string): boolean {
  const target = process.env.ADMIN_PASSWORD || 'mmakf2025';
  if (!submitted) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(target);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
