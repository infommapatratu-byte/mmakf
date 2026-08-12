// Regression tests for the second-pass audit findings.
//
// Each describe block corresponds to a defect that was found in shipped code.
// The test is what stops it coming back.

import { describe, it, expect } from 'vitest';
import { isSameOrigin, isJsonContentType } from '../src/lib/origin';
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
