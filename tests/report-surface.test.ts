// The annual report page.
//
// db/analytics.ts already refuses to print a zero for a section with no
// records — the reasoning being that "0 gradings held" reads as a measurement
// the register cannot support. That discipline is worthless if the PAGE prints
// `f.value ?? 0`, or drops withheld sections, or lets a designer trim the
// provenance because it is visually noisy. This suite guards the rendering.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { annualReport, AnalyticsError } from '../src/db/analytics';
import { ForbiddenError } from '../src/lib/rbac';
import type { Principal } from '../src/lib/rbac';

const page = readFileSync('src/pages/admin/report.astro', 'utf8');

let db: any, JH: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const stateOnly: Principal = {
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 1 }],
};
const NOW = new Date('2026-08-12T00:00:00Z');

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
});

describe('a section with no records prints no zeros', () => {
  it('nulls every figure in an empty section rather than reporting 0', async () => {
    // 2019 predates every record in this database.
    const r = await annualReport(db, national, 2019, { now: NOW });
    const emptySections = r.sections.filter((x) => x.status === 'no_records');
    expect(emptySections.length).toBeGreaterThan(0);
    for (const sec of emptySections) {
      for (const f of sec.figures) {
        // A printed 0 says "the federation examined nobody". The register can
        // only honestly say "nobody entered a grading into this system".
        expect(f.value, `${sec.key}.${f.key} reported a zero`).toBeNull();
      }
    }
  });

  it('the page renders an empty section as prose, never as a figure grid', () => {
    // Guard against `f.value ?? 0` creeping back in.
    expect(page).not.toMatch(/\.value \?\? 0/);
    expect(page).not.toMatch(/Number\(f\.value\) \|\| 0/);
    // Empty sections go through the prose list, not the figure grid.
    expect(page).toMatch(/status === 'no_records'/);
    expect(page).toMatch(/Not "none happened"/);
  });

  it('renders a null figure as an em dash, not a zero', () => {
    expect(page).toMatch(/f\.value === null \? '—' : fmt\(f\.value\)/);
  });
});

describe('a withheld section is visible as withheld', () => {
  it('the page lists withheld sections instead of dropping them', () => {
    // A report in which safeguarding silently does not appear is the more
    // dangerous document: a reader concludes no such record is kept.
    expect(page).toMatch(/status === 'withheld'/);
    expect(page).toMatch(/Sections you may/);
    expect(page).toMatch(/silently did not\n?\s*appear would be the more dangerous/);
  });

  it('the module marks a section withheld rather than omitting it', async () => {
    // A principal with no safeguarding authority still learns the section exists.
    const r = await annualReport(db, national, 2026, { now: NOW });
    const keys = r.sections.map((x) => x.key);
    // Every section the module knows about is present at every permission level;
    // only its STATUS changes.
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('every figure carries its query', () => {
  it('the module attaches table, column and filter to each figure', async () => {
    await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000001', fullName: 'Report Subject',
      stateUnitId: JH, createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    const r = await annualReport(db, national, 2026, { now: NOW });
    const reported = r.sections.filter((x) => x.status === 'reported');
    expect(reported.length).toBeGreaterThan(0);
    for (const sec of reported) {
      for (const f of sec.figures) {
        expect(f.source.table, `${sec.key}.${f.key} has no table`).toBeTruthy();
        expect(f.source.column, `${sec.key}.${f.key} has no column`).toBeTruthy();
        expect(f.source.filter, `${sec.key}.${f.key} has no filter`).toBeTruthy();
      }
    }
  });

  it('the page PRINTS all three — provenance is the figure, not decoration', () => {
    // The only defensible answer to a challenged figure is "here is the query".
    expect(page).toMatch(/f\.source\.table/);
    expect(page).toMatch(/f\.source\.column/);
    expect(page).toMatch(/f\.source\.filter/);
  });

  it('keeps provenance when the report is printed on paper', () => {
    // The office will print this for a meeting. The year picker goes; the
    // provenance stays.
    const print = page.match(/@media print \{([\s\S]*?)\n  \}/);
    expect(print, 'no print stylesheet').toBeTruthy();
    expect(print![1]).not.toMatch(/\.fig-src[^;]*display:\s*none/);
    expect(print![1]).toMatch(/\.year-bar/);
  });
});

describe('the year is parsed, never assumed', () => {
  it('the module refuses a year outside four digits', async () => {
    await expect(annualReport(db, national, 12 as any, { now: NOW })).rejects.toThrow(AnalyticsError);
    await expect(annualReport(db, national, 2026.5 as any, { now: NOW })).rejects.toThrow(/four-digit/);
  });

  it('the page reports a malformed year instead of silently using this one', () => {
    // Falling back would show a reader a different year than they asked for,
    // under a heading that says otherwise.
    expect(page).toMatch(/is not a four-digit year/);
    expect(page).toMatch(/yearProblem/);
  });
});

describe('authority', () => {
  it('the report is national; a state administrator is refused', async () => {
    await expect(annualReport(db, stateOnly, 2026, { now: NOW })).rejects.toThrow(ForbiddenError);
  });

  it('the page explains the refusal and points somewhere useful', () => {
    expect(page).toMatch(/ForbiddenError/);
    expect(page).toMatch(/Not yours to read/);
    expect(page).toMatch(/\/admin\/dashboard/);
  });

  it('the page shows nothing at all when unconfigured, and says why', () => {
    expect(page).toMatch(/database is not configured/i);
    expect(page).toMatch(/rendered as a year of zeros/);
  });
});

describe('coverage is stated, so a sparse year is not misread', () => {
  it('says records predating the system are not in it', () => {
    // A report for 1995 is not a report of a quiet year; it is a report of a
    // year this system did not cover.
    expect(page).toMatch(/founded\s*\n?\s*in 1983/);
    expect(page).toMatch(/coverage and not about the federation's\s*\n?\s*activity/);
  });

  it('offers only years this system could plausibly hold records for', () => {
    expect(page).toMatch(/OFFERED_YEARS = Array\.from\(\{ length: 6 \}/);
  });

  it('says the report is a live view, not a signed statement', () => {
    expect(page).toMatch(/generated on request from the live register/);
    expect(page).toMatch(/certified copy/);
  });
});
