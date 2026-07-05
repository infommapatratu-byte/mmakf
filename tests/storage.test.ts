// Unit tests for src/lib/storage.ts (MASTER-SPEC §15.1).
// No UPSTASH_* env vars in test runs → exercises the in-memory fallback path,
// which shares guardShape/getAll logic with the Redis path.
import { describe, it, expect } from 'vitest';
import { get, set, getAll } from '../src/lib/storage';
import { SEED, KEYS } from '../src/data/seed';

describe('storage (in-memory fallback)', () => {
  it('returns seed content for unwritten keys', async () => {
    const programs = await get('programs');
    expect(programs).toEqual(SEED.programs);
  });

  it('round-trips a write', async () => {
    const next = [{ q: 'Test?', a: 'Yes.' }];
    await set('faqs', next);
    expect(await get('faqs')).toEqual(next);
  });

  it('guards shape: a non-array stored under an array key serves seed', async () => {
    await set('gallery', 'corrupted-string' as any);
    expect(await get('gallery')).toEqual(SEED.gallery);
  });

  it('guards shape: a non-object stored under an object key serves seed', async () => {
    await set('federation', ['not', 'an', 'object'] as any);
    expect(await get('federation')).toEqual(SEED.federation);
  });

  it('getAll returns exactly the public KEYS and never leads', async () => {
    const all = await getAll();
    expect(Object.keys(all).sort()).toEqual([...KEYS].sort());
    expect(all).not.toHaveProperty('leads');
  });

  it('leads key round-trips independently of getAll', async () => {
    const lead = { id: 1, name: 'T', phone: '9', program: '', ts: new Date().toISOString() };
    await set('leads', [lead]);
    expect(await get('leads')).toEqual([lead]);
    const all = await getAll();
    expect(all).not.toHaveProperty('leads');
  });
});
