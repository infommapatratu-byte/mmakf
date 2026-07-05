// Unit tests for src/lib/auth.ts (MASTER-SPEC §15.1)
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  createSessionCookie,
  clearSessionCookie,
  isAuthenticated,
  checkPassword,
} from '../src/lib/auth';

// Dev-default secret (no env vars set in test runs)
const SECRET = 'dev-secret-change-me';

function forgeCookie(payloadObj: object, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `mmakf_admin=${payload}.${sig}`;
}

describe('session cookie', () => {
  it('mints a cookie that authenticates', () => {
    const setCookie = createSessionCookie();
    const value = setCookie.split(';')[0]; // "mmakf_admin=..."
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=604800');
    expect(isAuthenticated(value)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const value = createSessionCookie().split(';')[0];
    const [name, token] = value.split('=');
    const [payload, sig] = token.split('.');
    const badSig = sig.slice(0, -2) + (sig.endsWith('aa') ? 'bb' : 'aa');
    expect(isAuthenticated(`${name}=${payload}.${badSig}`)).toBe(false);
  });

  it('rejects a payload signed with the wrong secret', () => {
    expect(isAuthenticated(forgeCookie({ t: Date.now() }, 'attacker-secret'))).toBe(false);
  });

  it('rejects an expired session (t older than 7 days)', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    expect(isAuthenticated(forgeCookie({ t: old }))).toBe(false);
  });

  it('accepts a fresh forged-with-correct-secret cookie (sanity of forge helper)', () => {
    expect(isAuthenticated(forgeCookie({ t: Date.now() }))).toBe(true);
  });

  it('rejects garbage and missing cookies', () => {
    expect(isAuthenticated(null)).toBe(false);
    expect(isAuthenticated('')).toBe(false);
    expect(isAuthenticated('mmakf_admin=not-a-token')).toBe(false);
    expect(isAuthenticated('other=value')).toBe(false);
    expect(isAuthenticated('mmakf_admin=a.b.c')).toBe(false);
  });

  it('clearSessionCookie expires the cookie', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});

describe('checkPassword', () => {
  it('accepts the dev default password', () => {
    expect(checkPassword('mmakf2025')).toBe(true);
  });
  it('rejects wrong, empty, and length-mismatched passwords', () => {
    expect(checkPassword('wrong-password')).toBe(false);
    expect(checkPassword('')).toBe(false);
    expect(checkPassword('mmakf2024')).toBe(false);
    expect(checkPassword('mmakf20255')).toBe(false);
  });
});
