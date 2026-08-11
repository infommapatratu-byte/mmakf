// Regression tests for P0-1: session token type-confusion (privilege escalation).
// A unit-portal token must never authenticate as national admin, and vice versa.
import { describe, it, expect } from 'vitest';
import {
  createSessionCookie,
  createUnitSessionCookie,
  isAuthenticated,
  getUnitSession,
} from '../src/lib/auth';

const value = (setCookie: string) => setCookie.split(';')[0];          // name=token
const token = (setCookie: string) => value(setCookie).split('=')[1];   // token only

const adminCookie = () => value(createSessionCookie());
const unitCookie = () =>
  value(createUnitSessionCookie({ name: 'Test Unit', level: 'Club', state: 'Jharkhand' }));

describe('session audience separation (P0-1)', () => {
  it('a unit token replayed under the admin cookie name is REJECTED', () => {
    const stolen = token(unitCookie());
    expect(isAuthenticated(`mmakf_admin=${stolen}`)).toBe(false);
  });

  it('an admin token replayed under the unit cookie name is REJECTED', () => {
    const stolen = token(adminCookie());
    expect(getUnitSession(`mmakf_unit=${stolen}`)).toBeNull();
  });

  it('genuine admin session still authenticates', () => {
    expect(isAuthenticated(adminCookie())).toBe(true);
  });

  it('genuine unit session still resolves with its scope', () => {
    const s = getUnitSession(unitCookie());
    expect(s).not.toBeNull();
    expect(s!.state).toBe('Jharkhand');
    expect(s!.level).toBe('Club');
  });

  it('both cookies present: each verifier reads only its own', () => {
    const both = `${adminCookie()}; ${unitCookie()}`;
    expect(isAuthenticated(both)).toBe(true);
    expect(getUnitSession(both)!.name).toBe('Test Unit');
  });

  it('legacy tokens without an audience claim are rejected', () => {
    // Pre-fix admin payload shape: {t: <ms>} signed with the raw secret.
    const crypto = require('node:crypto');
    const payload = Buffer.from(JSON.stringify({ t: Date.now() })).toString('base64url');
    const legacySig = crypto
      .createHmac('sha256', 'dev-secret-change-me')
      .update(payload)
      .digest('base64url');
    expect(isAuthenticated(`mmakf_admin=${payload}.${legacySig}`)).toBe(false);
  });

  it('tampered payload fails signature check', () => {
    const [payload, sig] = token(adminCookie()).split('.');
    // Extend the session lifetime by rewriting the timestamp, keeping the old signature.
    const forged = Buffer.from(
      JSON.stringify({ k: 'admin', t: Date.now() + 86_400_000 })
    ).toString('base64url');
    expect(forged).not.toBe(payload);
    expect(isAuthenticated(`mmakf_admin=${forged}.${sig}`)).toBe(false);
  });

  it('expired session is rejected', () => {
    const crypto = require('node:crypto');
    const key = crypto
      .createHmac('sha256', 'dev-secret-change-me')
      .update('mmakf:session:admin:v2')
      .digest();
    const old = Buffer.from(
      JSON.stringify({ k: 'admin', t: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(old).digest('base64url');
    expect(isAuthenticated(`mmakf_admin=${old}.${sig}`)).toBe(false);
  });
});
