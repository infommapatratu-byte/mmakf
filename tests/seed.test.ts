// Seed invariants (MASTER-SPEC §15.1): keeps content and code in agreement.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  it('publishes the federation address and NOTHING personal', () => {
    const c = SEED.federation.contact;
    // What must be there.
    for (const f of ['email', 'address', 'hours'] as const) {
      expect(typeof c[f]).toBe('string');
      expect(c[f].length).toBeGreaterThan(0);
    }
    expect(c.email).toBe('admin@mmakf.in');
    expect(c.emailSecondary).toBe('karate.pramod@gmail.com');

    // What must NOT. This test used to assert the opposite — that a phone number
    // and a UPI handle were present — and it passed while the site published
    // Sensei's personal mobile in fourteen places and his personal UPI handle as
    // the federation's payment route. The federation asked twice for both to go.
    expect(c.phone).toBe('');
    expect(SEED.federation.upi).toBe('');
  });
});

// ── What must never reappear ────────────────────────────────────────────────
//
// Each of these was published, the federation asked for it to be removed, and
// it survived because nothing enforced the removal. A request in a conversation
// is not an enforcement mechanism. These are.

describe('content the federation has asked to be removed', () => {
  const sources = (dir = 'src'): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|astro|css)$/.test(name)) out.push(full.replace(/\\/g, '/'));
    }
    return out;
  };
  const FILES = sources();
  /**
   * Comments are stripped before matching. A comment recording that a claim was
   * REMOVED would otherwise fail a "this claim is gone" assertion for ever — the
   * same trap, inverted, that this project's accessibility verifier already found
   * once (a guard satisfied by the comment sitting above the line it checked).
   */
  const codeOf = (src: string) =>
    src
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  const grep = (re: RegExp) => FILES.filter((f) => re.test(codeOf(readFileSync(f, 'utf8'))));

  it('no personal mobile number appears anywhere in the source', () => {
    // It stood in fourteen places, including as a DEFAULT PARAMETER in a
    // component — which survives every attempt to remove it from the data,
    // because nothing passes the prop.
    expect(grep(/9939144318|99391\s*44318/)).toEqual([]);
  });

  it('no personal UPI handle appears anywhere in the source', () => {
    expect(grep(/@ybl\b/)).toEqual([]);
    expect(grep(/upi:\s*'[^']+'/)).toEqual([]);
  });

  it('the site claims no "Tiger Lee lineage"', () => {
    // "Junior Tiger Lee" is a title conferred on Shihan Pramod Kumar Pathak in
    // 2021. It is his name. It is not a school of Shotokan that MMAKF descends
    // from, and the site asserted that descent in nine places.
    expect(grep(/Tiger Lee (lineage|Lineage|inheritance|Shotokan)/)).toEqual([]);
    // The title itself is real, documented, and stays.
    expect((SEED.leadership[0] as any).honours.some((h: any) => h.title === 'Junior Tiger Lee')).toBe(true);
  });

  it('no fixture, result, circular or member row is typed by hand', () => {
    // Every one of these was invented — six events dated into a year that had
    // not happened, medal tallies for championships nobody held, circulars
    // instructing units to meet deadlines nobody set, and a five-row member
    // register that /api/verify reported as verified.
    expect(SEED.events).toEqual([]);
    expect(SEED.circulars).toEqual([]);
    expect(SEED.members).toEqual([]);
  });

  it('every news item carries the source it came from', () => {
    expect(SEED.news.length).toBeGreaterThan(0);
    for (const n of SEED.news as any[]) {
      expect(n.source, `news "${n.title}" has no source`).toBeTruthy();
      expect(String(n.source).length).toBeGreaterThan(20);
    }
  });

  it('no news item is dated into the future', () => {
    // One announced a championship "concluded" on a day that had not arrived.
    const years = (SEED.news as any[]).map((n) => Number(String(n.date).match(/\d{4}/)?.[0] ?? 0));
    for (const y of years) expect(y).toBeLessThanOrEqual(new Date().getUTCFullYear());
  });

  it('a gallery photograph declares whether the federation owns it', () => {
    for (const g of SEED.gallery as any[]) {
      expect(typeof g.own, `gallery "${g.title}" does not say whose photograph it is`).toBe('boolean');
    }
    // And the federation's own photographs are local files, never hotlinks.
    for (const g of (SEED.gallery as any[]).filter((x) => x.own)) {
      expect(g.img.startsWith('/media/')).toBe(true);
    }
  });
});
