// Moving the published headquarters hours into the engine.
//
// THE VALUES THIS SUITE GUARDS ARE REAL. `federation.contact.hours` and
// `federation.contact.hoursSunday` are what www.mmakf.in publishes today, and a
// migration that mis-reads either of them puts a wrong opening time on the
// federation's own site under the appearance of having been checked. So the
// first describe block below feeds the parser the EXACT strings from
// src/data/seed.ts and asserts the rows they become, window by window.
//
// The second block is the four refusals. Each one is a way this migration could
// quietly do harm — publish one club's clock as every club's default, overwrite
// an administrator's configuration, invent a class length, or store a
// half-understood string — and each is a test rather than a paragraph.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as sch from '../src/db/scheduling.schema';
import { SEED } from '../src/data/seed';
import { parseHoursLine, planMigration, applyMigration, DIRECTIVE_SEASONS } from '../src/db/schedule-bootstrap';
import { createSchedule, openingHoursOn, isSchedulingError } from '../src/db/scheduling';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

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
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM schedule_rules');
  await db.execute?.('DELETE FROM schedule_versions');
  await db.execute?.('DELETE FROM schedules');
  await db.execute?.('DELETE FROM seasons');
});

const federationWith = (hours: string, hoursSunday: string) => ({ contact: { hours, hoursSunday } });

// ═══════════════════════════════════════════════════════════════════════════
// THE PARSER, AGAINST THE STRINGS THE SITE ACTUALLY PUBLISHES
// ═══════════════════════════════════════════════════════════════════════════

describe('reading what the federation published', () => {
  it('reads the weekday line from src/data/seed.ts exactly', () => {
    // Not a copy — the real value, so that editing the seed without editing
    // this migration is caught here rather than on the live site.
    const parsed = parseHoursLine(SEED.federation.contact.hours)!;
    expect(parsed.days).toEqual([1, 2, 3, 4, 5, 6]);           // Mon–Sat
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].season).toBeNull();
    expect(parsed.groups[0].windows).toEqual([
      { opensAt: '06:00', closesAt: '09:00' },
      { opensAt: '17:00', closesAt: '20:00' },
    ]);
  });

  it('reads the seasonal Sunday line, with each season kept apart', () => {
    const parsed = parseHoursLine(SEED.federation.contact.hoursSunday)!;
    expect(parsed.days).toEqual([7]);                          // Sunday only
    expect(parsed.groups.map((g) => g.season)).toEqual(['Summer', 'Winter']);
    expect(parsed.groups[0].windows).toEqual([
      { opensAt: '06:00', closesAt: '10:00' },
      { opensAt: '15:00', closesAt: '18:00' },
    ]);
    expect(parsed.groups[1].windows).toEqual([
      { opensAt: '08:00', closesAt: '11:30' },
      { opensAt: '16:00', closesAt: '18:30' },
    ]);
  });

  it('pads a single-digit hour rather than storing it short', () => {
    const parsed = parseHoursLine('Mon · 6:00–9:00 IST')!;
    expect(parsed.groups[0].windows).toEqual([{ opensAt: '06:00', closesAt: '09:00' }]);
  });

  it('reads a comma list and a single day', () => {
    expect(parseHoursLine('Mon, Wed, Fri · 18:00–21:00')!.days).toEqual([1, 3, 5]);
    expect(parseHoursLine('Sat · 07:00–11:00')!.days).toEqual([6]);
  });

  it('refuses a string it does not understand instead of guessing at it', () => {
    // Every one of these is a plausible thing an administrator might type, and
    // every one of them would produce a WRONG opening time if the parser tried.
    expect(() => parseHoursLine('Mon–Sat mornings and evenings')).toThrow(/expected "<days> · <times>"/);
    expect(() => parseHoursLine('Mon–Sat · mornings and evenings')).toThrow(/two HH:MM times/);
    expect(() => parseHoursLine('Funday · 06:00–09:00')).toThrow(/not a day/);
    expect(() => parseHoursLine('Sat–Mon · 06:00–09:00')).toThrow(/backwards/);
    expect(() => parseHoursLine('Mon · 20:00–06:00')).toThrow(/ends before it starts/);
    expect(() => parseHoursLine('06:00–09:00')).toThrow(/expected/i);
  });

  it('treats an empty value as nothing to migrate, not as an error', () => {
    expect(parseHoursLine('')).toBeNull();
    expect(parseHoursLine(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR REFUSALS
// ═══════════════════════════════════════════════════════════════════════════

describe('what the migration refuses to do', () => {
  it('will not store the headquarters hours at national scope', async () => {
    const plan = await planMigration(db, {
      federation: SEED.federation, dojoId: null,
    });
    expect(plan.blocked.join(' ')).toMatch(/need a club to belong to/);
    expect(plan.blocked.join(' ')).toMatch(/inherited by every unit/);
    await expect(applyMigration(db, ctx, { federation: SEED.federation, dojoId: null }))
      .rejects.toThrow(/need a club to belong to/);
  });

  it('will not overwrite a schedule somebody has already configured', async () => {
    await createSchedule(db, ctx, {
      name: 'Hombu — set by the club', purpose: 'operating', owner: { scope: 'dojo', id: HQ },
    });
    const plan = await planMigration(db, { federation: SEED.federation, dojoId: HQ });
    expect(plan.blocked.join(' ')).toMatch(/already has an operating schedule/);
    await expect(applyMigration(db, ctx, { federation: SEED.federation, dojoId: HQ }))
      .rejects.toThrow(/already has an operating schedule/);
  });

  it('will not guess how long a class runs', async () => {
    const plan = await planMigration(db, {
      federation: SEED.federation, timetable: SEED.schedule, dojoId: HQ,
    });
    // The editorial timetable records '6:00 AM' and no finish. Those rows are
    // reported, never migrated — a duration nobody set would read afterwards as
    // the federation's decision.
    expect(plan.classesNotMigrated.length).toBeGreaterThan(0);
    expect(plan.classesNotMigrated[0]).toHaveProperty('time');
    // And the ones that DO carry a range are not in the list.
    const withRanges = SEED.schedule.filter((r: any) => (String(r.t).match(/\d{1,2}:\d{2}/g) ?? []).length >= 2);
    expect(plan.classesNotMigrated).toHaveLength(SEED.schedule.length - withRanges.length);
  });

  it('will not migrate a string it could not read', async () => {
    const plan = await planMigration(db, {
      federation: federationWith('Mon–Sat mornings', ''), dojoId: HQ,
    });
    expect(plan.unreadable).toHaveLength(1);
    expect(plan.unreadable[0].field).toBe('federation.contact.hours');
    expect(plan.blocked.join(' ')).toMatch(/not in a shape this migration can read/);
  });

  it('will not migrate a season the run does not define', async () => {
    const plan = await planMigration(db, {
      federation: federationWith('Mon · 06:00–09:00', 'Sun · Monsoon 06:00–10:00'), dojoId: HQ,
    });
    expect(plan.blocked.join(' ')).toMatch(/names a season called "Monsoon"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE MIGRATION ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe('carrying the values across', () => {
  it('turns the two published strings into a week that renders the same hours', async () => {
    const result = await applyMigration(db, ctx, {
      federation: SEED.federation, timetable: SEED.schedule, dojoId: HQ,
    });
    // Mon–Sat × 2 windows = 12, plus Sunday × 2 seasons × 2 windows = 4.
    expect(result.rules).toBe(16);
    expect(result.seasonsCreated.sort()).toEqual(['summer', 'winter']);

    const target = { purpose: 'operating' as const, dojoId: HQ };

    // A Monday inside Summer.
    const monday = await openingHoursOn(db, target, '2026-09-14');
    expect(monday.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`))
      .toEqual(['06:00-09:00', '17:00-20:00']);

    // The Sunday that started this whole wave — both ways round.
    const summerSunday = await openingHoursOn(db, target, '2026-09-20');
    expect(summerSunday.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`))
      .toEqual(['06:00-10:00', '15:00-18:00']);
    expect(summerSunday.seasons.map((x: any) => x.name)).toContain('Summer');

    const winterSunday = await openingHoursOn(db, target, '2026-10-04');
    expect(winterSunday.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`))
      .toEqual(['08:00-11:30', '16:00-18:30']);
    expect(winterSunday.seasons.map((x: any) => x.name)).toContain('Winter');
  });

  it('does not make those hours anybody else\'s', async () => {
    await applyMigration(db, ctx, { federation: SEED.federation, dojoId: HQ });
    // THE ASSERTION THE WHOLE WAVE IS FOR. Another club, which has configured
    // nothing, must NOT inherit Patratu's clock — because the hours were stored
    // against the hombu dojo and not against the federation.
    const other = await openingHoursOn(db, { purpose: 'operating', dojoId: OTHER }, '2026-09-14');
    expect(other.unconfigured).toBe(true);
    expect(other.windows).toEqual([]);
  });

  it('publishes with a named publisher and a reason, because the database insists', async () => {
    const result = await applyMigration(db, ctx, { federation: SEED.federation, dojoId: HQ });
    const [version] = await db.select().from(sch.scheduleVersions)
      .where(eq(sch.scheduleVersions.id, result.versionId));
    expect(version.status).toBe('published');
    expect(version.publishedByUserId).toBe(nat.userId);
    expect(version.publishedAt).not.toBeNull();
    expect(version.reason).toMatch(/were not changed/);
  });

  it('reuses a season somebody has already defined rather than defining a second', async () => {
    const first = await applyMigration(db, ctx, { federation: SEED.federation, dojoId: HQ });
    expect(first.seasonsCreated).toHaveLength(2);

    // Retire the schedule so a second migration is permitted, and confirm the
    // seasons are reused — a second 'Summer' with different dates would make
    // every seasonal rule ambiguous.
    await db.update(sch.schedules).set({ status: 'retired' }).where(eq(sch.schedules.id, first.scheduleId));
    const second = await applyMigration(db, ctx, { federation: SEED.federation, dojoId: OTHER });
    expect(second.seasonsCreated).toHaveLength(0);
    expect(second.seasonsReused.sort()).toEqual(['summer', 'winter']);
  });

  it('starts the version early enough to answer a question about the past', async () => {
    const plan = await planMigration(db, { federation: SEED.federation, dojoId: HQ });
    // Not "today". A version that began today could not render a March
    // attendance record, and being able to is the reason versions are dated.
    expect(plan.effectiveFrom).toBe([...DIRECTIVE_SEASONS].map((x) => x.startsOn).sort()[0]);
  });
});
