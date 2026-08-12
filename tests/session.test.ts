// identify() — the single place a request becomes an identity.
//
// Every page and endpoint asks this one function who the caller is. A defect
// here is a defect everywhere, so the precedence between the three credential
// types, and the failure paths, are pinned explicitly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let dbConfigured = true;
let resolved: any = null;
let resolveCalls: Array<{ userId: number; epoch: number }> = [];

vi.mock('../src/db', () => ({
  isConfigured: () => dbConfigured,
  db: () => ({}),
}));

vi.mock('../src/db/users', () => ({
  resolvePrincipal: async (_db: any, userId: number, epoch: number) => {
    resolveCalls.push({ userId, epoch });
    return resolved;
  },
}));

const { identify, clientIp } = await import('../src/lib/session');
const { createUserSessionCookie, createSessionCookie, createUnitSessionCookie } =
  await import('../src/lib/auth');

/** Strip a Set-Cookie header down to the `name=value` a request would send. */
function asRequestCookie(setCookie: string): string {
  return setCookie.split(';')[0];
}

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = 'test-secret-for-session-suite';
  dbConfigured = true;
  resolved = null;
  resolveCalls = [];
});

describe('no credential', () => {
  it('returns null for an absent, empty or junk cookie header', async () => {
    expect(await identify(null)).toBeNull();
    expect(await identify(undefined)).toBeNull();
    expect(await identify('')).toBeNull();
    expect(await identify('not=a-real-session')).toBeNull();
    expect(await identify('mmakf_user=garbage.signature')).toBeNull();
  });
});

describe('a personal account', () => {
  const userCookie = () => asRequestCookie(createUserSessionCookie({ userId: 42, epoch: 3 }));

  it('resolves to the principal the database returns, and is not shared', async () => {
    resolved = {
      userId: 42, label: 'secretary@mmakf.in',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 7 }],
    };
    const identity = await identify(userCookie());
    expect(identity!.via).toBe('user');
    expect(identity!.shared).toBe(false);
    expect(identity!.userId).toBe(42);
    expect(identity!.principal.label).toBe('secretary@mmakf.in');
  });

  it('passes the cookie epoch through, so a bumped epoch invalidates the session', async () => {
    resolved = { userId: 42, label: 'x', bindings: [] };
    await identify(userCookie());
    expect(resolveCalls).toEqual([{ userId: 42, epoch: 3 }]);
  });

  it('ATTACK: a revoked account does NOT fall back to a shared credential', async () => {
    // The dangerous shape: a user cookie that no longer resolves, presented
    // alongside a valid shared-password cookie. Falling through would silently
    // restore access to someone whose account was disabled.
    resolved = null;
    const both = `${userCookie()}; ${asRequestCookie(createSessionCookie())}`;
    expect(await identify(both)).toBeNull();
  });

  it('refuses to trust a user cookie when the database cannot verify it', async () => {
    dbConfigured = false;
    resolved = { userId: 42, label: 'x', bindings: [] };
    expect(await identify(userCookie())).toBeNull();
    expect(resolveCalls).toEqual([]);   // never even attempted
  });

  it('takes precedence over a shared credential presented at the same time', async () => {
    resolved = { userId: 42, label: 'secretary@mmakf.in', bindings: [] };
    const both = `${asRequestCookie(createSessionCookie())}; ${userCookie()}`;
    const identity = await identify(both);
    expect(identity!.via).toBe('user');
    expect(identity!.shared).toBe(false);
  });
});

describe('the legacy shared office password', () => {
  it('resolves to a national admin, clearly marked as shared', async () => {
    const identity = await identify(asRequestCookie(createSessionCookie()));
    expect(identity!.via).toBe('shared-admin-password');
    // The audit trail must never imply an individual took the action.
    expect(identity!.shared).toBe(true);
    expect(identity!.userId).toBeNull();
    expect(identity!.principal.label).toBe('legacy-admin');
    expect(identity!.principal.bindings[0].role).toBe('FEDERATION_ADMIN');
  });
});

describe('the legacy shared unit code', () => {
  it('resolves to a scoped principal, marked as shared', async () => {
    const cookie = asRequestCookie(
      createUnitSessionCookie({ name: 'Jharkhand Unit', level: 'State', state: 'Jharkhand' })
    );
    const identity = await identify(cookie);
    expect(identity!.via).toBe('shared-unit-code');
    expect(identity!.shared).toBe(true);
    expect(identity!.principal.label).toBe('Jharkhand Unit');
    expect(identity!.principal.bindings[0].role).toBe('STATE_ADMIN');
  });

  it('maps a club code to the narrower role, not to a state administrator', async () => {
    const cookie = asRequestCookie(
      createUnitSessionCookie({ name: 'Ranchi Centre', level: 'Club', state: 'Jharkhand' })
    );
    const identity = await identify(cookie);
    expect(identity!.principal.bindings[0].role).toBe('DOJO_ADMIN');
  });

  it('ranks below the admin password, which ranks below a personal account', async () => {
    const unit = asRequestCookie(createUnitSessionCookie({ name: 'U', level: 'Club', state: 'Jharkhand' }));
    const admin = asRequestCookie(createSessionCookie());
    const identity = await identify(`${unit}; ${admin}`);
    expect(identity!.via).toBe('shared-admin-password');
  });
});

describe('client IP', () => {
  const req = (headers: Record<string, string>) => new Request('https://www.mmakf.in/', { headers });

  it('takes the first hop from x-forwarded-for', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18' }))).toBe('203.0.113.9');
  });

  it('falls back through the other proxy headers', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.5' }))).toBe('198.51.100.5');
  });

  it('returns null when there is nothing to report, rather than inventing one', () => {
    expect(clientIp(req({}))).toBeNull();
  });
});
