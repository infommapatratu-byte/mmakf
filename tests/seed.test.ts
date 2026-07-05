// Seed invariants (MASTER-SPEC §15.1): keeps content and code in agreement.
import { describe, it, expect } from 'vitest';
import { SEED, KEYS } from '../src/data/seed';

// Must match the names implemented in src/components/Icon.astro (§3.15).
const ICON_NAMES = [
  'karate-gi', 'kata', 'kumite', 'shield', 'women', 'star', 'medal', 'globe',
  'black-belt', 'book', 'school', 'users', 'pin', 'monitor', 'mat', 'target',
  'dumbbell', 'water', 'first-aid', 'locker', 'cctv', 'parking', 'clock',
];

describe('seed integrity', () => {
  it('every KEYS entry exists in SEED', () => {
    for (const k of KEYS) {
      expect(SEED, `SEED missing key ${k}`).toHaveProperty(k);
    }
  });

  it('array keys are arrays; object keys are objects', () => {
    const objectKeys = ['federation', 'beltGrading'];
    for (const k of KEYS) {
      if (objectKeys.includes(k)) {
        expect(typeof (SEED as any)[k]).toBe('object');
        expect(Array.isArray((SEED as any)[k])).toBe(false);
      } else {
        expect(Array.isArray((SEED as any)[k]), `${k} should be an array`).toBe(true);
      }
    }
  });

  it('every icon reference is a valid Icon name', () => {
    const iconed = [
      ...SEED.programs, ...SEED.products, ...SEED.achievements,
      ...SEED.facilities, ...SEED.gallery,
    ];
    for (const item of iconed as any[]) {
      if (item.icon) {
        expect(ICON_NAMES, `unknown icon "${item.icon}"`).toContain(item.icon);
      }
    }
  });

  it('fees and prices are non-negative integers', () => {
    for (const p of SEED.programs) {
      expect(Number.isInteger(p.fee) && p.fee >= 0, `program ${p.name}`).toBe(true);
    }
    for (const k of SEED.beltGrading.kyu) {
      expect(Number.isInteger(k.fee) && k.fee >= 0, `kyu ${k.rank}`).toBe(true);
    }
    for (const pr of SEED.products) {
      expect(Number.isInteger(pr.p) && pr.p >= 0, `product ${pr.n}`).toBe(true);
    }
  });

  it('schedule modes are dojo or online (drives pill styling)', () => {
    for (const s of SEED.schedule) {
      expect(['dojo', 'online']).toContain(s.mode);
    }
  });

  it('federation has all contact fields required by templates', () => {
    const c = SEED.federation.contact;
    for (const f of ['email', 'phone', 'address', 'hours'] as const) {
      expect(typeof c[f]).toBe('string');
      expect(c[f].length).toBeGreaterThan(0);
    }
    expect(SEED.federation.upi).toBeTruthy();
  });
});
