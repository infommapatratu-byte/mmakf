// Officials licensing and the Athlete Passport, against real Postgres.
//
// The invariant under test: AN EXPIRED LICENCE MUST NEVER SILENTLY PRODUCE A
// VALID OFFICIAL ACT, and validity is always asked AS AT A DATE — never "now".

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  licenceValidity, assertLicensed, grantLicence, withdrawLicence,
  licenceStanding, expiringLicences, appointOfficial, publicOfficialsDirectory,
} from '../src/db/officials';
import {
  publicAthleteProfile, athletePassport, searchAthletes, careerStatistics,
} from '../src/db/athletes';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number, DOJO: number;
let REFEREE: any, LAPSED: any, ATHLETE: any;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const brAdmin = (): Principal => ({
  userId: 2, label: 'bihar-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});
const publicUser: Principal = { userId: null, label: 'public', bindings: [] };

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'ST-BR', state: 'Bihar', name: 'BR', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;

  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;

  REFEREE = await createPerson(db, { principal: national }, { fullName: 'Ref Kumar', stateUnitId: JH, dojoId: DOJO });
  LAPSED = await createPerson(db, { principal: national }, { fullName: 'Lapsed Ref', stateUnitId: JH, dojoId: DOJO });
  ATHLETE = await createPerson(db, { principal: national }, {
    fullName: 'Test Athlete', stateUnitId: JH, dojoId: DOJO,
    email: 'athlete@example.in', phone: '9876543210', dob: '2008-04-15', gender: 'Male',
  });
  for (const p of [REFEREE, LAPSED, ATHLETE]) {
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
  }
});

describe('licence validity is always asked AS AT A DATE', () => {
  beforeAll(async () => {
    await grantLicence(db, { principal: national }, {
      personId: REFEREE.id, registry: 'official', kind: 'referee', level: 'National',
      grantedOn: '2024-01-01', expiresOn: '2027-01-01',
    });
    await grantLicence(db, { principal: national }, {
      personId: LAPSED.id, registry: 'official', kind: 'referee', level: 'National',
      grantedOn: '2020-01-01', expiresOn: '2025-06-30',
    });
  });

  it('is valid inside its window', async () => {
    const v = await licenceValidity(db, REFEREE.id, 'official', '2026-08-12');
    expect(v.valid).toBe(true);
    expect(v.expiresOn).toBe('2027-01-01');
    expect(v.daysRemaining).toBeGreaterThan(0);
  });

  it('ATTACK: the SAME licence is invalid after its expiry date', async () => {
    const v = await licenceValidity(db, REFEREE.id, 'official', '2027-06-01');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/expired on 2027-01-01/);
  });

  it('is invalid BEFORE it takes effect', async () => {
    const v = await licenceValidity(db, REFEREE.id, 'official', '2023-06-01');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/does not take effect until 2024-01-01/);
  });

  it('reports a lapsed licence with the date, not just "invalid"', async () => {
    const v = await licenceValidity(db, LAPSED.id, 'official', '2026-08-12');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/expired on 2025-06-30/);
  });

  it('says plainly when a person holds no licence in that registry at all', async () => {
    const v = await licenceValidity(db, ATHLETE.id, 'examiner', '2026-08-12');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/holds no examiner qualification/i);
  });

  it('assertLicensed throws with the reason attached', async () => {
    await expect(assertLicensed(db, LAPSED.id, 'official', '2026-08-12'))
      .rejects.toThrow(/expired on 2025-06-30/);
  });
});

describe('granting and withdrawal', () => {
  it('refuses an expiry on or before the grant date', async () => {
    await expect(grantLicence(db, { principal: national }, {
      personId: ATHLETE.id, registry: 'instructor', level: 'Assistant',
      grantedOn: '2026-01-01', expiresOn: '2025-12-31',
    })).rejects.toThrow(/cannot expire on or before/i);
  });

  it('requires a scope for an examiner licence and a kind for an officiating one', async () => {
    await expect(grantLicence(db, { principal: national }, {
      personId: ATHLETE.id, registry: 'examiner', level: 'A', grantedOn: '2026-01-01',
    })).rejects.toThrow(/which grades it covers/i);

    await expect(grantLicence(db, { principal: national }, {
      personId: ATHLETE.id, registry: 'official', level: 'A', grantedOn: '2026-01-01',
    })).rejects.toThrow(/must state its kind/i);
  });

  it('applies NO default expiry, and surfaces the licence as open-ended', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'Open Ended', stateUnitId: JH });
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    await grantLicence(db, { principal: national }, {
      personId: p.id, registry: 'instructor', level: 'Chief', grantedOn: '2020-01-01',
    });

    const standing = await licenceStanding(db, p.id, '2026-08-12');
    const licence = standing!.registries.find((r) => r.registry === 'instructor')!;
    // A licence duration is federation policy — inventing one would either
    // expire someone meant to be licensed indefinitely, or leave open one meant
    // to lapse.
    expect(licence.expiresOn).toBeNull();
    expect(licence.openEnded).toBe(true);
    expect(licence.daysRemaining).toBeNull();
  });

  it('withdrawal requires a reason and NEVER deletes', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'To Withdraw', stateUnitId: JH });
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const q = await grantLicence(db, { principal: national }, {
      personId: p.id, registry: 'official', kind: 'judge', level: 'State',
      grantedOn: '2024-01-01', expiresOn: '2028-01-01',
    });

    await expect(withdrawLicence(db, { principal: national }, {
      registry: 'official', qualificationId: q.id, status: 'revoked', reason: '  ',
    })).rejects.toThrow(/reason/i);

    await withdrawLicence(db, { principal: national }, {
      registry: 'official', qualificationId: q.id, status: 'revoked', reason: 'Disciplinary outcome',
    });

    // The row survives, because acts performed while licensed remain valid and
    // must still be explicable.
    const [row] = await db.select().from(s.officialQuals).where(eq(s.officialQuals.id, q.id));
    expect(row.status).toBe('revoked');
    expect(row.grantedOn).toBe('2024-01-01');

    expect((await licenceValidity(db, p.id, 'official', '2026-08-12')).valid).toBe(false);
  });
});

describe('expiry report', () => {
  it('includes ALREADY-LAPSED licences, which are the dangerous ones', async () => {
    const rows = await expiringLicences(db, national, 90, '2026-08-12');
    const lapsed = rows.filter((r: any) => r.lapsed);
    expect(lapsed.length).toBeGreaterThan(0);
    // Lapsed first — an official still on an appointment list is how an invalid
    // act happens.
    expect(Number(rows[0].daysRemaining)).toBeLessThanOrEqual(Number(rows[rows.length - 1].daysRemaining));
  });
});

describe('appointment checks the licence AS AT THE EVENT DATE', () => {
  async function makeEvent(startsOn: string) {
    const [ev] = await db.insert(s.competitionEvents).values({
      code: `MMAKF-EVT-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Championship', kind: 'national_championship',
      status: 'approved', startsOn,
    }).returning();
    return ev;
  }

  it('appoints a licensed referee and freezes the licence relied on', async () => {
    const ev = await makeEvent('2026-09-01');
    const row = await appointOfficial(db, { principal: national }, {
      eventId: ev.id, personId: REFEREE.id, role: 'referee', mat: 'Tatami 1',
    });
    expect(row.licenceSnapshot.asAt).toBe('2026-09-01');
    expect(row.licenceSnapshot.validity.valid).toBe(true);
  });

  it('ATTACK: refuses a referee whose licence has lapsed by the event date', async () => {
    const ev = await makeEvent('2026-09-01');
    await expect(appointOfficial(db, { principal: national }, {
      eventId: ev.id, personId: LAPSED.id, role: 'referee',
    })).rejects.toThrow(/expired on 2025-06-30/);
  });

  it('ATTACK: refuses a referee whose licence lapses BETWEEN today and the event', async () => {
    // The exact failure a "is it valid now?" check would let through.
    const ev = await makeEvent('2027-06-01');
    await expect(appointOfficial(db, { principal: national }, {
      eventId: ev.id, personId: REFEREE.id, role: 'referee',
    })).rejects.toThrow(/expired on 2027-01-01/);
  });

  it('permits a role that carries no federation licence, and records that', async () => {
    const ev = await makeEvent('2026-09-01');
    const row = await appointOfficial(db, { principal: national }, {
      eventId: ev.id, personId: ATHLETE.id, role: 'volunteer',
    });
    expect(row.licenceSnapshot.validity.reason).toMatch(/no federation licence requirement/i);
  });

  it('refuses a duplicate appointment in the same role', async () => {
    const ev = await makeEvent('2026-09-01');
    await appointOfficial(db, { principal: national }, { eventId: ev.id, personId: REFEREE.id, role: 'referee' });
    await expect(appointOfficial(db, { principal: national }, {
      eventId: ev.id, personId: REFEREE.id, role: 'referee',
    })).rejects.toThrow(/already appointed/i);
  });
});

describe('public officials directory', () => {
  it('lists current licences and no contact details', async () => {
    const rows = await publicOfficialsDirectory(db, 'official', '2026-08-12');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r: any) => r.fullName === 'Ref Kumar')).toBe(true);
    expect(rows.some((r: any) => r.fullName === 'Lapsed Ref')).toBe(false);
    expect(Object.keys(rows[0])).not.toContain('email');
    expect(Object.keys(rows[0])).not.toContain('phone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the athlete profile is public, and carries no personal data', () => {
  beforeAll(async () => {
    await db.insert(s.rankRecords).values({
      personId: ATHLETE.id, kind: 'kyu', gradeLabel: '5th Kyu', gradeOrdinal: 5,
      awardedOn: '2025-03-01', status: 'active',
    });
  });

  it('returns the grade with its provenance', async () => {
    const p = await publicAthleteProfile(db, ATHLETE.federationId);
    expect(p!.currentGrade!.label).toBe('5th Kyu');
    // No grading event behind it — an honest legacy claim, not an examined one.
    expect(p!.currentGrade!.provenance).toBe('unverified_legacy');
  });

  it('exposes the birth YEAR but never the full date of birth', async () => {
    const p = await publicAthleteProfile(db, ATHLETE.federationId);
    expect(p!.birthYear).toBe(2008);
    const dumped = JSON.stringify(p);
    expect(dumped).not.toContain('2008-04-15');
    expect(dumped).not.toContain('athlete@example.in');
    expect(dumped).not.toContain('9876543210');
  });

  it('returns null for someone who is not active', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'Inactive', stateUnitId: JH });
    expect(await publicAthleteProfile(db, p.federationId)).toBeNull();
  });
});

describe('the Athlete Passport is scope-controlled', () => {
  it('opens for an authorised administrator in the right scope', async () => {
    const passport = await athletePassport(db, national, ATHLETE.federationId);
    expect(passport!.email).toBe('athlete@example.in');
    expect(passport!.dob).toBe('2008-04-15');
    expect(passport!.gradeHistory.length).toBeGreaterThan(0);
  });

  it('ATTACK: a state admin cannot open a passport in ANOTHER state', async () => {
    await expect(athletePassport(db, brAdmin(), ATHLETE.federationId))
      .rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: an unauthenticated caller gets nothing', async () => {
    await expect(athletePassport(db, publicUser, ATHLETE.federationId))
      .rejects.toThrow(/Forbidden/);
  });

  it('shows the FULL grade history including superseded and revoked entries', async () => {
    await db.update(s.rankRecords).set({ status: 'superseded' })
      .where(and(eq(s.rankRecords.personId, ATHLETE.id), eq(s.rankRecords.status, 'active')));
    await db.insert(s.rankRecords).values({
      personId: ATHLETE.id, kind: 'kyu', gradeLabel: '4th Kyu', gradeOrdinal: 4,
      awardedOn: '2026-01-10', status: 'revoked', revokedReason: 'Awarded in error',
    });

    const passport = await athletePassport(db, national, ATHLETE.federationId);
    const statuses = passport!.gradeHistory.map((g) => g.status);
    // A passport showing only the current grade would hide a revocation, which
    // is exactly what someone whose grade was withdrawn would want.
    expect(statuses).toContain('superseded');
    expect(statuses).toContain('revoked');
    expect(passport!.gradeHistory.find((g) => g.status === 'revoked')!.revokedReason).toBe('Awarded in error');
  });

  it('opens for an inactive person rather than returning null', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'Dormant', stateUnitId: JH });
    const passport = await athletePassport(db, national, p.federationId);
    expect(passport).not.toBeNull();
    expect(passport!.fullName).toBe('Dormant');
  });
});

describe('registry search is scope-filtered', () => {
  it('a state admin sees only their own state', async () => {
    const other = await createPerson(db, { principal: national }, { fullName: 'Bihar Athlete', stateUnitId: BR });
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, other.id));

    const brRows = await searchAthletes(db, brAdmin());
    expect(brRows.every((r: any) => r.stateUnitId === BR)).toBe(true);
    expect(brRows.some((r: any) => r.fullName === 'Test Athlete')).toBe(false);
  });

  it('returns the public shape only, whoever asks', async () => {
    const rows = await searchAthletes(db, national);
    expect(rows.length).toBeGreaterThan(0);
    const keys = Object.keys(rows[0]);
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('dob');
    expect(keys).toContain('birthYear');
  });

  it('filters by birth-year bounds, as karate age categories are defined', async () => {
    const rows = await searchAthletes(db, national, { bornOnOrAfter: '2008-01-01', bornOnOrBefore: '2008-12-31' });
    expect(rows.some((r: any) => r.fullName === 'Test Athlete')).toBe(true);
    const none = await searchAthletes(db, national, { bornOnOrAfter: '2015-01-01' });
    expect(none.some((r: any) => r.fullName === 'Test Athlete')).toBe(false);
  });

  it('refuses a caller with no read authority', async () => {
    await expect(searchAthletes(db, publicUser)).rejects.toThrow(/Forbidden/);
  });
});

describe('career statistics are derived, never cached', () => {
  it('distinguishes "never competed" from a 0% win rate', async () => {
    const stats = await careerStatistics(db, national, ATHLETE.federationId);
    expect(stats!.entries).toBe(0);
    // null, not 0 — showing 0% for someone who has never competed is a small lie
    // a profile page would repeat forever.
    expect(stats!.winRatePercent).toBeNull();
  });

  it('counts only FINAL results', async () => {
    const [ev] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-STATS', title: 'Nationals', kind: 'national_championship',
      status: 'results_final', startsOn: '2026-05-01',
    }).returning();
    const [cat] = await db.insert(s.eventCategories).values({
      eventId: ev.id, code: 'CAD-M-KUM', label: 'Cadet Male Kumite', discipline: 'kumite',
    }).returning();
    const [entry] = await db.insert(s.eventEntries).values({
      entryNo: 'MMAKF-ENT-1', eventId: ev.id, categoryId: cat.id, personId: ATHLETE.id, status: 'confirmed',
    }).returning();

    await db.insert(s.competitionResults).values({
      eventId: ev.id, categoryId: cat.id, entryId: entry.id, personId: ATHLETE.id,
      placing: 1, medal: 'gold', matchesWon: 3, matchesLost: 0, status: 'provisional',
    });

    let stats = await careerStatistics(db, national, ATHLETE.federationId);
    expect(stats!.entries).toBe(0);              // provisional does not count

    await db.update(s.competitionResults).set({ status: 'final' })
      .where(eq(s.competitionResults.entryId, entry.id));

    stats = await careerStatistics(db, national, ATHLETE.federationId);
    expect(stats!.entries).toBe(1);
    expect(stats!.podiums).toBe(1);
    expect(stats!.winRatePercent).toBe(100);
    expect(stats!.byDiscipline.kumite.medals).toBe(1);
  });

  it('a provisional result does NOT appear on the public profile', async () => {
    const profile = await publicAthleteProfile(db, ATHLETE.federationId);
    expect(profile!.results.every((r: any) => r.eventTitle === 'Nationals')).toBe(true);
    expect(profile!.medals.gold).toBe(1);
  });
});
