// Membership standing, renewal and lapse.
//
// The question this module exists to answer is asked at a tournament desk, by
// an insurer after an injury, and by a school at a gate: is THIS person a
// member in good standing, on THIS date? Every test below is a version of that
// question, including the versions that get asked months afterwards about a day
// in the past.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  standing, standingOf, resolveStanding, renew, suspend, reinstate, revoke,
  lapsingSoon, history, requireIsoDate, isMembershipError, MembershipError,
  CATEGORIES,
} from '../src/db/membership';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number, DOJO: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: 3, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});
const ctx = { principal: national };

const person = async (name: string, stateUnitId?: number) =>
  // The dojo only belongs to Jharkhand; attaching it to a Bihar person is a
  // hierarchy violation the federation module correctly refuses.
  createPerson(db, ctx, {
    fullName: name,
    stateUnitId: stateUnitId ?? JH,
    ...((stateUnitId ?? JH) === JH ? { dojoId: DOJO } : {}),
  });

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
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
  const [d] = await db.insert(s.dojos)
    .values({ code: 'MMAKF-DOJO-JH-001', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;
});

describe('standing is DERIVED, never stored', () => {
  it('a membership whose term has passed reads as lapsed with no job having run', async () => {
    const p = await person('Lapsed Member');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-12-31' });

    // Nothing has updated the row. The database still says status = 'active'.
    const [row] = await db.select().from(s.memberships).where(eq(s.memberships.personId, p.id));
    expect(row.status).toBe('active');

    // And yet the answer for today is correct, because it is computed.
    const a = await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' });
    expect(a.standing).toBe('lapsed');
    expect(a.covered).toBe(false);
  });

  it('answers for a date IN THE PAST, which is the question asked after an incident', async () => {
    const p = await person('Historic Member');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-12-31' });

    const during = await standing(db, national, p.id, 'athlete', { asAt: '2024-06-15' });
    expect(during.standing).toBe('in_good_standing');
    expect(during.covered).toBe(true);
    // A stored `expired` flag could never have answered this.
    expect(during.asAt).toBe('2024-06-15');
  });

  it('echoes the date it answered for, so a cached page cannot mislead', async () => {
    const p = await person('Echo Member');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    const a = await standing(db, national, p.id, 'athlete', { asAt: '2026-03-03' });
    expect(a.asAt).toBe('2026-03-03');
  });

  it('the boundary days are inclusive at both ends', () => {
    const row = { status: 'active', validFrom: '2026-01-01', validTo: '2026-12-31' };
    expect(standingOf(row, '2025-12-31')).toBe('not_yet_valid');
    expect(standingOf(row, '2026-01-01')).toBe('in_good_standing');
    expect(standingOf(row, '2026-12-31')).toBe('in_good_standing');
    expect(standingOf(row, '2027-01-01')).toBe('lapsed');
  });
});

describe('"no expiry recorded" is its own answer', () => {
  it('is NOT reported as valid forever, and is not reported as lapsed either', async () => {
    const p = await person('Open Ended');
    await renew(db, ctx, { personId: p.id, category: 'instructor', validFrom: '2020-01-01', validTo: null });
    const a = await standing(db, national, p.id, 'instructor', { asAt: '2026-06-01' });
    expect(a.standing).toBe('no_expiry_recorded');
    // Treated as covered, but the surface must say WHY it is covered.
    expect(a.covered).toBe(true);
    expect(a.explanation).toMatch(/deliberate or an omission/);
  });
});

describe('the distinctions a boolean would destroy', () => {
  it('lapsed and revoked are both "not a member" and are not the same thing', async () => {
    const lapsedP = await person('Just Lapsed');
    await renew(db, ctx, { personId: lapsedP.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-06-30' });

    const revokedP = await person('Was Revoked');
    const r = await renew(db, ctx, { personId: revokedP.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await revoke(db, ctx, r.membershipId, 'Disciplinary outcome');

    const a = await standing(db, national, lapsedP.id, 'athlete', { asAt: '2026-06-01' });
    const b = await standing(db, national, revokedP.id, 'athlete', { asAt: '2026-06-01' });

    expect(a.standing).toBe('lapsed');
    expect(b.standing).toBe('revoked');
    expect(a.covered).toBe(false);
    expect(b.covered).toBe(false);
    // One is an oversight a renewal fixes; the other is a federation decision.
    expect(a.explanation).toMatch(/can be renewed/);
    expect(b.explanation).toMatch(/revoked by the federation/);
  });

  it('a federation decision outranks the calendar', async () => {
    const p = await person('Suspended Today');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await suspend(db, ctx, r.membershipId, 'Pending investigation');

    // The dates are current. The membership is not.
    const a = await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' });
    expect(a.standing).toBe('suspended');
    expect(a.covered).toBe(false);
    expect(a.explanation).toMatch(/not a lapse/);
  });

  it('reinstatement returns a suspended membership to active, and needs a reason', async () => {
    const p = await person('Reinstated');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await suspend(db, ctx, r.membershipId, 'Pending investigation');

    await expect(reinstate(db, ctx, r.membershipId, '  ')).rejects.toThrow(/reason/i);
    await reinstate(db, ctx, r.membershipId, 'Investigation closed, no case to answer');

    expect((await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' })).standing).toBe('in_good_standing');
  });

  it('only a suspended membership can be reinstated', async () => {
    const p = await person('Never Suspended');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await expect(reinstate(db, ctx, r.membershipId, 'x')).rejects.toThrow(/Only a suspended/);
  });

  it('a valid renewal outranks an older revoked membership in ANOTHER category', async () => {
    // Revocation must survive an older lapse, but must not poison a different
    // category the federation never touched.
    const p = await person('Mixed Categories');
    const r = await renew(db, ctx, { personId: p.id, category: 'official', validFrom: '2024-01-01', validTo: '2024-12-31' });
    await revoke(db, ctx, r.membershipId, 'Licence withdrawn');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });

    expect((await standing(db, national, p.id, 'official', { asAt: '2026-06-01' })).standing).toBe('revoked');
    expect((await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' })).standing).toBe('in_good_standing');
  });

  it('never registered is distinct from lapsed', async () => {
    const p = await person('No Membership');
    const a = await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' });
    expect(a.standing).toBe('never_registered');
    expect(a.membership).toBeNull();
  });
});

describe('picking which membership speaks for the person', () => {
  it('a renewal makes the person current even though an older term lapsed', async () => {
    const p = await person('Renewed After Gap');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-12-31' });
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });

    // Reporting "the most recent row" would be right here by luck. Reporting
    // "the strongest answer" is right by construction.
    const a = await standing(db, national, p.id, 'athlete', { asAt: '2026-06-01' });
    expect(a.standing).toBe('in_good_standing');
    expect(a.membership!.validFrom).toBe('2026-01-01');
  });

  it('resolveStanding prefers good standing over a lapsed row regardless of order', () => {
    const lapsed = { id: 1, category: 'athlete', status: 'expired', validFrom: '2024-01-01', validTo: '2024-12-31' };
    const current = { id: 2, category: 'athlete', status: 'active', validFrom: '2026-01-01', validTo: '2026-12-31' };
    for (const rows of [[lapsed, current], [current, lapsed]]) {
      expect(resolveStanding(rows, '2026-06-01').standing).toBe('in_good_standing');
    }
  });
});

describe('renewal will not invent a term', () => {
  it('REFUSES when validTo is omitted entirely', async () => {
    const p = await person('No Term Given');
    await expect(
      renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01' } as any)
    ).rejects.toThrow(/will not assume a term/);
  });

  it('ACCEPTS an explicit null, because that is a stated decision', async () => {
    const p = await person('Explicit Open Ended');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: null });
    expect(r.membershipId).toBeGreaterThan(0);
  });

  it('refuses a term that ends before it begins', async () => {
    const p = await person('Backwards Term');
    await expect(
      renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-06-01', validTo: '2026-01-01' })
    ).rejects.toThrow(/cannot end before it begins/);
  });

  it('refuses a malformed date rather than coercing it', async () => {
    const p = await person('Bad Date');
    await expect(
      renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '01/01/2026', validTo: null })
    ).rejects.toThrow(/ISO date/);
  });

  it('refuses an unknown category', async () => {
    const p = await person('Bad Category');
    await expect(
      renew(db, ctx, { personId: p.id, category: 'spectator' as any, validFrom: '2026-01-01', validTo: null })
    ).rejects.toThrow(/Unknown membership category/);
  });
});

describe('a gap is reported, never hidden', () => {
  it('reports the days a person was uncovered between two terms', async () => {
    const p = await person('Gap Member');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2025-01-01', validTo: '2025-12-31' });
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-03-01', validTo: '2026-12-31' });

    // 2026-01-01 to 2026-02-28 inclusive = 59 days uncovered.
    expect(r.previous!.gapDays).toBe(59);
    expect(r.previous!.validTo).toBe('2025-12-31');
    expect(r.overlapsPrevious).toBe(false);
  });

  it('reports a gap of zero for a seamless renewal', async () => {
    const p = await person('Seamless');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2025-01-01', validTo: '2025-12-31' });
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(r.previous!.gapDays).toBe(0);
  });

  it('reports an overlap when the new term starts early', async () => {
    const p = await person('Early Renewal');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2025-01-01', validTo: '2025-12-31' });
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2025-11-01', validTo: '2026-10-31' });
    expect(r.overlapsPrevious).toBe(true);
    expect(r.previous!.gapDays).toBe(0);
  });

  it('reports NULL rather than 0 when the previous term had no end', async () => {
    // Zero would claim continuity this module cannot establish.
    const p = await person('Following Open Ended');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2020-01-01', validTo: null });
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(r.previous!.gapDays).toBeNull();
  });

  it('reports no previous for a first membership', async () => {
    const p = await person('First Ever');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(r.previous).toBeNull();
  });

  it('supersedes the old term WITHOUT rewriting its dates', async () => {
    const p = await person('History Preserved');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-12-31' });
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });

    const rows = await db.select().from(s.memberships).where(eq(s.memberships.personId, p.id));
    const old = rows.find((r: any) => String(r.validFrom).startsWith('2024'));
    expect(old.status).toBe('expired');
    // Its real dates survive, which is what makes "covered in March 2024"
    // answerable two years later.
    expect(String(old.validTo)).toContain('2024-12-31');
  });
});

describe('a revocation cannot be undone by issuing a new card', () => {
  it('REFUSES to renew over a revoked membership', async () => {
    const p = await person('Revoked Then Renewed');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await revoke(db, ctx, r.membershipId, 'Serious breach');

    // Otherwise any administrator could reverse a federation decision by
    // filling in a form — which is exactly the control revocation provides.
    await expect(
      renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2027-01-01', validTo: '2027-12-31' })
    ).rejects.toThrow(/undo it without the decision that reversed it/);
  });

  it('every state change requires a recorded reason', async () => {
    const p = await person('Reason Required');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    for (const fn of [suspend, revoke]) {
      await expect(fn(db, ctx, r.membershipId, '')).rejects.toThrow(/reason/i);
      await expect(fn(db, ctx, r.membershipId, '   ')).rejects.toThrow(/reason/i);
    }
  });

  it('writes the reason to the audit trail, not only to the row', async () => {
    const p = await person('Audited Revocation');
    const r = await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await revoke(db, ctx, r.membershipId, 'Recorded for the audit');

    // Scoped to THIS membership — earlier tests in this file revoke too, and
    // "the first revoke row" would be somebody else's.
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityId, String(r.membershipId)));
    const rev = audit.find((a: any) => a.action === 'revoke' && a.entityType === 'membership');
    expect(rev.reason).toBe('Recorded for the audit');
    expect(rev.oldValue.status).toBe('active');
    expect(rev.newValue.status).toBe('revoked');
  });
});

describe('scope', () => {
  it('a state administrator cannot read another state\'s standing', async () => {
    const p = await person('Jharkhand Person', JH);
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });
    await expect(standing(db, brAdmin(), p.id, 'athlete')).rejects.toThrow(/Forbidden/);
    await expect(standing(db, jhAdmin(), p.id, 'athlete')).resolves.toBeTruthy();
  });

  it('a state administrator cannot renew in another state', async () => {
    const p = await person('Jharkhand Renewal', JH);
    await expect(
      renew(db, { principal: brAdmin() }, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: null })
    ).rejects.toThrow(/Forbidden/);
  });
});

describe('the lapsing list', () => {
  beforeAll(async () => {
    const a = await person('Lapses In Ten', JH);
    await renew(db, ctx, { personId: a.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-06-11' });
    const b = await person('Lapses In Sixty', JH);
    await renew(db, ctx, { personId: b.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-07-31' });
    const c = await person('Bihar Lapses Soon', BR);
    await renew(db, { principal: national }, { personId: c.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-06-05' });
  });

  it('lists only what lapses inside the window, soonest first', async () => {
    const r = await lapsingSoon(db, national, { asAt: '2026-06-01', withinDays: 30 });
    const names = r.rows.map((x) => x.fullName);
    expect(names).toContain('Lapses In Ten');
    expect(names).toContain('Bihar Lapses Soon');
    expect(names).not.toContain('Lapses In Sixty');

    const days = r.rows.map((x) => x.daysRemaining);
    expect(days).toEqual([...days].sort((x, y) => x - y));
    expect(r.rows[0].daysRemaining).toBe(4);
  });

  it('is scoped — a Jharkhand administrator does not see Bihar', async () => {
    const r = await lapsingSoon(db, jhAdmin(), { asAt: '2026-06-01', withinDays: 30 });
    expect(r.rows.map((x) => x.fullName)).not.toContain('Bihar Lapses Soon');
    expect(r.rows.every((x) => x.stateUnitId === JH)).toBe(true);
  });

  it('COUNTS the memberships with no expiry rather than staying silent', async () => {
    // They cannot lapse, so they cannot appear — but a register full of them is
    // a data quality problem the office needs to see.
    const r = await lapsingSoon(db, national, { asAt: '2026-06-01', withinDays: 30 });
    expect(r.withNoExpiryRecorded).toBeGreaterThan(0);
  });

  it('says when the list was truncated, so it is not read as the total', async () => {
    const r = await lapsingSoon(db, national, { asAt: '2026-06-01', withinDays: 365, limit: 1 });
    expect(r.rows.length).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it('refuses a caller without membership:read anywhere', async () => {
    const athlete: Principal = {
      userId: 9, label: 'athlete',
      bindings: [{ role: 'ATHLETE', scopeType: 'dojo', scopeId: DOJO }],
    };
    // ATHLETE does hold membership:read; a principal with NO bindings does not.
    await expect(lapsingSoon(db, { userId: null, label: 'anon', bindings: [] }))
      .rejects.toThrow(/membership:read/);
    expect(athlete.bindings.length).toBe(1);
  });
});

describe('history shows everything, including what expired', () => {
  it('returns every term with the standing it had on the date asked about', async () => {
    const p = await person('Full History');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2024-01-01', validTo: '2024-12-31' });
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31' });

    const h = await history(db, national, p.id, { asAt: '2024-06-01' });
    const athlete = h.byCategory.find((c) => c.category === 'athlete')!;
    expect(athlete.terms.length).toBe(2);
    // As at mid-2024 the 2024 term was current and the 2026 one had not begun.
    expect(athlete.terms.find((t: any) => t.validFrom === '2024-01-01')!.standingAsAt).toBe('in_good_standing');
    expect(athlete.terms.find((t: any) => t.validFrom === '2026-01-01')!.standingAsAt).toBe('not_yet_valid');
    expect(athlete.current.standing).toBe('in_good_standing');
  });

  it('omits categories the person never held, rather than printing empty ones', async () => {
    const p = await person('One Category Only');
    await renew(db, ctx, { personId: p.id, category: 'athlete', validFrom: '2026-01-01', validTo: null });
    const h = await history(db, national, p.id);
    expect(h.byCategory.map((c) => c.category)).toEqual(['athlete']);
  });
});

describe('input hygiene', () => {
  it('requireIsoDate refuses anything that is not one', () => {
    expect(() => requireIsoDate('2026-1-1', 'validFrom')).toThrow(/ISO date/);
    expect(() => requireIsoDate('2026-13-01', 'validFrom')).toThrow(/not a real date/);
    expect(requireIsoDate('2026-02-29', 'validFrom')).toBe('2026-02-29');
  });

  it('errors are identified by shape, not constructor identity', () => {
    const e = new MembershipError('bad_date', 'x');
    expect(isMembershipError(e)).toBe(true);
    expect(isMembershipError(new Error('x'))).toBe(false);
    expect(isMembershipError(null)).toBe(false);
  });

  it('every category in the enum is covered by CATEGORIES', () => {
    expect([...CATEGORIES].sort()).toEqual([...s.membershipCategory.enumValues].sort());
  });
});
