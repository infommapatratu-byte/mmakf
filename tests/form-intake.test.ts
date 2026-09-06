// Reading a submission that arrives as JSON because the edge refuses forms.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FAULT THIS COVERS
// ─────────────────────────────────────────────────────────────────────────────
//
// Reproduced against production on 6 September 2026: Vercel's edge answers
// 403 "Cross-site POST form submissions are forbidden" to every POST carrying
// an encoding an HTML form can produce. It refuses a POST to a STATIC FILE, so
// it is not this application refusing it, and `application/json` is the only
// body type that reaches the function.
//
// `readSubmission()` is what lets all thirty-one page handlers accept either.
// These tests pin the conversion, because a field silently dropped here is an
// application form that loses somebody's answers with no error anywhere.

import { describe, it, expect } from 'vitest';
import { readSubmission } from '../src/lib/form-intake';

const json = (body: unknown) =>
  new Request('https://www.mmakf.in/start/individual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const urlencoded = (body: string) =>
  new Request('https://www.mmakf.in/start/individual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

describe('an ordinary form submission still reads exactly as before', () => {
  it('parses urlencoded bodies untouched', async () => {
    const form = await readSubmission(urlencoded('act=create&title=Head+of+Media'));
    expect(form.get('act')).toBe('create');
    expect(form.get('title')).toBe('Head of Media');
  });

  it('keeps repeated fields repeated', async () => {
    const form = await readSubmission(urlencoded('tag=a&tag=b'));
    expect(form.getAll('tag')).toEqual(['a', 'b']);
  });
});

describe('a JSON submission reads as the same FormData', () => {
  it('converts strings, numbers and booleans to their string form', async () => {
    const form = await readSubmission(json({ act: 'create', openings: 3, paid: true }));
    // Every handler reads through String(form.get(k) ?? '') — so the values
    // must arrive as the strings a form would have sent.
    expect(form.get('act')).toBe('create');
    expect(form.get('openings')).toBe('3');
    expect(form.get('paid')).toBe('true');
  });

  it('expands an array into repeated fields, as a multi-select arrives', async () => {
    const form = await readSubmission(json({ tag: ['a', 'b', 'c'] }));
    expect(form.getAll('tag')).toEqual(['a', 'b', 'c']);
  });

  it('carries a checkbox through as "on", which is what the handlers test for', async () => {
    // e.g. `form.get('paid') === 'on'` in /admin/hr.
    const form = await readSubmission(json({ paid: 'on' }));
    expect(form.get('paid')).toBe('on');
  });

  it('SKIPS null and undefined rather than stringifying them', async () => {
    // The handlers read `String(form.get(k) ?? '')`. A field arriving as the
    // literal "null" would defeat the `?? ''` and be stored as a four-letter
    // string — which is how a database ends up with a reason of "null".
    const form = await readSubmission(json({ a: 'x', b: null }));
    expect(form.get('a')).toBe('x');
    expect(form.has('b')).toBe(false);
    expect(String(form.get('b') ?? '')).toBe('');
  });

  it('skips a nested object rather than writing "[object Object]"', async () => {
    const form = await readSubmission(json({ a: 'x', nested: { y: 1 } }));
    expect(form.has('nested')).toBe(false);
  });

  it('returns an empty FormData for a malformed body instead of throwing', async () => {
    const bad = new Request('https://www.mmakf.in/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const form = await readSubmission(bad);
    // The handlers validate what they read and answer with a sentence. A throw
    // here would become a 500, which tells the person less and the logs no more.
    expect([...form.keys()]).toEqual([]);
  });

  it('returns an empty FormData for a JSON array or scalar', async () => {
    expect([...(await readSubmission(json(['a', 'b']))).keys()]).toEqual([]);
    expect([...(await readSubmission(json('nope'))).keys()]).toEqual([]);
  });
});

describe('the two halves agree', () => {
  it('the same submission reads identically either way', async () => {
    const asForm = await readSubmission(urlencoded('act=move&status=shortlisted&note=Good+fit'));
    const asJson = await readSubmission(json({ act: 'move', status: 'shortlisted', note: 'Good fit' }));
    for (const key of ['act', 'status', 'note']) {
      expect(asJson.get(key), key).toBe(asForm.get(key));
    }
  });
});

describe('every page that handles a submission uses the tolerant reader', () => {
  it('no page still calls request.formData() directly', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = `${dir}/${f}`;
        return statSync(p).isDirectory() ? walk(p) : [p];
      });

    const offenders = walk('src/pages')
      .filter((p) => p.endsWith('.astro') || p.endsWith('.ts'))
      .filter((p) => /(?<!readSubmission\()\brequest\.formData\(\)/.test(readFileSync(p, 'utf8')));

    // A page missed here is a form that works locally and is refused in
    // production, which is the exact shape of the bug this file documents.
    expect(offenders, `these still read formData() directly: ${offenders.join(', ')}`)
      .toEqual([]);
  });
});

describe('the client half is wired into every page', () => {
  it('Base.astro imports the form upgrade, so no page has to remember it', async () => {
    const { readFileSync } = await import('node:fs');
    const base = readFileSync('src/layouts/Base.astro', 'utf8');
    // Loaded from the layout rather than per page: a form added anywhere is
    // covered without anybody remembering, and the one page that forgot would
    // be a form that silently cannot be submitted in production.
    expect(base).toContain("import '@/scripts/form-upgrade'");
  });

  it('the upgrade refuses to touch what it must not', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/scripts/form-upgrade.ts', 'utf8');
    // GET forms are not blocked by the edge and are how every filter on this
    // site works; upgrading one would turn a shareable filtered URL into a POST.
    expect(src).toContain("(form.method || 'get').toLowerCase() !== 'post'");
    // JSON cannot carry a file.
    expect(src).toContain('isFileForm');
    // A cross-origin action is the browser's business, not ours.
    expect(src).toContain('targetsThisOrigin');
    // And a failure must reach the visitor rather than becoming a dead button.
    expect(src).toContain('fallBack');
  });
});
