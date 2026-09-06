// Signing out must actually sign the person out.
//
// /api/auth/login has two success paths that mint two different cookies —
// `mmakf_user` for a per-person account, `mmakf_admin` for the shared-password
// path. Logout cleared only the second one, and had done since May 2026, when
// it was the only one that existed. clearUserSessionCookie() sat in
// src/lib/auth.ts with zero call sites anywhere in the codebase.
//
// The reason this needs a test rather than a fix alone is that the broken
// version LOOKS like it works. identify() prefers the surviving `mmakf_user`
// cookie, so /admin renders the full console still signed in while the
// operations bar has already redirected to the public homepage. Nobody sees an
// error. On a shared office machine the next person is the previous person, for
// the seven days the cookie's Max-Age allows.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { POST } from '../src/pages/api/auth/logout';

/** The route takes no input; Astro's context is unused on this path. */
async function signOut(): Promise<Response> {
  return (await (POST as any)({ request: new Request('https://admin.mmakf.in/api/auth/logout', { method: 'POST' }) })) as Response;
}

function setCookies(res: Response): string[] {
  // getSetCookie() is the only accessor that returns BOTH values — headers.get()
  // folds them into one comma-joined string, which is exactly the shape that
  // hides a missing second cookie.
  return typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [];
}

describe('POST /api/auth/logout', () => {
  it('answers 200 with ok:true', async () => {
    const res = await signOut();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('sends TWO Set-Cookie headers, not one', async () => {
    const cookies = setCookies(await signOut());
    // The count is the assertion. An object literal cannot carry two Set-Cookie
    // properties, so a regression to `{ 'Set-Cookie': ... }` drops to one here.
    expect(cookies, `expected two Set-Cookie values, got: ${JSON.stringify(cookies)}`)
      .toHaveLength(2);
  });

  it('clears the per-person session — the cookie that used to survive', async () => {
    const cookies = setCookies(await signOut());
    const user = cookies.find((c) => c.startsWith('mmakf_user='));
    expect(user, 'mmakf_user must be cleared; this is the whole defect').toBeTruthy();
    expect(user).toMatch(/^mmakf_user=;/);
    expect(user).toMatch(/Max-Age=0/);
    expect(user).toMatch(/HttpOnly/);
    expect(user).toMatch(/Path=\//);
  });

  it('still clears the legacy shared session', async () => {
    const cookies = setCookies(await signOut());
    const admin = cookies.find((c) => c.startsWith('mmakf_admin='));
    expect(admin, 'the fix must not trade one cookie for the other').toBeTruthy();
    expect(admin).toMatch(/^mmakf_admin=;/);
    expect(admin).toMatch(/Max-Age=0/);
    expect(admin).toMatch(/HttpOnly/);
  });

  it('does NOT clear the unit portal session', async () => {
    // A separate surface with its own sign-in and its own /api/unit/logout.
    // Clearing it here would sign somebody out of a place they did not leave.
    const cookies = setCookies(await signOut());
    expect(cookies.some((c) => c.startsWith('mmakf_unit='))).toBe(false);
  });
});

describe('the cookie-clearing helpers all have callers', () => {
  // The defect was not a wrong line — it was a MISSING line, and the evidence
  // was an exported function nothing called. That is the shape to guard.
  const sources = [
    'src/pages/api/auth/logout.ts',
    'src/pages/api/unit/logout.ts',
  ].map((p) => readFileSync(p, 'utf8')).join('\n');

  it.each([
    ['clearUserSessionCookie', 'the per-person session'],
    ['clearSessionCookie', 'the legacy shared session'],
    ['clearUnitSessionCookie', 'the unit portal session'],
  ])('%s is called by a logout route (%s)', (fn) => {
    expect(sources, `${fn} is exported from src/lib/auth.ts but nothing calls it`)
      .toMatch(new RegExp(`${fn}\\(\\)`));
  });
});
