// Regression tests for the second-pass audit findings.
//
// Each describe block corresponds to a defect that was found in shipped code.
// The test is what stops it coming back.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSameOrigin, isTrustedHost, isJsonContentType } from '../src/lib/origin';
import { inScope, scopeList, scopeProblem, scopeLabel, type UnitScope } from '../src/lib/unit-scope';
import { PRIVATE_KEYS, PUBLIC_KEYS, KEYS } from '../src/data/seed';
import { recordId, reference, accessToken } from '../src/lib/refs';

// ─────────────────────────────────────────────────────────────────────────────

describe('CSRF: the site had no origin checking at all', () => {
  const H = (o: Record<string, string>) => new Headers(o);

  it('trusts Sec-Fetch-Site, which script cannot forge', () => {
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-origin' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(H({ 'sec-fetch-site': 'none' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(H({ 'sec-fetch-site': 'cross-site' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-site' }), 'www.mmakf.in')).toBe(false);
  });

  it('ATTACK: a sibling subdomain is NOT the same origin', () => {
    // The exact hole SameSite=Lax leaves open: Lax is site-scoped, so any
    // subdomain could previously drive authenticated writes.
    expect(isSameOrigin(H({ origin: 'https://evil.mmakf.in' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-site' }), 'www.mmakf.in')).toBe(false);
  });

  it('accepts a matching Origin regardless of scheme, since TLS ends at the edge', () => {
    expect(isSameOrigin(H({ origin: 'https://www.mmakf.in' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(H({ origin: 'http://www.mmakf.in' }), 'www.mmakf.in')).toBe(true);
  });

  it('ATTACK: a request with NO origin information is refused, not waved through', () => {
    // A forged cross-site form is exactly this shape.
    expect(isSameOrigin(H({}), 'www.mmakf.in')).toBe(false);
  });

  it('rejects lookalike and malformed origins', () => {
    expect(isSameOrigin(H({ origin: 'https://www.mmakf.in.evil.com' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(H({ origin: 'https://wwwXmmakf.in' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(H({ origin: 'not a url' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(H({ origin: '' }), 'www.mmakf.in')).toBe(false);
  });

  it('falls back to Referer only when Origin is absent', () => {
    expect(isSameOrigin(H({ referer: 'https://www.mmakf.in/admin' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(H({ referer: 'https://evil.example/x' }), 'www.mmakf.in')).toBe(false);
  });

  it('ATTACK: the content types a cross-site form can send are refused', () => {
    // These three are what a <form> can produce without a CORS preflight.
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType('')).toBe(false);

    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('unit portal scoping: every level used to see its whole state', () => {
  const stateAdmin: UnitScope = { name: 'Jharkhand Association', level: 'State', state: 'Jharkhand' };
  const districtAdmin: UnitScope = { name: 'Ramgarh District Association', level: 'District', state: 'Jharkhand', district: 'Ramgarh' };
  const club: UnitScope = { name: 'MMAKF Ranchi Training Centre', level: 'Club', state: 'Jharkhand' };

  const rows = [
    { name: 'A', state: 'Jharkhand', district: 'Ramgarh', unit: 'MMAKF Ranchi Training Centre' },
    { name: 'B', state: 'Jharkhand', district: 'Ramgarh', unit: 'Hombu Dojo' },
    { name: 'C', state: 'Jharkhand', district: 'Hazaribagh', unit: 'Hazaribagh Dojo' },
    { name: 'D', state: 'Bihar', district: 'Patna', unit: 'Patna Dojo' },
  ];

  it('a state code sees its whole state and nothing beyond it', () => {
    const seen = scopeList(stateAdmin, rows).map((r: any) => r.name);
    expect(seen).toEqual(['A', 'B', 'C']);
    expect(seen).not.toContain('D');
  });

  it('a district code sees only its district', () => {
    expect(scopeList(districtAdmin, rows).map((r: any) => r.name)).toEqual(['A', 'B']);
  });

  it('ATTACK: a club code no longer sees the whole state', () => {
    const seen = scopeList(club, rows).map((r: any) => r.name);
    expect(seen).toEqual(['A']);
    expect(seen).not.toContain('B');    // same district, different club
    expect(seen).not.toContain('C');
  });

  it('FAILS CLOSED: a district code with no district recorded sees NOTHING', () => {
    const misconfigured: UnitScope = { name: 'Some District', level: 'District', state: 'Jharkhand' };
    expect(scopeList(misconfigured, rows)).toEqual([]);
    expect(scopeProblem(misconfigured)).toMatch(/no district is recorded/i);
  });

  it('FAILS CLOSED: an unrecognised level is treated as the narrowest scope, never the widest', () => {
    const weird: UnitScope = { name: 'MMAKF Ranchi Training Centre', level: 'Regional', state: 'Jharkhand' };
    expect(scopeList(weird, rows).map((r: any) => r.name)).toEqual(['A']);

    const nameless: UnitScope = { name: '', level: 'Whatever', state: 'Jharkhand' };
    expect(scopeList(nameless, rows)).toEqual([]);
  });

  it('matches case-insensitively and tolerates whitespace', () => {
    expect(inScope(districtAdmin, { state: '  jharkhand ', district: 'RAMGARH' })).toBe(true);
    expect(inScope(districtAdmin, { state: 'Jharkhand', district: 'ramgarh ' })).toBe(true);
  });

  it('refuses records with no location rather than assuming they are in scope', () => {
    expect(inScope(stateAdmin, {})).toBe(false);
    expect(inScope(stateAdmin, { name: 'X' })).toBe(false);
    expect(inScope(stateAdmin, null)).toBe(false);
    expect(scopeList(stateAdmin, null as any)).toEqual([]);
  });

  it('labels what the unit is actually looking at', () => {
    expect(scopeLabel(stateAdmin)).toBe('Jharkhand');
    expect(scopeLabel(districtAdmin)).toBe('Ramgarh, Jharkhand');
    expect(scopeLabel(club)).toBe('MMAKF Ranchi Training Centre');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the member register is no longer a public download', () => {
  it('excludes members from the public payload', () => {
    expect(PRIVATE_KEYS).toContain('members');
    expect(PUBLIC_KEYS).not.toContain('members');
  });

  it('keeps every other content key public', () => {
    for (const key of KEYS) {
      if ((PRIVATE_KEYS as readonly string[]).includes(key)) continue;
      expect(PUBLIC_KEYS).toContain(key);
    }
    expect(PUBLIC_KEYS.length).toBe(KEYS.length - PRIVATE_KEYS.length);
  });

  it('still publishes the content the site actually renders', () => {
    for (const key of ['federation', 'events', 'news', 'products', 'stateUnits', 'circulars']) {
      expect(PUBLIC_KEYS).toContain(key as any);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('record identifiers no longer collide', () => {
  it('ATTACK: a batch submitted in the same millisecond gets distinct ids', () => {
    // Date.now() produced one value for the whole batch; a dojo entering
    // students in bulk silently overwrote its own records.
    const ids = Array.from({ length: 500 }, () => recordId());
    expect(new Set(ids).size).toBe(500);
  });

  it('ids are not derived from the clock, so they cannot be guessed from a timestamp', () => {
    const a = recordId(), b = recordId();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/^\d{13}$/);
    expect(Number.isFinite(Number(a))).toBe(false);
  });

  it('references and access tokens stay unguessable', () => {
    const refs = Array.from({ length: 200 }, () => reference('R'));
    expect(new Set(refs).size).toBe(200);
    expect(refs[0]).toMatch(/^MMAKF-R-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/);

    const tokens = Array.from({ length: 200 }, () => accessToken());
    expect(new Set(tokens).size).toBe(200);
    expect(tokens[0].length).toBeGreaterThanOrEqual(30);
  });
});

// ── The apex domain, and the day every form on it was refused ───────────────
describe('a POST that crossed the apex-to-www redirect', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('accepts same-site between two hosts the federation serves', () => {
    // THE LIVE BUG. Vercel 308-redirects mmakf.in to www.mmakf.in; a POST
    // replayed across that redirect arrives as `same-site`, not `same-origin`,
    // and every form on the apex was refused. A school lost a completed
    // application on submit.
    expect(isSameOrigin(
      h({ 'sec-fetch-site': 'same-site', origin: 'https://mmakf.in' }),
      'www.mmakf.in',
    )).toBe(true);
  });

  it('REFUSES same-site from a subdomain the federation does not serve', () => {
    // The reason the fix is an allowlist rather than accepting same-site.
    // Lax cookies are site-scoped, so a subdomain an attacker takes over is
    // same-site and would otherwise be able to drive authenticated writes.
    // `same-site` never says WHICH subdomain; the allowlist does.
    for (const evil of ['https://blog.mmakf.in', 'https://x.mmakf.in', 'https://staging.mmakf.in']) {
      expect(isSameOrigin(h({ 'sec-fetch-site': 'same-site', origin: evil }), 'www.mmakf.in')).toBe(false);
    }
  });

  it('refuses same-site with no Origin at all', () => {
    expect(isSameOrigin(h({ 'sec-fetch-site': 'same-site' }), 'www.mmakf.in')).toBe(false);
  });

  it('still refuses cross-site outright', () => {
    expect(isSameOrigin(
      h({ 'sec-fetch-site': 'cross-site', origin: 'https://mmakf.in' }),
      'www.mmakf.in',
    )).toBe(false);
  });

  it('still accepts plain same-origin and direct navigation', () => {
    expect(isSameOrigin(h({ 'sec-fetch-site': 'same-origin' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(h({ 'sec-fetch-site': 'none' }), 'www.mmakf.in')).toBe(true);
  });

  it('falls back to Origin for a browser that sends no Sec-Fetch-Site', () => {
    expect(isSameOrigin(h({ origin: 'https://mmakf.in' }), 'www.mmakf.in')).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://evil.example' }), 'www.mmakf.in')).toBe(false);
    expect(isSameOrigin(h({}), 'www.mmakf.in')).toBe(false);
  });

  it('every host the surface router serves is trusted', () => {
    // Otherwise learn.mmakf.in could serve a form that admin.mmakf.in refuses.
    for (const host of ['mmakf.in', 'www.mmakf.in', 'learn.mmakf.in', 'admin.mmakf.in']) {
      expect(isTrustedHost(host), `${host} is served and is not trusted`).toBe(true);
    }
    expect(isTrustedHost('mmakf.in.evil.example')).toBe(false);
    expect(isTrustedHost('notmmakf.in')).toBe(false);
  });
});

// ── The subdomains that resolved, returned 200, and served the wrong site ──
describe('the surface is decided from the host the visitor typed', () => {
  it('reads x-forwarded-host, because behind a proxy url.host is not it', () => {
    // THE LIVE BUG. learn.mmakf.in and admin.mmakf.in each resolved and
    // returned 200 — and served the PUBLIC HOMEPAGE. Behind Vercel's proxy
    // `url.host` is the internal invocation host, so surfaceForHost() saw a
    // name on no list and fell back to 'public'. The surface router had never
    // run in production, and nothing failed loudly enough to say so.
    const src = readFileSync('src/middleware.ts', 'utf8');
    expect(src, 'the surface is still decided from url.host alone')
      .toMatch(/x-forwarded-host/);
    // And the fallback stays, so a direct request with no proxy still works.
    expect(src).toMatch(/x-forwarded-host'\)\s*\|\|\s*url\.host/);
  });

  it('does NOT use the forwarded host for the CSRF comparison', () => {
    // The header is forgeable by anything speaking directly to the origin.
    // Deciding "is this same-origin?" from a value the caller supplies would
    // answer the question with the attacker's own input.
    const src = readFileSync('src/middleware.ts', 'utf8');
    // Matched on the CALL, not on the first mention of the name. This used to
    // find `.includes('isSameOrigin(')`, which also matches a comment — so
    // documenting the check above it broke the guard and reported the call as
    // wrong. A guard that fails when somebody explains the code is a guard
    // people delete.
    const csrfLine = src.split('\n').find((l) => l.includes('isSameOrigin(request.headers'));
    expect(csrfLine, 'no isSameOrigin call found — has the check been removed?').toBeTruthy();
    expect(csrfLine, 'the CSRF check is using the forgeable forwarded host')
      .not.toMatch(/publicHost/);
    expect(csrfLine).toMatch(/url\.host/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE APEX-DOMAIN REFUSAL, SECOND OCCURRENCE.
 *
 * Reported from production: submitting the individual training form at
 * mmakf.in/start/individual answered "Cross-site POST form submissions are
 * forbidden". It had been doing so for months.
 *
 * `eb1004e` had already fixed this once, correctly, by adding TRUSTED_HOSTS and
 * the `same-site` branch. The tests above prove that fix works. They prove it
 * by passing `'www.mmakf.in'` as the host — and the production caller,
 * src/middleware.ts, passes `url.host`, which behind Vercel's proxy is the
 * INTERNAL invocation host. The same file says so twenty lines above the call.
 *
 * So the branch asked whether an internal Vercel hostname is one of the
 * federation's public hosts, which it never is, and refused every POST that
 * crossed the apex-to-www redirect.
 *
 * Every test below passes a host of the shape the CALLER ACTUALLY SUPPLIES.
 * That is the whole point of this block: the previous suite tested the function
 * with an argument nothing in the application ever gives it.
 */
describe('CSRF: the caller passes an internal host, and that must not refuse real traffic', () => {
  const H = (o: Record<string, string>) => new Headers(o);

  // What `url.host` actually looks like inside a Vercel function.
  const INTERNAL = 'mmakf-a1b2c3d4.vercel.app';

  it('THE REPORTED BUG: an apex form POST survives the redirect to www', () => {
    // Chrome, submitting a form on https://mmakf.in that 308-redirects to
    // https://www.mmakf.in: the initiator is still the apex, and the two are
    // the same site but not the same origin.
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'https://mmakf.in' }),
      INTERNAL,
    )).toBe(true);
  });

  it('the ordinary same-origin POST is unaffected', () => {
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-origin' }), INTERNAL)).toBe(true);
  });

  it('a cross-surface POST between the federation’s own hosts is allowed', () => {
    for (const from of ['https://www.mmakf.in', 'https://learn.mmakf.in',
      'https://admin.mmakf.in', 'https://employee.mmakf.in']) {
      expect(isSameOrigin(H({ 'sec-fetch-site': 'same-site', origin: from }), INTERNAL), from)
        .toBe(true);
    }
  });

  it('ATTACK: a hijacked sibling subdomain is still refused, internal host or not', () => {
    // This is the hole the receiving-host check was believed to be closing, and
    // it is closed by the INITIATOR allowlist instead — which is what actually
    // closed it all along.
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'https://evil.mmakf.in' }),
      INTERNAL,
    )).toBe(false);
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'https://blog.mmakf.in' }),
      INTERNAL,
    )).toBe(false);
  });

  it('ATTACK: cross-site is refused before the same-site branch can be reached', () => {
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'cross-site', origin: 'https://www.mmakf.in' }),
      INTERNAL,
    )).toBe(false);
  });

  it('ATTACK: same-site with no initiator at all is refused', () => {
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-site' }), INTERNAL)).toBe(false);
  });

  it('ATTACK: a lookalike apex is refused', () => {
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'https://mmakf.in.evil.example' }),
      INTERNAL,
    )).toBe(false);
  });

  it('an opaque Origin falls through to Referer instead of abandoning the search', () => {
    // Some browsers send `Origin: null` once a request has crossed an origin
    // boundary through a redirect. The old initiator() returned null on the
    // first unparseable header, discarding a perfectly good Referer behind it.
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'null', referer: 'https://mmakf.in/start/individual' }),
      INTERNAL,
    )).toBe(true);
    // …and an opaque Origin with a hostile Referer is still refused.
    expect(isSameOrigin(
      H({ 'sec-fetch-site': 'same-site', origin: 'null', referer: 'https://evil.example/x' }),
      INTERNAL,
    )).toBe(false);
    // …and an opaque Origin with nothing behind it is refused.
    expect(isSameOrigin(H({ 'sec-fetch-site': 'same-site', origin: 'null' }), INTERNAL)).toBe(false);
  });

  it('the older-browser path works on an internal host too', () => {
    // No Sec-Fetch-Site at all. Before the fix this compared the browser's
    // Origin against the internal hostname and refused every request from every
    // host, not only the apex.
    expect(isSameOrigin(H({ origin: 'https://www.mmakf.in' }), INTERNAL)).toBe(true);
    expect(isSameOrigin(H({ origin: 'https://mmakf.in' }), INTERNAL)).toBe(true);
    expect(isSameOrigin(H({ origin: 'https://evil.example' }), INTERNAL)).toBe(false);
    expect(isSameOrigin(H({}), INTERNAL)).toBe(false);
  });

  it('every host the surface router serves is a host the CSRF check trusts', () => {
    // The two lists are maintained in different files and drifted once already:
    // a surface added without its entry here has every form on it refused, with
    // exactly the error this block exists for.
    for (const h of ['mmakf.in', 'www.mmakf.in', 'learn.mmakf.in',
      'admin.mmakf.in', 'employee.mmakf.in']) {
      expect(isTrustedHost(h), `${h} is not a trusted host`).toBe(true);
    }
  });
});
