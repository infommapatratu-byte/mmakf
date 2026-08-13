// The Shotokan kata library.
//
// This library is the one place on the platform where an agent is invited to
// write martial-arts content at length, and that is exactly what makes it the
// most dangerous surface in the repository. Three specific failures are being
// guarded against here, each of which has a real precedent on this project:
//
//  1. A FABRICATED SYLLABUS. MMAKF has not published which kata is examined at
//     which grade. The library therefore carries a PLACE for that association
//     and nothing in it. A page that says "Heian Nidan — 8th kyu" invents
//     federation policy, and it is the failure this project treats as
//     unforgivable. The guards below read the source and refuse any grade-to-
//     kata mapping, in either direction, in data or in prose.
//
//  2. AN UNVERIFIED VIDEO. An earlier agent on this project published a link
//     recording evidence it never gathered. So a kata may carry a video ONLY
//     with the evidence of the check attached to it — the id, the channel it
//     resolved to, and the date it was checked. A video field with no evidence
//     is refused by the test, not by a code review.
//
//  3. A GLOSSARY THAT DRIFTS. The federation asked for the Japanese terms
//     explained. Twenty-six kata sharing thirty terms will, if each writes its
//     own, end up explaining `kokutsu-dachi` three different ways. The terms
//     are defined once and referenced by key, and these guards prove no kata
//     can reference a term that does not exist.
//
// Everything here is a pure data/source check: no database, no dev server.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  KATA, TERMS, FEDERATION_KATA_FOOTAGE,
  kataBySlug, kataTerms, kataWithVideo,
  type Kata,
} from '../src/data/kata';

const dataSrc = readFileSync('src/data/kata.ts', 'utf8');
const indexSrc = readFileSync('src/pages/kata/index.astro', 'utf8');
const detailSrc = readFileSync('src/pages/kata/[slug].astro', 'utf8');
const allSrc = dataSrc + indexSrc + detailSrc;

// ── the canon ───────────────────────────────────────────────────────────────

describe('the canon is complete and addressable', () => {
  it('carries all twenty-six Shotokan kata', () => {
    expect(KATA).toHaveLength(26);
  });

  it('has the five Heian, in order, as a named series', () => {
    const heian = KATA.filter((k) => k.series === 'Heian').map((k) => k.name);
    expect(heian).toEqual([
      'Heian Shodan', 'Heian Nidan', 'Heian Sandan', 'Heian Yondan', 'Heian Godan',
    ]);
  });

  it('has the three Tekki, in order, as a named series', () => {
    const tekki = KATA.filter((k) => k.series === 'Tekki').map((k) => k.name);
    expect(tekki).toEqual(['Tekki Shodan', 'Tekki Nidan', 'Tekki Sandan']);
  });

  it('carries both halves of every Dai/Sho pair', () => {
    // Shipping Bassai Dai without Bassai Sho is the classic half-done import.
    for (const stem of ['bassai', 'kanku', 'gojushiho']) {
      expect(kataBySlug(`${stem}-dai`), `${stem}-dai missing`).toBeTruthy();
      expect(kataBySlug(`${stem}-sho`), `${stem}-sho missing`).toBeTruthy();
    }
  });

  it('gives every kata a unique, URL-safe slug', () => {
    const slugs = KATA.map((k) => k.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s, `${s} is not URL-safe`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('resolves a slug to exactly one kata, and an unknown slug to null', () => {
    expect(kataBySlug('heian-shodan')?.name).toBe('Heian Shodan');
    expect(kataBySlug('kata-that-does-not-exist')).toBeNull();
    // A slug lookup that trusts user input into a property access is how
    // /kata/__proto__ becomes a 500 instead of a 404.
    expect(kataBySlug('__proto__')).toBeNull();
    expect(kataBySlug('constructor')).toBeNull();
  });

  it('writes real content in every required field, not a placeholder', () => {
    for (const k of KATA) {
      expect(k.meaning.length, `${k.name} meaning`).toBeGreaterThan(3);
      // The federation asked for "what it is" and "its benefits". A one-line
      // stub satisfies a type checker and fails the reader.
      expect(k.character.length, `${k.name} character`).toBeGreaterThan(120);
      expect(k.develops.length, `${k.name} develops`).toBeGreaterThanOrEqual(3);
      expect(k.terms.length, `${k.name} terms`).toBeGreaterThanOrEqual(3);
      expect(/TODO|TBD|Lorem|placeholder/i.test(k.character), `${k.name}`).toBe(false);
    }
  });
});

// ── the syllabus that does not exist ────────────────────────────────────────

describe('no kata claims a grade it was never assigned', () => {
  it('leaves the grade association empty on every kata', () => {
    // The FIELD exists so the federation can fill it in without a migration or
    // a redesign. It is empty because MMAKF has not published a syllabus.
    for (const k of KATA) {
      expect(k.gradeAssociation, `${k.name} has been given a grade`).toBeNull();
    }
  });

  it('exposes the empty slot as a real, typed part of the model', () => {
    // Proves the placeholder is a declared field rather than an absent one, so
    // a reader of the type knows where the syllabus goes when it arrives.
    for (const k of KATA) {
      expect(Object.prototype.hasOwnProperty.call(k, 'gradeAssociation')).toBe(true);
    }
  });

  it('never maps a kyu or dan grade to a kata anywhere in the section', () => {
    // Both directions of the sentence that must never be written:
    //   "Heian Nidan — 8th kyu"   /   "8th kyu: Heian Nidan"
    const names = KATA.map((k) => k.name.replace(/\s+/g, '\\s+')).join('|');
    const grade = String.raw`(\d+(?:st|nd|rd|th)?\s*(?:kyu|dan)|shodan|nidan|sandan|yondan|godan)`;
    // `shodan` etc. also appear INSIDE kata names (Heian Shodan), so the
    // forbidden pattern requires a grade token that is NOT part of a kata name.
    const offenders: string[] = [];
    for (const [label, src] of [['kata.ts', dataSrc], ['index.astro', indexSrc], ['[slug].astro', detailSrc]] as const) {
      const stripped = src.replace(new RegExp(names, 'gi'), '·');
      for (const re of [
        new RegExp(String.raw`·[^.\n]{0,24}${grade}`, 'gi'),
        new RegExp(`${grade}[^.\\n]{0,24}·`, 'gi'),
      ]) {
        for (const m of stripped.matchAll(re)) offenders.push(`${label}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls anything a grading kata or a requirement', () => {
    const banned = [
      /grading kata/i,
      /required (?:kata|for (?:your|the) grad)/i,
      /examination kata/i,
      /you (?:must|will) (?:perform|present) .{0,30}(?:to grade|for your)/i,
      /pass mark/i,
      /scoring criteri/i,
    ];
    const offenders = banned.filter((re) => re.test(allSrc)).map(String);
    expect(offenders).toEqual([]);
  });

  it('says outright that the federation has not published a syllabus', () => {
    // The absence must be STATED. A page that simply omits the syllabus reads
    // as an oversight; one that says it is unpublished is credible.
    expect(/has not (?:yet )?published/i.test(indexSrc)).toBe(true);
    expect(/has not (?:yet )?published/i.test(detailSrc)).toBe(true);
  });

  it('sends the reader to /belt-system from both surfaces', () => {
    expect(indexSrc).toMatch(/href="\/belt-system"/);
    expect(detailSrc).toMatch(/href="\/belt-system"/);
  });
});

// ── the glossary ────────────────────────────────────────────────────────────

describe('the Japanese terminology is defined once and explained', () => {
  it('resolves every term key every kata references', () => {
    const missing: string[] = [];
    for (const k of KATA) {
      for (const key of k.terms) if (!TERMS[key]) missing.push(`${k.name} -> ${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('returns resolved term objects, in the order the kata lists them', () => {
    const k = kataBySlug('heian-shodan')!;
    const resolved = kataTerms(k);
    expect(resolved).toHaveLength(k.terms.length);
    expect(resolved.map((t) => t.key)).toEqual(k.terms);
    for (const t of resolved) expect(t.romaji.length).toBeGreaterThan(1);
  });

  it('never leaves a term defined but unused', () => {
    // An orphan glossary entry is a term the reader can never reach.
    const used = new Set(KATA.flatMap((k) => k.terms));
    const orphans = Object.keys(TERMS).filter((key) => !used.has(key));
    expect(orphans).toEqual([]);
  });

  it('gives every term an English rendering AND an explanation of its own', () => {
    // The federation asked specifically for the terms EXPLAINED. A translation
    // is not an explanation: "kokutsu-dachi = back stance" tells a beginner
    // nothing about what the stance is or does.
    for (const [key, t] of Object.entries(TERMS)) {
      expect(t.romaji.length, key).toBeGreaterThan(1);
      expect(t.english.length, key).toBeGreaterThan(2);
      expect(t.explain.length, `${key} is translated but not explained`).toBeGreaterThan(60);
      expect(t.explain.toLowerCase()).not.toBe(t.english.toLowerCase());
    }
  });

  it('writes romaji consistently — hyphenated, never mixed with kanji', () => {
    for (const [key, t] of Object.entries(TERMS)) {
      expect(t.romaji, key).not.toMatch(/[　-鿿]/);
      if (t.kanji) expect(t.kanji, key).toMatch(/[　-鿿]/);
    }
  });

  it('keys the glossary on the romaji it describes, so a lookup is readable', () => {
    for (const [key, t] of Object.entries(TERMS)) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(key, `${key} does not match its romaji ${t.romaji}`)
        .toBe(t.romaji.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  });
});

// ── Japanese ────────────────────────────────────────────────────────────────

describe('the Japanese beside the English is real Japanese', () => {
  it('writes kanji as kanji, or writes nothing at all', () => {
    // A romaji string in the kanji field renders as a claim the page cannot
    // support. Null is honest; "Heian" in the kanji column is not.
    for (const k of KATA) {
      if (k.kanji === null) continue;
      expect(k.kanji, `${k.name}`).toMatch(/^[　-鿿゠-ヿ]+$/);
    }
  });

  it('spells the two series with the characters they share', () => {
    for (const k of KATA.filter((x) => x.series === 'Heian')) expect(k.kanji).toContain('平安');
    for (const k of KATA.filter((x) => x.series === 'Tekki')) expect(k.kanji).toContain('鉄騎');
  });

  it('marks Dai and Sho with the characters that distinguish them', () => {
    expect(kataBySlug('bassai-dai')!.kanji).toContain('大');
    expect(kataBySlug('bassai-sho')!.kanji).toContain('小');
    expect(kataBySlug('kanku-dai')!.kanji).toContain('大');
    expect(kataBySlug('kanku-sho')!.kanji).toContain('小');
  });

  it('records the Okinawan name a kata was renamed FROM, where it had one', () => {
    // Funakoshi renamed most of these. A reader who has trained elsewhere is
    // searching for the old name, and a library that only knows the new one is
    // useless to them.
    expect(kataBySlug('empi')!.formerName).toMatch(/Wanshu/i);
    expect(kataBySlug('gankaku')!.formerName).toMatch(/Chinto/i);
    expect(kataBySlug('hangetsu')!.formerName).toMatch(/Seishan|Seisan/i);
    expect(kataBySlug('kanku-dai')!.formerName).toMatch(/Kushanku|Kosokun/i);
    expect(kataBySlug('tekki-shodan')!.formerName).toMatch(/Naihanchi/i);
    expect(kataBySlug('heian-shodan')!.formerName).toMatch(/Pinan/i);
  });
});

// ── counts and kiai ─────────────────────────────────────────────────────────

describe('a number is published only where it means something', () => {
  it('keeps every kiai inside the movement count it belongs to', () => {
    // A kiai on movement 47 of a 42-movement kata is a transcription error, and
    // it is invisible to the eye once it is inside a data file.
    for (const k of KATA) {
      if (!k.kiai) continue;
      expect(k.movements, `${k.name} lists kiai but no movement count`).not.toBeNull();
      for (const point of k.kiai) {
        expect(point, `${k.name} kiai ${point}`).toBeGreaterThan(0);
        expect(point, `${k.name} kiai ${point} exceeds ${k.movements} movements`)
          .toBeLessThanOrEqual(k.movements!);
      }
      expect([...k.kiai], `${k.name} kiai out of order`).toEqual([...k.kiai].sort((a, b) => a - b));
      expect(new Set(k.kiai).size, `${k.name} repeats a kiai`).toBe(k.kiai.length);
    }
  });

  it('publishes a movement count for the two series that are settled', () => {
    for (const k of KATA.filter((x) => x.series)) {
      expect(k.movements, `${k.name}`).toBeGreaterThan(0);
    }
  });

  it('states that counts vary between organisations rather than implying a standard', () => {
    // These numbers are not the same in every Shotokan body. Printing one
    // without saying so turns a convention into a federation ruling.
    expect(/vary|varies|differ/i.test(detailSrc)).toBe(true);
  });
});

// ── video ───────────────────────────────────────────────────────────────────

describe('no video is published without the evidence of its check', () => {
  it('attaches verification evidence to every video that ships', () => {
    for (const k of kataWithVideo()) {
      const v = k.video!;
      expect(v.youtubeId, `${k.name}`).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(v.channel.length, `${k.name} video has no channel`).toBeGreaterThan(2);
      expect(v.verifiedOn, `${k.name} video has no check date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.verifiedBy.length, `${k.name} video does not say HOW it was checked`)
        .toBeGreaterThan(10);
    }
  });

  it('never presents a search as though it were the kata\'s video', () => {
    // Constructing /results?search_query=... and calling it "the video" is the
    // shortcut this project has explicitly forbidden.
    expect(allSrc).not.toMatch(/results\?search_query|\/search\?q=.*youtube/i);
  });

  it('carries no bare YouTube id outside a verified record', () => {
    // A hand-written watch URL in a template bypasses every check above.
    expect(indexSrc).not.toMatch(/youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/);
    expect(detailSrc).not.toMatch(/youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/);
  });

  it('says so on the page when a kata has no video, instead of rendering nothing', () => {
    expect(/no (?:verified )?(?:video|recording)/i.test(detailSrc)).toBe(true);
  });

  it('holds the federation\'s own footage with the same evidence discipline', () => {
    for (const f of FEDERATION_KATA_FOOTAGE) {
      expect(f.youtubeId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(f.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.verifiedBy.length).toBeGreaterThan(10);
      // This footage is general kata training. Attributing it to a named kata
      // would be exactly the guess the video rule forbids.
      expect(f.kata, 'federation footage must not claim to be a specific kata').toBeNull();
    }
  });

  it('does not let general footage masquerade as a kata recording', () => {
    const slugs = new Set(KATA.map((k) => k.slug));
    for (const f of FEDERATION_KATA_FOOTAGE) {
      expect(slugs.has(String(f.kata))).toBe(false);
    }
  });
});

// ── the surfaces ────────────────────────────────────────────────────────────

describe('the two surfaces render the library honestly', () => {
  it('links the index to every kata in the canon', () => {
    // Built from the data, not hand-listed: a hand-listed index goes stale the
    // day a kata is added.
    expect(indexSrc).toMatch(/KATA/);
    expect(indexSrc).toMatch(/\/kata\/\$\{?/);
  });

  it('404s an unknown slug rather than rendering an empty kata page', () => {
    expect(detailSrc).toMatch(/status:\s*404/);
  });

  it('declares no second <main> — the layout owns the only one', () => {
    for (const src of [indexSrc, detailSrc]) expect(src).not.toMatch(/<main[\s>]/i);
  });

  it('gives each surface a top-level heading through PageHero', () => {
    for (const src of [indexSrc, detailSrc]) expect(src).toMatch(/<PageHero\b|<h1[\s>]/);
  });

  it('never paints text with the token the audit banned', () => {
    // --muted-2 is 1.87:1 on white. tests/accessibility.test.ts enforces this
    // globally; it is repeated here so a kata-page regression names itself.
    for (const src of [indexSrc, detailSrc]) expect(src).not.toMatch(/color:\s*var\(--muted-2\)/);
  });

  it('scopes the header of any table it renders', () => {
    for (const src of [indexSrc, detailSrc]) {
      for (const th of src.match(/<th\b[^>]*>/gi) || []) expect(th).toMatch(/scope=/);
    }
  });

  it('does not describe the federation as international', () => {
    // MMAKF's jurisdiction is national. This has been got wrong before.
    expect(allSrc).not.toMatch(/international federation|worldwide federation/i);
  });
});

// ── the type surface ────────────────────────────────────────────────────────

describe('helpers behave at the edges', () => {
  it('kataWithVideo returns only kata that actually have one', () => {
    for (const k of kataWithVideo()) expect(k.video).not.toBeNull();
    const expected = KATA.filter((k: Kata) => k.video !== null).length;
    expect(kataWithVideo()).toHaveLength(expected);
  });

  it('kataTerms on a kata with no terms returns an empty array, not a throw', () => {
    expect(kataTerms({ ...KATA[0], terms: [] })).toEqual([]);
  });

  it('kataTerms drops an unknown key rather than emitting an undefined row', () => {
    // Defence in depth: the guard above forbids unknown keys in the data, and
    // this makes the renderer safe even if one ever lands.
    expect(kataTerms({ ...KATA[0], terms: ['not-a-real-term'] })).toEqual([]);
  });
});
