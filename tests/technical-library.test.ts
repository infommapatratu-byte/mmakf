// The technical knowledge library — the refusals that make it safe to publish.
//
// The library's whole job is to stand between "we found a video" and "MMAKF
// teaches this". Three things have to be true at that boundary and nothing else
// in the system checks them:
//
//   · RIGHTS. A video MMAKF may not lawfully show never reaches a learner, and
//     no reviewer can approve their way past an unanswered rights question.
//   · AUTHORSHIP. "MMAKF approved" always names the person who approved it.
//     A classifier cannot write it, and neither can an UPDATE that forgot.
//   · PROVENANCE. Reference material stays reference material: another
//     federation's syllabus cannot become examinable by being loaded.
//
// Everything below is one of those three, or the search behaviour that makes
// the library findable by someone who does not already know how to spell what
// they are looking for.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  mediaUse, isShowable, authorityLabel, proposeLink, reviewLink, approveApplication,
  registerSource, cite, mediaFor, getKata, searchTerms, reviewQueue, technicalLookup,
  LibraryError, canReviewLibrary,
} from '../src/db/library';
import { seedTechnicalLibrary, importTerminology, importVideoRegister, importShotokanCorpus } from '../src/db/library-seed';
import { JKA_GRADING_GUIDELINE, WKF_KUMITE_PROVISIONS, REFERENCE_SOURCES } from '../src/data/technical-reference';
import { KATA_DETERMINATIONS } from '../src/data/kata-verification';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let client: PGlite;

const technicalDirector: Principal = {
  userId: 1, label: 'technical director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const mediaOfficer: Principal = {
  userId: 2, label: 'media officer',
  bindings: [{ role: 'MEDIA_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 3, label: 'an athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = technicalDirector): AuditContext =>
  ({ principal: p, reason: 'test', authority: 'test' });

let REVIEWER_PERSON: number;

async function makeAsset(over: Record<string, unknown> = {}) {
  const [row] = await db.insert(s.mediaAssets).values({
    platform: 'youtube',
    externalId: `vid_${Math.random().toString(36).slice(2, 10)}`,
    url: 'https://www.youtube.com/watch?v=example',
    title: 'A kata demonstration',
    rights: 'unknown',
    classification: 'pending_review',
    ...over,
  }).returning();
  return row;
}

// Find-or-create. The seed imports the real 26-kata corpus, so a test asking
// for 'heian-nidan' may find it already present — that is the system working,
// not a collision to route around.
async function makeKata(slug: string, over: Record<string, unknown> = {}) {
  const existing = await db.select().from(s.kata).where(eq(s.kata.slug, slug)).limit(1);
  if (existing[0]) {
    if (Object.keys(over).length) {
      const [updated] = await db.update(s.kata).set(over).where(eq(s.kata.slug, slug)).returning();
      return updated;
    }
    return existing[0];
  }
  const [row] = await db.insert(s.kata).values({
    slug, nameRomaji: slug.replace(/-/g, ' '), published: true, ...over,
  }).returning();
  return row;
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [person] = await db.insert(s.persons).values({
    federationId: 'MMAKF-MEM-2026-000001',
    fullName: 'Technical Director', status: 'active', dob: '1980-01-01', gender: 'male',
  }).returning();
  REVIEWER_PERSON = person.id;
});

// ─── Rights ─────────────────────────────────────────────────────────────────

describe('rights', () => {
  it('maps every rights value to exactly one permitted use', () => {
    // Owned, licensed, cleared and embed-allowed are the only four that let
    // MMAKF serve a player from its own page.
    expect(mediaUse('federation_owned')).toBe('embed');
    expect(mediaUse('licensed')).toBe('embed');
    expect(mediaUse('cleared')).toBe('embed');
    expect(mediaUse('embed_allowed')).toBe('embed');

    // Link-only is the honest middle: point at it, never re-serve it.
    expect(mediaUse('link_only')).toBe('link');

    // The five that permit nothing. 'unknown' is in here deliberately —
    // "nobody has checked" must behave exactly like "no".
    expect(mediaUse('unknown')).toBe('none');
    expect(mediaUse('permission_pending')).toBe('none');
    expect(mediaUse('not_cleared')).toBe('none');
    expect(mediaUse('restricted')).toBe('none');
    expect(mediaUse('do_not_use')).toBe('none');
  });

  it('refuses to guess about a rights value it has never seen', () => {
    // The failure mode this prevents: somebody adds an enum value, forgets this
    // function, and the default is permissive.
    expect(mediaUse('some_future_value')).toBe('none');
    expect(mediaUse(null)).toBe('none');
    expect(mediaUse(undefined)).toBe('none');
    expect(isShowable(null)).toBe(false);
  });

  it('labels a third party video as external, never as MMAKF content', () => {
    expect(authorityLabel({ classification: 'federation_official' })).toBe('MMAKF OFFICIAL');
    expect(authorityLabel({ rights: 'federation_owned' })).toBe('MMAKF OFFICIAL');
    expect(authorityLabel({ sourceTier: 'competition_authority' })).toBe('COMPETITION REFERENCE');
    expect(authorityLabel({ classification: 'master_teaching' })).toBe('MMAKF APPROVED REFERENCE');
    // The default is the safe one: anything unrecognised reads as external.
    expect(authorityLabel({})).toBe('EXTERNAL REFERENCE');
    expect(authorityLabel({ classification: 'shotokan_technical' })).toBe('EXTERNAL REFERENCE');
  });
});

// ─── The approval boundary ──────────────────────────────────────────────────

describe('approval', () => {
  it('lands every proposal at "new", whoever proposed it and whatever they claim', async () => {
    const asset = await makeAsset();
    const kata = await makeKata('proposal-kata');

    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
      proposedBy: 'ai', confidence: 99,
    });

    // A classifier at 99% confidence is still a proposal.
    expect(link.state).toBe('new');
    expect(link.proposedBy).toBe('ai');
    expect(link.reviewedByPersonId).toBeNull();
  });

  it('refuses to approve a link whose video MMAKF may not show', async () => {
    const asset = await makeAsset({ rights: 'unknown' });
    const kata = await makeKata('rights-unknown-kata');
    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
    });

    // This is the case that matters most: a technically excellent video that
    // nobody has cleared. The technical reviewer is fully authorised and is
    // still refused, because the rights question is not theirs to skip.
    await expect(reviewLink(db, ctx(), {
      id: link.id, toState: 'approved', reviewerPersonId: REVIEWER_PERSON,
    })).rejects.toThrow(LibraryError);

    const [after] = await db.select().from(s.mediaTechnicalLinks)
      .where(eq(s.mediaTechnicalLinks.id, link.id));
    expect(after.state).toBe('new');
  });

  it('refuses to approve a link on a video the rights holder has refused', async () => {
    const asset = await makeAsset({ rights: 'do_not_use' });
    const kata = await makeKata('do-not-use-kata');
    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
    });

    await expect(reviewLink(db, ctx(), {
      id: link.id, toState: 'published', reviewerPersonId: REVIEWER_PERSON,
    })).rejects.toMatchObject({ code: 'rights_not_cleared' });
  });

  it('approves when the rights permit it, and records who decided', async () => {
    const asset = await makeAsset({ rights: 'embed_allowed' });
    const kata = await makeKata('embeddable-kata');
    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id, proposedBy: 'ai',
    });

    const approved = await reviewLink(db, ctx(), {
      id: link.id, toState: 'approved', reviewerPersonId: REVIEWER_PERSON,
      dimension: 'technical', note: 'Correct Shotokan form.',
    });

    expect(approved.state).toBe('approved');
    expect(approved.reviewedByPersonId).toBe(REVIEWER_PERSON);
    expect(approved.reviewedAt).toBeTruthy();

    // The trail survives independently of the row it describes.
    const reviews = await db.select().from(s.technicalReviews)
      .where(and(
        eq(s.technicalReviews.subjectKind, 'media_technical_link'),
        eq(s.technicalReviews.subjectId, link.id),
      ));
    expect(reviews).toHaveLength(1);
    expect(reviews[0].fromState).toBe('new');
    expect(reviews[0].toState).toBe('approved');
    expect(reviews[0].reviewerPersonId).toBe(REVIEWER_PERSON);
  });

  it('refuses an approval that names nobody', async () => {
    const asset = await makeAsset({ rights: 'licensed' });
    const kata = await makeKata('anonymous-approval-kata');
    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
    });

    await expect(reviewLink(db, ctx(), {
      id: link.id, toState: 'approved',
    })).rejects.toMatchObject({ code: 'no_reviewer' });
  });

  it('refuses a reviewer who lacks technical:review, however senior they look', async () => {
    const asset = await makeAsset({ rights: 'licensed' });
    const kata = await makeKata('permission-kata');
    const link = await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
    });

    // A media officer publishes federation content all day. Deciding that a
    // third party's video meets MMAKF's TECHNICAL standard is a different
    // authority, and this is where the two come apart.
    await expect(reviewLink(db, ctx(mediaOfficer), {
      id: link.id, toState: 'approved', reviewerPersonId: REVIEWER_PERSON,
    })).rejects.toThrow(ForbiddenError);

    expect(canReviewLibrary(mediaOfficer)).toBe(false);
    expect(canReviewLibrary(technicalDirector)).toBe(true);
    expect(canReviewLibrary(athlete)).toBe(false);
    expect(canReviewLibrary(null)).toBe(false);
  });

  it('lets the database, not the code, refuse an unattributed MMAKF endorsement', async () => {
    const kata = await makeKata('bunkai-kata');

    // Straight INSERT, bypassing every function in src/db/library.ts. This is
    // the guarantee that survives a future code path nobody has written yet.
    await expect(client.exec(`
      INSERT INTO kata_applications (kata_id, title, kind)
      VALUES (${kata.id}, 'Claimed as MMAKF doctrine', 'mmakf_approved')
    `)).rejects.toThrow();

    // The same row as an instructor's own reading is entirely legitimate.
    const [ok] = await db.insert(s.kataApplications).values({
      kataId: kata.id, title: 'One instructor\'s reading', kind: 'instructor',
      attributedTo: 'A named instructor',
    }).returning();
    expect(ok.kind).toBe('instructor');
    expect(ok.approvedByPersonId).toBeNull();
  });

  it('promotes an interpretation to MMAKF doctrine only with an approver', async () => {
    const kata = await makeKata('promotion-kata');
    const [application] = await db.insert(s.kataApplications).values({
      kataId: kata.id, title: 'A reading under review', kind: 'traditional',
    }).returning();

    await expect(approveApplication(db, ctx(), { id: application.id }))
      .rejects.toMatchObject({ code: 'no_approver' });

    const approved = await approveApplication(db, ctx(), {
      id: application.id, approvedByPersonId: REVIEWER_PERSON, note: 'Adopted by the committee.',
    });
    expect(approved.kind).toBe('mmakf_approved');
    expect(approved.approvedByPersonId).toBe(REVIEWER_PERSON);
    expect(approved.approvedOn).toBeTruthy();
    expect(approved.verification).toBe('committee_verified');
  });
});

// ─── What a learner actually receives ───────────────────────────────────────

describe('learner reads', () => {
  it('never returns a video whose rights do not permit showing it', async () => {
    const kata = await makeKata('mixed-rights-kata');

    const embeddable = await makeAsset({ rights: 'embed_allowed', title: 'Cleared' });
    const linkOnly = await makeAsset({ rights: 'link_only', title: 'Link only' });
    const unknown = await makeAsset({ rights: 'unknown', title: 'Unchecked' });

    for (const asset of [embeddable, linkOnly, unknown]) {
      const link = await proposeLink(db, ctx(), {
        mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id,
      });
      // Force all three to 'approved' directly, so the read path is tested
      // rather than the write path's refusal. The unknown-rights row is
      // deliberately smuggled past review to prove the read path stops it too.
      await db.update(s.mediaTechnicalLinks)
        .set({ state: 'approved', reviewedByPersonId: REVIEWER_PERSON, reviewedAt: new Date() })
        .where(eq(s.mediaTechnicalLinks.id, link.id));
    }

    const media = await mediaFor(db, 'kata', kata.id);
    const titles = media.map((m: any) => m.asset.title).sort();

    // Two survive. The unchecked one does not, even though its link row says
    // 'approved' — belt and braces, because approval and rights are different
    // questions and only one of them was answered.
    expect(titles).toEqual(['Cleared', 'Link only']);
    expect(media.find((m: any) => m.asset.title === 'Cleared').use).toBe('embed');
    expect(media.find((m: any) => m.asset.title === 'Link only').use).toBe('link');
  });

  it('does not return unapproved links to learners, but does to reviewers', async () => {
    const kata = await makeKata('pending-kata');
    const asset = await makeAsset({ rights: 'licensed' });
    await proposeLink(db, ctx(), {
      mediaAssetId: asset.id, subjectKind: 'kata', subjectId: kata.id, proposedBy: 'ai',
    });

    expect(await mediaFor(db, 'kata', kata.id)).toHaveLength(0);
    expect(await mediaFor(db, 'kata', kata.id, { includeUnpublished: true })).toHaveLength(1);
  });

  it('hides an unpublished kata from the learn surface entirely', async () => {
    await makeKata('draft-kata', { published: false });
    expect(await getKata(db, 'draft-kata')).toBeNull();
    expect(await getKata(db, 'draft-kata', { includeUnpublished: true })).not.toBeNull();
  });

  it('returns movements even when almost every field is unknown', async () => {
    const kata = await makeKata('sparse-kata');
    await db.insert(s.kataMovements).values([
      { kataId: kata.id, ordinal: 1, directionLabel: 'Turn 90 degrees left', stanceLabel: 'Zenkutsu-dachi' },
      { kataId: kata.id, ordinal: 2 },
    ]);

    const result = await getKata(db, 'sparse-kata');
    // A movement documented only as "there is a movement here" is still part of
    // the kata, and dropping it would misrepresent the form's length.
    expect(result!.movements).toHaveLength(2);
    expect(result!.movements[1].verification).toBe('unverified');
    expect(result!.movements[1].techniqueLabel).toBeNull();
  });
});

// ─── The review queue ───────────────────────────────────────────────────────

describe('review queue', () => {
  it('shows a reviewer the rights blocker before they spend time on the technique', async () => {
    const kata = await makeKata('queue-kata');
    const blocked = await makeAsset({ rights: 'unknown', title: 'Rights unchecked' });
    const fine = await makeAsset({ rights: 'embed_allowed', title: 'Rights fine' });
    await proposeLink(db, ctx(), { mediaAssetId: blocked.id, subjectKind: 'kata', subjectId: kata.id });
    await proposeLink(db, ctx(), { mediaAssetId: fine.id, subjectKind: 'kata', subjectId: kata.id });

    const queue = await reviewQueue(db, technicalDirector);
    const blockedRow = queue.find((q: any) => q.asset.title === 'Rights unchecked');
    const fineRow = queue.find((q: any) => q.asset.title === 'Rights fine');

    expect(blockedRow.rightsBlocked).toBe(true);
    expect(fineRow.rightsBlocked).toBe(false);
  });

  it('refuses the queue to anyone without technical:read', async () => {
    await expect(reviewQueue(db, athlete)).rejects.toThrow(ForbiddenError);
  });
});

// ─── Seeding from primary sources ───────────────────────────────────────────

describe('seed', () => {
  beforeEach(async () => {
    await client.exec('DELETE FROM reference_curriculum_items');
    await client.exec('DELETE FROM reference_curricula');
    await client.exec('DELETE FROM sport_kumite_provisions');
    await client.exec('DELETE FROM sport_kumite_rulesets');
    await client.exec('DELETE FROM technical_citations');
    await client.exec('DELETE FROM technical_sources');
  });

  it('loads the researched sources, curriculum and rules', async () => {
    const report = await seedTechnicalLibrary(db);

    // `sources` aggregates the researched primary sources AND the video
    // register's own source pages, so it is at least the researched count.
    expect(report.sources).toBeGreaterThanOrEqual(REFERENCE_SOURCES.length);
    expect(report.curriculumItems).toBe(JKA_GRADING_GUIDELINE.length);
    expect(report.provisions).toBe(WKF_KUMITE_PROVISIONS.length);
    expect(report.citations).toBeGreaterThan(0);

    // The full seed now brings the Shotokan corpus with it, which is what gives
    // every other table something to point at.
    expect(report.kata).toBe(26);
    expect(report.techniques).toBeGreaterThanOrEqual(40);
    expect(report.appearances).toBeGreaterThan(0);
    expect(report.mediaAssets).toBeGreaterThan(0);

    const slugs = (await db.select().from(s.technicalSources)).map((x: any) => x.slug);
    for (const src of REFERENCE_SOURCES) expect(slugs).toContain(src.slug);
  });

  it('runs twice without duplicating anything', async () => {
    await seedTechnicalLibrary(db);
    const first = await db.select({ n: sql<number>`count(*)::int` }).from(s.referenceCurriculumItems);
    const firstSources = await db.select({ n: sql<number>`count(*)::int` }).from(s.technicalSources);

    await seedTechnicalLibrary(db);
    const second = await db.select({ n: sql<number>`count(*)::int` }).from(s.referenceCurriculumItems);
    const secondSources = await db.select({ n: sql<number>`count(*)::int` }).from(s.technicalSources);

    expect(second[0].n).toBe(first[0].n);
    expect(secondSources[0].n).toBe(firstSources[0].n);
  });

  it('keeps another federation\'s syllabus out of the MMAKF grading engine', async () => {
    await seedTechnicalLibrary(db);

    // The JKA guideline is loaded and readable...
    const items = await db.select().from(s.referenceCurriculumItems);
    expect(items.length).toBeGreaterThan(50);
    expect(items.some((i: any) => i.requirement === 'HEIAN SHODAN')).toBe(true);

    // ...and the grading engine's own tables are untouched. This is the whole
    // reason reference_curricula exists as a separate table: nothing MMAKF
    // examines has silently acquired a requirement from a document MMAKF has
    // not adopted.
    const syllabi = await db.select().from(s.syllabusVersions);
    const requirements = await db.select().from(s.gradeRequirements);
    expect(syllabi).toHaveLength(0);
    expect(requirements).toHaveLength(0);

    const [curriculum] = await db.select().from(s.referenceCurricula);
    expect(curriculum.adoptedByMmakf).toBe(false);
  });

  it('records the JKA guideline verbatim, inconsistent grade labels and all', async () => {
    await seedTechnicalLibrary(db);
    const labels = new Set(
      (await db.select().from(s.referenceCurriculumItems)).map((i: any) => i.gradeLabel),
    );
    // The source document writes these four differently. Normalising them would
    // be editing somebody else's published syllabus.
    expect(labels.has('10th Kyu')).toBe(true);
    expect(labels.has('8 Kyu')).toBe(true);
    expect(labels.has('6th Kyu')).toBe(true);
    expect(labels.has('3 Kyu')).toBe(true);
  });

  it('never presents a movement count as verified when the source does not state it', async () => {
    await seedTechnicalLibrary(db);

    // The widely-repeated Heian counts (21/26/20/27/23) are attributed to the
    // JKA instructor manual. The manual was read and does not publish them.
    //
    // The corpus in this repository asserts them anyway, so the counts DO reach
    // the database — suppressing them would discard work somebody did
    // deliberately. What must never happen is the number arriving without its
    // provenance, looking like something the federation verified.
    const heian = (await db.select().from(s.kata))
      .filter((k: any) => /heian/i.test(k.nameRomaji ?? ''));
    expect(heian.length).toBe(5);

    for (const k of heian) {
      const citations = await db.select().from(s.technicalCitations)
        .where(and(
          eq(s.technicalCitations.subjectKind, 'kata'),
          eq(s.technicalCitations.subjectId, k.id),
        ));
      expect(citations.length, `${k.slug} has no provenance`).toBeGreaterThan(0);
      // Not one of them may claim committee verification.
      for (const c of citations) {
        expect(c.verification).not.toBe('committee_verified');
      }
      // A stored count must be backed by a citation that actually documents it.
      // Before the verification pass these were all 'unverified'; the pass
      // corroborated them against a published JKA table, so they are now
      // 'source_documented' — and either way the rule is the same: the number
      // never appears without provenance, and never claims more than it has.
      if (k.movementCount != null) {
        expect(citations.some((c: any) =>
          c.verification === 'source_documented' || c.verification === 'unverified')).toBe(true);
      }
    }

    const report = await seedTechnicalLibrary(db);
    expect(report.notes.join(' ')).toMatch(/cited as UNVERIFIED/i);
  });

  it('does not promote the master teacher channel on an unverified claim', async () => {
    await seedTechnicalLibrary(db);
    const [channel] = await db.select().from(s.technicalSources)
      .where(eq(s.technicalSources.slug, 'pramod-pathak-martial-art'));

    // The directive calls it the MMAKF master teacher source. Authorisation
    // could not be verified without API access, so the tier stays honest and
    // the reason is recorded rather than assumed away.
    expect(channel.authorityTier).toBe('educational');
    expect(channel.notes).toMatch(/could not verify/i);
  });

  it('stores the WKF rules as regulation, apart from traditional kumite', async () => {
    await seedTechnicalLibrary(db);
    const [ruleset] = await db.select().from(s.sportKumiteRulesets);
    expect(ruleset.version).toBe('2026.01');
    expect(ruleset.effectiveFrom).toBe('2026-01-01');

    const provisions = await db.select().from(s.sportKumiteProvisions);
    const scoring = provisions.find((p: any) => p.clause === '8.6');
    expect(scoring.sourceQuote).toMatch(/IPPON \(3 points\)/);

    // Traditional kumite lives in kumite_forms, and loading sport regulation
    // does not put a single WKF article into it. The two vocabularies never
    // meet: no kumite_forms row carries a rules version or an effective date,
    // because those are properties of regulation and not of a teaching drill.
    const forms = await db.select().from(s.kumiteForms);
    expect(forms.length).toBeGreaterThan(0);
    expect(Object.keys(forms[0])).not.toContain('version');
    expect(Object.keys(forms[0])).not.toContain('effectiveFrom');

    // And competition kumite, which exists in both worlds by name, is not
    // published as traditional teaching material.
    const shiai = forms.find((f: any) => f.slug === 'shiai-kumite');
    if (shiai) expect(shiai.published).toBe(false);
  });
});

// ─── Search ─────────────────────────────────────────────────────────────────

describe('search', () => {
  beforeAll(async () => {
    await importTerminology(db);
  });

  it('finds a technique however the learner romanises it', async () => {
    // The four spellings a beginner actually types. All of them are legitimate
    // renderings or near-misses of the same 突き, and all must land on one term.
    const spellings = ['oi-zuki', 'oi zuki', 'oizuki', 'oi tsuki'];
    const found = await Promise.all(spellings.map((q) => searchTerms(db, q)));

    for (const [i, results] of found.entries()) {
      expect(results.length, `no result for "${spellings[i]}"`).toBeGreaterThan(0);
    }
    // Every spelling reaches the same canonical row.
    const ids = found.map((r: any) => r[0].id);
    expect(new Set(ids).size).toBe(1);
  });

  it('handles the zuki/tsuki split in both directions', async () => {
    const zuki = await searchTerms(db, 'gyaku-zuki');
    const tsuki = await searchTerms(db, 'gyaku tsuki');
    expect(zuki.length).toBeGreaterThan(0);
    expect(tsuki.length).toBeGreaterThan(0);
    expect(tsuki[0].id).toBe(zuki[0].id);
  });

  it('puts an exact match first', async () => {
    const results = await searchTerms(db, 'zenkutsu-dachi');
    expect(results[0].romaji.toLowerCase().replace(/[\s\-]/g, '')).toBe('zenkutsudachi');
  });

  it('ignores a query too short to mean anything', async () => {
    expect(await searchTerms(db, '')).toEqual([]);
    expect(await searchTerms(db, 'a')).toEqual([]);
  });

  it('returns the knowledge graph, not just a definition', async () => {
    const result = await technicalLookup(db, 'gyaku-zuki');
    expect(result.terms.length).toBeGreaterThan(0);
    // appearances and media are empty until kata movements and approved videos
    // reference the technique — but the shape is the contract the learn page
    // renders against, and it must be present rather than undefined.
    expect(Array.isArray(result.appearances)).toBe(true);
    expect(Array.isArray(result.media)).toBe(true);
  });
});

// ─── Provenance ─────────────────────────────────────────────────────────────

describe('provenance', () => {
  it('refuses a citation that cites nothing', async () => {
    const kata = await makeKata('uncited-kata');
    await expect(cite(db, ctx(), { subjectKind: 'kata', subjectId: kata.id }))
      .rejects.toMatchObject({ code: 'no_source' });

    // ...and the database refuses it too, for callers that skip the function.
    await expect(client.exec(`
      INSERT INTO technical_citations (subject_kind, subject_id) VALUES ('kata', ${kata.id})
    `)).rejects.toThrow();
  });

  it('records a source in the registry with its tier and who reviewed it', async () => {
    const source = await registerSource(db, ctx(), {
      slug: `test-source-${Math.random().toString(36).slice(2, 8)}`,
      organisation: 'A Shotokan organisation',
      sourceType: 'organisation',
      authorityTier: 'educational',
      reviewedByPersonId: REVIEWER_PERSON,
    });
    expect(source.authorityTier).toBe('educational');
    expect(source.reviewedByPersonId).toBe(REVIEWER_PERSON);
    expect(source.active).toBe(true);
  });

  it('refuses source registration to a principal without technical:review', async () => {
    await expect(registerSource(db, ctx(mediaOfficer), {
      slug: 'unauthorised-source',
      organisation: 'Someone',
      sourceType: 'organisation',
      authorityTier: 'discovery',
    })).rejects.toThrow(ForbiddenError);
  });
});

// ─── The verified video register enters the queue, not the library ──────────

describe('video register import', () => {
  // The full seed now imports the register itself, so these tests start from a
  // clean media slate to measure what one import actually does.
  beforeEach(async () => {
    await client.exec('DELETE FROM media_technical_links');
    await client.exec('DELETE FROM media_chapters');
    await client.exec('DELETE FROM media_assets');
  });

  it('imports verified videos as UNKNOWN rights, never as cleared', async () => {
    const result = await importVideoRegister(db);
    expect(result.assets).toBeGreaterThan(0);
    expect(result.sources).toBeGreaterThan(0);

    const assets = await db.select().from(s.mediaAssets);
    const imported = assets.filter((a: any) => a.rightsNote?.includes('No licence has been sought'));
    expect(imported.length).toBeGreaterThan(0);

    // THE POINT OF THIS TEST. The register proved every one of these videos is
    // live and embeddable on YouTube — oEmbed 200, playabilityStatus OK, a real
    // iframe, and a negative control that failed as expected. None of that is a
    // licence, and the import must not quietly upgrade technical embeddability
    // into permission.
    for (const asset of imported) {
      expect(asset.rights).toBe('unknown');
      expect(asset.published).toBe(false);
      expect(asset.classification).toBe('pending_review');
    }
  });

  it('records provenance strength without letting it decide rights', async () => {
    await importVideoRegister(db);
    const assets = await db.select().from(s.mediaAssets);
    const onOwnChannel = assets.filter((a: any) =>
      a.rightsNote?.includes('sits on the channel of the organisation'));
    const possibleReupload = assets.filter((a: any) =>
      a.rightsNote?.includes('possible re-upload'));

    // Both kinds exist in the register and both arrive at the same rights
    // standing. The difference is recorded for the reviewer, not acted on.
    expect(onOwnChannel.length).toBeGreaterThan(0);
    for (const a of [...onOwnChannel, ...possibleReupload]) {
      expect(a.rights).toBe('unknown');
    }
  });

  it('proposes kata links at "new", attributed to the import', async () => {
    // The register tags 59 videos with a kata slug. Links only appear for kata
    // that exist in the register — an unmatched slug is reported, not invented.
    await makeKata('heian-nidan');
    await makeKata('bassai-dai');

    const result = await importVideoRegister(db);
    expect(result.links).toBeGreaterThan(0);

    const links = await db.select().from(s.mediaTechnicalLinks)
      .where(eq(s.mediaTechnicalLinks.proposedBy, 'import'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.state).toBe('new');
      expect(link.reviewedByPersonId).toBeNull();
    }
  });

  it('reports kata it could not match instead of dropping them silently', async () => {
    const result = await importVideoRegister(db);
    // The register tags kata this database may not carry yet. Those are named
    // in the return value so somebody can act on them; a silent skip would read
    // as "the register had nothing for those kata".
    expect(Array.isArray(result.unmatchedKata)).toBe(true);
    for (const slug of result.unmatchedKata) {
      expect(typeof slug).toBe('string');
    }
  });

  it('shows a learner none of it, because none of it is cleared', async () => {
    const kata = await makeKata('unsu');
    await importVideoRegister(db);

    // Everything imported is unknown-rights, so the learner-facing read returns
    // nothing at all — even for a kata the register has several videos for.
    expect(await mediaFor(db, 'kata', kata.id)).toHaveLength(0);
  });

  it('runs twice without duplicating an asset or a link', async () => {
    await makeKata('jion');
    await importVideoRegister(db);
    const firstAssets = await db.select({ n: sql<number>`count(*)::int` }).from(s.mediaAssets);
    const firstLinks = await db.select({ n: sql<number>`count(*)::int` }).from(s.mediaTechnicalLinks);

    const second = await importVideoRegister(db);
    const afterAssets = await db.select({ n: sql<number>`count(*)::int` }).from(s.mediaAssets);
    const afterLinks = await db.select({ n: sql<number>`count(*)::int` }).from(s.mediaTechnicalLinks);

    expect(second.assets).toBe(0);
    expect(afterAssets[0].n).toBe(firstAssets[0].n);
    expect(afterLinks[0].n).toBe(firstLinks[0].n);
  });
});

// ─── The Shotokan corpus enters the database ────────────────────────────────
//
// The repository had two Shotokan libraries that could not see each other: a
// static corpus rendered as pages, and a set of database tables that make a
// corpus reviewable but held nothing. These tests are about the bridge between
// them, and above all about what the bridge REFUSES to upgrade on the way
// across — a number the corpus asserts does not become a verified fact by being
// SELECTed.

describe('shotokan corpus import', () => {
  beforeEach(async () => {
    await client.exec('DELETE FROM technique_kata_appearances');
    await client.exec('DELETE FROM media_technical_links');
    await client.exec('DELETE FROM technical_term_aliases');
    await client.exec('DELETE FROM technical_terms');
    await client.exec('DELETE FROM technical_citations');
    await client.exec('DELETE FROM kata_movements');
    await client.exec('DELETE FROM kata_applications');
    await client.exec('DELETE FROM kata');
    await client.exec('DELETE FROM techniques');
    await client.exec('DELETE FROM kumite_forms');
  });

  it('imports the whole corpus — kata, techniques and kumite systems', async () => {
    const result = await importShotokanCorpus(db);

    expect(result.kata).toBe(26);
    expect(result.techniques).toBeGreaterThanOrEqual(40);
    expect(result.kumiteForms).toBeGreaterThanOrEqual(6);

    const kata = await db.select().from(s.kata);
    expect(kata.map((k: any) => k.slug)).toContain('heian-shodan');
    expect(kata.map((k: any) => k.slug)).toContain('gojushiho-sho');

    // Kanji come across as kanji, never as romaji wearing a Japanese label.
    const [shodan] = kata.filter((k: any) => k.slug === 'heian-shodan');
    expect(shodan.nameJa).toBe('平安初段');
    expect(shodan.nameRomaji).toBe('Heian Shodan');
    expect(shodan.family).toBe('Heian');
  });

  it('does not turn an asserted movement count into a verified one', async () => {
    await importShotokanCorpus(db);
    const [shodan] = await db.select().from(s.kata).where(eq(s.kata.slug, 'heian-shodan'));

    // The corpus says 21, and the value is carried across — hiding it would be
    // its own kind of dishonesty, since somebody wrote it deliberately.
    expect(shodan.movementCount).toBe(21);

    // But the claim travels with its strength attached. This is the whole
    // point: the JKA instructor manual requires an accurate count and does not
    // publish one, so nothing here may present 21 as federation-verified.
    const citations = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, shodan.id),
      ));
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0].verification).toBe('unverified');
    expect(citations[0].notes).toMatch(/does not publish one/i);
  });

  it('leaves the count NULL when sources verifiably disagree, and keeps both figures', async () => {
    await importShotokanCorpus(db, [{
      slug: 'heian-shodan',
      verification: 'disputed',
      variants: [
        { count: 21, organisation: 'Organisation A', url: 'https://example.org/a' },
        { count: 20, organisation: 'Organisation B', url: 'https://example.org/b' },
      ],
      reason: 'Two authoritative bodies count the opening sequence differently.',
    }]);

    const [shodan] = await db.select().from(s.kata).where(eq(s.kata.slug, 'heian-shodan'));

    // NULL rather than a winner. Storing either number would make this system
    // the thing that decided a disagreement it has no authority to settle.
    expect(shodan.movementCount).toBeNull();

    const citations = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, shodan.id),
      ));
    const counts = citations
      .map((c: any) => c.sourceTitle)
      .filter((t: string) => /movements per/.test(t));
    expect(counts).toHaveLength(2);
    for (const c of citations.filter((x: any) => /movements per/.test(x.sourceTitle))) {
      expect(c.verification).toBe('disputed');
    }
  });

  it('stores a count as fact only when a determination brings evidence', async () => {
    await importShotokanCorpus(db, [{
      slug: 'heian-nidan',
      verification: 'source_documented',
      movementCount: 26,
      citation: {
        organisation: 'A recognised Shotokan body',
        url: 'https://example.org/heian-nidan',
        quote: 'Heian Nidan consists of 26 movements.',
      },
      reason: 'Stated on the organisation published syllabus page.',
    }]);

    const [nidan] = await db.select().from(s.kata).where(eq(s.kata.slug, 'heian-nidan'));
    expect(nidan.movementCount).toBe(26);

    const [citation] = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, nidan.id),
      ));
    expect(citation.verification).toBe('source_documented');
    expect(citation.quote).toMatch(/26 movements/);
  });

  it('keeps sport kumite out of the traditional teaching material', async () => {
    await importShotokanCorpus(db);
    const forms = await db.select().from(s.kumiteForms);

    const traditional = forms.filter((f: any) => f.published);
    const sport = forms.filter((f: any) => !f.published);

    expect(traditional.length).toBeGreaterThan(0);
    // Shiai kumite exists in the corpus and is imported, but not published as
    // Shotokan teaching progression — it belongs with the WKF ruleset, which
    // carries an effective date and a governing authority.
    expect(sport.map((f: any) => f.slug)).toContain('shiai-kumite');
    expect(traditional.map((f: any) => f.slug)).toContain('gohon-kumite');
  });

  it('records where a technique appears without inventing where in', async () => {
    const result = await importShotokanCorpus(db);
    expect(result.appearances).toBeGreaterThan(0);

    const rows = await db.select().from(s.techniqueKataAppearances);
    expect(rows.length).toBeGreaterThan(0);

    // THE LINE THAT MATTERS. The corpus knows a technique appears in a kata; it
    // does not know at which count. Every ordinal is null, so nothing here can
    // ever be mistaken for researched movement-level data.
    for (const row of rows) {
      expect(row.movementOrdinal).toBeNull();
      expect(row.verification).toBe('unverified');
    }

    // And the stronger table stays empty, because no movement-level source was
    // verified. Two tables, two strengths, no blurring.
    expect(await db.select().from(s.kataMovements)).toHaveLength(0);
  });

  it('carries a technique the corpus flags as contested into a disputed citation', async () => {
    await importShotokanCorpus(db);
    const disputedCitations = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'technique'),
        eq(s.technicalCitations.verification, 'disputed'),
      ));
    // The corpus marks genuine disagreements between Shotokan organisations in
    // its `contested` field. Those must not flatten into house style on import.
    expect(disputedCitations.length).toBeGreaterThan(0);
    expect(disputedCitations[0].quote).toBeTruthy();
  });

  it('answers the knowledge-graph question, and says how strong the answer is', async () => {
    await importShotokanCorpus(db);

    const result = await technicalLookup(db, 'gyaku-zuki');
    expect(result.terms.length).toBeGreaterThan(0);
    expect(result.appearances.length).toBeGreaterThan(0);

    // Everything available today is kata-level, and is labelled as such rather
    // than dressed up with a movement number.
    for (const appearance of result.appearances) {
      expect(appearance.precision).toBe('kata');
      expect(appearance.ordinal).toBeNull();
      expect(appearance.kata.nameRomaji).toBeTruthy();
    }
  });

  it('prefers the movement-level answer and does not repeat the weaker one', async () => {
    await importShotokanCorpus(db);

    const [technique] = await db.select().from(s.techniques)
      .where(eq(s.techniques.slug, 'gyaku-zuki'));
    const [appearance] = await db.select().from(s.techniqueKataAppearances)
      .where(eq(s.techniqueKataAppearances.techniqueId, technique.id)).limit(1);

    // Research a single movement, and that kata should now answer precisely
    // rather than twice.
    await db.insert(s.kataMovements).values({
      kataId: appearance.kataId, ordinal: 17, techniqueId: technique.id,
      verification: 'source_documented',
    });

    const result = await technicalLookup(db, 'gyaku-zuki');
    const forThatKata = result.appearances.filter((a: any) => a.kata.id === appearance.kataId);
    expect(forThatKata).toHaveLength(1);
    expect(forThatKata[0].precision).toBe('movement');
    expect(forThatKata[0].ordinal).toBe(17);
  });

  it('finds a technique by the aliases the corpus authored', async () => {
    await importShotokanCorpus(db);
    // These are hand-written by somebody who knows the art, and are better than
    // anything a generator produces.
    const results = await searchTerms(db, 'gyaku zuki');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].techniqueId).toBeTruthy();
  });

  it('unblocks the video register: kata links now resolve', async () => {
    // Before the corpus exists, every kata-tagged video in the register is
    // skipped because there is no kata row to point at.
    await client.exec("DELETE FROM media_technical_links");
    await client.exec("DELETE FROM media_assets");
    const before = await importVideoRegister(db);
    expect(before.links).toBe(0);
    expect(before.unmatchedKata.length).toBeGreaterThan(0);

    // After it exists, they land in the review queue at 'new'.
    await importShotokanCorpus(db);
    await client.exec("DELETE FROM media_technical_links");
    await client.exec("DELETE FROM media_assets");
    const after = await importVideoRegister(db);
    expect(after.links).toBeGreaterThan(0);
    expect(after.unmatchedKata).toHaveLength(0);

    const links = await db.select().from(s.mediaTechnicalLinks);
    for (const link of links) expect(link.state).toBe('new');
  });

  it('runs twice without duplicating a kata, a technique or an appearance', async () => {
    await importShotokanCorpus(db);
    const first = await Promise.all([
      db.select({ n: sql`count(*)::int` }).from(s.kata),
      db.select({ n: sql`count(*)::int` }).from(s.techniques),
      db.select({ n: sql`count(*)::int` }).from(s.techniqueKataAppearances),
    ]);

    await importShotokanCorpus(db);
    const second = await Promise.all([
      db.select({ n: sql`count(*)::int` }).from(s.kata),
      db.select({ n: sql`count(*)::int` }).from(s.techniques),
      db.select({ n: sql`count(*)::int` }).from(s.techniqueKataAppearances),
    ]);

    expect(second[0][0].n).toBe(first[0][0].n);
    expect(second[1][0].n).toBe(first[1][0].n);
    expect(second[2][0].n).toBe(first[2][0].n);
  });
});

// ─── The verification pass, and the error it caught ─────────────────────────
//
// A parallel research pass checked all 26 asserted movement counts against a
// published JKA affiliate table. Twenty-four were corroborated exactly, which
// is a good result for the corpus. One was not, and these tests are mostly
// about that one — because a system that only records agreement is not a
// verification system.

describe('kata count verification', () => {
  beforeEach(async () => {
    await client.exec('DELETE FROM technique_kata_appearances');
    await client.exec('DELETE FROM technical_citations');
    await client.exec('DELETE FROM kata_movements');
    await client.exec('DELETE FROM kata_applications');
    await client.exec('DELETE FROM kata');
  });

  it('stores a corroborated count as documented, with the source that says so', async () => {
    await importShotokanCorpus(db, KATA_DETERMINATIONS);
    const [shodan] = await db.select().from(s.kata).where(eq(s.kata.slug, 'heian-shodan'));
    expect(shodan.movementCount).toBe(21);

    const citations = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, shodan.id),
      ));
    const documented = citations.find((c: any) => c.verification === 'source_documented');
    expect(documented, 'heian-shodan should carry a documented citation').toBeTruthy();
    expect(documented.sourceOrganisation).toMatch(/Japan Karate Association/i);
    expect(documented.sourceUrl).toBeTruthy();
    // The quote is the table row itself, so a later reader can find it again.
    expect(documented.quote).toMatch(/21/);
  });

  it('refuses to store a count the sources disagree about', async () => {
    await importShotokanCorpus(db, KATA_DETERMINATIONS);
    const [nijushiho] = await db.select().from(s.kata).where(eq(s.kata.slug, 'nijushiho'));

    // THE FINDING. The repository corpus records 24 — which is what the kata's
    // NAME means (nijushiho = "24 steps"). The JKA's published movement-count
    // table gives 34. A name is not a count, and this is exactly the kind of
    // plausible-looking error that survives review by looking obvious.
    //
    // The system does not pick a winner. It stores neither and keeps both.
    expect(nijushiho.movementCount).toBeNull();

    const citations = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, nijushiho.id),
      ));
    const variants = citations.filter((c: any) => c.verification === 'disputed');
    expect(variants.length).toBe(2);
    const titles = variants.map((c: any) => c.sourceTitle).join(' ');
    expect(titles).toMatch(/34 movements/);
    expect(titles).toMatch(/24 movements/);
  });

  it('asserts nothing about a kata the source does not list', async () => {
    await importShotokanCorpus(db, KATA_DETERMINATIONS);
    const [jiin] = await db.select().from(s.kata).where(eq(s.kata.slug, 'jiin'));
    // Jiin is absent from the JKA table. The corpus's 38 therefore has no
    // corroboration, and no count is stored rather than one being carried over
    // on the strength of the kata next to it having been checked.
    expect(jiin.movementCount).toBeNull();
  });

  it('flags a kiai the source contradicts, without silently changing it', async () => {
    await importShotokanCorpus(db, KATA_DETERMINATIONS);
    const [kanku] = await db.select().from(s.kata).where(eq(s.kata.slug, 'kanku-dai'));

    // Kanku Dai's COUNT is corroborated at 65. Its second kiai is not: the
    // corpus records 45, the table says 65 — an apparent digit transposition.
    // Kiai are not stored in a column here, so the contradiction is recorded in
    // the citation for a reviewer rather than quietly corrected in passing.
    expect(kanku.movementCount).toBe(65);
    const [citation] = await db.select().from(s.technicalCitations)
      .where(and(
        eq(s.technicalCitations.subjectKind, 'kata'),
        eq(s.technicalCitations.subjectId, kanku.id),
      ));
    expect(citation.notes).toMatch(/kiai/i);
    expect(citation.notes).toMatch(/not/i);
  });

  it('covers every kata in the corpus, agreement or not', async () => {
    // A determination per kata. A missing one would silently fall back to
    // 'unverified', which is safe but would hide that the kata was never
    // checked at all.
    const slugs = new Set(KATA_DETERMINATIONS.map((d: any) => d.slug));
    expect(slugs.size).toBe(26);

    const byVerification = KATA_DETERMINATIONS.reduce((acc: any, d: any) => {
      acc[d.verification] = (acc[d.verification] ?? 0) + 1;
      return acc;
    }, {});
    expect(byVerification.source_documented).toBe(24);
    expect(byVerification.disputed).toBe(1);
    expect(byVerification.unverified).toBe(1);
  });

  it('reports the disputed kata in the seed report rather than burying it', async () => {
    const report = await seedTechnicalLibrary(db);
    expect(report.disputed).toContain('nijushiho');
    expect(report.notes.join(' ')).toMatch(/DISPUTED movement count/i);
  });
});
