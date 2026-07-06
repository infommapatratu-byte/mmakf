// Admin auth — signed-cookie session, no JWT lib needed.
// Cookie value = base64(payload) + "." + base64(hmac-sha256(payload, secret))

import crypto from 'node:crypto';

const COOKIE_NAME = 'mmakf_admin';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const s = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-secret-change-me';
  if (s.length < 8) throw new Error('ADMIN_SESSION_SECRET too short');
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

export function createSessionCookie(): string {
  const payload = b64url(JSON.stringify({ t: Date.now() }));
  const sig = sign(payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

export function isAuthenticated(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...rest] = c.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  // NFR-SEC-3: constant-time signature comparison
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    const { t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!t || typeof t !== 'number') return false;
    if (Date.now() - t > MAX_AGE * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Unit portal sessions (state / district / club level) ───
// Same HMAC scheme as the admin cookie, but the payload carries the unit's
// identity so every portal view/action is scoped server-side.

const UNIT_COOKIE = 'mmakf_unit';

export interface UnitSession {
  name: string;   // unit display name
  level: string;  // State | District | Club
  state: string;  // scoping state
}

export function createUnitSessionCookie(u: UnitSession): string {
  const payload = b64url(JSON.stringify({ t: Date.now(), n: u.name, l: u.level, s: u.state }));
  const sig = sign(payload);
  return `${UNIT_COOKIE}=${payload}.${sig}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

export function clearUnitSessionCookie(): string {
  return `${UNIT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;
}

export function getUnitSession(cookieHeader: string | null | undefined): UnitSession | null {
  if (!cookieHeader) return null;
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...rest] = c.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  const token = cookies[UNIT_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const { t, n, l, s } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!t || typeof t !== 'number') return null;
    if (Date.now() - t > MAX_AGE * 1000) return null;
    if (!n || !l || !s) return null;
    return { name: String(n), level: String(l), state: String(s) };
  } catch {
    return null;
  }
}

export function checkPassword(submitted: string): boolean {
  const target = process.env.ADMIN_PASSWORD || 'mmakf2025';
  if (!submitted) return false;
  // constant-time compare
  const a = Buffer.from(submitted);
  const b = Buffer.from(target);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
