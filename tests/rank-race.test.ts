// §5 ADVERSARIAL — concurrency against the rank ledger.
//
// Current rank is derived from `status = 'active'`, so "exactly one active rank
// per person per kind" is the invariant the whole grading record rests on. These
// tests attack it directly.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson, awardRank, currentRank, rankHistory } from '../src/db/federation';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number;
const nat: Principal = {
  userId: 1, label: 'nat',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [jh] = await db.insert(s.stateUnits).values({ code: 'ST-JH', state: 'JH', name: 'JH' }).returning({ id: s.stateUnits.id });
  JH = jh.id;
});

async function activeRanks(personId: number) {
  return db.select().from(s.rankRecords)
    .where(and(eq(s.rankRecords.personId, personId), eq(s.rankRecords.status, 'active')));
}

describe('ATTACK: concurrent promotion', () => {
  it('two simultaneous awards leave exactly one active rank, and lose neither record', async () => {
    const p = await createPerson(db, { principal: nat }, { fullName: 'Racer', stateUnitId: JH });
    await Promise.all([
      awardRank(db, { principal: nat }, { personId: p.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9, awardedOn: '2026-01-01' }),
      awardRank(db, { principal: nat }, { personId: p.id, kind: 'kyu', gradeLabel: '8th Kyu', gradeOrdinal: 8, awardedOn: '2026-01-01' }),
    ]);

    expect((await activeRanks(p.id)).length).toBe(1);
    // Append-only: the losing race still recorded its award, standing down.
    expect((await rankHistory(db, p.id)).length).toBe(2);
  });

  it('survives a five-way race', async () => {
    const p = await createPerson(db, { principal: nat }, { fullName: 'Racer5', stateUnitId: JH });
    await Promise.all(
      [9, 8, 7, 6, 5].map((n) =>
        awardRank(db, { principal: nat }, { personId: p.id, kind: 'kyu', gradeLabel: `${n}th Kyu`, gradeOrdinal: n, awardedOn: '2026-02-01' })
      )
    );
    expect((await activeRanks(p.id)).length).toBe(1);
    expect((await rankHistory(db, p.id)).length).toBe(5);
    expect(await currentRank(db, p.id, 'kyu')).not.toBeNull();
  });

  it('kyu and dan are independent ledgers — one active of each is legal', async () => {
    const p = await createPerson(db, { principal: nat }, { fullName: 'Dual', stateUnitId: JH });
    await awardRank(db, { principal: nat }, { personId: p.id, kind: 'kyu', gradeLabel: '1st Kyu', gradeOrdinal: 1, awardedOn: '2025-01-01' });
    await awardRank(db, { principal: nat }, { personId: p.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1, awardedOn: '2026-01-01' });
    expect((await activeRanks(p.id)).length).toBe(2);
    expect((await currentRank(db, p.id, 'dan')).gradeLabel).toBe('Shodan');
    expect((await currentRank(db, p.id, 'kyu')).gradeLabel).toBe('1st Kyu');
  });

  it('the database refuses a second active rank even if application logic is bypassed', async () => {
    const p = await createPerson(db, { principal: nat }, { fullName: 'Direct', stateUnitId: JH });
    await awardRank(db, { principal: nat }, { personId: p.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1, awardedOn: '2026-01-01' });
    // Raw insert, skipping awardRank entirely — the constraint must still hold.
    await expect(
      db.insert(s.rankRecords).values({
        personId: p.id, kind: 'dan', gradeLabel: 'Nidan', gradeOrdinal: 2,
        awardedOn: '2026-06-01', status: 'active',
      })
    ).rejects.toThrow();
  });
});
