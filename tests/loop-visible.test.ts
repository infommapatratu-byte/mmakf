// THE LOOP, PROVED TO START WORKING WHEN A FEE FRAMEWORK IS PUBLISHED.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Two screens claim, in prose, that MMAKF's application-to-programme loop is
// already wired and is waiting on one thing — a published fee framework:
//
//   /admin/pipeline                  "every open application is waiting for a
//                                     quotation, and publishing a framework is
//                                     what unblocks them"
//   /learn/applications/{ref}        "when a quotation is issued it will appear
//                                     here, itemised"
//
// A claim of that shape is worthless as a comment. Either publishing a framework
// makes the figures appear WITH NO CODE CHANGE AND NO DEPLOY, or the design is
// wrong and the screens are lying to the office and to the school.
//
// So this file runs the loop with nothing published, calls publishFramework()
// and NOTHING ELSE, and runs the identical calls again. Every assertion below is
// about the SAME function with the SAME arguments answering differently because
// a row appeared in fee_frameworks.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT ALSO PINS DOWN
// ─────────────────────────────────────────────────────────────────────────────
//
//   · NO FIGURE IS EVER INVENTED. Where nothing is published the answer is null
//     and never 0, because zero reads as FREE.
//   · ONE QUOTATION PER REQUEST. Issuing twice produces one quotation with two
//     versions — the property migration 0048 makes the database's job rather
//     than a SELECT-then-INSERT's hope.
//   · A FIGURE HELD FOR APPROVAL NEVER REACHES THE APPLICANT, so the status page
//     cannot be used to defeat the second pair of eyes the fee module exists to
//     put in the room.
//   · HISTORY DOES NOT MOVE. Publishing a second framework does not re-price a
//     quotation that has already been issued.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY FIGURE HERE IS A TEST FIXTURE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF has published no fee. The amounts below exist so that "a real figure
// appeared" is checkable; they are not the federation's prices and nothing in
// src/ ships them.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import * as e from '../src/db/engagement.schema';
import * as g from '../src/db/governance.schema';

import {
  submitApplication, applicationsAwaitingQuotation, type SubmitResult,
} from '../src/db/applications';
import { autoQuoteApplication } from '../src/db/auto-quote';
import {
  activeFramework, createFramework, addRule, publishFramework, issueQuote,
  reproduce, approveQuoteVersion, isFeeError,
} from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';

let db: any, client: any;

/** Reads every application in the federation. */
const national: Principal = {
  userId: 1, label: 'admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Authors and publishes fee frameworks. Deliberately cannot issue a quotation. */
const finance: Principal = {
  userId: 2, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Issues quotations. Deliberately cannot author the rules they are computed from. */
const ops: Principal = {
  userId: 3, label: 'ops',
  bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
/** Holds quote:approve as well, so the approval separation can be exercised. */
const director: Principal = {
  userId: 4, label: 'director',
  bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};

const financeCtx = { principal: finance };
const opsCtx = { principal: ops };
const directorCtx = { principal: director };

const TODAY = new Date().toISOString().slice(0, 10);

function payload(over: Record<string, unknown> = {}) {
  return {
    institutionName: 'Sunrise Public School',
    institutionType: 'school',
    city: 'Patratu',
    stateName: 'Jharkhand',
    populationCount: 900,
    participantCount: 140,
    batchCount: 4,
    campusCount: 1,
    ageBands: ['7-9', '10-12'],
    requirements: 'Two sessions a week for the middle school, with an annual grading.',
    frequencyPerWeek: 2,
    durationWeeks: 24,
    mode: 'on_site',
    hasHall: true,
    hasMats: false,
    wantsAssessment: true,
    wantsGrading: true,
    wantsCertification: true,
    contactName: 'Anita Verma',
    contactRole: 'Principal',
    contactEmail: 'principal@sunrise.example',
    contactPhone: '9876500011',
    decisionMakerName: 'Anita Verma',
    decisionMakerEmail: 'principal@sunrise.example',
    ...over,
  };
}

/** Submitted BEFORE anything is published, and priced by hand while nothing is. */
let before: SubmitResult;
/** Submitted before publication and quoted AFTER it, by the identical call. */
let after: SubmitResult;
/** Answered by a person. Must never appear in a queue of work outstanding. */
let declined: SubmitResult;

let FW1 = 0;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...g } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // published_by_user_id and quotes.created_by_user_id are real foreign keys.
  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'finance@mmakf.in', status: 'active' },
    { id: 3, email: 'ops@mmakf.in', status: 'active' },
    { id: 4, email: 'director@mmakf.in', status: 'active' },
  ]);

  before = await submitApplication(db, {
    payload: payload(), leadSource: 'organic_search', landingPath: '/learn/apply',
  });
  after = await submitApplication(db, {
    payload: payload({ institutionName: 'Riverside Academy', contactEmail: 'head@riverside.example' }),
    leadSource: 'organic_search', landingPath: '/learn/apply',
  });
  declined = await submitApplication(db, {
    payload: payload({ institutionName: 'Hillview School', contactEmail: 'head@hillview.example' }),
    leadSource: 'organic_search', landingPath: '/learn/apply',
  });
  await db.update(o.institutionApplications)
    .set({ status: 'declined' })
    .where(eq(o.institutionApplications.id, declined.applicationId));
});

// ════════════════════════════════════════════════════════════════════════════
// PART ONE — THE FEDERATION AS IT ACTUALLY IS TODAY
// ════════════════════════════════════════════════════════════════════════════

describe('with no fee framework published', () => {
  it('has nothing in force, and says so with a null rather than an error', async () => {
    expect(await activeFramework(db, TODAY)).toBeNull();
  });

  it('leaves every OPEN application waiting for a quotation, counted by the query the office reads', async () => {
    const waiting = await applicationsAwaitingQuotation(db, national, { limit: 100 });

    // Two open applications were submitted. Both are waiting; neither is
    // waiting because of anything this test did to them.
    expect(waiting.scope).toBe('all');
    expect(waiting.total).toBe(2);
    expect(waiting.rows.map((r) => r.ref).sort())
      .toEqual([before.ref, after.ref].sort());
    expect(waiting.truncated).toBe(false);

    // Both produced a training request, so they are waiting for a PRICE and not
    // for an intake fault. The two are different jobs and the queue says which.
    expect(waiting.rows.every((r) => r.hasRequest)).toBe(true);
  });

  it('does not count an application the federation has already answered', async () => {
    const waiting = await applicationsAwaitingQuotation(db, national, { limit: 100 });
    expect(waiting.rows.map((r) => r.ref)).not.toContain(declined.ref);
  });

  it('prices an application at NO FIGURE — null, never zero', async () => {
    const result = await autoQuoteApplication(db, opsCtx, before.applicationId);

    expect(result.outcome).toBe('manual_quote_required');
    // THE ASSERTION THIS WHOLE CODEBASE TURNS ON. Not 0, not '', not '0.00'.
    expect(result.totalMinor).toBeNull();
    expect(result.currency).toBeNull();
    expect(result.quoteVersionId).toBeNull();
    expect(result.frameworkId).toBeNull();
    expect(result.reason).toMatch(/has not published a fee framework/i);

    // And nothing was quoted. A quotation row here would be a figure nobody
    // computed sitting where the school's page reads one.
    const rows = await db.select().from(e.quotes);
    expect(rows).toHaveLength(0);
  });

  it('keeps that application in the waiting queue, because the office still owes it a quotation', async () => {
    const waiting = await applicationsAwaitingQuotation(db, national, { limit: 100 });
    expect(waiting.rows.map((r) => r.ref)).toContain(before.ref);
    expect(waiting.total).toBe(2);
  });

  it('refuses to price from a framework that is still a draft', async () => {
    const draft = await createFramework(db, financeCtx, { title: 'Not yet MMAKF’s', version: 99 });
    await addRule(db, financeCtx, draft.id, {
      code: 'DRAFT-BASE', label: 'Base', kind: 'base',
      audience: 'school', amountMinor: 100000, sortOrder: 10,
    });

    // A draft framework exists. activeFramework() still returns null, which is
    // the difference between a figure somebody typed and a figure the federation
    // has decided.
    expect(await activeFramework(db, TODAY)).toBeNull();

    await expect(issueQuote(db, opsCtx, {
      requestId: null, frameworkId: draft.id, inputs: { audience: 'school' },
    })).rejects.toThrow(/only a published framework may price a request/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART TWO — PUBLISH ONE THING, CHANGE NO CODE
// ════════════════════════════════════════════════════════════════════════════

describe('publishing a framework starts the loop with no code change', () => {
  it('publishes, and that is the ONLY thing that happens between the two halves of this file', async () => {
    const fw = await createFramework(db, financeCtx, {
      title: 'Institutional training, v1 (TEST FIXTURE — not MMAKF’s prices)',
      version: 1,
      effectiveFrom: null,
    });
    FW1 = fw.id;

    await addRule(db, financeCtx, FW1, {
      code: 'SCHOOL-BASE', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 5_000_000, sortOrder: 10,
    });
    await addRule(db, financeCtx, FW1, {
      code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 45_000, sortOrder: 20,
    });

    // FINANCE publishes; TRAINING_OPERATIONS quotes. Two authorities, and the
    // loop below is exercised across both.
    const published = await publishFramework(db, financeCtx, FW1);
    expect(published.status).toBe('published');

    const inForce = await activeFramework(db, TODAY);
    expect(inForce?.id).toBe(FW1);
  });

  it('publishing the same framework twice is refused rather than rewriting who froze the prices', async () => {
    await expect(publishFramework(db, financeCtx, FW1)).rejects.toThrow(/already/i);

    const [row] = await db.select().from(s.feeFrameworks).where(eq(s.feeFrameworks.id, FW1));
    expect(row.publishedByUserId).toBe(finance.userId);
  });

  it('answers the IDENTICAL call with a real figure, computed from the published rules', async () => {
    // Same function, same argument shape, same principal as the call in Part One
    // that returned null. Nothing in src/ was edited between them.
    const result = await autoQuoteApplication(db, opsCtx, after.applicationId);

    expect(result.outcome).toBe('quoted');
    expect(result.frameworkId).toBe(FW1);
    expect(result.quoteRef).toMatch(/^MMAKF-QUO-\d{4}-\d{6}$/);
    expect(result.quoteVersion).toBe(1);
    expect(result.currency).toBe('INR');

    // ₹50,000 base + 140 × ₹450 = ₹1,13,000 → 11,300,000 paise. Asserted as the
    // arithmetic and not as a magic number, so a rule change fails loudly.
    expect(result.totalMinor).toBe(5_000_000 + 140 * 45_000);
    expect(Number.isInteger(result.totalMinor)).toBe(true);
    expect(result.totalMinor! > 0).toBe(true);
  });

  it('itemises it, so the school is shown working rather than a total to argue with', async () => {
    const [version] = await db.select().from(e.quoteVersions)
      .orderBy(e.quoteVersions.id);
    const lines = await db.select().from(e.quoteLines)
      .where(eq(e.quoteLines.quoteVersionId, version.id))
      .orderBy(e.quoteLines.sortOrder);

    expect(lines.map((l: any) => l.ruleCode)).toEqual(['SCHOOL-BASE', 'PER-CHILD']);
    expect(lines[1].quantity).toBe(140);
    expect(lines[1].unitAmountMinor).toBe(45_000);
    expect(lines[1].runningTotalMinor).toBe(version.totalMinor);
    expect(version.requiresManualQuote).toBe(false);
  });

  it('takes that application OUT of the waiting queue, and leaves the unpriced one in it', async () => {
    const waiting = await applicationsAwaitingQuotation(db, national, { limit: 100 });

    expect(waiting.rows.map((r) => r.ref)).not.toContain(after.ref);
    // The one auto-quoted while nothing was published is still owed a
    // quotation by a person, and still says so.
    expect(waiting.rows.map((r) => r.ref)).toContain(before.ref);
    expect(waiting.total).toBe(1);
  });

  it('still shows no figure where no rule covers the request — an unpriced case is not a free one', async () => {
    // A university, which no rule in the framework names.
    const university = await submitApplication(db, {
      payload: payload({
        institutionName: 'Ranchi University', institutionType: 'university',
        contactEmail: 'registrar@ranchi.example',
      }),
      leadSource: 'organic_search', landingPath: '/learn/apply',
    });

    const result = await autoQuoteApplication(db, opsCtx, university.applicationId);
    expect(result.outcome).toBe('manual_quote_required');
    expect(result.totalMinor).toBeNull();
    // The framework EXISTS now, so the reason has to be the honest one — this
    // request, not the federation's silence.
    expect(result.frameworkId).toBe(FW1);
    expect(result.reason).toMatch(/no published fee rule covers/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART THREE — IDEMPOTENCY AT THE QUOTATION HOP
// ════════════════════════════════════════════════════════════════════════════

describe('issuing a quotation twice', () => {
  let requestId: number;

  beforeAll(async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, before.applicationId));
    requestId = app.requestId;
    expect(requestId).toBeTruthy();
  });

  it('produces ONE quotation with two versions, never two quotations', async () => {
    const first = await issueQuote(db, opsCtx, {
      requestId, frameworkId: FW1,
      inputs: { audience: 'school', participants: 140, mode: 'on_site' },
    });
    const second = await issueQuote(db, opsCtx, {
      requestId, frameworkId: FW1,
      inputs: { audience: 'school', participants: 150, mode: 'on_site' },
    });

    // THE PROPERTY. Two quotations for one request would mean the federation
    // quoting two prices at once, each numbering its versions from 1, with
    // nothing in the schema saying which one the school was given.
    expect(second.quoteId).toBe(first.quoteId);
    expect(second.ref).toBe(first.ref);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);

    const quotes = await db.select().from(e.quotes).where(eq(e.quotes.requestId, requestId));
    expect(quotes).toHaveLength(1);
  });

  it('leaves exactly one version live, because the earlier one was superseded', async () => {
    const [quote] = await db.select().from(e.quotes).where(eq(e.quotes.requestId, requestId));
    const versions = await db.select().from(e.quoteVersions)
      .where(eq(e.quoteVersions.quoteId, quote.id))
      .orderBy(e.quoteVersions.version);

    expect(versions.map((v: any) => v.status)).toEqual(['superseded', 'issued']);
    // Superseding is scoped to a quote_id. It only means anything because there
    // is exactly one quote_id per request — which is why the test above matters.
    expect(versions.filter((v: any) => v.status === 'issued')).toHaveLength(1);
  });

  it('is refused by the database, not merely avoided by a lucky read', async () => {
    const [quote] = await db.select().from(e.quotes).where(eq(e.quotes.requestId, requestId));

    // The guarantee stated as the database's own refusal. Without
    // quotes_request_uk (migration 0048) this INSERT succeeds and the property
    // above holds only until two callers arrive together.
    await expect(
      db.insert(e.quotes).values({ ref: 'MMAKF-QUO-9999-000001', requestId })
    ).rejects.toThrow();

    const quotes = await db.select().from(e.quotes).where(eq(e.quotes.requestId, requestId));
    expect(quotes).toHaveLength(1);
    expect(quotes[0].id).toBe(quote.id);
  });

  it('auto-quoting the same application twice writes nothing the second time', async () => {
    const first = await autoQuoteApplication(db, opsCtx, after.applicationId);
    const second = await autoQuoteApplication(db, opsCtx, after.applicationId);

    expect(first.duplicate).toBe(true);   // Part Two already ran it
    expect(second.duplicate).toBe(true);
    expect(second.quoteVersionId).toBe(first.quoteVersionId);

    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, after.applicationId));
    const quotes = await db.select().from(e.quotes).where(eq(e.quotes.requestId, app.requestId));
    expect(quotes).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART FOUR — WHAT THE APPLICANT'S PAGE MAY SHOW
// ════════════════════════════════════════════════════════════════════════════

describe('a figure held for approval', () => {
  /** The exact set /learn/applications/[ref].astro reads. */
  const VISIBLE = ['issued', 'accepted', 'rejected', 'expired', 'superseded'];

  let heldVersionId = 0;
  let heldRequestId = 0;

  beforeAll(async () => {
    // A rule the federation decided needs a second pair of eyes.
    const fw = await createFramework(db, financeCtx, {
      title: 'Framework with a rule held for approval (TEST FIXTURE)', version: 2,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'HELD-BASE', label: 'Base', kind: 'base',
      audience: 'club', amountMinor: 2_000_000, sortOrder: 10,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'HELD-DISCOUNT', label: 'Negotiated reduction', kind: 'discount',
      audience: 'club', amountMinor: -1_000_000, sortOrder: 20, requiresApproval: true,
    });
    await publishFramework(db, financeCtx, fw.id);

    const club = await submitApplication(db, {
      payload: payload({
        institutionName: 'Patratu Karate Club', institutionType: 'club',
        contactEmail: 'secretary@patratu.example',
      }),
      leadSource: 'organic_search', landingPath: '/learn/apply',
    });
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, club.applicationId));
    heldRequestId = app.requestId;

    const issued = await issueQuote(db, opsCtx, {
      requestId: heldRequestId, frameworkId: fw.id, inputs: { audience: 'club' },
    });
    const [v] = await db.select().from(e.quoteVersions)
      .where(and(eq(e.quoteVersions.quoteId, issued.quoteId), eq(e.quoteVersions.version, issued.version)));
    heldVersionId = v.id;
    expect(v.status).toBe('awaiting_approval');
  });

  it('is not in the set of statuses the applicant page reads', async () => {
    const [v] = await db.select().from(e.quoteVersions).where(eq(e.quoteVersions.id, heldVersionId));
    expect(VISIBLE).not.toContain(v.status);
    expect(v.issuedAt).toBeNull();
  });

  it('is excluded in the applicant page’s WHERE clause and not by a filter over rows already read', () => {
    const src = readFileSync('src/pages/learn/applications/[ref].astro', 'utf8');
    // The constant the page filters on, and the two statuses that must not be
    // in it. If somebody adds one, this fails before a school sees a number
    // nobody approved.
    const m = src.match(/const VISIBLE_QUOTE_STATUSES = \[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/draft/);
    expect(m![1]).not.toMatch(/awaiting_approval/);
    for (const status of VISIBLE) expect(m![1]).toContain(status);
  });

  it('reaches the applicant only after a DIFFERENT person approves it', async () => {
    // The issuer cannot approve their own, whatever action they hold.
    await expect(approveQuoteVersion(db, opsCtx, heldVersionId)).rejects.toThrow();

    await approveQuoteVersion(db, directorCtx, heldVersionId);

    const [v] = await db.select().from(e.quoteVersions).where(eq(e.quoteVersions.id, heldVersionId));
    expect(v.status).toBe('issued');
    expect(VISIBLE).toContain(v.status);
    expect(v.issuedAt).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART FIVE — HISTORY DOES NOT MOVE
// ════════════════════════════════════════════════════════════════════════════

describe('a later fee framework', () => {
  it('does not re-price a quotation that has already been issued', async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, after.applicationId));
    const [quote] = await db.select().from(e.quotes).where(eq(e.quotes.requestId, app.requestId));
    const [issued] = await db.select().from(e.quoteVersions)
      .where(eq(e.quoteVersions.quoteId, quote.id));

    const totalBefore = issued.totalMinor;
    const codeBefore = issued.frameworkCode;
    expect(totalBefore).toBe(5_000_000 + 140 * 45_000);

    // The federation doubles its prices and publishes.
    const fw = await createFramework(db, financeCtx, {
      title: 'Institutional training, v3 (TEST FIXTURE)', version: 3,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'SCHOOL-BASE', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 10_000_000, sortOrder: 10,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 90_000, sortOrder: 20,
    });
    await publishFramework(db, financeCtx, fw.id);
    expect((await activeFramework(db, TODAY))?.id).toBe(fw.id);

    // The issued quotation is unmoved, on the row and on re-computation.
    const [still] = await db.select().from(e.quoteVersions).where(eq(e.quoteVersions.id, issued.id));
    expect(still.totalMinor).toBe(totalBefore);
    expect(still.frameworkCode).toBe(codeBefore);

    const again = await reproduce(db, issued.id);
    expect(again.matches).toBe(true);
    expect(again.stored.totalMinor).toBe(totalBefore);
  });
});
