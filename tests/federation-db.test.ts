// Wave 2a — federation data layer tested against REAL Postgres.
//
// PGlite runs an actual Postgres engine in-process, so migrations, constraints,
// enums and SQL semantics are exercised for real — not mocked.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  allocateFederationId, createPerson, awardRank, currentRank, rankHistory,
  revokeRank, issueMembership, listPersons, publicRegisterEntry, auditTrail,
} from '../src/db/federation';
import type { Principal } from '../src/lib/rbac';

let db: any;
let JH: number, BR: number, RMG: number, DOJO: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jharkhand-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: 3, label: 'bihar-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});
const examiner: Principal = {
  userId: 4, label: 'examiner',
  bindings: [{ role: 'EXAMINER', scopeType: 'national', scopeId: null }],
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });

  // Apply the generated migration exactly as production will.
  // EVERY migration, discovered rather than listed — a hardcoded file breaks
  // the moment a later one adds a column the schema selects.
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await client.exec(t);
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;

  const [rmg] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DIST-JH-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RMG = rmg.id;

  const [d] = await db.insert(s.dojos)
    .values({ code: 'MMAKF-DOJO-JH-RMG-001', name: 'Hombu Dojo', stateUnitId: JH, districtUnitId: RMG, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;
});

describe('migration + constraints', () => {
  it('applies cleanly and enforces unique federation codes', async () => {
    await expect(
      db.insert(s.stateUnits).values({ code: 'MMAKF-ST-JH', state: 'Duplicate', name: 'X' })
    ).rejects.toThrow();
  });

  it('enforces foreign keys', async () => {
    await expect(
      db.insert(s.dojos).values({ code: 'MMAKF-DOJO-XX-1', name: 'Orphan', stateUnitId: 99999 })
    ).rejects.toThrow();
  });

  it('rejects values outside an enum', async () => {
    await expect(
      db.insert(s.stateUnits).values({ code: 'MMAKF-ST-ZZ', state: 'Z', name: 'Z', status: 'not_a_status' as any })
    ).rejects.toThrow();
  });
});

describe('federation IDs (§73)', () => {
  it('allocates sequentially and never repeats', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await allocateFederationId(db, 'TST', 2026));
    expect(new Set(ids).size).toBe(5);
    expect(ids[0]).toMatch(/^MMAKF-TST-2026-\d{6}$/);
    const nums = ids.map((i) => Number(i.slice(-6)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(nums[4] - nums[0]).toBe(4);
  });

  it('allocates concurrently without collision', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => allocateFederationId(db, 'CON', 2026)));
    expect(new Set(ids).size).toBe(12);
  });
});

describe('RBAC scope enforcement (§38, §53 IDOR)', () => {
  it('a national admin can create a person anywhere', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'National Person', stateUnitId: BR });
    expect(p.federationId).toMatch(/^MMAKF-MEM-/);
  });

  it('a state admin can create within their own state', async () => {
    const p = await createPerson(db, { principal: jhAdmin() }, { fullName: 'JH Person', stateUnitId: JH, dojoId: DOJO });
    expect(p.id).toBeGreaterThan(0);
  });

  it('a state admin CANNOT create in another state', async () => {
    await expect(
      createPerson(db, { principal: brAdmin() }, { fullName: 'Cross-state', stateUnitId: JH })
    ).rejects.toThrow(/Forbidden/);
  });

  it('an examiner cannot create people at all', async () => {
    await expect(
      createPerson(db, { principal: examiner }, { fullName: 'X', stateUnitId: JH })
    ).rejects.toThrow(/Forbidden/);
  });

  it('list queries are scope-filtered in SQL, not after the fact', async () => {
    const all = await listPersons(db, national);
    const jhOnly = await listPersons(db, jhAdmin());
    const brOnly = await listPersons(db, brAdmin());
    expect(all.length).toBeGreaterThan(jhOnly.length);
    expect(jhOnly.every((p: any) => p.stateUnitId === JH)).toBe(true);
    expect(brOnly.every((p: any) => p.stateUnitId === BR)).toBe(true);
  });
});

describe('rank history is append-only (§31) and current rank is derived (§72)', () => {
  let personId: number;

  beforeAll(async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'Grading Candidate', stateUnitId: JH, dojoId: DOJO });
    personId = p.id;
  });

  it('awarding a new rank supersedes the old one without deleting it', async () => {
    await awardRank(db, { principal: national }, {
      personId, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9, awardedOn: '2025-06-01',
    });
    await awardRank(db, { principal: national }, {
      personId, kind: 'kyu', gradeLabel: '8th Kyu', gradeOrdinal: 8, awardedOn: '2025-12-01',
    });

    const cur = await currentRank(db, personId, 'kyu');
    expect(cur.gradeLabel).toBe('8th Kyu');

    const history = await rankHistory(db, personId);
    expect(history.length).toBe(2);                       // nothing deleted
    const old = history.find((r: any) => r.gradeLabel === '9th Kyu');
    expect(old.status).toBe('superseded');
    expect(old.awardedOn).toBe('2025-06-01');             // original fact intact
  });

  it('revocation requires a reason and preserves the record', async () => {
    const [rec] = await db.select().from(s.rankRecords)
      .where(eq(s.rankRecords.personId, personId)).limit(1);
    await expect(
      revokeRank(db, { principal: national }, rec.id, '   ')
    ).rejects.toThrow(/reason/i);

    await revokeRank(db, { principal: national }, rec.id, 'Awarded in error');
    const [after] = await db.select().from(s.rankRecords).where(eq(s.rankRecords.id, rec.id));
    expect(after.status).toBe('revoked');
    expect(after.revokedReason).toBe('Awarded in error');
    expect(after.gradeLabel).toBe(rec.gradeLabel);        // history preserved
  });

  it('an examiner may score but may NOT award rank', async () => {
    await expect(
      awardRank(db, { principal: examiner }, {
        personId, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1, awardedOn: '2026-01-01',
      })
    ).rejects.toThrow(/Forbidden/);
  });
});

describe('audit spine (§52)', () => {
  it('records every privileged mutation with actor and values', async () => {
    const p = await createPerson(db, { principal: national, ip: '203.0.113.9' }, {
      fullName: 'Audited Person', stateUnitId: JH,
    });
    const trail = await auditTrail(db, national, 'person', p.id);
    expect(trail.length).toBe(1);
    expect(trail[0].action).toBe('create');
    expect(trail[0].actorLabel).toBe('federation-admin');
    expect(trail[0].newValue.federationId).toBe(p.federationId);
  });

  it('never stores a raw IP address', async () => {
    const rows = await db.select().from(s.auditEvents);
    const hashes = rows.map((r: any) => r.actorIpHash).filter(Boolean);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.some((h: string) => h.includes('203.0.113.9'))).toBe(false);
  });

  it('revocation audit captures old and new value plus the reason', async () => {
    const rows = await db.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'revoke'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].reason).toBeTruthy();
    expect(rows[0].oldValue).toBeTruthy();
    expect(rows[0].newValue).toBeTruthy();
  });

  it('reading the audit trail itself requires authority', async () => {
    const athlete: Principal = {
      userId: 9, label: 'athlete',
      bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
    };
    await expect(auditTrail(db, athlete, 'person', 1)).rejects.toThrow(/Forbidden/);
  });
});

describe('public register exposes no PII (§66)', () => {
  it('returns register fields only', async () => {
    const p = await createPerson(db, { principal: national }, {
      fullName: 'Public Person', stateUnitId: JH,
      email: 'private@example.com', phone: '9999999999', dob: '2000-01-01', gender: 'M',
    });
    const entry = await publicRegisterEntry(db, p.federationId);
    expect(entry.fullName).toBe('Public Person');
    expect(Object.keys(entry)).not.toContain('email');
    expect(Object.keys(entry)).not.toContain('phone');
    expect(Object.keys(entry)).not.toContain('dob');
    expect(Object.keys(entry)).not.toContain('gender');
  });
});

describe('memberships', () => {
  it('issues within scope and refuses outside it', async () => {
    const p = await createPerson(db, { principal: national }, { fullName: 'Member A', stateUnitId: JH, dojoId: DOJO });
    const m = await issueMembership(db, { principal: jhAdmin() }, {
      personId: p.id, category: 'instructor', validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    expect(m.id).toBeGreaterThan(0);

    await expect(
      issueMembership(db, { principal: brAdmin() }, { personId: p.id, category: 'instructor', validFrom: '2026-01-01', validTo: null })
    ).rejects.toThrow(/Forbidden/);
  });
});
