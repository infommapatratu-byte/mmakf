// vercel.json, and the two mistakes in it that cost this project a day.
//
// vercel.json is JSON, so it cannot carry a comment explaining why it says what
// it says. That is exactly why these belong in a test: this file is where the
// reasoning lives, and it fails the moment somebody undoes either decision.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync('vercel.json', 'utf8');
const cfg = JSON.parse(raw);

describe('the cron schedule the Hobby plan will actually accept', () => {
  it('runs AT MOST once a day', () => {
    // THE SEVENTEEN-HOUR BUG. This was '0 * * * *' — hourly. On a Hobby account
    // Vercel refuses that outright:
    //
    //   cron_jobs_limits_reached — Hobby accounts are limited to daily cron
    //   jobs. This cron expression (0 * * * *) would run more than once per day.
    //
    // And it refuses it WHEN THE DEPLOYMENT IS CREATED, before any build starts.
    // So no deployment existed, nothing appeared in the Deployments tab, and the
    // Git integration went on reporting itself connected and healthy.
    //
    // Every symptom pointed elsewhere: pushes reached GitHub, the repository was
    // connected, the production branch was correctly `main`, there was no ignored
    // build step, and the build was clean locally. Production simply kept serving
    // a build from the previous morning. A rejection that leaves no artefact is
    // indistinguishable from a webhook that never fired.
    for (const cron of cfg.crons ?? []) {
      const [minute, hour] = String(cron.schedule).split(/\s+/);
      expect(minute, `${cron.path}: a wildcard minute runs 60× a day`).not.toBe('*');
      expect(hour, `${cron.path}: a wildcard hour runs 24× a day`).not.toBe('*');
      expect(String(cron.schedule), `${cron.path}: step syntax runs more than daily`).not.toMatch(/\//);
    }
  });

  it('carries NO field Vercel does not recognise', () => {
    // The second mistake, made while fixing the first: an explanatory `_comment`
    // was added beside the schedule. Vercel validates vercel.json strictly and
    // failed the build with "crons[0] should NOT have additional property
    // _comment". JSON cannot hold the reasoning — which is why it is here.
    const ALLOWED = new Set(['path', 'schedule']);
    for (const cron of cfg.crons ?? []) {
      for (const key of Object.keys(cron)) {
        expect(ALLOWED.has(key), `crons entry has unrecognised property "${key}"`).toBe(true);
      }
    }
  });

  it('every cron points at a route that exists', () => {
    // A schedule aimed at a deleted endpoint fails silently once a day for ever.
    for (const cron of cfg.crons ?? []) {
      const p = String(cron.path).replace(/^\//, '');
      const candidates = [`src/pages/${p}.ts`, `src/pages/${p}.astro`, `src/pages/${p}/index.ts`];
      const found = candidates.some((f) => {
        try { readFileSync(f); return true; } catch { return false; }
      });
      expect(found, `${cron.path} has no route in src/pages`).toBe(true);
    }
  });
});

describe('the security headers stay', () => {
  it('still sends a Content-Security-Policy and HSTS', () => {
    const headers = (cfg.headers ?? []).flatMap((h: any) => h.headers ?? []);
    const names = headers.map((h: any) => h.key);
    expect(names).toContain('Content-Security-Policy');
    expect(names).toContain('Strict-Transport-Security');
    expect(names).toContain('X-Content-Type-Options');
  });

  it('keeps /api out of search results', () => {
    // An endpoint indexed by a crawler is an endpoint probed by everyone.
    const api = (cfg.headers ?? []).find((h: any) => String(h.source).startsWith('/api'));
    expect(api, 'no header rule for /api').toBeTruthy();
    expect(api.headers.map((h: any) => h.key)).toContain('X-Robots-Tag');
  });
});
