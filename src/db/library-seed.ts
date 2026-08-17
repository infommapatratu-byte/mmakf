// Seeding the technical library from researched primary sources.
//
// IDEMPOTENT BY SLUG. Every function here can be run repeatedly: it looks for
// the natural key first and updates rather than duplicating. That matters
// because this runs on deploy, and a seeder that doubles its rows on the second
// run is a seeder nobody dares run.
//
// EVERYTHING SEEDED HERE IS REFERENCE, NOT DOCTRINE. The JKA grading guideline
// is another federation's syllabus and lands in `reference_curricula` with
// `adopted_by_mmakf` false. The WKF rules are sport regulation. Neither is
// reachable from the MMAKF grading engine, and neither is published as MMAKF's
// technical standard by being loaded.
//
// TERMINOLOGY IS IMPORTED, NOT AUTHORED. src/data/shotokan/terminology.ts is
// the canonical Shotokan vocabulary in this repository and it is another
// agent's work. This file reads it and projects it into `technical_terms` so
// the vocabulary becomes searchable and citable; it does not restate it. If
// that file grows a term, re-running the import picks it up.

import { and, eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import {
  REFERENCE_SOURCES, JKA_GRADING_GUIDELINE, WKF_KUMITE_RULESET,
  WKF_KUMITE_PROVISIONS, RETRIEVED_ON, MOVEMENT_COUNT_EVIDENCE,
} from '@/data/technical-reference';

type DB = any;

export interface SeedReport {
  sources: number;
  curriculumItems: number;
  provisions: number;
  terms: number;
  aliases: number;
  citations: number;
  notes: string[];
}

/** Find-or-create by slug, returning the row either way. */
async function upsertBySlug(db: DB, table: any, slug: string, values: Record<string, unknown>) {
  const existing = await db.select().from(table).where(eq(table.slug, slug)).limit(1);
  if (existing[0]) {
    const updated = await db.update(table).set(values).where(eq(table.slug, slug)).returning();
    return { row: updated[0], created: false };
  }
  const inserted = await db.insert(table).values({ slug, ...values }).returning();
  return { row: inserted[0], created: true };
}

/**
 * The source registry.
 *
 * Note what the Pramod Pathak entry does NOT claim. The directive calls it the
 * MMAKF master teacher channel; this pass could not verify the authorisation,
 * so it is registered at 'educational' with the reason recorded in `notes`.
 * Promoting it is a federation decision, and leaving the honest tier in place
 * until then costs nothing except an accurate label.
 */
export async function seedSources(db: DB): Promise<number> {
  let count = 0;
  for (const src of REFERENCE_SOURCES) {
    await upsertBySlug(db, s.technicalSources, src.slug, {
      organisation: src.organisation,
      sourceType: src.sourceType,
      authorityTier: src.authorityTier,
      websiteUrl: src.websiteUrl,
      channelUrl: src.channelUrl,
      style: src.style,
      language: src.language,
      rightsPolicy: src.rightsPolicy,
      notes: src.notes,
      lastReviewedOn: RETRIEVED_ON,
    });
    count++;
  }
  return count;
}

/**
 * The JKA kyu/dan grading guideline, as reference.
 *
 * Items are replaced wholesale on re-run rather than merged. A grading
 * guideline is a document: if the transcription changes, the old rows are not
 * a history worth keeping, they are a stale copy of somebody else's syllabus.
 */
export async function seedReferenceCurriculum(db: DB): Promise<number> {
  const source = await db.select().from(s.technicalSources)
    .where(eq(s.technicalSources.slug, 'jka')).limit(1);

  const { row: curriculum } = await upsertBySlug(db, s.referenceCurricula, 'jka-kyu-dan-grading-guideline', {
    sourceId: source[0]?.id ?? null,
    organisation: 'Japan Karate Association',
    title: 'JKA Kyu / Dan Grading Guideline',
    documentUrl: 'https://www.jka.or.jp/wp/wp-content/uploads/2022/03/f421fec70fb6a7004d4e58a7cf567bb9.pdf',
    retrievedOn: RETRIEVED_ON,
    adoptedByMmakf: false,
    notes:
      'Transcribed verbatim, including the document\'s own inconsistent grade labels and ' +
      'romanisations. Covers 10th Kyu to 3rd Dan; the document continues to 5th Dan but those ' +
      'kihon lists were not fully legible in extraction and are deliberately absent rather than ' +
      'partially transcribed. NOT MMAKF CURRICULUM — see adopted_by_mmakf.',
  });

  await db.delete(s.referenceCurriculumItems)
    .where(eq(s.referenceCurriculumItems.curriculumId, curriculum.id));

  let order = 0;
  for (const item of JKA_GRADING_GUIDELINE) {
    await db.insert(s.referenceCurriculumItems).values({
      curriculumId: curriculum.id,
      gradeLabel: item.gradeLabel,
      gradeOrdinal: item.gradeOrdinal,
      component: item.component,
      requirement: item.requirement,
      detail: item.detail,
      displayOrder: order++,
    });
  }

  await citeOnce(db, {
    subjectKind: 'reference_curriculum',
    subjectId: curriculum.id,
    sourceId: source[0]?.id ?? null,
    sourceUrl: 'https://www.jka.or.jp/wp/wp-content/uploads/2022/03/f421fec70fb6a7004d4e58a7cf567bb9.pdf',
    sourceTitle: 'Kyu / Dan Grading Guideline',
    sourceOrganisation: 'Japan Karate Association',
    sourceType: 'document',
    retrievedOn: RETRIEVED_ON,
    domain: 'kihon',
    language: 'en',
    verification: 'source_documented',
  });

  return JKA_GRADING_GUIDELINE.length;
}

/** The WKF competition rules, article by article. */
export async function seedSportKumiteRules(db: DB): Promise<number> {
  const source = await db.select().from(s.technicalSources)
    .where(eq(s.technicalSources.slug, 'wkf')).limit(1);

  const { row: ruleset } = await upsertBySlug(db, s.sportKumiteRulesets, WKF_KUMITE_RULESET.slug, {
    authority: WKF_KUMITE_RULESET.authority,
    version: WKF_KUMITE_RULESET.version,
    title: WKF_KUMITE_RULESET.title,
    effectiveFrom: WKF_KUMITE_RULESET.effectiveFrom,
    status: WKF_KUMITE_RULESET.status,
    documentUrl: WKF_KUMITE_RULESET.documentUrl,
    sourceId: source[0]?.id ?? null,
    retrievedOn: RETRIEVED_ON,
    notes:
      'Sport competition regulation. NOT a description of traditional Shotokan practice: Article ' +
      '8.6 scores a jodan kick above a punch, which is a competition convention and carries no ' +
      'technical judgement about the value of a technique in kihon or kata.',
  });

  await db.delete(s.sportKumiteProvisions)
    .where(eq(s.sportKumiteProvisions.rulesetId, ruleset.id));

  let order = 0;
  for (const p of WKF_KUMITE_PROVISIONS) {
    await db.insert(s.sportKumiteProvisions).values({
      rulesetId: ruleset.id,
      article: p.article,
      clause: p.clause,
      topic: p.topic,
      heading: p.heading,
      sourceQuote: p.sourceQuote,
      appliesTo: p.appliesTo,
      displayOrder: order++,
      verification: 'source_documented',
    });
  }

  await citeOnce(db, {
    subjectKind: 'sport_kumite_ruleset',
    subjectId: ruleset.id,
    sourceId: source[0]?.id ?? null,
    sourceUrl: WKF_KUMITE_RULESET.documentUrl,
    sourceTitle: `${WKF_KUMITE_RULESET.title} (Rules Version ${WKF_KUMITE_RULESET.version})`,
    sourceOrganisation: 'World Karate Federation',
    sourceType: 'document',
    publicationDate: WKF_KUMITE_RULESET.effectiveFrom,
    retrievedOn: RETRIEVED_ON,
    domain: 'competition',
    language: 'en',
    verification: 'source_documented',
  });

  return WKF_KUMITE_PROVISIONS.length;
}

/**
 * Project the repository's canonical Shotokan vocabulary into the searchable
 * term tables.
 *
 * WHY IMPORT RATHER THAN RE-AUTHOR. src/data/shotokan/terminology.ts already
 * defines each term once, deliberately, so that twenty-six kata pages do not
 * each explain kokutsu-dachi differently. Restating those definitions here
 * would recreate exactly the drift that file exists to prevent. So this reads
 * it, and the database becomes a queryable projection of it rather than a
 * competing copy.
 *
 * ALIASES ARE GENERATED, and this is what makes search survive real users. A
 * learner types "oi zuki", "oizuki", "oi tsuki" or "oi-tsuki"; the term is
 * stored as "Oi-zuki". Each spacing and hyphenation variant becomes an alias
 * row, plus the zuki/tsuki rendering, which is the single most common
 * romanisation split in Japanese karate vocabulary.
 */
export async function importTerminology(db: DB): Promise<{ terms: number; aliases: number }> {
  const mod: any = await import('@/data/shotokan/terminology');
  const TERMS = mod.TERMS ?? {};
  const familyOf = (key: string): string => {
    const k = key.toLowerCase();
    if (k.includes('dachi') || k.includes('tai')) return 'kihon';
    if (k.includes('kumite') || k.includes('maai') || k.includes('sen')) return 'kumite';
    if (k.includes('kata') || k.includes('embusen')) return 'kata';
    if (k.includes('bunkai')) return 'bunkai';
    return 'kihon';
  };

  let terms = 0;
  let aliases = 0;

  for (const [key, value] of Object.entries<any>(TERMS)) {
    if (!value || typeof value.romaji !== 'string') continue;
    const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) continue;

    const { row } = await upsertBySlug(db, s.technicalTerms, slug, {
      kanji: value.kanji ?? null,
      romaji: value.romaji,
      english: value.english ?? null,
      domain: familyOf(key),
      definition: value.explain ?? null,
      // Imported from a reviewed in-repository source, not from the open web.
      // Still 'source_documented' rather than 'committee_verified': MMAKF's
      // technical committee has not signed this vocabulary off, and the import
      // has no authority to say it has.
      verification: 'source_documented',
      published: true,
    });
    terms++;

    for (const alias of aliasesFor(value.romaji, value.english, key)) {
      const exists = await db.select().from(s.technicalTermAliases)
        .where(and(
          eq(s.technicalTermAliases.termId, row.id),
          eq(s.technicalTermAliases.alias, alias.alias),
        )).limit(1);
      if (exists[0]) continue;
      await db.insert(s.technicalTermAliases).values({
        termId: row.id,
        alias: alias.alias,
        kind: alias.kind,
        language: alias.language,
      });
      aliases++;
    }
  }

  return { terms, aliases };
}

/**
 * Every way a learner might reasonably type a term.
 *
 * The zuki/tsuki pair is not a misspelling — both are legitimate romanisations
 * of 突き, and which one a student meets depends entirely on which book their
 * instructor learned from. Treating either as wrong would be a judgement this
 * system has no business making; treating them as the same concept is the
 * whole point of a canonical term table.
 */
function aliasesFor(romaji: string, english: string | null, key: string) {
  const out: { alias: string; kind: string; language: string | null }[] = [];
  const seen = new Set<string>();
  const push = (alias: string, kind: string, language: string | null = null) => {
    const clean = alias.trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    out.push({ alias: clean, kind, language });
  };

  const base = romaji.toLowerCase();
  push(base, 'romanisation');
  push(base.replace(/-/g, ' '), 'romanisation');
  push(base.replace(/-/g, ''), 'romanisation');
  push(key.toLowerCase(), 'romanisation');

  // zuki ⇄ tsuki, and the same for the strike/uchi family's common variants.
  const swaps: [RegExp, string][] = [
    [/zuki/g, 'tsuki'],
    [/tsuki/g, 'zuki'],
    [/geri/g, 'keri'],
    [/keri/g, 'geri'],
  ];
  for (const [pattern, replacement] of swaps) {
    if (!pattern.test(base)) continue;
    const swapped = base.replace(pattern, replacement);
    push(swapped, 'romanisation');
    push(swapped.replace(/-/g, ' '), 'romanisation');
    push(swapped.replace(/-/g, ''), 'romanisation');
  }

  if (english) push(english.toLowerCase(), 'translation', 'en');
  return out;
}

/** Insert a citation only if an identical one is not already recorded. */
async function citeOnce(db: DB, values: Record<string, any>) {
  const existing = await db.select().from(s.technicalCitations)
    .where(and(
      eq(s.technicalCitations.subjectKind, values.subjectKind),
      eq(s.technicalCitations.subjectId, values.subjectId),
      values.sourceUrl
        ? eq(s.technicalCitations.sourceUrl, values.sourceUrl)
        : sql`1 = 1`,
    )).limit(1);
  if (existing[0]) return existing[0];
  const rows = await db.insert(s.technicalCitations).values(values).returning();
  return rows[0];
}

/**
 * Run the whole seed.
 *
 * Returns a report rather than logging, so a deploy script, a test and an admin
 * screen can each present it in their own way — and so a test can assert on the
 * counts instead of scraping stdout.
 */
export async function seedTechnicalLibrary(db: DB): Promise<SeedReport> {
  const notes: string[] = [];

  const sources = await seedSources(db);
  const curriculumItems = await seedReferenceCurriculum(db);
  const provisions = await seedSportKumiteRules(db);

  let terms = 0;
  let aliases = 0;
  try {
    const imported = await importTerminology(db);
    terms = imported.terms;
    aliases = imported.aliases;
  } catch (err: any) {
    // The terminology module is another agent's file and is under active
    // development. A failure to import it must not take the rest of the seed
    // down with it, and it must be reported rather than swallowed.
    notes.push(`Terminology import skipped: ${err?.message ?? err}`);
  }

  notes.push(
    'Per-kata movement counts were NOT seeded. ' + MOVEMENT_COUNT_EVIDENCE.finding,
  );
  notes.push(
    'The Pramod Pathak channel is registered at tier "educational", not "mmakf_official": ' +
    'MMAKF authorisation could not be verified without YouTube Data API access.',
  );

  const citations = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.technicalCitations);

  return {
    sources,
    curriculumItems,
    provisions,
    terms,
    aliases,
    citations: citations[0]?.n ?? 0,
    notes,
  };
}
