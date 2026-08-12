// §5 ADVERSARIAL — deliberate attempts to break authorisation.
//
// Each test is an attack. A passing test means the attack FAILED, which is the
// outcome we want. Any attack that succeeds here is a P0 finding.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { can, canAnywhere, canGrantRole, type Principal } from '../src/lib/rbac';
import { createPerson, listPersons, auditTrail, allocateFederationId } from '../src/db/federation';

let db: any, JH: number, BR: number, JH_DIST: number, JH_DOJO: number;

const nat: Principal = {
  userId: 1, label: 'nat',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.exec(stmt.trim());
    }
  }
  const [jh] = await db.insert(s.stateUnits).values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH' }).returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits).values({ code: 'ST-BR', state: 'Bihar', name: 'BR' }).returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
  const [d] = await db.insert(s.districtUnits).values({ code: 'D-JH-1', stateUnitId: JH, district: 'Ramgarh', name: 'R' }).returning({ id: s.districtUnits.id });
  JH_DIST = d.id;
  const [dj] = await db.insert(s.dojos).values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, districtUnitId: JH_DIST }).returning({ id: s.dojos.id });
  JH_DOJO = dj.id;
});

describe('ATTACK: malformed or forged principals', () => {
  it('a principal with no bindings is refused', () => {
    expect(can({ userId: 1, label: 'x', bindings: [] }, 'person:write', { stateUnitId: JH })).toBe(false);
  });

  it('an invented role name grants nothing', () => {
    const forged: any = { userId: 1, label: 'x', bindings: [{ role: 'GOD_ADMIN', scopeType: 'national', scopeId: null }] };
    expect(can(forged, 'person:write', { stateUnitId: JH })).toBe(false);
    expect(canAnywhere(forged, 'person:read')).toBe(false);
  });

  it('null and undefined principals are refused', () => {
    expect(can(null, 'person:read', {})).toBe(false);
    expect(can(undefined, 'content:write', {})).toBe(false);
    expect(canAnywhere(null, 'audit:read')).toBe(false);
  });

  it('a non-array bindings field cannot bypass the loop', () => {
    const forged: any = { userId: 1, label: 'x', bindings: 'FEDERATION_ADMIN' };
    expect(can(forged, 'person:write', { stateUnitId: JH })).toBe(false);
    expect(canAnywhere(forged, 'person:read')).toBe(false);
  });

  it('a state binding with a null scopeId does NOT become national', () => {
    const p: Principal = { userId: 1, label: 'x', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: null }] };
    expect(can(p, 'person:write', { stateUnitId: JH })).toBe(false);
    expect(can(p, 'person:write', { stateUnitId: null })).toBe(false);
  });

  it('an unknown scopeType is refused rather than defaulting open', () => {
    const p: any = { userId: 1, label: 'x', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'planet', scopeId: null }] };
    expect(can(p, 'person:write', { stateUnitId: JH })).toBe(false);
  });

  it('expired and suspended bindings are inert', () => {
    const expired: Principal = { userId: 1, label: 'x', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH, expiresAt: '2020-01-01' }] };
    const suspended: Principal = { userId: 1, label: 'x', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH, status: 'suspended' }] };
    expect(can(expired, 'person:write', { stateUnitId: JH })).toBe(false);
    expect(can(suspended, 'person:write', { stateUnitId: JH })).toBe(false);
    expect(canAnywhere(expired, 'person:read')).toBe(false);
  });

  it('a scopeId supplied as a string does not match a numeric scope', () => {
    const p: any = { userId: 1, label: 'x', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: String(JH) }] };
    expect(can(p, 'person:write', { stateUnitId: JH })).toBe(false);
  });
});

describe('ATTACK: unlocated resources', () => {
  it('a state admin cannot reach a resource with no location (national content)', () => {
    const st: Principal = { userId: 1, label: 'st', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }] };
    expect(can(st, 'person:write', {})).toBe(false);
    expect(can(st, 'person:write', { stateUnitId: null })).toBe(false);
  });
});

describe('ATTACK: hierarchy laundering (cross-scope write via a second column)', () => {
  it('a district admin cannot file a person into ANOTHER state by naming their own district', async () => {
    const dist: Principal = { userId: 5, label: 'dist', bindings: [{ role: 'DISTRICT_ADMIN', scopeType: 'district', scopeId: JH_DIST }] };
    await expect(
      createPerson(db, { principal: dist }, { fullName: 'Laundered', stateUnitId: BR, districtUnitId: JH_DIST })
    ).rejects.toThrow();
  });

  it('a dojo admin cannot file a person into another state by naming their own dojo', async () => {
    const dojo: Principal = { userId: 6, label: 'dojo', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: JH_DOJO }] };
    await expect(
      createPerson(db, { principal: dojo }, { fullName: 'Laundered2', stateUnitId: BR, dojoId: JH_DOJO })
    ).rejects.toThrow();
  });

  it('a person cannot be filed under a district that belongs to a different state', async () => {
    await expect(
      createPerson(db, { principal: nat }, { fullName: 'Inconsistent', stateUnitId: BR, districtUnitId: JH_DIST })
    ).rejects.toThrow(/hierarch|belong|consistent/i);
  });

  it('a person cannot be filed under a dojo that belongs to a different district', async () => {
    const [brDist] = await db.insert(s.districtUnits)
      .values({ code: 'D-BR-1', stateUnitId: BR, district: 'Patna', name: 'P' })
      .returning({ id: s.districtUnits.id });
    await expect(
      createPerson(db, { principal: nat }, { fullName: 'Inconsistent2', stateUnitId: BR, districtUnitId: brDist.id, dojoId: JH_DOJO })
    ).rejects.toThrow(/hierarch|belong|consistent/i);
  });

  it('a consistent hierarchy is still accepted', async () => {
    const p = await createPerson(db, { principal: nat }, { fullName: 'Consistent', stateUnitId: JH, districtUnitId: JH_DIST, dojoId: JH_DOJO });
    expect(p.id).toBeGreaterThan(0);
  });
});

describe('ATTACK: audit-trail IDOR', () => {
  it('a state-scoped officer cannot read the audit trail of another state', async () => {
    const brPerson = await createPerson(db, { principal: nat }, { fullName: 'BR Person', stateUnitId: BR });
    const jhFinance: Principal = { userId: 7, label: 'jh-finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'state', scopeId: JH }] };
    await expect(auditTrail(db, jhFinance, 'person', brPerson.id)).rejects.toThrow(/Forbidden/);
  });

  it('but may read the trail of an entity inside their own state', async () => {
    const jhPerson = await createPerson(db, { principal: nat }, { fullName: 'JH Person', stateUnitId: JH });
    const jhFinance: Principal = { userId: 7, label: 'jh-finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'state', scopeId: JH }] };
    const trail = await auditTrail(db, jhFinance, 'person', jhPerson.id);
    expect(trail.length).toBeGreaterThan(0);
  });
});

describe('ATTACK: privilege escalation through role granting', () => {
  it('a federation admin cannot mint a SUPER_ADMIN', () => {
    expect(canGrantRole(nat, 'SUPER_ADMIN', { scopeType: 'national', scopeId: null })).toBe(false);
  });

  it('only a super admin may grant SUPER_ADMIN or SAFEGUARDING_OFFICER', () => {
    const su: Principal = { userId: 0, label: 'su', bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }] };
    expect(canGrantRole(su, 'SUPER_ADMIN', { scopeType: 'national', scopeId: null })).toBe(true);
    expect(canGrantRole(nat, 'SAFEGUARDING_OFFICER', { scopeType: 'national', scopeId: null })).toBe(false);
  });

  it('a state admin cannot grant any role at all', () => {
    const st: Principal = { userId: 2, label: 'st', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }] };
    expect(canGrantRole(st, 'INSTRUCTOR', { scopeType: 'state', scopeId: JH })).toBe(false);
    expect(canGrantRole(st, 'STATE_ADMIN', { scopeType: 'state', scopeId: JH })).toBe(false);
  });

  it('a granter cannot bind a role outside their own scope', () => {
    const su: Principal = { userId: 3, label: 'su-jh', bindings: [{ role: 'SUPER_ADMIN', scopeType: 'state', scopeId: JH }] };
    expect(canGrantRole(su, 'INSTRUCTOR', { scopeType: 'state', scopeId: BR })).toBe(false);
    expect(canGrantRole(su, 'INSTRUCTOR', { scopeType: 'state', scopeId: JH })).toBe(true);
  });

  it('a granter cannot confer an action they do not themselves hold', () => {
    // GENERAL_SECRETARY holds role granting in this scenario but no finance
    // actions, so must not be able to create a FINANCE_OFFICER.
    const gs: any = {
      userId: 4, label: 'gs',
      bindings: [{ role: 'GENERAL_SECRETARY', scopeType: 'national', scopeId: null }],
    };
    expect(canGrantRole(gs, 'FINANCE_OFFICER', { scopeType: 'national', scopeId: null })).toBe(false);
  });
});

describe('ATTACK: list-query leakage', () => {
  it('a role holding no person:read lists nothing, even nationally bound', async () => {
    const referee: Principal = { userId: 8, label: 'ref', bindings: [{ role: 'REFEREE', scopeType: 'national', scopeId: null }] };
    await expect(listPersons(db, referee)).rejects.toThrow(/Forbidden/);
  });

  it('an expired state admin lists nothing', async () => {
    const stale: Principal = { userId: 9, label: 'stale', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH, expiresAt: '2020-01-01' }] };
    await expect(listPersons(db, stale)).rejects.toThrow(/Forbidden/);
  });

  it('a dojo-scoped admin sees only their own dojo', async () => {
    const dojo: Principal = { userId: 10, label: 'dojo', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: JH_DOJO }] };
    const rows = await listPersons(db, dojo);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.dojoId === JH_DOJO)).toBe(true);
  });
});

describe('ATTACK: identifier collision under load', () => {
  it('40 concurrent allocations produce 40 distinct ids', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => allocateFederationId(db, 'RACE', 2026)));
    expect(new Set(ids).size).toBe(40);
  });

  it('concurrent person creation never duplicates a federation id', async () => {
    const people = await Promise.all(
      Array.from({ length: 15 }, (_, i) => createPerson(db, { principal: nat }, { fullName: `Racer ${i}`, stateUnitId: JH }))
    );
    expect(new Set(people.map((p) => p.federationId)).size).toBe(15);
  });
});
