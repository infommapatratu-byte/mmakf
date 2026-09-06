// The public Black Belt register — src/db/grading.ts and /black-belts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS MOST
// ─────────────────────────────────────────────────────────────────────────────
//
// "a revoked grade disappears from the register" is the test this file exists
// for. The federation's whole reason for deriving this page rather than typing
// it is that a hand-maintained list does not update itself when a grade is
// withdrawn — somebody has to remember, and eventually nobody does.
//
// `revokeRank()` sets `rank_records.status` away from 'active'; the register
// filters on it. So removal is a CONSEQUENCE of the revocation rather than a
// second act, and that is what is asserted below rather than described.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE ONE THAT IS EASIEST TO GET WRONG LATER
// ─────────────────────────────────────────────────────────────────────────────
//
// Provenance. An examined grade and a legacy record must never render alike:
// /verify was built specifically to stop that conflation, and a register that
// collapsed them would undo it one row at a time.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { blackBeltRegister, blackBeltFacets } from '../src/db/grading';

let db: any;
let ASSAM: number, KERALA: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

let seq = 920000;
async function person(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name, status: 'active', ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

async function dan(personId: number, ordinal: number, over: Record<string, unknown> = {}) {
  const LABELS = ['', 'Shodan', 'Nidan', 'Sandan', 'Yondan', 'Godan'];
  const [r] = await db.insert(s.rankRecords).values({
    personId, kind: 'dan',
    gradeLabel: LABELS[ordinal] ?? `${ordinal} Dan`,
    gradeOrdinal: ordinal,
    awardedOn: '2020-06-01',
    status: 'active',
    ...over,
  }).returning({ id: s.rankRecords.id });
  return r.id as number;
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
  const [k] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-KL', state: 'Kerala', name: 'Kerala', status: 'active',
  }).returning({ id: s.stateUnits.id });
  KERALA = k.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM rank_records');
  await db.execute?.('DELETE FROM persons');
});

describe('what appears', () => {
  it('lists an active Dan grade held by an active person', async () => {
    const p = await person('Pramod Pathak');
    await dan(p, 4);
    const reg = await blackBeltRegister(db);
    expect(reg).toHaveLength(1);
    expect(reg[0].fullName).toBe('Pramod Pathak');
    expect(reg[0].dan).toBe(4);
    expect(reg[0].gradeLabel).toBe('Yondan');
  });

  it('does NOT list a kyu grade — this is the Dan register', async () => {
    const p = await person('Beginner');
    await db.insert(s.rankRecords).values({
      personId: p, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9,
      awardedOn: '2025-01-01', status: 'active',
    });
    expect(await blackBeltRegister(db)).toEqual([]);
  });

  it('drops a REVOKED grade, with no second act required', async () => {
    const p = await person('Pramod Pathak');
    const rankId = await dan(p, 4);
    expect(await blackBeltRegister(db)).toHaveLength(1);

    // Exactly what revokeRank() does to the row.
    await db.update(s.rankRecords)
      .set({ status: 'revoked', revokedReason: 'misconduct' })
      .where(eq(s.rankRecords.id, rankId));

    expect(await blackBeltRegister(db)).toEqual([]);
  });

  it('drops a SUPERSEDED grade, so a promotion does not list somebody twice', async () => {
    const p = await person('Pramod Pathak');
    await dan(p, 3, { status: 'superseded' });
    await dan(p, 4);
    const reg = await blackBeltRegister(db);
    expect(reg).toHaveLength(1);
    expect(reg[0].dan).toBe(4);
  });

  it('drops the grade of a person whose own record is not active', async () => {
    const p = await person('Departed', { status: 'suspended' });
    await dan(p, 2);
    expect(await blackBeltRegister(db)).toEqual([]);
  });
});

describe('provenance is never collapsed', () => {
  it('separates an examined grade from a legacy record', async () => {
    const examined = await person('Examined Person');
    // A grading event id is what makes it traceable to an examination.
    await dan(examined, 2, { gradingEventId: 4242 });
    const legacy = await person('Legacy Person');
    await dan(legacy, 2);

    const reg = await blackBeltRegister(db);
    const byName = Object.fromEntries(reg.map((r) => [r.fullName, r.provenance]));
    expect(byName['Examined Person']).toBe('examined');
    expect(byName['Legacy Person']).toBe('unverified_legacy');
  });

  it('filters to examined records only', async () => {
    const e = await person('Examined Person');
    await dan(e, 2, { gradingEventId: 4242 });
    const l = await person('Legacy Person');
    await dan(l, 2);

    const reg = await blackBeltRegister(db, { provenance: 'examined' });
    expect(reg.map((r) => r.fullName)).toEqual(['Examined Person']);
  });

  it('the page renders the two with different wording', () => {
    const src = readFileSync('src/pages/black-belts.astro', 'utf8');
    expect(src).toContain('Examined');
    expect(src).toContain('Legacy record');
    // And it warns the reader that absence proves nothing, so a withdrawn grade
    // is not read as one that never existed.
    expect(src).toContain('Absence is not proof');
  });
});

describe('the register exposes nothing private', () => {
  it('returns no contact detail, date of birth or score', async () => {
    const p = await person('Pramod Pathak', {
      email: 'private@example.invalid', phone: '+910000000000', dob: '1980-01-01',
    });
    await dan(p, 4, { score: 88 });

    const [entry] = await blackBeltRegister(db);
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('private@example.invalid');
    expect(serialised).not.toContain('+910000000000');
    expect(serialised).not.toContain('1980-01-01');
    expect(serialised).not.toContain('88');
    expect(Object.keys(entry).sort()).toEqual([
      'awardedOn', 'city', 'dan', 'district', 'dojo', 'dojoSlug',
      'federationId', 'fullName', 'gradeLabel', 'provenance', 'state',
    ]);
  });
});

describe('filters', () => {
  it('filters by Dan, by state and by year', async () => {
    const a = await person('Assam Yondan', { stateUnitId: ASSAM });
    await dan(a, 4, { awardedOn: '2019-03-01' });
    const k = await person('Kerala Nidan', { stateUnitId: KERALA });
    await dan(k, 2, { awardedOn: '2021-07-01' });

    expect((await blackBeltRegister(db, { dan: 4 })).map((r) => r.fullName)).toEqual(['Assam Yondan']);
    expect((await blackBeltRegister(db, { stateUnitId: KERALA })).map((r) => r.fullName)).toEqual(['Kerala Nidan']);
    expect((await blackBeltRegister(db, { year: 2019 })).map((r) => r.fullName)).toEqual(['Assam Yondan']);
  });

  it('treats a name search as a literal, so % cannot widen it', async () => {
    await dan(await person('Pramod Pathak'), 4);
    await dan(await person('Anita Bose'), 2);

    expect((await blackBeltRegister(db, { q: 'Pathak' })).map((r) => r.fullName)).toEqual(['Pramod Pathak']);
    // A bare '%' would match everything if it reached ILIKE unescaped.
    expect(await blackBeltRegister(db, { q: '%' })).toEqual([]);
    expect(await blackBeltRegister(db, { q: '_' })).toEqual([]);
  });

  it('orders by grade, highest first', async () => {
    await dan(await person('Nidan Person'), 2);
    await dan(await person('Godan Person'), 5);
    await dan(await person('Shodan Person'), 1);
    expect((await blackBeltRegister(db)).map((r) => r.dan)).toEqual([5, 2, 1]);
  });
});

describe('the facets are derived, never enumerated', () => {
  it('offers only states and grades that actually hold somebody', async () => {
    const a = await person('Assam Yondan', { stateUnitId: ASSAM });
    await dan(a, 4, { awardedOn: '2019-03-01' });

    const f = await blackBeltFacets(db);
    expect(f.dans).toEqual([4]);
    expect(f.years).toEqual(['2019']);
    expect(f.states).toEqual([{ id: ASSAM, name: 'Assam' }]);
    // Kerala exists as a chartered unit and holds no Dan grade, so it is NOT
    // offered — a filter that returns nothing teaches the reader the register
    // holds distinctions it does not.
    expect(f.states.map((st) => st.name)).not.toContain('Kerala');
  });

  it('is empty when the register is empty, rather than listing every state', async () => {
    const f = await blackBeltFacets(db);
    expect(f).toEqual({ dans: [], years: [], states: [], total: 0 });
  });
});
