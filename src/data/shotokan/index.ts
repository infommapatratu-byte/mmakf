/**
 * THE TECHNICAL LIBRARY — assembly, graph and search.
 *
 * The three divisions of Shotokan are not three lists. §27 of the directive
 * calls the relationship between them critical, and it is right: kihon is the
 * vocabulary, kata is the literature, kumite is the conversation, and a library
 * that files them separately has taught a student three subjects instead of
 * one.
 *
 * So this module builds the GRAPH. Ask it about gyaku-zuki and it answers with
 * the mechanics, the kata the technique appears in, the kumite principles that
 * use it, the drills, the terminology and the registered recordings — because
 * that is what a student actually wants when they type those two words.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE GRAPH IS ALLOWED TO ASSERT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every edge here comes from a field written by hand in the source data, and
 * every one of those fields is documented as recording only what is
 * uncontroversial. NOTHING IS INFERRED. In particular:
 *
 *   · A technique-to-kata edge exists because someone wrote that the technique
 *     appears in that kata, not because a string matched.
 *   · There are NO movement-level application edges in this file. §27 and §39
 *     both require technical review before an application becomes authoritative,
 *     and a reviewed application is a database record with a reviewer's name on
 *     it — see src/db/shotokan.ts. This module is the reviewed-free layer.
 *
 * The distinction matters. What is here is safe to render as fact because it is
 * public martial-arts knowledge. What needs a reviewer lives in the database and
 * renders with the reviewer's decision attached.
 */

import { STANCES } from './stances';
import { PUNCHES, BLOCKS, STRIKES } from './hand-techniques';
import { KICKS, MOVEMENT } from './kicks';
import type { Technique } from './kihon-types';
import { KIHON_FAMILIES, TERMS, term, type KihonFamily, type ResolvedTerm } from './terminology';
import { SYSTEMS, CONCEPTS, COMBINATION_FAMILIES, type KumiteSystem, type KumiteConcept } from './kumite';
import { VIDEOS, videosForKata, videosForTopic, type RegisteredVideo } from './video-register';
import { KATA, kataBySlug, type Kata } from '../kata';

export type { Technique, Mechanics, Fault, CurriculumPlacement } from './kihon-types';
export type { KumiteSystem, KumiteConcept, CombinationFamily, KumiteCategory } from './kumite';
export type { RegisteredVideo, VideoSource, ContentType } from './video-register';
export type { Term, ResolvedTerm, KihonFamily } from './terminology';

export { STANCES } from './stances';
export { PUNCHES, BLOCKS, STRIKES } from './hand-techniques';
export { KICKS, MOVEMENT } from './kicks';
export { SYSTEMS, CONCEPTS, COMBINATION_FAMILIES, kumiteSystem, kumiteConcept, conceptsInCategory, systemsInWorld, rulesDependentEntries } from './kumite';
export { KIHON_FAMILIES, TERMS, term, terms, allTerms, termsWithHindi, familyByKey } from './terminology';
export {
  VIDEOS, SOURCES, BARREN_SOURCES, CHECK_METHOD, REGISTER_CHECKED_ON,
  videoById, sourceByKey, videosForKata, videosForTopic, videosOfType,
  selfPublishedByOrganisation, awaitingRightsDecision, kataCoverage,
} from './video-register';

// ─── The technique catalogue ────────────────────────────────────────────────

/** Every kihon technique, in the order the families are taught. */
export const TECHNIQUES: readonly Technique[] = [
  ...STANCES,
  ...PUNCHES,
  ...BLOCKS,
  ...STRIKES,
  ...KICKS,
  ...MOVEMENT,
];

/**
 * A Map, not an object literal.
 *
 * `TECHNIQUE_BY_SLUG['__proto__']` on a plain object returns Object.prototype,
 * which is truthy — so /shotokan/techniques/__proto__ would render a page for
 * an object with no name, or throw. src/data/kata.ts made this same note for
 * the same reason; the hazard is identical and so is the fix.
 */
const BY_SLUG = new Map<string, Technique>(TECHNIQUES.map((t) => [t.slug, t]));

export function techniqueBySlug(slug: string | null | undefined): Technique | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}

export function techniquesInFamily(family: KihonFamily): Technique[] {
  return TECHNIQUES.filter((t) => t.family === family);
}

/** The families that actually contain techniques, with their members. */
export function techniqueGroups(): Array<{
  family: (typeof KIHON_FAMILIES)[number];
  members: Technique[];
}> {
  return KIHON_FAMILIES.map((family) => ({
    family,
    members: techniquesInFamily(family.key),
  })).filter((g) => g.members.length > 0);
}

// ─── The graph ──────────────────────────────────────────────────────────────

/**
 * Everything the library knows about one technique, assembled.
 *
 * This is the §35 technique page and the §26 technique-to-video graph in one
 * object, so the page has no assembly logic of its own and two surfaces cannot
 * drift into showing different neighbourhoods for the same technique.
 */
export interface TechniqueGraph {
  technique: Technique;
  /** Resolved kata records, not slugs. Unknown slugs are dropped, not faked. */
  kata: Kata[];
  kumite: KumiteConcept[];
  /** Kumite systems in which this technique is a standard part of the exercise. */
  systems: KumiteSystem[];
  glossary: ResolvedTerm[];
  /** Registered recordings tagged with this technique. Often empty. */
  videos: RegisteredVideo[];
  /** Techniques in the same family, excluding this one. */
  siblings: Technique[];
  /** Combination families this technique appears in. */
  combinations: typeof COMBINATION_FAMILIES;
}

export function techniqueGraph(slug: string): TechniqueGraph | null {
  const technique = techniqueBySlug(slug);
  if (!technique) return null;

  return {
    technique,
    kata: technique.relatedKata
      .map((s) => kataBySlug(s))
      .filter((k): k is Kata => k !== null),
    kumite: technique.relatedKumite
      .map((s) => CONCEPTS.find((c) => c.slug === s) ?? null)
      .filter((c): c is KumiteConcept => c !== null),
    systems: SYSTEMS.filter((sys) =>
      technique.relatedKumite.includes(sys.slug)
    ),
    glossary: technique.terms
      .map((k) => term(k))
      .filter((t): t is ResolvedTerm => t !== null),
    videos: videosForTopic(technique.slug),
    siblings: techniquesInFamily(technique.family).filter((t) => t.slug !== technique.slug),
    combinations: COMBINATION_FAMILIES.filter((f) => f.shape.includes(technique.slug)),
  };
}

/**
 * Everything the library knows about one kata.
 *
 * The kata records themselves live in src/data/kata.ts and are not duplicated
 * here — this assembles the NEIGHBOURHOOD around one, which is the part that
 * did not exist before.
 */
export interface KataGraph {
  kata: Kata;
  /** Techniques whose own record names this kata. Never inferred. */
  techniques: Technique[];
  /** Kumite concepts whose record names this kata. */
  kumite: KumiteConcept[];
  /** Registered recordings of this kata, most authoritative source first. */
  videos: RegisteredVideo[];
  /** Of those, the ones publishable without a rights decision. Usually none. */
  publishableVideos: RegisteredVideo[];
}

export function kataGraph(slug: string): KataGraph | null {
  const kata = kataBySlug(slug);
  if (!kata) return null;

  const videos = videosForKata(slug);
  return {
    kata,
    techniques: TECHNIQUES.filter((t) => t.relatedKata.includes(slug)),
    kumite: CONCEPTS.filter((c) => c.relatedKata.includes(slug)),
    videos,
    publishableVideos: videos.filter((v) => v.channelIsSourceOrganisation),
  };
}

/** The reverse direction: which kata a technique reaches, as a coverage table. */
export function kataTechniqueMatrix(): Array<{ kata: Kata; techniques: Technique[] }> {
  return KATA.map((k) => ({
    kata: k,
    techniques: TECHNIQUES.filter((t) => t.relatedKata.includes(k.slug)),
  }));
}

// ─── Search ─────────────────────────────────────────────────────────────────

export type ResultKind = 'technique' | 'kata' | 'kumite' | 'system' | 'term';

export interface SearchResult {
  kind: ResultKind;
  slug: string;
  title: string;
  /** One line of context, so a result list is readable without opening it. */
  subtitle: string;
  href: string;
  /** Higher is better. Exact and alias matches beat substring matches. */
  score: number;
}

/**
 * Normalise for matching.
 *
 * "gyaku zuki", "gyaku-zuki", "gyakuzuki" and "Gyaku Zuki" are the same query
 * typed by four people, and §31 requires all four to work. Hyphens, spaces and
 * apostrophes are removed rather than normalised to one separator, because
 * "ji'in" and "jiin" differ only by an apostrophe and both are written by real
 * instructors.
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    // NFKD splits an accented character into base + combining mark, and the
    .replace(/[\u0300-\u036f]/g, '')
    // than as literal combining characters, which are invisible in an editor
    // and do not survive a copy-paste through a terminal.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’\-\s_]+/g, '');
}

/**
 * Transliteration aliases for the kata canon. §2 asks for them explicitly.
 *
 * These are SPELLINGS OF THE SAME NAME, not alternative kata. Japanese written
 * in the Latin alphabet has no single correct rendering, and the variants below
 * all appear on real syllabuses printed by real organisations — a student who
 * learned "Enpi" at one dojo and searches for it here should not be told the
 * federation has never heard of it.
 *
 * Deliberately NOT stored in src/data/kata.ts: that file is the canon, and a
 * canon should carry the name a form has, not every way people have spelled it.
 * Search is where spelling variance belongs.
 */
const KATA_ALIASES: Record<string, readonly string[]> = {
  // The directive itself writes HANGESTU, and so do a good many syllabuses.
  hangetsu: ['hangestu'],
  empi: ['enpi'],
  jitte: ['jutte'],
  unsu: ['unsuu'],
  // The bare family name, which is what people actually type when there is a
  // Dai and a Sho and they only half-remember which they wanted.
  'bassai-dai': ['bassai'],
  'kanku-dai': ['kanku', 'kosokun', 'kosokun dai'],
  'kanku-sho': ['kosokun sho'],
  'gojushiho-dai': ['gojushiho', 'goju shi ho', 'goju shi ho dai'],
  'gojushiho-sho': ['goju shi ho sho'],
};

interface Indexed {
  kind: ResultKind;
  slug: string;
  title: string;
  subtitle: string;
  href: string;
  /** Normalised strings that identify this record exactly. */
  keys: string[];
  /** Normalised free text searched only as a substring. */
  body: string;
}

/**
 * The index, built once at module load.
 *
 * Deliberately NOT rebuilt per request: the data is static, the index is small,
 * and rebuilding it on every keystroke of a search box would be the slowest
 * thing on the page.
 */
const INDEX: Indexed[] = (() => {
  const out: Indexed[] = [];

  for (const t of TECHNIQUES) {
    out.push({
      kind: 'technique',
      slug: t.slug,
      title: t.name,
      subtitle: t.english,
      href: `/shotokan/techniques/${t.slug}`,
      keys: [t.slug, t.name, t.english, ...t.aliases].map(norm),
      body: norm([t.summary, t.application, ...t.principles].join(' ')),
    });
  }

  for (const k of KATA) {
    out.push({
      kind: 'kata',
      slug: k.slug,
      title: k.name,
      subtitle: k.meaning,
      href: `/kata/${k.slug}`,
      keys: [
        k.slug,
        k.name,
        k.meaning,
        // The Okinawan name Funakoshi renamed it from is already in the canon
        // file, so it is taken from there rather than restated here.
        ...(k.formerName ? [k.formerName] : []),
        ...(k.kanji ? [k.kanji] : []),
        ...(KATA_ALIASES[k.slug] ?? []),
      ].map(norm),
      body: norm([k.character, ...k.develops].join(' ')),
    });
  }

  for (const c of CONCEPTS) {
    out.push({
      kind: 'kumite',
      slug: c.slug,
      title: c.name,
      subtitle: c.english,
      href: `/shotokan/kumite/${c.slug}`,
      keys: [c.slug, c.name, c.english, ...c.aliases].map(norm),
      body: norm(c.summary),
    });
  }

  for (const s of SYSTEMS) {
    out.push({
      kind: 'system',
      slug: s.slug,
      title: s.name,
      subtitle: s.english,
      href: `/shotokan/kumite/${s.slug}`,
      keys: [s.slug, s.name, s.english, ...s.aliases].map(norm),
      body: norm(s.summary),
    });
  }

  for (const [key, t] of Object.entries(TERMS)) {
    out.push({
      kind: 'term',
      slug: key,
      title: t.romaji,
      subtitle: t.english,
      href: `/shotokan/terminology#${key}`,
      keys: [key, t.romaji, t.english, ...(t.kanji ? [t.kanji] : [])].map(norm),
      body: norm(t.explain),
    });
  }

  return out;
})();

/**
 * Search the technical library.
 *
 * Scoring, highest first:
 *   100  an exact match on a key — slug, name, English name or alias
 *    60  a key starts with the query
 *    30  a key contains the query
 *    10  the body text contains the query
 *
 * A term and a technique can legitimately share a name — `gyaku-zuki` is both —
 * and both are returned, because a student searching it wants the mechanics AND
 * the definition. The technique sorts first because it carries more.
 */
export function searchTechnical(query: string, limit = 25): SearchResult[] {
  const q = norm(query ?? '');
  if (q.length < 2) return [];

  const KIND_ORDER: Record<ResultKind, number> = {
    technique: 0, kata: 1, kumite: 2, system: 3, term: 4,
  };

  const results: SearchResult[] = [];
  for (const e of INDEX) {
    let score = 0;
    if (e.keys.includes(q)) score = 100;
    else if (e.keys.some((k) => k.startsWith(q))) score = 60;
    else if (e.keys.some((k) => k.includes(q))) score = 30;
    else if (e.body.includes(q)) score = 10;
    if (score === 0) continue;
    results.push({ kind: e.kind, slug: e.slug, title: e.title, subtitle: e.subtitle, href: e.href, score });
  }

  return results
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Every alias the search understands, for the test that proves §31's examples. */
export function allSearchKeys(): string[] {
  return [...new Set(INDEX.flatMap((e) => e.keys))];
}

// ─── Coverage, for the research matrix in §50 ───────────────────────────────

export interface CoverageRow {
  kataSlug: string;
  kataName: string;
  /** Recordings found, by source key. */
  bySource: Record<string, number>;
  total: number;
  /** How many may be shown without a human rights decision. */
  publishable: number;
  /** Techniques the library links to this kata. */
  techniques: number;
}

export function researchMatrix(): CoverageRow[] {
  return KATA.map((k) => {
    const vids = videosForKata(k.slug);
    const bySource: Record<string, number> = {};
    for (const v of vids) bySource[v.discoveredVia] = (bySource[v.discoveredVia] ?? 0) + 1;
    return {
      kataSlug: k.slug,
      kataName: k.name,
      bySource,
      total: vids.length,
      publishable: vids.filter((v) => v.channelIsSourceOrganisation).length,
      techniques: TECHNIQUES.filter((t) => t.relatedKata.includes(k.slug)).length,
    };
  });
}

/** Headline counts, for the library index and for the docs. */
export function libraryStats() {
  return {
    techniques: TECHNIQUES.length,
    stances: STANCES.length,
    punches: PUNCHES.length,
    blocks: BLOCKS.length,
    strikes: STRIKES.length,
    kicks: KICKS.length,
    kata: KATA.length,
    kumiteSystems: SYSTEMS.length,
    kumiteConcepts: CONCEPTS.length,
    combinationFamilies: COMBINATION_FAMILIES.length,
    terms: Object.keys(TERMS).length,
    videosRegistered: VIDEOS.length,
    videosPublishable: VIDEOS.filter((v) => v.channelIsSourceOrganisation).length,
    videosAwaitingRights: VIDEOS.filter((v) => !v.channelIsSourceOrganisation).length,
    kataWithFootage: new Set(VIDEOS.filter((v) => v.kata).map((v) => v.kata)).size,
  };
}
