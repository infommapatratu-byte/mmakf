// Regression tests for the fallback session-signing key (AUDIT-REGISTER P0-2).
//
// getSecret() used to fall back to the literal 'dev-secret-change-me' whenever
// neither ADMIN_SESSION_SECRET nor ADMIN_PASSWORD was set, and every audience
// key is derived from it. That literal is published in this repository, so a
// production deployment missing the env var can be impersonated by anyone who
// can read the source: they compute a cookie on their own machine and present
// it. The boot guard on the login route does not help, because verification
// never goes near the login route — isAuthenticated(), getUserSession() and
// getUnitSession() read no environment variable at all.
//
// The rule these tests pin: in production the fallback must not exist, and a
// deployment that cannot derive a key must treat every caller as SIGNED OUT
// rather than as a national administrator.

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createSessionCookie,
  createUnitSessionCookie,
  createUserSessionCookie,
  isAuthenticated,
  getUnitSession,
  getUserSession,
} from '../src/lib/auth';

/** The key an attacker reads out of the repository. */
const PUBLISHED = 'dev-secret-change-me';

type Audience = 'admin' | 'unit' | 'user';

/** Mint a cookie the way src/lib/auth.ts does, but with a chosen secret. */
function forge(aud: Audience, claims: Record<string, unknown>, secret = PUBLISHED): string {
  const key = crypto.createHmac('sha256', secret).update(`mmakf:session:${aud}:v2`).digest();
  const payload = Buffer.from(JSON.stringify({ k: aud, t: Date.now(), ...claims })).toString(
    'base64url'
  );
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `mmakf_${aud}=${payload}.${sig}`;
}

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
};

function setEnv(name: keyof typeof saved, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A deployment where the operator forgot the two admin variables. */
function unconfiguredProduction(): void {
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_PASSWORD;
}

afterEach(() => {
  setEnv('NODE_ENV', saved.NODE_ENV);
  setEnv('ADMIN_SESSION_SECRET', saved.ADMIN_SESSION_SECRET);
  setEnv('ADMIN_PASSWORD', saved.ADMIN_PASSWORD);
});

describe('production without ADMIN_SESSION_SECRET (P0-2)', () => {
  it('does not accept an admin cookie forged from the published constant', () => {
    unconfiguredProduction();
    expect(isAuthenticated(forge('admin', {}))).toBe(false);
  });

  it('does not accept a user cookie forged from the published constant', () => {
    unconfiguredProduction();
    // {u:1, e:0} is the first account `npm run user:create` makes — a
    // SUPER_ADMIN — and session_epoch defaults to 0 (src/db/schema.ts).
    expect(getUserSession(forge('user', { u: 1, e: 0 }))).toBeNull();
  });

  it('does not accept a unit cookie forged from the published constant', () => {
    unconfiguredProduction();
    expect(
      getUnitSession(forge('unit', { n: 'Forged Unit', l: 'State', s: 'Jharkhand', d: null }))
    ).toBeNull();
  });

  it('refuses to mint any session rather than signing with a public key', () => {
    unconfiguredProduction();
    expect(() => createSessionCookie()).toThrow(/ADMIN_SESSION_SECRET/);
    expect(() =>
      createUnitSessionCookie({ name: 'U', level: 'Club', state: 'Jharkhand' })
    ).toThrow(/ADMIN_SESSION_SECRET/);
    expect(() => createUserSessionCookie({ userId: 1, epoch: 0 })).toThrow(/ADMIN_SESSION_SECRET/);
  });

  it('reports "no session" rather than crashing the request', () => {
    unconfiguredProduction();
    // Verification must fail closed and quietly: a 500 on every page would be
    // an outage, and an exception escaping into a middleware that treats
    // errors as "carry on" would be the escalation this test exists to stop.
    expect(() => isAuthenticated('mmakf_admin=anything.at-all')).not.toThrow();
    expect(isAuthenticated('mmakf_admin=anything.at-all')).toBe(false);
    expect(getUserSession(null)).toBeNull();
  });

  it('refuses a secret too short to be worth anything', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_SESSION_SECRET = 'short';
    delete process.env.ADMIN_PASSWORD;
    expect(() => createSessionCookie()).toThrow(/too short/);
    expect(isAuthenticated(forge('admin', {}, 'short'))).toBe(false);
  });
});

describe('production with the secret configured', () => {
  it('mints and verifies its own sessions normally', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_SESSION_SECRET = 'a-real-32-byte-looking-secret-value';
    delete process.env.ADMIN_PASSWORD;

    const admin = createSessionCookie().split(';')[0];
    expect(isAuthenticated(admin)).toBe(true);
    expect(createSessionCookie()).toContain('Secure');

    const user = createUserSessionCookie({ userId: 42, epoch: 3 }).split(';')[0];
    expect(getUserSession(user)).toEqual({ userId: 42, epoch: 3 });

    const unit = createUnitSessionCookie({ name: 'JH', level: 'State', state: 'Jharkhand' }).split(';')[0];
    expect(getUnitSession(unit)!.state).toBe('Jharkhand');
  });

  it('still rejects the cookie forged from the published constant', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_SESSION_SECRET = 'a-real-32-byte-looking-secret-value';
    expect(isAuthenticated(forge('admin', {}))).toBe(false);
    expect(getUserSession(forge('user', { u: 1, e: 0 }))).toBeNull();
  });

  it('accepts ADMIN_PASSWORD as the key when ADMIN_SESSION_SECRET is absent', () => {
    // MASTER-SPEC §16 defines the chain as ADMIN_SESSION_SECRET else
    // ADMIN_PASSWORD. Only the published literal is withdrawn here.
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_SESSION_SECRET;
    process.env.ADMIN_PASSWORD = 'a-long-enough-office-password';
    expect(isAuthenticated(createSessionCookie().split(';')[0])).toBe(true);
  });
});

describe('development', () => {
  it('still works with no environment at all, so local dev needs no setup', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.ADMIN_PASSWORD;
    const admin = createSessionCookie().split(';')[0];
    expect(isAuthenticated(admin)).toBe(true);
    expect(isAuthenticated(forge('admin', {}))).toBe(true);   // the dev fallback IS the constant
  });
});
