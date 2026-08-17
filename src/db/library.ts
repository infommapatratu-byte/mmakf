// The technical library's read, write and review paths.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. A learner may only ever be shown a
// video MMAKF is entitled to show them, in the manner it is entitled to show it.
// "Publicly viewable on YouTube" is not a licence, and the difference between
// embedding a video and linking to it is the difference between serving
// somebody else's work from our page and pointing at theirs.
//
// So rights are not a label on a form. `mediaUse()` below is the single
// function that decides what may be done with an asset, every read path calls
// it, and `publishLink()` refuses rather than trusting a reviewer to remember.
// The migration's CHECK constraints cover the other half — that an approval
// always names a human — and between them there is no code path, and no
// classifier, that can put unapproved or unlicensed material in front of a
// learner.
//
// WHY THE REVIEW FUNCTIONS TAKE A PRINCIPAL AND WRITE AUDIT. Every state
// transition here is a decision somebody must be able to answer for later:
// which reviewer accepted this bunkai as MMAKF's reading, who cleared the
// rights on that seminar recording. `technical_reviews` keeps the trail even
// when the subject row is later revised.

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere, canAnywhere, type Principal } from '@/lib/rbac';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

// ─── Rights ─────────────────────────────────────────────────────────────────

/** What MMAKF may do with a piece of media. */
export type MediaUse = 'embed' | 'link' | 'none';

/**
 * The rights decision, in one place.
 *
 * 'embed'  — MMAKF owns it, licensed it, cleared it, or the rights holder
 *            permits embedding. The player may be served on an MMAKF page.
 * 'link'   — we may point a learner at the original and nothing more. This is
 *            the honest answer for material that is freely viewable at source
 *            but not ours to re-serve.
 * 'none'   — nobody has checked ('unknown'), somebody is still asking
 *            ('permission_pending'), or the answer was no ('not_cleared',
 *            'restricted', 'do_not_use'). All four produce the same behaviour
 *            and are kept distinct because they need different follow-up.
 *
 * Anything unrecognised returns 'none'. A rights value this function has never
 * heard of is precisely when it must not guess.
 */
export function mediaUse(rights: string | null | undefined): MediaUse {
  switch (rights) {
    case 'federation_owned':
    case 'licensed':
    case 'cleared':
    case 'embed_allowed':
      return 'embed';
    case 'link_only':
      return 'link';
    case 'unknown':
    case 'permission_pending':
    case 'not_cleared':
    case 'restricted':
    case 'do_not_use':
      return 'none';
    default:
      return 'none';
  }
}

/** True when an asset may appear on a learner-facing page in any form. */
export function isShowable(rights: string | null | undefined): boolean {
  return mediaUse(rights) !== 'none';
}

/**
 * The attribution label the directive requires every video to carry.
 *
 * A learner must never have to guess whether they are watching MMAKF's own
 * teaching or a third party's. The label is derived from the asset, not typed
 * by whoever added it, so it cannot drift from the record.
 */
export function authorityLabel(asset: {
  classification?: string | null;
  rights?: string | null;
  sourceTier?: string | null;
}): string {
  if (asset.classification === 'federation_official' || asset.rights === 'federation_owned') {
    return 'MMAKF OFFICIAL';
  }
  if (asset.sourceTier === 'competition_authority') return 'COMPETITION REFERENCE';
  if (asset.classification === 'master_teaching') return 'MMAKF APPROVED REFERENCE';
  return 'EXTERNAL REFERENCE';
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Published kata, for the learn surface. */
export async function listKata(db: DB, opts: { includeUnpublished?: boolean } = {}) {
  const where = opts.includeUnpublished ? undefined : eq(s.kata.published, true);
  return db.select().from(s.kata).where(where).orderBy(asc(s.kata.nameRomaji));
}

/**
 * One kata with everything hanging off it.
 *
 * Movements come back ordered and complete, including the ones that are almost
 * entirely null — a movement documented only as "turn 90 degrees left" is still
 * a movement, and hiding it would misrepresent the kata's length.
 */
export async function getKata(db: DB, slug: string, opts: { includeUnpublished?: boolean } = {}) {
  const rows = await db.select().from(s.kata).where(eq(s.kata.slug, slug)).limit(1);
  const record = rows[0];
  if (!record) return null;
  if (!record.published && !opts.includeUnpublished) return null;

  const [movements, applications, citations] = await Promise.all([
    db.select().from(s.kataMovements)
      .where(eq(s.kataMovements.kataId, record.id))
      .orderBy(asc(s.kataMovements.ordinal)),
    db.select().from(s.kataApplications)
      .where(opts.includeUnpublished
        ? eq(s.kataApplications.kataId, record.id)
        : and(eq(s.kataApplications.kataId, record.id), eq(s.kataApplications.published, true)))
      .orderBy(asc(s.kataApplications.movementFrom)),
    citationsFor(db, 'kata', record.id),
  ]);

  const media = await mediaFor(db, 'kata', record.id, opts);

  return { kata: record, movements, applications, citations, media };
}

/** Provenance for one record. Empty means unsourced, and callers should say so. */
export async function citationsFor(db: DB, subjectKind: string, subjectId: number) {
  return db.select().from(s.technicalCitations)
    .where(and(
      eq(s.technicalCitations.subjectKind, subjectKind),
      eq(s.technicalCitations.subjectId, subjectId),
    ))
    .orderBy(asc(s.technicalCitations.id));
}

/**
 * Approved, rights-permitted media for a subject.
 *
 * TWO filters, both necessary. `state` gates on technical approval; `mediaUse`
 * gates on rights. An asset that passes review but whose rights are unknown
 * comes back excluded — which is why the rights check happens here rather than
 * in a template somebody might forget to write.
 */
export async function mediaFor(
  db: DB,
  subjectKind: string,
  subjectId: number,
  opts: { includeUnpublished?: boolean } = {},
) {
  const states = opts.includeUnpublished
    ? ['new', 'classified', 'rights_review', 'technical_review', 'approved', 'published', 'rejected', 'archived']
    : ['approved', 'published'];

  const rows = await db.select({
    link: s.mediaTechnicalLinks,
    asset: s.mediaAssets,
  })
    .from(s.mediaTechnicalLinks)
    .innerJoin(s.mediaAssets, eq(s.mediaTechnicalLinks.mediaAssetId, s.mediaAssets.id))
    .where(and(
      eq(s.mediaTechnicalLinks.subjectKind, subjectKind),
      eq(s.mediaTechnicalLinks.subjectId, subjectId),
      inArray(s.mediaTechnicalLinks.state, states as any),
    ))
    .orderBy(asc(s.mediaTechnicalLinks.id));

  return rows
    .map((r: any) => ({
      ...r.link,
      asset: r.asset,
      use: mediaUse(r.asset?.rights),
      label: authorityLabel(r.asset ?? {}),
    }))
    .filter((r: any) => opts.includeUnpublished || r.use !== 'none');
}

/** Chapters for a video, in order. */
export async function chaptersFor(db: DB, mediaAssetId: number) {
  return db.select().from(s.mediaChapters)
    .where(eq(s.mediaChapters.mediaAssetId, mediaAssetId))
    .orderBy(asc(s.mediaChapters.ordinal));
}

/** A competition ruleset with its provisions, in document order. */
export async function getRuleset(db: DB, slug: string) {
  const rows = await db.select().from(s.sportKumiteRulesets)
    .where(eq(s.sportKumiteRulesets.slug, slug)).limit(1);
  const ruleset = rows[0];
  if (!ruleset) return null;
  const provisions = await db.select().from(s.sportKumiteProvisions)
    .where(eq(s.sportKumiteProvisions.rulesetId, ruleset.id))
    .orderBy(asc(s.sportKumiteProvisions.displayOrder));
  return { ruleset, provisions };
}

/** Another organisation's curriculum, grouped by the grade labels it uses. */
export async function getReferenceCurriculum(db: DB, slug: string) {
  const rows = await db.select().from(s.referenceCurricula)
    .where(eq(s.referenceCurricula.slug, slug)).limit(1);
  const curriculum = rows[0];
  if (!curriculum) return null;
  const items = await db.select().from(s.referenceCurriculumItems)
    .where(eq(s.referenceCurriculumItems.curriculumId, curriculum.id))
    .orderBy(asc(s.referenceCurriculumItems.displayOrder));

  const grades: { label: string; ordinal: number | null; items: any[] }[] = [];
  for (const item of items) {
    let grade = grades.find((g) => g.label === item.gradeLabel);
    if (!grade) {
      grade = { label: item.gradeLabel, ordinal: item.gradeOrdinal ?? null, items: [] };
      grades.push(grade);
    }
    grade.items.push(item);
  }
  return { curriculum, grades };
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Terminology search that tolerates how people actually type Japanese.
 *
 * "oi zuki", "oi tsuki", "oizuki" and "lunge punch" must all reach the same
 * term. Two mechanisms do that: aliases are stored rows (including known
 * misspellings), and the comparison strips spaces and hyphens on both sides so
 * a learner is not punished for a missing hyphen.
 *
 * Deliberately NOT full-text search over descriptions. A learner typing a
 * technique name wants the technique, not every page that mentions it, and a
 * relevance ranker would bury the canonical term under prose.
 */
export async function searchTerms(db: DB, query: string, opts: { includeUnpublished?: boolean } = {}) {
  const raw = (query || '').trim().toLowerCase();
  if (raw.length < 2) return [];
  const squashed = raw.replace(/[\s\-_.]/g, '');
  const like = `%${raw}%`;

  const normalise = (col: any) =>
    sql`replace(replace(replace(lower(${col}), ' ', ''), '-', ''), '_', '')`;

  const aliasHits = await db.select({ termId: s.technicalTermAliases.termId })
    .from(s.technicalTermAliases)
    .where(or(
      sql`${normalise(s.technicalTermAliases.alias)} = ${squashed}`,
      sql`${normalise(s.technicalTermAliases.alias)} LIKE ${'%' + squashed + '%'}`,
    ));

  const ids: number[] = Array.from(new Set(aliasHits.map((r: any) => Number(r.termId))));

  const conditions = [
    sql`${normalise(s.technicalTerms.romaji)} LIKE ${'%' + squashed + '%'}`,
    sql`${normalise(s.technicalTerms.slug)} LIKE ${'%' + squashed + '%'}`,
    sql`lower(coalesce(${s.technicalTerms.english}, '')) LIKE ${like}`,
  ];
  if (ids.length) conditions.push(inArray(s.technicalTerms.id, ids));

  const where = opts.includeUnpublished
    ? or(...conditions)
    : and(eq(s.technicalTerms.published, true), or(...conditions));

  const terms = await db.select().from(s.technicalTerms).where(where)
    .orderBy(asc(s.technicalTerms.romaji)).limit(50);

  // Exact matches first: somebody typing "gyaku-zuki" means gyaku-zuki, and it
  // should not sit below "gyaku-zuki (jodan)" because of alphabetical order.
  return terms.sort((a: any, b: any) => {
    const an = a.romaji.toLowerCase().replace(/[\s\-_.]/g, '');
    const bn = b.romaji.toLowerCase().replace(/[\s\-_.]/g, '');
    if (an === squashed && bn !== squashed) return -1;
    if (bn === squashed && an !== squashed) return 1;
    return a.romaji.localeCompare(b.romaji);
  });
}

/**
 * Everything the library knows that touches a term — the knowledge graph query.
 *
 * This is the difference between a playlist and a library: one search for
 * "gyaku-zuki" returns the definition, the kata movements it appears in, and
 * the approved video that teaches it, because those are edges in the data
 * rather than a curated list somebody maintains by hand.
 */
export async function technicalLookup(db: DB, query: string) {
  const terms = await searchTerms(db, query);
  if (!terms.length) return { terms: [], appearances: [], media: [] };

  const techniqueIds = terms.map((t: any) => t.techniqueId).filter(Boolean);
  const appearances = techniqueIds.length
    ? await db.select({
        movement: s.kataMovements,
        kata: s.kata,
      })
        .from(s.kataMovements)
        .innerJoin(s.kata, eq(s.kataMovements.kataId, s.kata.id))
        .where(and(
          inArray(s.kataMovements.techniqueId, techniqueIds),
          eq(s.kata.published, true),
        ))
        .orderBy(asc(s.kata.nameRomaji), asc(s.kataMovements.ordinal))
        .limit(100)
    : [];

  const media = techniqueIds.length
    ? (await Promise.all(techniqueIds.map((id: number) => mediaFor(db, 'technique', id)))).flat()
    : [];

  return { terms, appearances, media };
}

// ─── Review queue ───────────────────────────────────────────────────────────

export interface QueueFilters {
  state?: string;
  limit?: number;
}

/**
 * The admin review queue.
 *
 * Ordered oldest first, deliberately: a queue that surfaces the newest item
 * first is a queue where the oldest item is never reached.
 */
export async function reviewQueue(db: DB, principal: Principal, filters: QueueFilters = {}) {
  assertCanAnywhere(principal, 'technical:read');
  const limit = Math.min(filters.limit ?? 100, 500);

  const where = filters.state
    ? eq(s.mediaTechnicalLinks.state, filters.state as any)
    : inArray(s.mediaTechnicalLinks.state, ['new', 'classified', 'rights_review', 'technical_review'] as any);

  const rows = await db.select({
    link: s.mediaTechnicalLinks,
    asset: s.mediaAssets,
  })
    .from(s.mediaTechnicalLinks)
    .innerJoin(s.mediaAssets, eq(s.mediaTechnicalLinks.mediaAssetId, s.mediaAssets.id))
    .where(where)
    .orderBy(asc(s.mediaTechnicalLinks.createdAt))
    .limit(limit);

  return rows.map((r: any) => ({
    ...r.link,
    asset: r.asset,
    use: mediaUse(r.asset?.rights),
    label: authorityLabel(r.asset ?? {}),
    // Surfaced so a reviewer sees the blocker before opening the row: there is
    // no point deciding the technical question on a video we may not use.
    rightsBlocked: mediaUse(r.asset?.rights) === 'none',
  }));
}

/** Records with no provenance at all — the directive's "every record cited" check. */
export async function unsourcedRecords(db: DB, principal: Principal, subjectKind: string) {
  assertCanAnywhere(principal, 'technical:read');
  const table: any = subjectKind === 'kata' ? s.kata
    : subjectKind === 'technique' ? s.techniques
    : subjectKind === 'kata_application' ? s.kataApplications
    : null;
  if (!table) return [];

  return db.select().from(table).where(sql`NOT EXISTS (
    SELECT 1 FROM technical_citations c
    WHERE c.subject_kind = ${subjectKind} AND c.subject_id = ${table.id}
  )`).limit(200);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export class LibraryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

/**
 * Propose a link between a video and a technical subject.
 *
 * ALWAYS lands at 'new', whatever the caller asks for, and that is the whole
 * point of the function. The AI classifier calls this; so does a human curator.
 * Neither can create an approved link, because approval is a different function
 * with a different permission and a CHECK constraint behind it.
 */
export async function proposeLink(
  db: DB,
  ctx: AuditContext,
  input: {
    mediaAssetId: number;
    subjectKind: string;
    subjectId: number;
    role?: string;
    startSeconds?: number | null;
    endSeconds?: number | null;
    label?: string | null;
    domain?: string | null;
    proposedBy?: 'ai' | 'human' | 'import';
    confidence?: number | null;
  },
) {
  const rows = await db.insert(s.mediaTechnicalLinks).values({
    mediaAssetId: input.mediaAssetId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    role: input.role ?? 'reference',
    startSeconds: input.startSeconds ?? null,
    endSeconds: input.endSeconds ?? null,
    label: input.label ?? null,
    domain: (input.domain ?? null) as any,
    proposedBy: input.proposedBy ?? 'human',
    confidence: input.confidence ?? null,
    state: 'new',
  }).returning();

  const link = rows[0];
  await writeAudit(db, ctx, {
    entityType: 'media_technical_link',
    entityId: link.id,
    action: 'create',
    newValue: { subjectKind: input.subjectKind, subjectId: input.subjectId, proposedBy: link.proposedBy },
  });
  return link;
}

/**
 * Move a link through the review pipeline.
 *
 * THE TWO REFUSALS, and neither is negotiable:
 *
 *  · Approving or publishing requires 'technical:review'. Reading the queue is
 *    a lesser authority than deciding on it.
 *
 *  · Approving or publishing requires the ASSET'S RIGHTS to permit use. A
 *    reviewer cannot approve their way past 'unknown'; the rights question has
 *    to be answered on the asset first. This is the check that stops a
 *    well-meaning technical reviewer from publishing an infringement.
 */
export async function reviewLink(
  db: DB,
  ctx: AuditContext,
  input: {
    id: number;
    toState: string;
    /**
     * The person making the decision. Explicit rather than derived from the
     * principal, following policy.ts: a `Principal` identifies a USER account,
     * and an approval has to name a PERSON in the register. The endpoint knows
     * the mapping; this layer refuses to guess it.
     */
    reviewerPersonId?: number | null;
    dimension?: string;
    note?: string | null;
    evidenceUrl?: string | null;
  },
) {
  assertCanAnywhere(ctx.principal, 'technical:review');

  const rows = await db.select({ link: s.mediaTechnicalLinks, asset: s.mediaAssets })
    .from(s.mediaTechnicalLinks)
    .innerJoin(s.mediaAssets, eq(s.mediaTechnicalLinks.mediaAssetId, s.mediaAssets.id))
    .where(eq(s.mediaTechnicalLinks.id, input.id))
    .limit(1);
  const current = rows[0];
  if (!current) throw new LibraryError('not_found', `No media link ${input.id}.`);

  const approving = input.toState === 'approved' || input.toState === 'published';

  if (approving && mediaUse(current.asset.rights) === 'none') {
    throw new LibraryError(
      'rights_not_cleared',
      `Cannot ${input.toState === 'published' ? 'publish' : 'approve'} this link: the video's rights are ` +
      `'${current.asset.rights}', which does not permit MMAKF to show it. Resolve the rights on the asset first.`,
    );
  }

  const personId = input.reviewerPersonId ?? null;
  if (approving && !personId) {
    throw new LibraryError(
      'no_reviewer',
      'Approval must name the person who made it.',
    );
  }

  const updated = await db.update(s.mediaTechnicalLinks)
    .set({
      state: input.toState as any,
      reviewedByPersonId: approving ? personId : current.link.reviewedByPersonId,
      reviewedAt: approving ? new Date() : current.link.reviewedAt,
    })
    .where(eq(s.mediaTechnicalLinks.id, input.id))
    .returning();

  await db.insert(s.technicalReviews).values({
    subjectKind: 'media_technical_link',
    subjectId: input.id,
    dimension: input.dimension ?? 'technical',
    fromState: current.link.state,
    toState: input.toState as any,
    reviewerPersonId: personId,
    note: input.note ?? null,
    evidenceUrl: input.evidenceUrl ?? null,
  });

  await writeAudit(db, ctx, {
    entityType: 'media_technical_link',
    entityId: input.id,
    action: input.toState === 'rejected' ? 'reject' : approving ? 'approve' : 'update',
    oldValue: { state: current.link.state },
    newValue: { state: input.toState },
  });

  return updated[0];
}

/**
 * Endorse an application as MMAKF's reading.
 *
 * Takes the row from whatever interpretation it was to 'mmakf_approved', and
 * stamps the approver. The CHECK constraint means this function is the ONLY
 * way that value can legitimately appear — an UPDATE that forgot the approver
 * would be rejected by the database.
 */
export async function approveApplication(
  db: DB,
  ctx: AuditContext,
  input: { id: number; approvedByPersonId?: number | null; note?: string | null },
) {
  assertCanAnywhere(ctx.principal, 'technical:review');
  const personId = input.approvedByPersonId ?? null;
  if (!personId) {
    throw new LibraryError(
      'no_approver',
      'An MMAKF-approved application must name the person who approved it.',
    );
  }

  const existing = await db.select().from(s.kataApplications)
    .where(eq(s.kataApplications.id, input.id)).limit(1);
  if (!existing[0]) throw new LibraryError('not_found', `No application ${input.id}.`);

  const rows = await db.update(s.kataApplications)
    .set({
      kind: 'mmakf_approved',
      approvedByPersonId: personId,
      approvedOn: new Date().toISOString().slice(0, 10),
      verification: 'committee_verified',
    })
    .where(eq(s.kataApplications.id, input.id))
    .returning();

  await db.insert(s.technicalReviews).values({
    subjectKind: 'kata_application',
    subjectId: input.id,
    dimension: 'technical',
    toState: 'approved',
    reviewerPersonId: personId,
    note: input.note ?? null,
  });

  await writeAudit(db, ctx, {
    entityType: 'kata_application',
    entityId: input.id,
    action: 'approve',
    oldValue: { kind: existing[0].kind },
    newValue: { kind: 'mmakf_approved', approvedByPersonId: personId },
  });

  return rows[0];
}

/** Register or update a source in the registry. */
export async function registerSource(
  db: DB,
  ctx: AuditContext,
  input: {
    slug: string;
    organisation: string;
    sourceType: string;
    authorityTier: string;
    websiteUrl?: string | null;
    channelUrl?: string | null;
    style?: string | null;
    language?: string | null;
    rightsPolicy?: string | null;
    notes?: string | null;
    reviewedByPersonId?: number | null;
  },
) {
  assertCanAnywhere(ctx.principal, 'technical:review');

  const rows = await db.insert(s.technicalSources).values({
    slug: input.slug,
    organisation: input.organisation,
    sourceType: input.sourceType,
    authorityTier: input.authorityTier as any,
    websiteUrl: input.websiteUrl ?? null,
    channelUrl: input.channelUrl ?? null,
    style: input.style ?? null,
    language: input.language ?? null,
    rightsPolicy: input.rightsPolicy ?? null,
    notes: input.notes ?? null,
    reviewedByPersonId: input.reviewedByPersonId ?? null,
    lastReviewedOn: new Date().toISOString().slice(0, 10),
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'technical_source',
    entityId: rows[0].id,
    action: 'create',
    newValue: { slug: input.slug, tier: input.authorityTier },
  });
  return rows[0];
}

/** Attach provenance to a record. */
export async function cite(
  db: DB,
  ctx: AuditContext,
  input: {
    subjectKind: string;
    subjectId: number;
    sourceId?: number | null;
    sourceUrl?: string | null;
    sourceTitle?: string | null;
    sourceAuthor?: string | null;
    sourceOrganisation?: string | null;
    sourceType?: string | null;
    publicationDate?: string | null;
    retrievedOn?: string | null;
    quote?: string | null;
    page?: string | null;
    domain?: string | null;
    language?: string | null;
    verification?: string;
    notes?: string | null;
  },
) {
  if (!input.sourceId && !input.sourceUrl) {
    throw new LibraryError('no_source', 'A citation must name a registry source or a URL.');
  }
  const rows = await db.insert(s.technicalCitations).values({
    ...input,
    domain: (input.domain ?? null) as any,
    verification: (input.verification ?? 'source_documented') as any,
  }).returning();
  return rows[0];
}

/** Whether this principal may see the admin library at all. */
export function canReadLibrary(principal: Principal | null | undefined): boolean {
  return canAnywhere(principal, 'technical:read');
}

/** Whether this principal may decide on library records. */
export function canReviewLibrary(principal: Principal | null | undefined): boolean {
  return canAnywhere(principal, 'technical:review');
}
