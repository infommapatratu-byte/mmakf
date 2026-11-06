// The whole sign-in journey an administrator goes through after a password reset,
// driven through the REAL routes, cookies included:
//
//   one-time password -> POST /api/auth/login -> session cookie -> identify()
//   -> POST /api/auth/change-password -> fresh cookie -> sign in with the new one.
//
// Written after the office could not sign in for weeks: a hidden required field
// blocked the form in the browser (tests/form-hidden-required.test.ts pins that),
// and nothing proved the server half end to end. This does.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';

process.env.DATABASE_URL = 'postgres://test-only/never-connected';
process.env.ADMIN_SESSION_SECRET = 'signin-journey-secret-0123456789abcdef';
delete process.env.ADMIN_PASSWORD;
delete process.env.ALLOW_SHARED_ADMIN_PASSWORD;

const { POST: LOGIN } = await import('../src/pages/api/auth/login');
const { POST: CHANGE } = await import('../src/pages/api/auth/change-password');
const { identify } = await import('../src/lib/session');
const { createUser, grantRole } = await import('../src/db/users');
const { legacyAdminPrincipal, canAnywhere } = await import('../src/lib/rbac');

const EMAIL = 'office.admin@example.com';
const ONE_TIME = 'Xq7_one-time-password-27chr';
const NEW_PW = 'a brand new office passphrase';

let ip = 0;
function req(url: string, body: unknown, cookie?: string): Request {
  ip += 1;
  return new Request(`https://www.mmakf.in${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://www.mmakf.in',
      'Sec-Fetch-Site': 'same-origin',
      'x-forwarded-for': `198.51.100.${ip}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
/** The cookie header a browser would send back, from a response's Set-Cookie. */
function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(/,(?=\s*[A-Za-z0-9_]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

beforeAll(async () => {
  const client = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const db = drizzle(client, { schema: s });
  __setTestClient(db);
  const u = await createUser(db, { email: EMAIL, password: ONE_TIME, mustChangePassword: true } as any);
  await grantRole(db, { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any,
    { userId: u.id, role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null });
}, 120_000);

describe('signing in after a password reset', () => {
  let cookie = '';

  it('a wrong password is refused with the ordinary message', async () => {
    const res = await (LOGIN as any)({ request: req('/api/auth/login', { email: EMAIL, password: 'wrong-password-123' }) });
    expect(res.status).toBe(401);
  });

  it('the one-time password signs in, sets a session cookie and asks for a new password', async () => {
    const res = await (LOGIN as any)({ request: req('/api/auth/login', { email: `  ${EMAIL.toUpperCase()} `, password: ONE_TIME }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mustChangePassword: true });
    cookie = cookieFrom(res);
    expect(cookie).toMatch(/=/);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // `Secure` is added when NODE_ENV is production (src/lib/auth.ts), which a
    // Vercel production build is; a test run is not, so it is checked as such.
    if (process.env.NODE_ENV === 'production') expect(setCookie).toMatch(/Secure/i);
  });

  it('the cookie is a real session: the next request is recognised as that administrator', async () => {
    const identity = await identify(cookie);
    expect(identity).toBeTruthy();
    expect(identity!.shared).toBe(false);
    expect(canAnywhere(identity!.principal, 'feeframework:publish')).toBe(true);
    expect(canAnywhere(identity!.principal, 'content:write')).toBe(true);
  });

  it('the password change completes and clears the must-change flag', async () => {
    const res = await (CHANGE as any)({ request: req('/api/auth/change-password', { currentPassword: ONE_TIME, newPassword: NEW_PW }, cookie) });
    expect(res.status).toBe(200);
    const fresh = cookieFrom(res);
    if (fresh) cookie = fresh;
    expect(await identify(cookie)).toBeTruthy();
    const db = (await import('../src/db')).db();
    const [row] = await db.select().from(s.users).where(eq(s.users.email, EMAIL));
    expect(row.mustChangePassword).toBe('no');
  });

  it('the old one-time password no longer works; the new one does', async () => {
    const old = await (LOGIN as any)({ request: req('/api/auth/login', { email: EMAIL, password: ONE_TIME }) });
    expect(old.status).toBe(401);
    const ok = await (LOGIN as any)({ request: req('/api/auth/login', { email: EMAIL, password: NEW_PW }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, mustChangePassword: false });
  });
});

describe('a deployment address sends people to the real site', () => {
  it('the middleware redirects page requests on *.vercel.app to www.mmakf.in, and leaves APIs alone', () => {
    const src = readFileSync('src/middleware.ts', 'utf8');
    expect(src).toMatch(/endsWith\('\.vercel\.app'\)/);
    expect(src).toMatch(/https:\/\/www\.mmakf\.in\$\{url\.pathname\}\$\{url\.search\}/);
    expect(src).toMatch(/!url\.pathname\.startsWith\('\/api\/'\)/);
  });
});
