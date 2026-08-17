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
  kata: number;
  techniques: number;
  kumiteForms: number;
  appearances: number;
  mediaAssets: number;
  mediaLinks: number;
  /** Kata whose movement count is contested and therefore stored as NULL. */
  disputed: string[];
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
export async function seedTechnicalLibrary(
  db: DB,
  determinations?: readonly CorpusDetermination[],
): Promise<SeedReport> {
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

  // ORDER MATTERS HERE, and it is the one ordering constraint in this file.
  // The video register tags 59 of its videos with a kata slug, and can only
  // turn those into review-queue rows once the kata exist. Run the register
  // first and those 59 classifications are silently lost — the import reports
  // them as unmatched, which is honest, but the queue is then missing most of
  // its actual work.
  // Default to the generated verification determinations. Loaded dynamically so
  // that a caller who wants to seed WITHOUT them (a test isolating the
  // unverified path, say) can pass an empty array and get exactly that.
  let applied = determinations;
  if (!applied) {
    try {
      const mod: any = await import('@/data/kata-verification');
      applied = mod.KATA_DETERMINATIONS ?? [];
    } catch {
      applied = [];
      notes.push('No kata verification determinations were available; counts import as unverified.');
    }
  }

  let corpus = { kata: 0, techniques: 0, kumiteForms: 0, appearances: 0, terms: 0, disputed: [] as string[] };
  try {
    corpus = await importShotokanCorpus(db, applied);
  } catch (err: any) {
    notes.push(`Shotokan corpus import skipped: ${err?.message ?? err}`);
  }

  let videos = { sources: 0, assets: 0, links: 0, unmatchedKata: [] as string[] };
  try {
    videos = await importVideoRegister(db);
  } catch (err: any) {
    notes.push(`Video register import skipped: ${err?.message ?? err}`);
  }

  notes.push(
    'Kata movement counts come from the in-repository corpus and are cited as UNVERIFIED unless a ' +
    'determination was supplied. ' + MOVEMENT_COUNT_EVIDENCE.finding,
  );
  if (corpus.disputed.length) {
    notes.push(
      `${corpus.disputed.length} kata have a DISPUTED movement count and store none: ` +
      `${corpus.disputed.join(', ')}. The competing figures are in technical_citations.`,
    );
  }
  if (videos.unmatchedKata.length) {
    notes.push(
      `The video register tagged kata not present in the corpus: ${videos.unmatchedKata.join(', ')}.`,
    );
  }
  notes.push(
    `${videos.assets} videos entered the review queue at rights "unknown". None is visible to a ` +
    'learner until both its rights and its technique are decided by a named reviewer.',
  );
  notes.push(
    'The Pramod Pathak channel is registered at tier "educational", not "mmakf_official": ' +
    'MMAKF authorisation could not be verified without YouTube Data API access.',
  );

  const citations = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.technicalCitations);

  return {
    sources: sources + videos.sources,
    curriculumItems,
    provisions,
    terms: terms + corpus.terms,
    aliases,
    citations: citations[0]?.n ?? 0,
    kata: corpus.kata,
    techniques: corpus.techniques,
    kumiteForms: corpus.kumiteForms,
    appearances: corpus.appearances,
    mediaAssets: videos.assets,
    mediaLinks: videos.links,
    disputed: corpus.disputed,
    notes,
  };
}

/**
 * A verification determination for one kata's movement count.
 *
 * Produced by a research pass, consumed by the importer. Kept as an explicit
 * input rather than read from a file so that the importer has no opinion of its
 * own about what is true — it records what it is told, and records the evidence
 * alongside.
 */
export interface CorpusDetermination {
  slug: string;
  verification: 'unverified' | 'source_documented' | 'committee_verified' | 'disputed';
  movementCount?: number | null;
  variants?: Array<{ count: number; organisation: string; url: string }>;
  citation?: { organisation: string; url: string; quote: string } | null;
  reason?: string;
}

/**
 * Bring the repository's Shotokan corpus into the database.
 *
 * WHY THIS EXISTS. Until now the federation had two Shotokan libraries that
 * could not see each other. src/data/shotokan/ holds a substantial, carefully
 * written corpus — 26 kata, ~42 techniques, 6 kumite systems, 16 concepts — and
 * renders it as static pages. The database held the tables that make a corpus
 * REVIEWABLE: provenance, movement-level detail, bunkai with attributed
 * authorship, the media graph, the approval queue. Those tables were empty, so
 * none of that machinery had anything to act on. `kata_movements.kata_id` had
 * nowhere to point, and importVideoRegister() skipped every one of its 59
 * kata-tagged videos because no kata row existed to link them to.
 *
 * This function is the bridge. The files stay canonical and are not modified;
 * the database becomes a queryable, citable, reviewable projection of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MOVEMENT-COUNT PROBLEM, HANDLED RATHER THAN HIDDEN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * src/data/kata.ts asserts a movement count for all 26 kata. The research
 * behind migration 0031 reached the opposite conclusion: the JKA instructor
 * manual requires an accurate count but does not publish one, so no count could
 * be traced to that primary source.
 *
 * Two agents, one repository, and a genuine disagreement about a fact members
 * plan their grading around. The directive is explicit about this case — do not
 * silently combine; store the source, the variant and the explanation.
 *
 * So the count is imported, and a citation is written beside it recording WHERE
 * IT CAME FROM and HOW STRONG THE CLAIM IS. `determinations` lets a verification
 * pass raise a count to 'source_documented' with a real citation, or mark it
 * 'disputed' and record the competing figures. Absent any determination the
 * honest default is 'unverified', attributed to the in-repository corpus: the
 * number is shown, and it is not dressed up as federation-verified fact.
 */
export async function importShotokanCorpus(
  db: DB,
  determinations: readonly CorpusDetermination[] = [],
): Promise<{
  kata: number; techniques: number; kumiteForms: number;
  appearances: number; terms: number; disputed: string[];
}> {
  const kataMod: any = await import('@/data/kata');
  const shotokanMod: any = await import('@/data/shotokan');

  const KATA: any[] = kataMod.KATA ?? [];
  const TECHNIQUES: any[] = shotokanMod.TECHNIQUES ?? [];
  const SYSTEMS: any[] = shotokanMod.SYSTEMS ?? [];

  const bySlug = new Map(determinations.map((d) => [d.slug, d]));
  const disputed: string[] = [];

  // The in-repository corpus, registered so records imported from it can be
  // cited to something rather than appearing from nowhere.
  const { row: corpusSource } = await upsertBySlug(db, s.technicalSources, 'mmakf-shotokan-corpus', {
    organisation: 'MMAKF technical library (in-repository Shotokan corpus)',
    sourceType: 'publication',
    authorityTier: 'educational',
    style: 'shotokan',
    language: 'en',
    rightsPolicy: 'Written for MMAKF within this repository. No third-party material is reproduced.',
    notes:
      'src/data/kata.ts and src/data/shotokan/. Authored in-repository and NOT yet reviewed by the '
      + 'MMAKF technical committee, which is why records imported from it carry verification '
      + "'unverified' unless a separate verification pass established otherwise.",
    lastReviewedOn: RETRIEVED_ON,
  });

  // ── Kata ─────────────────────────────────────────────────────────────────
  const kataIdBySlug = new Map<string, number>();
  let kataCount = 0;

  for (const k of KATA) {
    if (!k || !k.slug) continue;
    const determination = bySlug.get(k.slug);
    const verification = determination?.verification ?? 'unverified';

    // A count goes into the kata row only when something stands behind it.
    //
    // WHEN A DETERMINATION EXISTS IT IS AUTHORITATIVE, including when it says
    // null. A verification pass that looked for a source and found none has
    // made a stronger statement than one that never looked, and falling back to
    // the corpus figure would erase exactly that distinction — the reader would
    // see a number and have no way to tell it had been checked and failed.
    //
    // Where sources verifiably disagree the column is likewise NULL: a single
    // number would have to pick a winner, and picking one is the failure the
    // directive names.
    const countToStore = determination
      ? (verification === 'disputed' ? null : (determination.movementCount ?? null))
      : (k.movements ?? null);

    const { row } = await upsertBySlug(db, s.kata, k.slug, {
      nameJa: k.kanji ?? null,
      nameRomaji: k.name,
      meaning: k.meaning ?? null,
      family: k.series ?? null,
      movementCount: countToStore,
      characteristics: k.character ?? null,
      history: k.formerName ? `Renamed from ${k.formerName}.` : null,
      // `sequence` and `bunkai` stay NULL on purpose. They are jsonb blobs, and
      // kata_movements / kata_applications exist precisely so this knowledge
      // stops being a blob. Writing both would create two answers to one
      // question, and the blob is the one nothing can join to.
      sourceKind: 'reference',
      published: true,
    });
    kataIdBySlug.set(k.slug, row.id);
    kataCount++;

    if (verification === 'disputed') disputed.push(k.slug);

    if (determination?.citation) {
      await citeOnce(db, {
        subjectKind: 'kata', subjectId: row.id,
        sourceUrl: determination.citation.url,
        sourceTitle: `Movement count for ${k.name}`,
        sourceOrganisation: determination.citation.organisation,
        sourceType: 'organisation',
        retrievedOn: RETRIEVED_ON,
        quote: determination.citation.quote,
        domain: 'kata', language: 'en',
        verification,
        notes: determination.reason ?? null,
      });
    }

    for (const variant of determination?.variants ?? []) {
      await citeOnce(db, {
        subjectKind: 'kata', subjectId: row.id,
        sourceUrl: variant.url,
        sourceTitle: `${k.name}: ${variant.count} movements per ${variant.organisation}`,
        sourceOrganisation: variant.organisation,
        sourceType: 'organisation',
        retrievedOn: RETRIEVED_ON,
        domain: 'kata', language: 'en',
        verification: 'disputed',
        notes:
          'Shotokan organisations count some movements differently. This row records one '
          + "organisation's figure; it is not MMAKF's determination.",
      });
    }

    // A determination that found nothing still records that it looked. Without
    // this the kata would have no citation at all, which reads as "never
    // examined" — the opposite of what happened.
    if (determination && !determination.citation && !(determination.variants ?? []).length) {
      await citeOnce(db, {
        subjectKind: 'kata', subjectId: row.id,
        sourceId: corpusSource.id,
        sourceUrl: 'repo:src/data/kata-verification.ts',
        sourceTitle: `${k.name} — verification pass found no corroborating source`,
        sourceOrganisation: 'MMAKF technical library',
        sourceType: 'publication',
        retrievedOn: RETRIEVED_ON,
        domain: 'kata', language: 'en',
        verification: 'unverified',
        notes: determination.reason
          ?? 'A verification pass looked for a published movement count and found none.',
      });
    }

    if (!determination) {
      await citeOnce(db, {
        subjectKind: 'kata', subjectId: row.id,
        sourceId: corpusSource.id,
        sourceUrl: 'repo:src/data/kata.ts',
        sourceTitle: `${k.name} — in-repository Shotokan corpus`,
        sourceOrganisation: 'MMAKF technical library',
        sourceType: 'publication',
        retrievedOn: RETRIEVED_ON,
        domain: 'kata', language: 'en',
        verification: 'unverified',
        notes: k.movements != null
          ? `The corpus states ${k.movements} movements. No primary source was verified for this `
            + 'figure; the JKA instructor manual requires an accurate count but does not publish one.'
          : 'The corpus records no movement count for this kata.',
      });
    }
  }

  // ── Techniques ───────────────────────────────────────────────────────────
  // KihonFamily maps almost exactly onto the existing technique_category enum.
  // 'ashi_sabaki' and 'combination' have no member and become 'other' rather
  // than being forced into a neighbouring category they do not belong to.
  const CATEGORY: Record<string, string> = {
    dachi: 'dachi', uke: 'uke', tsuki: 'tsuki', uchi: 'uchi', geri: 'geri',
    tai_sabaki: 'tai_sabaki', ashi_sabaki: 'other', combination: 'other',
  };

  const techniqueIdBySlug = new Map<string, number>();
  let techniqueCount = 0;

  for (const t of TECHNIQUES) {
    if (!t || !t.slug) continue;
    const m = t.mechanics ?? {};
    // The mechanical description is split across optional fields. Joining only
    // the fields actually present keeps an empty label out of the text — "Hips:"
    // with nothing after it reads as missing data rather than as a field that
    // does not apply to this technique.
    const execution = Object.entries(m)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([key, v]) => `${key.charAt(0).toUpperCase()}${key.slice(1)}: ${v}`)
      .join('\n');

    const { row } = await upsertBySlug(db, s.techniques, t.slug, {
      nameJa: t.kanji ?? null,
      nameRomaji: t.name,
      nameEn: t.english ?? null,
      category: CATEGORY[t.family] ?? 'other',
      description: t.summary ?? null,
      execution: execution || null,
      purpose: t.application ?? null,
      breathing: m.breathing ?? null,
      commonErrors: (t.commonErrors ?? []).map((f: any) => ({ error: f.error, why: f.why })),
      corrections: (t.commonErrors ?? []).map((f: any) => ({ error: f.error, fix: f.fix })),
      sourceKind: 'reference',
      published: true,
    });
    techniqueIdBySlug.set(t.slug, row.id);
    techniqueCount++;

    // A technique the corpus itself flags as contested between organisations is
    // recorded as disputed. This is the directive's "do not silently combine"
    // rule, and the corpus already did the hard part by noticing.
    if (t.contested) {
      await citeOnce(db, {
        subjectKind: 'technique', subjectId: row.id,
        sourceId: corpusSource.id,
        sourceUrl: `repo:src/data/shotokan#${t.slug}`,
        sourceTitle: `${t.name} — contested between Shotokan organisations`,
        sourceOrganisation: 'MMAKF technical library',
        sourceType: 'publication',
        retrievedOn: RETRIEVED_ON,
        quote: t.contested,
        domain: 'kihon', language: 'en',
        verification: 'disputed',
      });
    }
  }

  // ── Kumite systems ───────────────────────────────────────────────────────
  // The slug is the enum member with hyphens swapped for underscores, which is
  // checked rather than assumed: an unrecognised system becomes 'other' instead
  // of failing the whole import.
  const KUMITE_ENUM = new Set([
    'kihon_kumite', 'yakusoku_kumite', 'gohon_kumite', 'sanbon_kumite',
    'ippon_kumite', 'jiyu_ippon_kumite', 'jiyu_kumite', 'shiai_kumite', 'other',
  ]);

  let kumiteCount = 0;
  for (const sys of SYSTEMS) {
    if (!sys || !sys.slug) continue;
    const candidate = String(sys.slug).replace(/-/g, '_');
    await upsertBySlug(db, s.kumiteForms, sys.slug, {
      system: KUMITE_ENUM.has(candidate) ? candidate : 'other',
      nameRomaji: sys.name,
      purpose: sys.purpose ?? null,
      progression: sys.progression ?? null,
      principles: (sys.structure ?? []).join(' ') || null,
      safetyNotes: (sys.safety ?? []).join(' ') || null,
      drills: sys.drills ?? null,
      sourceKind: 'reference',
      // Sport kumite is NOT published as traditional teaching material here. It
      // has its own home in sport_kumite_rulesets, where it carries an
      // effective date and a governing authority. Publishing it in both places
      // is how a learner ends up reading a competition convention as Shotokan
      // doctrine.
      published: sys.world !== 'sport',
    });
    kumiteCount++;
  }

  // ── The knowledge graph edge ─────────────────────────────────────────────
  let appearances = 0;
  for (const t of TECHNIQUES) {
    const techniqueId = techniqueIdBySlug.get(t && t.slug);
    if (!techniqueId) continue;
    for (const kataSlug of t.relatedKata ?? []) {
      const kataId = kataIdBySlug.get(kataSlug);
      if (!kataId) continue;
      const exists = await db.select().from(s.techniqueKataAppearances)
        .where(and(
          eq(s.techniqueKataAppearances.techniqueId, techniqueId),
          eq(s.techniqueKataAppearances.kataId, kataId),
        )).limit(1);
      if (exists[0]) continue;
      await db.insert(s.techniqueKataAppearances).values({
        techniqueId,
        kataId,
        // Null: the corpus records THAT it appears, not where. Inventing an
        // ordinal here would make this indistinguishable from researched
        // movement data the moment it is stored.
        movementOrdinal: null,
        note: 'Recorded by the in-repository Shotokan corpus as appearing uncontroversially.',
        verification: 'unverified',
      });
      appearances++;
    }
  }

  // ── Terms, so the corpus is searchable by name ───────────────────────────
  // Each technique gets a canonical term linked back to it, and the corpus's
  // own hand-authored aliases become alias rows. Those aliases are better than
  // anything generated: somebody who knows the art wrote them.
  let terms = 0;
  for (const t of TECHNIQUES) {
    const techniqueId = techniqueIdBySlug.get(t && t.slug);
    if (!techniqueId) continue;

    const { row } = await upsertBySlug(db, s.technicalTerms, `technique-${t.slug}`, {
      kanji: t.kanji ?? null,
      romaji: t.name,
      english: t.english ?? null,
      domain: 'kihon',
      definition: t.summary ?? null,
      techniqueId,
      verification: 'unverified',
      published: true,
    });
    terms++;

    const aliasSet = new Set<string>([
      ...(t.aliases ?? []),
      ...aliasesFor(t.name, t.english ?? null, t.slug).map((a) => a.alias),
    ]);
    for (const alias of aliasSet) {
      if (!alias || !alias.trim()) continue;
      const exists = await db.select().from(s.technicalTermAliases)
        .where(and(
          eq(s.technicalTermAliases.termId, row.id),
          eq(s.technicalTermAliases.alias, alias),
        )).limit(1);
      if (exists[0]) continue;
      await db.insert(s.technicalTermAliases).values({
        termId: row.id, alias, kind: 'romanisation', language: null,
      });
    }
  }

  return {
    kata: kataCount,
    techniques: techniqueCount,
    kumiteForms: kumiteCount,
    appearances,
    terms,
    disputed,
  };
}
