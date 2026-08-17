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

/**
 * Bring the repository's verified video register into the review queue.
 *
 * WHAT THE REGISTER ALREADY PROVED, AND WHAT IT DID NOT.
 * src/data/shotokan/video-register.ts is unusually rigorous: for every id it
 * recorded an oEmbed 200 with the exact title and channel, an embed iframe in
 * the returned html, a watch-page playabilityStatus of OK, an empty
 * blockedRegions list, and a negative control that failed as expected. That is
 * real evidence and this import does not repeat it.
 *
 * It is evidence about EXISTENCE AND TECHNICAL EMBEDDABILITY. It is not
 * evidence about RIGHTS. "YouTube will serve this in an iframe" and "MMAKF may
 * lawfully present this as its teaching material" are different claims, and the
 * first is made by a server while the second can only be made by a person. So
 * every asset imported here lands at `rights: 'unknown'` — not 'not_cleared',
 * which would wrongly imply somebody looked and refused, and emphatically not
 * 'embed_allowed', which the oEmbed check does not establish.
 *
 * `channelIsSourceOrganisation` is the register's strongest provenance signal:
 * the video sits on the channel of the organisation whose page embedded it,
 * rather than on a re-uploader's. It is recorded in the rights note because it
 * is exactly what a rights reviewer wants to know first — but it decides
 * nothing on its own.
 *
 * Every link lands at state 'new'. 125 verified videos become 125 rows for a
 * human to work through, which is the honest size of the job.
 */
export async function importVideoRegister(db: DB): Promise<{
  sources: number; assets: number; links: number; unmatchedKata: string[];
}> {
  const mod: any = await import('@/data/shotokan/video-register');
  const SOURCES: any[] = mod.SOURCES ?? [];
  const VIDEOS: any[] = mod.VIDEOS ?? [];
  const checkMethod: string = mod.CHECK_METHOD ?? '';
  const checkedOn: string = mod.REGISTER_CHECKED_ON ?? RETRIEVED_ON;

  // The register's own `kind` maps onto the directive's tiers. A university
  // club is a real Shotokan club and still Tier D — the tier describes standing
  // as a reference, not the quality of the karate.
  const TIER: Record<string, string> = {
    federation_own: 'mmakf_official',
    national_organisation: 'primary_reference',
    institutional_shotokan: 'educational',
    university_club: 'educational',
  };

  // The instructional view a video offers. The register's contentType is
  // coarser than the directive's video-type list, so this maps only what it
  // actually knows and leaves the finer roles to a reviewer.
  const ROLE: Record<string, string> = {
    kata_demonstration: 'full_performance',
    kihon_reference: 'kihon_reference',
    kumite_reference: 'kumite_reference',
    teaching_breakdown: 'breakdown',
    competition_performance: 'competition_view',
    seminar: 'seminar',
    technical_demonstration: 'demonstration',
  };

  let sources = 0;
  for (const src of SOURCES) {
    if (!src?.key) continue;
    await upsertBySlug(db, s.technicalSources, `register-${src.key}`, {
      organisation: src.organisation ?? src.key,
      sourceType: 'organisation',
      authorityTier: TIER[src.kind] ?? 'discovery',
      websiteUrl: src.url ?? null,
      style: 'shotokan',
      rightsPolicy:
        'UNKNOWN. The discovery pass verified that videos from this source are playable and ' +
        'embeddable on YouTube. It did not establish any licence to present them as MMAKF ' +
        'material. Rights are decided per asset.',
      notes: `${src.note ?? ''} Discovery pass fetched ${src.url ?? 'the source page'} on ${src.fetchedOn ?? 'an unrecorded date'}; ` +
        `${src.candidatesFound ?? 0} candidates found, ${src.candidatesVerified ?? 0} verified.`,
      lastReviewedOn: src.fetchedOn ?? checkedOn,
    });
    sources++;
  }

  let assets = 0;
  let links = 0;
  const unmatchedKata = new Set<string>();

  for (const video of VIDEOS) {
    if (!video?.id) continue;

    const existing = await db.select().from(s.mediaAssets)
      .where(and(eq(s.mediaAssets.platform, 'youtube'), eq(s.mediaAssets.externalId, video.id)))
      .limit(1);

    let asset = existing[0];
    if (!asset) {
      const inserted = await db.insert(s.mediaAssets).values({
        platform: 'youtube',
        externalId: video.id,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        title: video.title ?? video.id,
        thumbnailUrl: video.thumbnailUrl ?? null,
        durationSeconds: video.durationSeconds ?? null,
        publishedAt: video.publishedOn ? new Date(video.publishedOn) : null,
        classification: 'pending_review',
        rights: 'unknown',
        rightsHolder: video.channel ?? null,
        rightsNote:
          (video.channelIsSourceOrganisation
            ? 'The video sits on the channel of the organisation whose page embedded it, which is ' +
              'the strongest provenance the discovery pass could establish. '
            : 'The video does NOT sit on the channel of the organisation whose page embedded it. ' +
              'Treat as a possible re-upload until the rights holder is identified. ') +
          'No licence has been sought or granted.',
        consentEvidence: null,
        published: false,
      }).returning();
      asset = inserted[0];
      assets++;
    }

    // The register only claims a kata where it matched one from the platform
    // title, so this is the only classification carried over. Everything else a
    // reviewer decides.
    if (!video.kata) continue;
    const kataRow = await db.select().from(s.kata)
      .where(eq(s.kata.slug, video.kata)).limit(1);
    if (!kataRow[0]) { unmatchedKata.add(video.kata); continue; }

    const linked = await db.select().from(s.mediaTechnicalLinks)
      .where(and(
        eq(s.mediaTechnicalLinks.mediaAssetId, asset.id),
        eq(s.mediaTechnicalLinks.subjectKind, 'kata'),
        eq(s.mediaTechnicalLinks.subjectId, kataRow[0].id),
      )).limit(1);
    if (linked[0]) continue;

    await db.insert(s.mediaTechnicalLinks).values({
      mediaAssetId: asset.id,
      subjectKind: 'kata',
      subjectId: kataRow[0].id,
      role: ROLE[video.contentType] ?? 'reference',
      domain: 'kata',
      proposedBy: 'import',
      state: 'new',
    });
    links++;

    await citeOnce(db, {
      subjectKind: 'media_asset',
      subjectId: asset.id,
      sourceUrl: `https://www.youtube.com/watch?v=${video.id}`,
      sourceTitle: video.title ?? null,
      sourceAuthor: video.channel ?? null,
      sourceType: 'video',
      publicationDate: video.publishedOn ?? null,
      retrievedOn: checkedOn,
      quote: checkMethod.slice(0, 500),
      domain: 'kata',
      verification: 'source_documented',
      notes: `Discovered via source "${video.discoveredVia}".`,
    });
  }

  return { sources, assets, links, unmatchedKata: Array.from(unmatchedKata) };
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
