// The register, answering "when does this club train?"
//
// /dojos publishes a club's standing and its charter validity. Neither answers
// the question a parent asks next, so the page resolves each club's own
// published timetable through `publishedWeek()` and falls back to the editorial
// string only where a club has published nothing.
//
// Two things have to be true for that to be safe, and both are load-bearing:
//
//   1. THE DIRECTORY MUST IDENTIFY THE UNIT. `publicDirectory()` returned a
//      name and a code and no id, so the page could name a club and had no key
//      to ask the engine about it. `id` was added for exactly this, and it is
//      asserted here because it is the one field on DirectoryEntry that exists
//      for a caller rather than for a reader — nothing on screen would break if
//      it silently disappeared, and the timings would just stop resolving.
//
//   2. A CLUB MUST NEVER INHERIT ANOTHER CLUB'S CLOCK. The Hombu trains at six
//      in the morning. A club in Bokaro that has published nothing must come
//      back `configured: false` — "ask them" — and never the headquarters'
//      hours wearing the club's name. That is the failure this whole engine
//      exists to prevent, so it is tested at the level the page actually calls.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { SEED } from '../src/data/seed';
import { applyMigration } from '../src/db/schedule-bootstrap';
import { publishedWeek, todayIso, addDays, mergedMinutes, isoDayOfWeek } from '../src/db/scheduling';
import { publicDirectory } from '../src/db/affiliation';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1,
  label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

// The two seasonal Sunday pairs, read from the string the site publishes rather
// than copied, so editing the seed without editing the engine fails here.
const SUMMER = [
  { opensAt: '06:00', closesAt: '10:00' },
  { opensAt: '15:00', closesAt: '18:00' },
];
const WINTER = [
  { opensAt: '08:00', closesAt: '11:30' },
  { opensAt: '16:00', closesAt: '18:30' },
];

let db: any;
let HQ: number;
let OTHER: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values({ id: 1, email: 'nat@example.test', status: 'active' });
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const rows = await db.insert(s.dojos).values([
    { code: 'MMAKF-DOJO-HQ', name: 'MMAKF Hombu Dojo', stateUnitId: jh.id, status: 'active' },
    { code: 'MMAKF-DOJO-B', name: 'MMAKF Bokaro Dojo', stateUnitId: jh.id, status: 'active' },
  ]).returning({ id: s.dojos.id });
  HQ = rows[0].id;
  OTHER = rows[1].id;

  // Only the headquarters is configured. Bokaro is left exactly as a club that
  // has never opened the schedule editor — which is the realistic case and the
  // one the page must not get wrong.
  await applyMigration(db, ctx, { federation: SEED.federation, dojoId: HQ });
});

describe('the directory identifies the unit it names', () => {
  it('carries the register row id on every entry', async () => {
    const entries = await publicDirectory(db, { kind: 'dojo', includeFormer: true });
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(typeof e.id).toBe('number');
      expect(Number.isInteger(e.id)).toBe(true);
    }
    expect(new Set(entries.map((e) => e.id))).toEqual(new Set([HQ, OTHER]));
  });

  it('still publishes no address, telephone number or email', async () => {
    const [entry] = await publicDirectory(db, { kind: 'dojo' });
    expect(Object.keys(entry).sort()).toEqual([
      'affiliated', 'affiliatedSince', 'charterCurrent', 'charterValidUntil',
      'city', 'code', 'district', 'id', 'kind', 'name', 'note', 'standing', 'state',
    ]);
  });
});

describe('what each club publishes, resolved the way /dojos resolves it', () => {
  it('gives the headquarters its own timetable', async () => {
    const today = todayIso();
    const week = await publishedWeek(db, { dojoId: HQ }, today, today);
    expect(week.configured).toBe(true);
    expect(week.isOwnSchedule).toBe(true);
    expect(week.days).toHaveLength(1);
  });

  it('refuses to lend that timetable to a club that has published nothing', async () => {
    const today = todayIso();
    const week = await publishedWeek(db, { dojoId: OTHER }, today, today);
    // NOT an empty week, and NOT the Hombu's. "They have not said" is the
    // answer, and the page renders it as a sentence telling the reader to ask.
    expect(week.configured).toBe(false);
    expect(week.days).toEqual([]);
    expect(week.purpose).toBeNull();
  });

  it('gives Sunday the seasonal hours in force on the day, not both at once', async () => {
    const from = todayIso();
    const week = await publishedWeek(db, { dojoId: HQ }, from, addDays(from, 6));
    expect(week.configured).toBe(true);

    const sunday = week.days.find((d) => isoDayOfWeek(d.date) === 7);
    expect(sunday, 'a seven-day run always contains one Sunday').toBeTruthy();
    expect(sunday!.open).toBe(true);

    const windows = mergedMinutes(sunday!.windows);
    const seasons = sunday!.seasons.map((x) => x.name);
    // Specificity, not union: one season governs the day, and its pair is the
    // whole answer. Two seasons' windows appearing together would be the bug
    // the engine's season handling exists to prevent.
    if (seasons.includes('Summer')) expect(windows).toEqual(SUMMER);
    else if (seasons.includes('Winter')) expect(windows).toEqual(WINTER);
    else throw new Error(`Sunday ${sunday!.date} fell in no season: ${JSON.stringify(seasons)}`);
    expect(windows).toHaveLength(2);
  });

  it('gives the weekdays the Mon–Sat line, morning and evening', async () => {
    const from = todayIso();
    const week = await publishedWeek(db, { dojoId: HQ }, from, addDays(from, 6));
    const weekday = week.days.find((d) => isoDayOfWeek(d.date) <= 6);
    expect(weekday!.open).toBe(true);
    expect(mergedMinutes(weekday!.windows)).toEqual([
      { opensAt: '06:00', closesAt: '09:00' },
      { opensAt: '17:00', closesAt: '20:00' },
    ]);
  });
});
