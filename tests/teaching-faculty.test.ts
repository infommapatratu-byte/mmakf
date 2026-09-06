// The public teaching faculty — publicFaculty() and /teachers.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TEST THIS FILE EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// "a self-stated grade never becomes a verified one".
//
// `coach_profiles.dan_grade` is free text an applicant typed about themselves.
// `rank_records` is the federation's examination register. A page that read the
// first and printed it under the MMAKF masthead would be publishing credentials
// the federation never awarded — which is the whole thing /verify was built to
// stop.
//
// The two travel as two named fields and the surface renders them differently.
// Both halves are asserted below: the data separation, and that the page does
// not present them alike.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import { publicFaculty, facultyFacets } from '../src/db/coaches';

let db: any;
let ASSAM: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

let seq = 940000;
async function person(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name, status: 'active', ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

async function coach(personId: number, over: Record<string, unknown> = {}) {
  const [c] = await db.insert(o.coachProfiles).values({
    personId, status: 'active', ...over,
  }).returning({ id: o.coachProfiles.id });
  return c.id as number;
}

async function danGrade(personId: number, ordinal: number, over: Record<string, unknown> = {}) {
  await db.insert(s.rankRecords).values({
    personId, kind: 'dan',
    gradeLabel: ['', 'Shodan', 'Nidan', 'Sandan', 'Yondan', 'Godan'][ordinal] ?? `${ordinal} Dan`,
    gradeOrdinal: ordinal, awardedOn: '2018-05-01', status: 'active', ...over,
  });
}

beforeAll(async () => {
  const pg = new PGlite();
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });
  const [a] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-AS', state: 'Assam', name: 'Assam', status: 'active',
  }).returning({ id: s.stateUnits.id });
  ASSAM = a.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM coach_profiles');
  await db.execute?.('DELETE FROM rank_records');
  await db.execute?.('DELETE FROM persons');
});

describe('a stated grade never becomes a verified one', () => {
  it('keeps the register grade and the self-stated grade in separate fields', async () => {
    const p = await person('Verified Sensei');
    await danGrade(p, 4, { gradingEventId: 77 });
    // The applicant typed something DIFFERENT from what the register holds.
    await coach(p, { danGrade: 'Godan' });

    const [m] = await publicFaculty(db);
    expect(m.verifiedGrade).toBe('Yondan');
    expect(m.verifiedExamined).toBe(true);
    expect(m.statedGrade).toBe('Godan');
  });

  it('leaves verifiedGrade null when the register holds nothing — never filling it in', async () => {
    const p = await person('Unverified Sensei');
    await coach(p, { danGrade: 'Sandan' });

    const [m] = await publicFaculty(db);
    expect(m.verifiedGrade).toBeNull();
    expect(m.verifiedExamined).toBe(false);
    expect(m.statedGrade).toBe('Sandan');
  });

  it('marks a legacy register grade as verified but NOT examined', async () => {
    const p = await person('Legacy Sensei');
    await danGrade(p, 3); // no gradingEventId
    await coach(p, {});

    const [m] = await publicFaculty(db);
    expect(m.verifiedGrade).toBe('Sandan');
    expect(m.verifiedExamined).toBe(false);
  });

  it('the page renders the two differently and says the stated one is unverified', () => {
    const src = readFileSync('src/pages/teachers.astro', 'utf8');
    expect(src).toContain('MMAKF credential');
    expect(src).toContain('Not verified by MMAKF');
    // Two distinct classes, so they cannot render as the same chip.
    expect(src).toContain('tf-grade-ok');
    expect(src).toContain('tf-grade-claim');
  });
});

describe('who appears', () => {
  it('lists only an active, unsuspended profile of an active person', async () => {
    const ok = await person('Active Sensei');
    await coach(ok, {});

    const candidate = await person('Candidate');
    await coach(candidate, { status: 'candidate' });

    const suspendedStatus = await person('Suspended By Status');
    await coach(suspendedStatus, { status: 'suspended' });

    // The belt-and-braces case: status still says active, the timestamp is set.
    const suspendedStamp = await person('Suspended By Timestamp');
    await coach(suspendedStamp, { status: 'active', suspendedAt: new Date() });

    const inactivePerson = await person('Departed', { status: 'suspended' });
    await coach(inactivePerson, {});

    expect((await publicFaculty(db)).map((m) => m.fullName)).toEqual(['Active Sensei']);
  });

  it('accepts no parameter that could widen it past active', () => {
    const src = readFileSync('src/db/coaches.ts', 'utf8');
    const block = src.slice(src.indexOf('export async function publicFaculty'), src.indexOf('/** Facets derived'));
    expect(block).not.toContain('includeInactive');
    expect(block).not.toContain('principal');
    // The status test and the suspension test are both present.
    expect(block).toContain("eq(o.coachProfiles.status, 'active')");
    expect(block).toContain('isNull(o.coachProfiles.suspendedAt)');
  });
});

describe('what it refuses to publish', () => {
  it('returns no safeguarding date, no availability and no contact detail', async () => {
    const p = await person('Cleared Sensei', { email: 'private@example.invalid', phone: '+910000000000' });
    await coach(p, {
      safeguardingClearedOn: '2026-01-01',
      safeguardingExpiresOn: '2027-01-01',
      travelRadiusKm: 40,
      maxSessionsPerWeek: 12,
    });

    const [m] = await publicFaculty(db);
    const keys = Object.keys(m);
    for (const forbidden of ['safeguardingClearedOn', 'safeguardingExpiresOn',
      'travelRadiusKm', 'maxSessionsPerWeek', 'email', 'phone']) {
      expect(keys, `publicFaculty returns ${forbidden}`).not.toContain(forbidden);
    }
    const serialised = JSON.stringify(m);
    expect(serialised).not.toContain('private@example.invalid');
    expect(serialised).not.toContain('+910000000000');
    expect(serialised).not.toContain('2027-01-01');
  });

  it('the page explains the safeguarding silence rather than leaving a gap', () => {
    const src = readFileSync('src/pages/teachers.astro', 'utf8');
    expect(src).toContain('Working with children');
    expect(src).toContain('ask the federation directly');
  });
});

describe('filters and facets', () => {
  it('filters by language of instruction', async () => {
    const a = await person('Assamese Speaker');
    await coach(a, { languages: ['Assamese', 'Hindi'] });
    const b = await person('Tamil Speaker');
    await coach(b, { languages: ['Tamil'] });

    expect((await publicFaculty(db, { language: 'Tamil' })).map((m) => m.fullName))
      .toEqual(['Tamil Speaker']);
    // Case-insensitive, because the value comes from a select built from the data.
    expect((await publicFaculty(db, { language: 'hindi' })).map((m) => m.fullName))
      .toEqual(['Assamese Speaker']);
  });

  it('survives a languages value that is not an array', async () => {
    const p = await person('Malformed Profile');
    // jsonb accepts a bare string; the column does not enforce a shape.
    await coach(p, { languages: 'Hindi' as any });
    const [m] = await publicFaculty(db);
    expect(m.languages).toEqual([]);
  });

  it('offers only facets the faculty actually holds', async () => {
    const p = await person('Assamese Speaker', {});
    await coach(p, { languages: ['Assamese'], stateUnitId: ASSAM, ageBands: ['5-8'] });

    const f = await facultyFacets(db);
    expect(f.languages).toEqual(['Assamese']);
    expect(f.states).toEqual(['Assam']);
    expect(f.ageBands).toEqual(['5-8']);
    expect(f.total).toBe(1);
  });

  it('orders by verified grade, highest first', async () => {
    const low = await person('Shodan Sensei');
    await danGrade(low, 1);
    await coach(low, {});
    const high = await person('Godan Sensei');
    await danGrade(high, 5);
    await coach(high, {});

    expect((await publicFaculty(db)).map((m) => m.fullName))
      .toEqual(['Godan Sensei', 'Shodan Sensei']);
  });

  it('does not duplicate an instructor who has held several grades', async () => {
    const p = await person('Promoted Sensei');
    await danGrade(p, 2, { status: 'superseded' });
    await danGrade(p, 3);
    await coach(p, {});

    const list = await publicFaculty(db);
    expect(list).toHaveLength(1);
    expect(list[0].verifiedGrade).toBe('Sandan');
  });
});
