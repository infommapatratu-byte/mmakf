import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { search } from '../src/lib/search';
import type { Principal } from '../src/lib/rbac';

let db: any;
const national: Principal = {
  userId: 1, label: 'fa',
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
  const [{ id: JH }] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  for (let i = 1; i <= 5; i++) {
    await db.insert(s.persons).values({
      federationId: `MMAKF-MEM-2026-00000${i}`, fullName: `Kumar Person ${i}`,
      city: 'Patratu', stateUnitId: JH, status: 'active',
    });
  }
}, 120_000);

describe('probes', () => {
  it('P1 empty kinds array', async () => {
    const r = await search(db, national, 'Kumar', { kinds: [], newsProvider: async () => [] });
    console.log('P1 kinds ran:', r.kinds, 'hits:', r.hits.length);
    expect(r.hits.length).toBe(0);
  });

  it('P2 NaN limit', async () => {
    let err: any = null;
    let r: any = null;
    try {
      r = await search(db, national, 'Kumar', { limit: Number.NaN, newsProvider: async () => [] });
    } catch (e) { err = e; }
    console.log('P2 err:', err && String(err).slice(0, 200), 'resp:', r && { hits: r.hits.length, truncated: r.truncated });
    expect(err).toBe(null);
  });

  it('P3 malformed principal bindings', async () => {
    let err: any = null;
    try {
      await search(db, { userId: 9, label: 'x', bindings: undefined as any }, 'Kumar', { newsProvider: async () => [] });
    } catch (e) { err = e; }
    console.log('P3 err:', err && String(err).slice(0, 200));
    expect(err).toBe(null);
  });

  it('P4 negative / zero limit', async () => {
    const r = await search(db, national, 'Kumar', { limit: 0, newsProvider: async () => [] });
    console.log('P4 limit 0 ->', r.hits.length, r.truncated);
    const r2 = await search(db, national, 'Kumar', { limit: -5, newsProvider: async () => [] });
    console.log('P4 limit -5 ->', r2.hits.length, r2.truncated);
  });
});
