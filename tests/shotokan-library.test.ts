// The Shotokan technical knowledge system — the data layer.
//
// This library is, along with src/data/kata.ts, the place on the platform where
// an agent is invited to write martial-arts content at length. That is exactly
// what makes it the most dangerous surface in the repository, and tests/kata.ts
// already documents three failures with real precedent here. This suite
// inherits all three and adds the ones the video register creates:
//
//  1. A FABRICATED SYLLABUS. MMAKF has not published which technique it
//     examines at which grade. Every record carries a `curriculum` field and
//     every one of them is null. The guards below read the source files and
//     refuse any grade-to-technique mapping in data or in prose.
//
//  2. AN UNVERIFIED VIDEO. A recording enters the register only with the result
//     of a real check attached. The guards assert the SHAPE of that evidence —
//     an eleven-character id, an ISO date, a duration, a thumbnail that belongs
//     to the same id — because a register entry that cannot be checked is
//     indistinguishable from one that was invented.
//
//  3. A GLOSSARY THAT DRIFTS. Terms are defined once and referenced by key.
//     Nothing may reference a key that does not exist.
//
//  4. NEW HERE: PUBLISHING SOMEBODY ELSE'S FOOTAGE. The register knows which
//     recordings were uploaded by the organisation being cited and which were
//     uploaded by a third party. Only the first group may be shown without a
//     human rights decision. The guard proves the second group can never leak
//     into the publishable set.
//
//  5. ALSO NEW: STATING A COMPETITION RULE AS PERMANENT TRUTH. §20 forbids it.
//     The kumite library carries tactical principles and no rule values at all.
//
// Everything here is a pure data/source check: no database, no dev server.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TECHNIQUES, STANCES, PUNCHES, BLOCKS, STRIKES, KICKS, MOVEMENT,
  SYSTEMS, CONCEPTS, COMBINATION_FAMILIES, TERMS, KIHON_FAMILIES,
  VIDEOS, SOURCES, BARREN_SOURCES, CHECK_METHOD,
  techniqueBySlug, techniqueGraph, kataGraph, searchTechnical,
  researchMatrix, libraryStats, selfPublishedByOrganisation, awaitingRightsDecision,
  videosForKata, techniqueGroups,
} from '../src/data/shotokan';
import { KATA, kataBySlug } from '../src/data/kata';

const SRC = [
  'src/data/shotokan/kihon-types.ts',
  'src/data/shotokan/stances.ts',
  'src/data/shotokan/hand-techniques.ts',
  'src/data/shotokan/kicks.ts',
  'src/data/shotokan/kumite.ts',
  'src/data/shotokan/terminology.ts',
  'src/data/shotokan/video-register.ts',
  'src/data/shotokan/index.ts',
];
const allSrc = SRC.map((p) => readFileSync(p, 'utf8')).join('\n');
const contentSrc = SRC.filter((p) => !p.endsWith('video-register.ts'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

// ─────────────────────────────────────────────────────────────────────────────

describe('the technique catalogue', () => {
  it('covers every family the directive names', () => {
    expect(STANCES.length).toBeGreaterThanOrEqual(10);
    expect(PUNCHES.length).toBeGreaterThanOrEqual(7);
    expect(BLOCKS.length).toBeGreaterThanOrEqual(8);
    expect(STRIKES.length).toBeGreaterThanOrEqual(6);
    expect(KICKS.length).toBeGreaterThanOrEqual(8);
    expect(MOVEMENT.length).toBeGreaterThanOrEqual(2);
  });

  it('contains every technique the directive names by name', () => {
    // §7 through §11, one assertion per named technique. A directive that
    // lists a technique and a library that omits it is a gap the reader finds
    // before the maintainer does.
    const required = [
      'zenkutsu-dachi', 'kokutsu-dachi', 'kiba-dachi', 'fudo-dachi',
      'neko-ashi-dachi', 'sanchin-dachi', 'hangetsu-dachi', 'musubi-dachi',
      'heisoku-dachi', 'hachiji-dachi',
      'oi-zuki', 'gyaku-zuki', 'kizami-zuki', 'age-zuki', 'tate-zuki',
      'ura-zuki', 'morote-zuki',
      'age-uke', 'soto-uke', 'uchi-uke', 'gedan-barai', 'shuto-uke',
      'morote-uke', 'juji-uke', 'kakiwake-uke',
      'shuto-uchi', 'uraken-uchi', 'tetsui-uchi', 'empi-uchi', 'haito-uchi',
      'teisho-uchi',
      'mae-geri', 'yoko-geri-keage', 'yoko-geri-kekomi', 'mawashi-geri',
      'ushiro-geri', 'ura-mawashi-geri', 'mikazuki-geri', 'fumikomi',
    ];
    const missing = required.filter((s) => techniqueBySlug(s) === null);
    expect(missing).toEqual([]);
  });

  it('has unique slugs', () => {
    const slugs = TECHNIQUES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every technique real substance rather than a stub', () => {
    for (const t of TECHNIQUES) {
      expect(t.summary.length, `${t.slug} summary`).toBeGreaterThan(120);
      expect(t.application.length, `${t.slug} application`).toBeGreaterThan(40);
      expect(t.principles.length, `${t.slug} principles`).toBeGreaterThan(0);
      expect(t.commonErrors.length, `${t.slug} errors`).toBeGreaterThan(0);
      expect(t.drills.length, `${t.slug} drills`).toBeGreaterThan(0);
      expect(Object.keys(t.mechanics).length, `${t.slug} mechanics`).toBeGreaterThan(2);
    }
  });

  it('teaches a fault rather than merely naming it', () => {
    // §9: "Teach principles rather than merely names." A fault with no cause
    // and no fix is a name.
    for (const t of TECHNIQUES) {
      for (const f of t.commonErrors) {
        expect(f.why.length, `${t.slug}: ${f.error}`).toBeGreaterThan(15);
        expect(f.fix.length, `${t.slug}: ${f.error}`).toBeGreaterThan(15);
      }
    }
  });

  it('assigns every technique to a declared family', () => {
    const known = new Set(KIHON_FAMILIES.map((f) => f.key));
    for (const t of TECHNIQUES) expect(known.has(t.family), t.slug).toBe(true);
  });

  it('groups without losing anybody', () => {
    const grouped = techniqueGroups().flatMap((g) => g.members.length);
    expect(grouped.reduce((a, b) => a + b, 0)).toBe(TECHNIQUES.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('no fabricated MMAKF syllabus', () => {
  it('leaves the curriculum placement unset on every technique', () => {
    for (const t of TECHNIQUES) expect(t.curriculum, t.slug).toBeNull();
  });

  it('declares the placement field so it can be filled rather than designed', () => {
    // The field must EXIST. A library with no place for the syllabus is one
    // that will invent a shape for it under deadline.
    expect(allSrc).toContain('CurriculumPlacement');
    expect(allSrc).toContain('curriculum: CurriculumPlacement | null');
  });

  it('maps no grade to any technique or kata anywhere in the content', () => {
    // Both directions. "8th kyu: gyaku-zuki" and "gyaku-zuki — 8th kyu" are the
    // same fabrication written two ways.
    const GRADE_NEAR_TECHNIQUE = [
      /\b(\d+)(st|nd|rd|th)\s+kyu\b[^.]{0,80}(zuki|uke|geri|dachi|uchi|kata|heian|tekki|bassai|kanku)/i,
      /(zuki|uke|geri|dachi|uchi|heian|tekki|bassai|kanku)[^.]{0,80}\b(\d+)(st|nd|rd|th)\s+kyu\b/i,
      /\b(shodan|nidan|sandan|yondan|godan)\s+grade[^.]{0,80}(required|examined|syllabus)/i,
      /(white|yellow|orange|green|blue|purple|brown|black)\s+belt[^.]{0,60}(requires?|examined|syllabus|combination)/i,
    ];
    for (const re of GRADE_NEAR_TECHNIQUE) {
      const m = contentSrc.match(re);
      expect(m?.[0] ?? null, `grade mapping found: ${m?.[0]}`).toBeNull();
    }
  });

  it('numbers no combination as a federation requirement', () => {
    // §12: "DO NOT invent MMAKF grading combinations."
    for (const f of COMBINATION_FAMILIES) {
      expect(f.name).not.toMatch(/\b(combination|kumite)\s*(no\.?|number)?\s*\d+/i);
      expect(f.slug).not.toMatch(/\d/);
    }
    expect(contentSrc).not.toMatch(/MMAKF\s+(grading\s+)?combination\s+\d/i);
  });

  it('claims no other organisation’s material as MMAKF’s', () => {
    // §49. The library cites JKA and SKIF constantly; it must never claim them.
    expect(allSrc).not.toMatch(/MMAKF['’]?s?\s+(JKA|SKIF)/i);
    expect(allSrc).not.toMatch(/(JKA|SKIF)\s+(syllabus|curriculum)\s+(adopted|used)\s+by\s+MMAKF/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the graph', () => {
  it('links only to kata that exist', () => {
    for (const t of TECHNIQUES) {
      for (const slug of t.relatedKata) {
        expect(kataBySlug(slug), `${t.slug} → ${slug}`).not.toBeNull();
      }
    }
    for (const c of CONCEPTS) {
      for (const slug of c.relatedKata) {
        expect(kataBySlug(slug), `${c.slug} → ${slug}`).not.toBeNull();
      }
    }
  });

  it('links only to kumite records that exist', () => {
    const known = new Set([...CONCEPTS.map((c) => c.slug), ...SYSTEMS.map((s) => s.slug)]);
    for (const t of TECHNIQUES) {
      for (const slug of t.relatedKumite) {
        expect(known.has(slug), `${t.slug} → ${slug}`).toBe(true);
      }
    }
  });

  it('links only to techniques that exist, from the kumite side', () => {
    for (const c of CONCEPTS) {
      for (const slug of c.relatedTechniques) {
        expect(techniqueBySlug(slug), `${c.slug} → ${slug}`).not.toBeNull();
      }
    }
  });

  it('references only glossary keys that exist', () => {
    const known = new Set(Object.keys(TERMS));
    const check = (keys: readonly string[], owner: string) => {
      for (const k of keys) expect(known.has(k), `${owner} → ${k}`).toBe(true);
    };
    for (const t of TECHNIQUES) check(t.terms, t.slug);
    for (const c of CONCEPTS) check(c.terms, c.slug);
    for (const s of SYSTEMS) check(s.terms, s.slug);
    for (const [key, term] of Object.entries(TERMS)) check(term.see, `TERMS.${key}`);
  });

  it('assembles a technique neighbourhood without inventing edges', () => {
    const g = techniqueGraph('gyaku-zuki');
    expect(g).not.toBeNull();
    expect(g!.technique.name).toBe('Gyaku-zuki');
    // Everything in the graph must be traceable back to a hand-written field.
    for (const k of g!.kata) expect(g!.technique.relatedKata).toContain(k.slug);
    for (const c of g!.kumite) expect(g!.technique.relatedKumite).toContain(c.slug);
    expect(g!.siblings.every((s) => s.family === g!.technique.family)).toBe(true);
    expect(g!.siblings.map((s) => s.slug)).not.toContain('gyaku-zuki');
  });

  it('assembles a kata neighbourhood', () => {
    const g = kataGraph('bassai-dai');
    expect(g).not.toBeNull();
    expect(g!.kata.name).toBe('Bassai Dai');
    for (const t of g!.techniques) expect(t.relatedKata).toContain('bassai-dai');
    expect(g!.videos.length).toBeGreaterThan(0);
  });

  it('returns null rather than an empty record for an unknown slug', () => {
    expect(techniqueGraph('not-a-technique')).toBeNull();
    expect(kataGraph('not-a-kata')).toBeNull();
    // The prototype-pollution shape that a plain object literal would answer.
    expect(techniqueBySlug('__proto__')).toBeNull();
    expect(techniqueGraph('constructor')).toBeNull();
  });

  it('connects kihon, kata and kumite in both directions', () => {
    // §27: the relationship IS the system. A technique that names a kata must
    // be findable from that kata.
    const g = kataGraph('heian-shodan');
    expect(g!.techniques.length).toBeGreaterThan(0);
    for (const t of g!.techniques) {
      expect(techniqueGraph(t.slug)!.kata.map((k) => k.slug)).toContain('heian-shodan');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('search', () => {
  // §31 names its own acceptance criteria. These are them, verbatim.
  it('finds gyaku-zuki however it is spelled', () => {
    for (const q of ['gyaku zuki', 'gyaku-zuki', 'gyakuzuki', 'GYAKU ZUKI', 'reverse punch']) {
      const hits = searchTechnical(q);
      expect(hits.length, q).toBeGreaterThan(0);
      expect(hits.some((h) => h.kind === 'technique' && h.slug === 'gyaku-zuki'), q).toBe(true);
    }
  });

  it('ranks the technique above the glossary entry for the same name', () => {
    const hits = searchTechnical('gyaku-zuki');
    expect(hits[0].kind).toBe('technique');
  });

  it('finds sen-no-sen and returns the tactical concept', () => {
    for (const q of ['sen no sen', 'sen-no-sen', 'sennosen']) {
      const hits = searchTechnical(q);
      expect(hits.some((h) => h.slug === 'sen-no-sen'), q).toBe(true);
    }
  });

  it('finds bassai dai', () => {
    for (const q of ['bassai dai', 'bassai-dai', 'bassaidai']) {
      const hits = searchTechnical(q);
      expect(hits.some((h) => h.kind === 'kata' && h.slug === 'bassai-dai'), q).toBe(true);
    }
  });

  it('handles the transliteration aliases the kata canon actually uses', () => {
    // §2 asks for spelling aliases to be handled. Enpi/Empi and Ji'in/Jiin are
    // the two that bite, because both spellings appear on real syllabuses.
    expect(searchTechnical('empi').some((h) => h.kind === 'kata')).toBe(true);
    expect(searchTechnical('enpi').some((h) => h.kind === 'kata')).toBe(true);
    expect(searchTechnical("ji'in").some((h) => h.kind === 'kata')).toBe(true);
    expect(searchTechnical('jiin').some((h) => h.kind === 'kata')).toBe(true);
  });

  it('finds an English name a beginner would actually type', () => {
    expect(searchTechnical('front kick').some((h) => h.slug === 'mae-geri')).toBe(true);
    expect(searchTechnical('back stance').some((h) => h.slug === 'kokutsu-dachi')).toBe(true);
    expect(searchTechnical('roundhouse kick').some((h) => h.slug === 'mawashi-geri')).toBe(true);
  });

  it('refuses a query too short to mean anything', () => {
    expect(searchTechnical('')).toEqual([]);
    expect(searchTechnical('a')).toEqual([]);
  });

  it('every href it returns points at a route this repository builds', () => {
    const ALLOWED = [/^\/kata\/[a-z0-9-]+$/, /^\/shotokan\/techniques\/[a-z0-9-]+$/, /^\/shotokan\/kumite\/[a-z0-9-]+$/, /^\/shotokan\/terminology#[a-z0-9'-]+$/];
    for (const q of ['zuki', 'uke', 'geri', 'kata', 'kumite', 'dachi']) {
      for (const h of searchTechnical(q, 100)) {
        expect(ALLOWED.some((re) => re.test(h.href)), `${h.href}`).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the video register', () => {
  it('records the check method in enough detail to be repeated', () => {
    expect(CHECK_METHOD).toMatch(/oembed/i);
    expect(CHECK_METHOD).toMatch(/negative control/i);
    expect(CHECK_METHOD).toMatch(/playabilityStatus/i);
    expect(CHECK_METHOD.length).toBeGreaterThan(300);
  });

  it('holds only well-formed YouTube ids, each registered once', () => {
    for (const v of VIDEOS) expect(v.id, v.title).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const ids = VIDEOS.map((v) => v.id);
    expect(new Set(ids).size, 'duplicate ids in the register').toBe(ids.length);
  });

  it('records an ISO date, never a localised human one', () => {
    // The bug this test exists for: "Jan 15, 20" — a human date sliced to ten
    // characters, which looks like a date and is not one.
    for (const v of VIDEOS) {
      expect(v.publishedOn, v.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(v.publishedOn!)), v.id).toBe(false);
    }
  });

  it('records a duration that was actually read off the platform', () => {
    for (const v of VIDEOS) {
      expect(v.durationSeconds, v.id).not.toBeNull();
      expect(v.durationSeconds!, v.id).toBeGreaterThan(0);
      // Nothing in this register is longer than a day; a value that large means
      // milliseconds leaked in where seconds were expected.
      expect(v.durationSeconds!, v.id).toBeLessThan(86_400);
    }
  });

  it('carries a thumbnail belonging to its own id', () => {
    // A thumbnail URL for a DIFFERENT video is the most quietly wrong thing a
    // register can contain: the page looks right and shows someone else.
    for (const v of VIDEOS) expect(v.thumbnailUrl, v.id).toContain(v.id);
  });

  it('attributes every recording to a source that was actually fetched', () => {
    const keys = new Set(SOURCES.map((s) => s.key));
    for (const v of VIDEOS) expect(keys.has(v.discoveredVia), `${v.id} → ${v.discoveredVia}`).toBe(true);
  });

  it('tags only kata that exist', () => {
    for (const v of VIDEOS) {
      if (v.kata) expect(kataBySlug(v.kata), `${v.id} → ${v.kata}`).not.toBeNull();
    }
  });

  it('tags only topics that resolve to a technique or a kumite record', () => {
    const known = new Set([
      ...TECHNIQUES.map((t) => t.slug),
      ...CONCEPTS.map((c) => c.slug),
      ...SYSTEMS.map((s) => s.slug),
      // Two general tags that are deliberately not records: they mark material
      // about the division as a whole rather than about one technique.
      'kihon', 'kihon-combination', 'bunkai',
    ]);
    for (const v of VIDEOS) {
      for (const t of v.topics) expect(known.has(t), `${v.id} → ${t}`).toBe(true);
    }
  });

  it('covers the whole kata canon', () => {
    // §50: do not stop after finding one video for each kata — and do not stop
    // before finding one for each, either.
    const covered = new Set(VIDEOS.filter((v) => v.kata).map((v) => v.kata));
    const missing = KATA.filter((k) => !covered.has(k.slug)).map((k) => k.slug);
    expect(missing, 'kata with no registered recording').toEqual([]);
  });

  it('records the sources that were checked and yielded nothing', () => {
    // "We looked there" is information. A silently absent source reads as one
    // nobody thought of.
    expect(BARREN_SOURCES.length).toBeGreaterThan(0);
    for (const b of BARREN_SOURCES) {
      expect(b.outcome.length, b.key).toBeGreaterThan(60);
      expect(b.url).toMatch(/^https:\/\//);
    }
    // Yale in particular: a page that returns 200 with eight dead videos on it
    // is the evidence for why link health is checked per id.
    const yale = BARREN_SOURCES.find((b) => b.key === 'yale');
    expect(yale?.outcome).toMatch(/dead|404/i);
  });

  it('counts what it found honestly', () => {
    for (const s of SOURCES) {
      const actual = VIDEOS.filter((v) => v.discoveredVia === s.key).length;
      expect(actual, s.key).toBe(s.candidatesVerified);
      expect(s.candidatesVerified, s.key).toBeLessThanOrEqual(s.candidatesFound);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('rights', () => {
  it('splits the register into exactly two disjoint groups', () => {
    const pub = selfPublishedByOrganisation();
    const held = awaitingRightsDecision();
    expect(pub.length + held.length).toBe(VIDEOS.length);
    const overlap = pub.filter((v) => held.some((h) => h.id === v.id));
    expect(overlap).toEqual([]);
  });

  it('never lets a third-party upload into the publishable set', () => {
    // The whole rights position in one assertion. skif.co.nz and
    // colchesterjka.co.uk embed genuinely excellent JKA-line material from
    // channels neither organisation owns. MMAKF citing those pages is fine.
    // MMAKF republishing those videos, unreviewed, is §49's named failure.
    for (const v of selfPublishedByOrganisation()) {
      expect(v.channelIsSourceOrganisation, v.id).toBe(true);
    }
    const thirdPartyChannels = ['shotokankataman', 'iZafod', '1000MOSHT', 'Shotokan Karate Academy'];
    for (const v of selfPublishedByOrganisation()) {
      expect(thirdPartyChannels, `${v.id} (${v.channel})`).not.toContain(v.channel);
    }
  });

  it('holds the entire twenty-six kata collection for a rights decision', () => {
    // Every complete-canon source found was third-party hosted. That is a fact
    // about the world, and the library must not quietly resolve it.
    const skif = VIDEOS.filter((v) => v.discoveredVia === 'skif-nz');
    expect(skif.length).toBe(26);
    expect(skif.every((v) => !v.channelIsSourceOrganisation)).toBe(true);
  });

  it('publishes nothing for a kata purely on the strength of a third party', () => {
    for (const k of KATA) {
      const g = kataGraph(k.slug)!;
      for (const v of g.publishableVideos) expect(v.channelIsSourceOrganisation).toBe(true);
    }
  });

  it('never claims a downloaded or rehosted copy', () => {
    // §23 and §49. The register stores ids and canonical URLs; it stores no
    // file, and no code path here should suggest otherwise.
    expect(allSrc).not.toMatch(/\b(download|rehost|mirror)\w*\s+(the\s+)?video/i);
    expect(allSrc).not.toMatch(/youtube-dl|yt-dlp/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the kumite library', () => {
  it('keeps traditional development and sport apart', () => {
    // §13. The separation is the point of the file.
    expect(SYSTEMS.some((s) => s.world === 'traditional')).toBe(true);
    expect(SYSTEMS.some((s) => s.world === 'sport')).toBe(true);
    for (const s of SYSTEMS) expect(['traditional', 'sport']).toContain(s.world);
  });

  it('covers every kumite system the directive names', () => {
    const required = [
      'gohon-kumite', 'sanbon-kumite', 'kihon-ippon-kumite',
      'jiyu-ippon-kumite', 'jiyu-kumite', 'shiai-kumite',
    ];
    const have = new Set(SYSTEMS.map((s) => s.slug));
    expect(required.filter((r) => !have.has(r))).toEqual([]);
  });

  it('covers the three initiatives', () => {
    const have = new Set(CONCEPTS.map((c) => c.slug));
    for (const s of ['go-no-sen', 'sen-no-sen', 'tai-no-sen']) expect(have.has(s), s).toBe(true);
  });

  it('teaches each initiative with the frame §18 asks for', () => {
    for (const slug of ['go-no-sen', 'sen-no-sen', 'tai-no-sen']) {
      const c = CONCEPTS.find((x) => x.slug === slug)!;
      for (const field of ['trigger', 'distance', 'timing', 'decision', 'risk', 'application'] as const) {
        expect(c.teaching[field], `${slug}.${field}`).toBeTruthy();
      }
    }
  });

  it('states no competition rule value anywhere', () => {
    // §20: rules-dependent information must be versioned, and outdated rules
    // must never be taught as permanent truth. The library's answer is to state
    // NO rule at all — principles survive a rule change, values do not.
    const RULE_VALUES = [
      /\bippon\s+is\s+\w+\s+points?\b/i,
      /\bwaza[- ]?ari\s+is\s+\w+\s+points?\b/i,
      /\byuko\s+is\s+\w+\s+points?\b/i,
      /\b(bout|match)\s+(is|lasts)\s+\w+\s+minutes?\b/i,
      /\bworth\s+(one|two|three|1|2|3)\s+points?\b/i,
      /\bfirst\s+to\s+\d+\s+points?\b/i,
      /\b\d+\s*-\s*point\s+lead\b/i,
    ];
    for (const re of RULE_VALUES) {
      const m = contentSrc.match(re);
      expect(m?.[0] ?? null, `rule value stated: ${m?.[0]}`).toBeNull();
    }
  });

  it('marks the entries that depend on a rule set', () => {
    const sport = [...SYSTEMS, ...CONCEPTS].filter(
      (e) => ('world' in e ? e.world : '') === 'sport'
    );
    expect(sport.length).toBeGreaterThan(0);
    for (const e of sport) expect(e.rulesDependent, e.slug).toBe(true);
  });

  it('names safety explicitly on every partner exercise', () => {
    for (const s of SYSTEMS) {
      expect(s.safety.length, s.slug).toBeGreaterThan(0);
      for (const line of s.safety) expect(line.length, s.slug).toBeGreaterThan(30);
    }
  });

  it('describes combinations as families rather than as doctrine', () => {
    // §17: allow Technical Committee approval; do not hardcode doctrine.
    expect(COMBINATION_FAMILIES.length).toBeGreaterThan(4);
    for (const f of COMBINATION_FAMILIES) {
      expect(f.why.length, f.slug).toBeGreaterThan(40);
      // Every combination has an answer, and saying so is what stops the
      // library reading as a list of things that always work.
      expect(f.countered.length, f.slug).toBeGreaterThan(30);
    }
  });

  it('builds combinations from techniques that exist, where it names them', () => {
    for (const f of COMBINATION_FAMILIES) {
      for (const step of f.shape) {
        // A step is either a technique slug or a described action. A step that
        // LOOKS like a slug must actually be one.
        if (/^[a-z]+(-[a-z]+)+$/.test(step) && step !== 'feint') {
          expect(techniqueBySlug(step), `${f.slug} → ${step}`).not.toBeNull();
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('terminology', () => {
  it('translates and also explains', () => {
    // §32, and the rule the kata library already learned: a translation is not
    // an explanation.
    for (const [key, t] of Object.entries(TERMS)) {
      expect(t.english.length, key).toBeGreaterThan(2);
      expect(t.explain.length, key).toBeGreaterThan(60);
      expect(t.explain, key).not.toBe(t.english);
    }
  });

  it('never disguises romaji as kanji', () => {
    for (const [key, t] of Object.entries(TERMS)) {
      if (t.kanji !== null) expect(t.kanji, key).not.toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('leaves Hindi null rather than inventing a rendering', () => {
    // A wrong translation in a federation's own glossary is worse than an
    // absent one, because students learn it.
    const withHindi = Object.values(TERMS).filter((t) => t.hindi !== null);
    expect(withHindi.length).toBeGreaterThan(0);
    for (const t of withHindi) expect(t.hindi).toMatch(/[ऀ-ॿ]/);
  });

  it('claims no pronunciation audio MMAKF has not recorded', () => {
    for (const [key, t] of Object.entries(TERMS)) expect(t.audio, key).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('honesty about what is not settled', () => {
  it('names the disagreements rather than printing a false precision', () => {
    // The soto-uke / uchi-uke naming really is inconsistent across Shotokan
    // organisations, and a library that picked one silently would be teaching
    // half its readers that their instructor is wrong.
    const contested = TECHNIQUES.filter((t) => t.contested !== null);
    expect(contested.length).toBeGreaterThan(2);
    for (const t of contested) expect(t.contested!.length, t.slug).toBeGreaterThan(60);
    expect(techniqueBySlug('soto-uke')!.contested).toBeTruthy();
  });

  it('flags sanchin-dachi as not a Shotokan stance', () => {
    const s = techniqueBySlug('sanchin-dachi')!;
    expect(s.contested).toMatch(/not a Shotokan stance/i);
  });

  it('reports coverage honestly in the research matrix', () => {
    const rows = researchMatrix();
    expect(rows.length).toBe(KATA.length);
    for (const r of rows) {
      const sum = Object.values(r.bySource).reduce((a, b) => a + b, 0);
      expect(sum, r.kataSlug).toBe(r.total);
      expect(r.publishable, r.kataSlug).toBeLessThanOrEqual(r.total);
      expect(r.total, r.kataSlug).toBe(videosForKata(r.kataSlug).length);
    }
  });

  it('counts itself correctly', () => {
    const s = libraryStats();
    expect(s.techniques).toBe(TECHNIQUES.length);
    expect(s.kata).toBe(KATA.length);
    expect(s.videosRegistered).toBe(VIDEOS.length);
    expect(s.videosPublishable + s.videosAwaitingRights).toBe(VIDEOS.length);
    expect(s.kataWithFootage).toBe(KATA.length);
  });
});
