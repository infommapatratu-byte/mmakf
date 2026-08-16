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

  it('NO TRAINING PATHWAY CARRIES A PRICE', () => {
    // This test used to assert the opposite — that every programme had a
    // non-negative integer `fee` — and it passed the whole time the site was
    // showing nine independent monthly subscriptions: ₹800, ₹900, ₹900, ₹999,
    // ₹1,000, ₹1,100, ₹1,200, ₹1,500, ₹1,800. The federation's objection was
    // precisely that architecture, so the assertion is inverted.
    //
    // Kihon, kata, kumite and the rest are COMPONENTS of one training system.
    // What somebody pays depends on who they are and what they need, and only
    // src/db/fees.ts decides it — versioned, reproducible, and able to show
    // which rule produced every line. A price typed into a content file can be
    // neither.
    for (const p of SEED.programs as any[]) {
      expect(p.fee, `programme "${p.name}" carries a price again`).toBeUndefined();
      expect(p.price, `programme "${p.name}" carries a price again`).toBeUndefined();
    }

    // The grading fee table is DIFFERENT and stays. It is a published federation
    // schedule with a rank against each figure, printed on /belt-system, and it
    // is not a subscription.
    for (const k of SEED.beltGrading.kyu) {
      expect(Number.isInteger(k.fee) && k.fee >= 0, `kyu ${k.rank}`).toBe(true);
    }
    // Shop products are goods with a shelf price, which is a normal thing to
    // publish. Integer rupees, as everywhere else.
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
      else if (/\.(ts|astro|css|json|webmanifest|txt|xml)$/.test(name)) out.push(full.replace(/\\/g, '/'));
    }
    return out;
  };
  // src/ AND public/. The "Tiger Lee Lineage" claim survived a whole removal
  // pass inside public/manifest.webmanifest — the file a phone reads when
  // somebody installs the site — because the walker only looked at src/.
  // A guard is only as wide as the tree it walks.
  const FILES = [...sources(), ...sources('public')];
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
    // Matched on the DIGITS, with any separator between them. The first version
    // of this guard listed two spellings — bare and space-separated — and an
    // agent promptly reintroduced the number as '+91-99391-44318' with DASHES,
    // straight into the JSON-LD contactPoint, where a search engine would have
    // republished it into a knowledge panel. Structured data is more exposed
    // than a page, not less, and far harder to withdraw.
    //
    // A guard that enumerates formats catches the formats you thought of.
    expect(grep(/9[\s.\-]*9[\s.\-]*3[\s.\-]*9[\s.\-]*1[\s.\-]*4[\s.\-]*4[\s.\-]*3[\s.\-]*1[\s.\-]*8/)).toEqual([]);
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

  it('states one date for the conferral of "Junior Tiger Lee", not two', () => {
    // THE BUG THIS CATCHES, which was live.
    //
    // The honours record and the biography both said 2021. The news item was
    // dated Aug 2022 and its body read "The title was conferred on…" — so a
    // visitor on /people saw 2021 and a visitor on the news page saw 2022, for
    // the same event.
    //
    // The `date` on a news item is when it was REPORTED, which is right and
    // consistent with every other item. The body simply had to say so. The
    // federation has been angry about exactly this class of error before — a
    // 2022 event published under a 2025 date — so it gets a guard rather than
    // a correction and a hope.
    const honour = (SEED.leadership as any[])
      .flatMap((p) => p.honours ?? [])
      .find((h: any) => /junior tiger lee/i.test(h.title));
    expect(honour, 'the Junior Tiger Lee honour is no longer on record').toBeTruthy();
    expect(honour.year).toBe('2021');

    const bio = (SEED.leadership as any[]).find((p) => /pramod/i.test(p.name))?.bio ?? '';
    const inBio = [...String(bio).matchAll(/Junior Tiger Lee\D{0,40}(\d{4})/gi)].map((m) => m[1]);
    for (const y of inBio) {
      expect(y, 'the biography dates the conferral differently from the honour').toBe(honour.year);
    }

    // Any news item about the conferral must name the year the honour records,
    // so its own publication date cannot be mistaken for the event.
    const item = (SEED.news as any[]).find((n) => /junior tiger lee/i.test(n.title));
    if (item) {
      expect(
        String(item.body).includes(honour.year),
        'the news item about the conferral never states the year it happened, so its ' +
        'publication date reads as the date of the award'
      ).toBe(true);
    }
  });

  it('attributes the conferral to the master, and the corroboration to the publication', () => {
    // Two different claims with two different bases, and they must not borrow
    // each other's. WHO conferred the name is the federation's own statement;
    // that the title exists at all is corroborated by a third-party compendium.
    // Putting the master into the honour's `note` would attribute him to
    // Shivangan Publication, which never mentioned him.
    const shihan = (SEED.leadership as any[]).find((p) => /pramod/i.test(p.name));
    expect(shihan?.master?.name).toBe('Grandmaster S N T Lee');
    expect(shihan?.master?.source).toMatch(/federation/i);

    const honour = (shihan?.honours ?? []).find((h: any) => /junior tiger lee/i.test(h.title));
    expect(
      /S N T Lee|master/i.test(String(honour?.note ?? '') + String(honour?.source ?? '')),
      'the honour record names the master, which attributes him to the publication cited'
    ).toBe(false);
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
