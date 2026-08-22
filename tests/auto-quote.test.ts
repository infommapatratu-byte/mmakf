// An application becomes a quotation, automatically — and the one property that
// makes it worth building.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DELIVERABLE IS THE THIRD DESCRIBE BLOCK
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything else here is scaffolding for it. The claim being tested is:
//
//     PUBLISHING A FEE FRAMEWORK IS AN ACT OF ADMINISTRATION, NOT A DEPLOY.
//
// So this file runs the whole flow — form submission through workflow through
// fee engine — against a database with NO published framework, and asserts the
// honest answer: no quotation, no figure, NOT ZERO, a task for a human and a
// message that says a quotation is being prepared. Then, in the middle of the
// same test run, somebody publishes a framework using nothing but the
// federation's own authoring functions. Then it runs the flow again and asserts
// a real quotation with a real total.
//
// NOTHING BETWEEN THE TWO RUNS IS A CODE CHANGE. To make that mechanical rather
// than a matter of trust, the test captures the stored workflow definition row
// before the framework is published and asserts it is byte-identical afterwards
// — same id, same version, same JSON. `installStandardAutomations()` is called
// exactly once, in `beforeAll`. If the second run needed a different definition
// the assertion fails, and the design is wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIGURES BELOW ARE TEST FIXTURES AND ARE NOT MMAKF'S FEES
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation has published none. They exist here to prove that a published
// framework is USED, and they are chosen so the expected total is checkable by
// hand rather than copied from what the code happened to produce.

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
  installStandardAutomations, submitApplicationWithAutomation,
  dispatchRequirementsComplete, sweepWorkflowRetries,
} from '../src/db/automations';
import {
  autoQuoteApplication, autoQuoteContext, autoQuotePrincipal,
  feeInputsForApplication, requirementsComplete, quotationDecision,
  isAutoQuoteError,
} from '../src/db/auto-quote';
import { createFramework, addRule, publishFramework, approveQuoteVersion, isFeeError } from '../src/db/fees';
import { applicantStatus, systemIntakePrincipal } from '../src/db/applications';
import type { Principal } from '../src/lib/rbac';

let db: any, client: any;

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const director: Principal = {
  userId: 2, label: 'director',
  bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const financeCtx = { principal: finance };
const directorCtx = { principal: director };

/** A complete, valid wizard payload. Every number here is one the school typed. */
function payload(over: Record<string, unknown> = {}) {
  return {
    institutionName: 'Delhi Public School Patratu',
    institutionType: 'school',
    city: 'Patratu',
    stateName: 'Jharkhand',
    populationCount: 1200,
    participantCount: 180,
    batchCount: 6,
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
    contactEmail: 'principal@dpspatratu.example',
    contactPhone: '9876543210',
    decisionMakerName: 'Anita Verma',
    decisionMakerEmail: 'principal@dpspatratu.example',
    ...over,
  };
}

async function apply(over: Record<string, unknown> = {}) {
  return submitApplicationWithAutomation(db, { payload: payload(over) });
}

async function applicationRow(id: number) {
  const [row] = await db.select().from(o.institutionApplications)
    .where(eq(o.institutionApplications.id, id)).limit(1);
  return row;
}

async function decisionRow(id: number) {
  const [row] = await db.select().from(o.applicationQuotations)
    .where(eq(o.applicationQuotations.applicationId, id)).limit(1);
  return row ?? null;
}

async function tasksFor(id: number) {
  return db.select().from(o.tasks).where(and(
    eq(o.tasks.subjectKind, 'institution_application'),
    eq(o.tasks.subjectId, id)
  ));
}

async function messagesFor(email: string) {
  return db.select().from(g.notifications).where(eq(g.notifications.recipientEmail, email));
}

async function autoQuoteDefinition() {
  const rows = await db.select().from(o.workflowDefinitions)
    .where(eq(o.workflowDefinitions.code, 'APPLICATION_AUTO_QUOTE'));
  return rows;
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...g } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'director@mmakf.in', status: 'active' },
  ]);

  // CALLED ONCE. Nothing below reinstalls a workflow or a task template, which
  // is what lets the "no code change" assertion mean anything.
  await installStandardAutomations(db);
});

// ════════════════════════════════════════════════════════════════════════════
describe('the wizard already collected everything the fee engine needs', () => {
  it('maps every quantity the engine prices on, and asks for none of them again', () => {
    const inputs = feeInputsForApplication({
      audience: 'school',
      participantCount: 180, batchCount: 6, campusCount: 2, instructorsRequired: 3,
      frequencyPerWeek: 2, durationWeeks: 24, mode: 'on_site',
      populationCount: 1200, ageBands: ['7-9'], stateName: 'Jharkhand', city: 'Patratu',
      wantsGrading: true, wantsCompetition: false,
      infrastructure: { hasHall: true, hasMats: false, notes: null },
    });

    expect(inputs).toMatchObject({
      audience: 'school',
      participants: 180,
      batches: 6,
      campuses: 2,
      instructors: 3,
      weeks: 24,
      sessionsPerWeek: 2,
      mode: 'on_site',
    });
    // The one derivation: 2 a week for 24 weeks is 48 sessions, not 2.
    expect(inputs.sessions).toBe(48);
    // `false` is an answer and travels; a skipped question does not.
    expect(inputs.wantsGrading).toBe(true);
    expect(inputs.wantsCompetition).toBe(false);
    expect(inputs.hasMats).toBe(false);
  });

  it('leaves an unanswered field OUT rather than defaulting it to zero', () => {
    // A rule that needed it is then skipped and says so. Defaulting to 0 would
    // price 0 participants at ₹450 each and call the answer ₹0.
    const inputs = feeInputsForApplication({ audience: 'college' });
    expect('participants' in inputs).toBe(false);
    expect('sessions' in inputs).toBe(false);
    expect('weeks' in inputs).toBe(false);
    expect(inputs.audience).toBe('college');
  });

  it('does not multiply sessions-per-week by nothing when the weeks are missing', () => {
    const inputs = feeInputsForApplication({ audience: 'school', frequencyPerWeek: 2 });
    expect(inputs.sessionsPerWeek).toBe(2);
    expect('sessions' in inputs).toBe(false);
  });

  it('treats a submitted application as requirements-complete and a draft as not', () => {
    expect(requirementsComplete({ status: 'submitted', requirements: 'x' }).complete).toBe(true);
    expect(requirementsComplete({ status: 'draft' }).complete).toBe(false);
    // Advisory, not a gate: an application missing a participant count is the
    // one that MOST needs a human, so it still goes through and says what is
    // missing.
    const thin = requirementsComplete({ status: 'submitted', requirements: 'x' });
    expect(thin.complete).toBe(true);
    expect(thin.missing.join(' ')).toMatch(/how many participants/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('TODAY: MMAKF has published no fee framework, and the system says so', () => {
  let appId: number, ref: string, token: string;

  beforeAll(async () => {
    const r = await apply();
    appId = r.applicationId; ref = r.ref; token = r.accessToken;
  });

  it('issues NO quotation at all', async () => {
    const quotes = await db.select().from(e.quotes);
    expect(quotes).toEqual([]);
    const versions = await db.select().from(e.quoteVersions);
    expect(versions).toEqual([]);
  });

  it('records the decision with NO FIGURE — null, not zero', async () => {
    const d = await decisionRow(appId);
    expect(d).not.toBeNull();
    expect(d.outcome).toBe('manual_quote_required');
    // THE ASSERTION THIS WHOLE SUBSYSTEM EXISTS FOR. Zero reads as FREE.
    expect(d.totalMinor).toBeNull();
    expect(d.totalMinor).not.toBe(0);
    expect(d.quoteId).toBeNull();
    expect(d.quoteVersionId).toBeNull();
    expect(d.currency).toBeNull();
  });

  it('says WHY, in the fee engine’s own words', async () => {
    const d = await decisionRow(appId);
    expect(d.reason).toMatch(/has not published a fee framework/i);
    expect(d.reason).toMatch(/by hand/i);
  });

  it('freezes what the engine was given, so the training office need not ask again', async () => {
    const d = await decisionRow(appId);
    expect(d.inputs).toMatchObject({
      audience: 'school', participants: 180, batches: 6, campuses: 1,
      weeks: 24, sessionsPerWeek: 2, sessions: 48, mode: 'on_site',
    });
  });

  it('moves the application to a state that says a person is preparing the price', async () => {
    const app = await applicationRow(appId);
    expect(app.status).toBe('awaiting_quotation');
  });

  it('creates a HIGH-priority task for the training office', async () => {
    const tasks = await tasksFor(appId);
    const manual = tasks.find((t: any) => t.templateCode === 'PREPARE_MANUAL_QUOTATION');
    expect(manual, 'no task was created to quote this by hand').toBeTruthy();
    expect(manual.assignedRole).toBe('TRAINING_OPERATIONS');
    expect(manual.priority).toBe('high');
    expect(manual.status).toBe('open');
    // No invented deadline. The federation has published no turnaround.
    expect(manual.dueAt).toBeNull();
  });

  it('does NOT leave the applicant in silence', async () => {
    const status = await applicantStatus(db, ref, token);
    const kinds = status.timeline.map((t: any) => t.kind);
    expect(kinds).toContain('awaiting_quotation');
    const line = status.timeline.find((t: any) => t.kind === 'awaiting_quotation');
    expect(line.summary).toMatch(/preparing your quotation/i);
  });

  it('shows the applicant NO figure and NO invented deadline, anywhere', async () => {
    const status = await applicantStatus(db, ref, token);
    for (const entry of status.timeline) {
      expect(entry.summary, `"${entry.summary}" shows the applicant a figure`).not.toMatch(/[₹]|\bINR\b/);
      expect(entry.summary).not.toMatch(/within \d+\s*(hours?|days?)/i);
    }
    expect(status.respondBy).toBeNull();

    const messages = await messagesFor('principal@dpspatratu.example');
    const pending = messages.find((m: any) => m.template === 'application_quotation_pending');
    expect(pending, 'the school was told nothing about its quotation').toBeTruthy();
    expect(pending.body).not.toMatch(/[₹]/);
    expect(pending.body).toMatch(/no figure to show you yet/i);
    expect(pending.status).toBe('queued');
  });

  it('keeps the internal reason internal', async () => {
    // "MMAKF has not published a fee framework" is useful to the training office
    // and alarming to a customer.
    const status = await applicantStatus(db, ref, token);
    expect(status.timeline.map((t: any) => t.summary).join(' '))
      .not.toMatch(/has not published a fee framework/i);

    const internal = await db.select().from(o.applicationEvents).where(and(
      eq(o.applicationEvents.applicationId, appId),
      eq(o.applicationEvents.kind, 'quotation_not_automated')
    ));
    expect(internal).toHaveLength(1);
    expect(internal[0].visibleToApplicant).toBe(false);
    // The detail is RESOLVED, not the reference that produced it.
    expect((internal[0].detail as any).reason).toMatch(/has not published a fee framework/i);
  });

  it('appends the honest event, and never QUOTE_ISSUED', async () => {
    const events = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.entityId, String(appId)));
    const types = events.map((x: any) => x.eventType);
    expect(types).toContain('QUOTE_MANUAL_QUOTATION_REQUIRED');
    expect(types).not.toContain('QUOTE_ISSUED');
    // The feed carries the identifier and no amount — there is no amount.
    const evt = events.find((x: any) => x.eventType === 'QUOTE_MANUAL_QUOTATION_REQUIRED');
    expect(evt.payload).toEqual({});
  });

  it('is idempotent: re-firing the trigger produces no second anything', async () => {
    const before = {
      decisions: (await db.select().from(o.applicationQuotations)).length,
      tasks: (await tasksFor(appId)).length,
      messages: (await messagesFor('principal@dpspatratu.example')).length,
      timeline: (await db.select().from(o.applicationEvents)
        .where(eq(o.applicationEvents.applicationId, appId))).length,
    };

    const again = await dispatchRequirementsComplete(db, {
      applicationId: appId, ref, accessToken: token,
    });
    expect(again[0].status).toBe('skipped');
    expect(again[0].skipReason).toBe('already_succeeded');

    expect((await db.select().from(o.applicationQuotations)).length).toBe(before.decisions);
    expect((await tasksFor(appId)).length).toBe(before.tasks);
    expect((await messagesFor('principal@dpspatratu.example')).length).toBe(before.messages);
    expect((await db.select().from(o.applicationEvents)
      .where(eq(o.applicationEvents.applicationId, appId))).length).toBe(before.timeline);
  });

  it('is idempotent BENEATH the workflow too — the unique index, not the run key', async () => {
    // Called directly, bypassing the engine entirely. This is the guarantee that
    // survives a lost workflow run, a second worker, or a future caller nobody
    // has written yet.
    const second = await autoQuoteApplication(db, autoQuoteContext(), appId);
    expect(second.duplicate).toBe(true);
    expect(second.outcome).toBe('manual_quote_required');
    expect(second.totalMinor).toBeNull();
    expect((await db.select().from(o.applicationQuotations)).length).toBe(1);
  });

  it('refuses to price a draft — that is the applicant’s unfinished business', async () => {
    const [draft] = await db.insert(o.institutionApplications).values({
      ref: 'MMAKF-APP-2026-999999', audience: 'school',
      institutionName: 'Half-filled School', status: 'draft',
    }).returning();
    await expect(autoQuoteApplication(db, autoQuoteContext(), draft.id)).rejects.toThrow();
    try {
      await autoQuoteApplication(db, autoQuoteContext(), draft.id);
    } catch (err) {
      expect(isAutoQuoteError(err)).toBe(true);
      expect((err as any).code).toBe('requirements_incomplete');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE DELIVERABLE
// ════════════════════════════════════════════════════════════════════════════
describe('publishing a fee framework starts the quotations, with NO code change', () => {
  let definitionBefore: any[];
  let FW: number;

  it('captures the stored automation exactly as it stands, before any fee exists', async () => {
    definitionBefore = await autoQuoteDefinition();
    expect(definitionBefore).toHaveLength(1);
    expect(definitionBefore[0].active).toBe(true);
    expect(definitionBefore[0].version).toBe(1);
  });

  it('publishes a framework using nothing but the federation’s authoring functions', async () => {
    // AN ACT OF ADMINISTRATION. No deploy, no environment variable, no seed
    // file, no code. Exactly what a finance officer would do through /admin.
    //
    // TEST FIXTURES, NOT MMAKF'S FEES — see the header.
    const fw = await createFramework(db, financeCtx, { title: 'Test framework', version: 1 });
    FW = fw.id;
    await addRule(db, financeCtx, FW, {
      code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 5_000_000, sortOrder: 10,          // ₹50,000
    });
    await addRule(db, financeCtx, FW, {
      code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 45_000, sortOrder: 20,             // ₹450
    });
    await publishFramework(db, financeCtx, FW);

    const [row] = await db.select().from(e.feeFrameworks).where(eq(e.feeFrameworks.id, FW));
    expect(row.status).toBe('published');
  });

  it('THE PROPERTY: the next application is priced, from a framework published mid-run', async () => {
    const r = await apply({
      institutionName: 'Kendriya Vidyalaya Ranchi',
      contactEmail: 'principal@kvranchi.example',
    });

    const d = await decisionRow(r.applicationId);
    expect(d, 'the automation did not run at all').not.toBeNull();
    expect(d.outcome).toBe('quoted');

    // ₹50,000 base + 180 × ₹450 = ₹50,000 + ₹81,000 = ₹1,31,000 = 13,100,000 paise.
    // Written out so a reader can check it without running the fee engine.
    expect(d.totalMinor).toBe(5_000_000 + 180 * 45_000);
    expect(d.totalMinor).toBe(13_100_000);
    expect(d.currency).toBe('INR');
    expect(d.frameworkCode).toBe('MMAKF-FEE-V1');
    expect(d.quoteId).not.toBeNull();
    expect(d.quoteVersionId).not.toBeNull();

    // A REAL quotation, with the working on it.
    const [qv] = await db.select().from(e.quoteVersions)
      .where(eq(e.quoteVersions.id, d.quoteVersionId));
    expect(qv.status).toBe('issued');
    expect(qv.totalMinor).toBe(13_100_000);
    expect(qv.requiresManualQuote).toBe(false);
    const lines = await db.select().from(e.quoteLines)
      .where(eq(e.quoteLines.quoteVersionId, qv.id));
    expect(lines.map((l: any) => l.ruleCode).sort()).toEqual(['BASE-SCHOOL', 'PER-CHILD']);
    // The per-participant line multiplied by what the SCHOOL typed.
    const perChild = lines.find((l: any) => l.ruleCode === 'PER-CHILD');
    expect(perChild.quantity).toBe(180);
    expect(perChild.unitAmountMinor).toBe(45_000);

    // And the school is told, on the timeline and in a message.
    const app = await applicationRow(r.applicationId);
    expect(app.status).toBe('quoted');
    const messages = await messagesFor('principal@kvranchi.example');
    expect(messages.some((m: any) => m.template === 'application_quotation_ready')).toBe(true);
    const events = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.entityId, String(r.applicationId)));
    expect(events.map((x: any) => x.eventType)).toContain('QUOTE_ISSUED');

    // NO manual-quotation task this time: nobody has to type anything.
    const tasks = await tasksFor(r.applicationId);
    expect(tasks.some((t: any) => t.templateCode === 'PREPARE_MANUAL_QUOTATION')).toBe(false);
  });

  it('AND THE AUTOMATION WAS NEVER TOUCHED — same row, same version, same JSON', async () => {
    // The point of the whole exercise. If publishing fees had required an edit
    // to the workflow, installStandardAutomations() would have written version 2
    // and this fails. It is called exactly once, in beforeAll.
    const after = await autoQuoteDefinition();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(definitionBefore[0].id);
    expect(after[0].version).toBe(definitionBefore[0].version);
    expect(JSON.stringify(after[0].definition)).toBe(JSON.stringify(definitionBefore[0].definition));
  });

  it('leaves the earlier application alone — a promise of a hand-made quotation is kept', async () => {
    // The application that was told a person would prepare its quotation is NOT
    // silently re-priced by a machine afterwards. Its task still stands, and the
    // school is not sent a second, different answer to the same question.
    const [first] = await db.select().from(o.applicationQuotations)
      .orderBy(o.applicationQuotations.id);
    expect(first.outcome).toBe('manual_quote_required');
    expect(first.totalMinor).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a rule that requires approval still waits for a person', () => {
  let appId: number;

  beforeAll(async () => {
    // A NEW VERSION, because a published framework is immutable. Version 2 is in
    // force from now on and version 1 keeps computing to what it computed.
    const fw = await createFramework(db, financeCtx, { title: 'Test framework v2', version: 2 });
    await addRule(db, financeCtx, fw.id, {
      code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 5_000_000, sortOrder: 10,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 45_000, sortOrder: 20,
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'LARGE-COHORT', label: 'Large cohort adjustment', kind: 'discount',
      audience: 'school', conditions: { participants: { min: 300 } },
      amountMinor: -2_000_000, sortOrder: 40, requiresApproval: true,
    });
    await publishFramework(db, financeCtx, fw.id);

    const r = await apply({
      institutionName: 'St Xavier’s Ranchi',
      contactEmail: 'principal@sxranchi.example',
      participantCount: 400,
    });
    appId = r.applicationId;
  });

  it('computes the figure and DOES NOT issue it', async () => {
    const d = await decisionRow(appId);
    expect(d.outcome).toBe('awaiting_approval');
    // ₹50,000 + 400 × ₹450 − ₹20,000 = ₹2,10,000.
    expect(d.totalMinor).toBe(5_000_000 + 400 * 45_000 - 2_000_000);
    const [qv] = await db.select().from(e.quoteVersions)
      .where(eq(e.quoteVersions.id, d.quoteVersionId));
    expect(qv.status).toBe('awaiting_approval');
    // Not issued means not issued: no issue timestamp.
    expect(qv.issuedAt).toBeNull();
  });

  it('does not tell the school it has a quotation, because it has not', async () => {
    const app = await applicationRow(appId);
    expect(app.status).toBe('awaiting_quotation');
    const messages = await messagesFor('principal@sxranchi.example');
    expect(messages.some((m: any) => m.template === 'application_quotation_ready')).toBe(false);
  });

  it('puts the approval in front of a named role', async () => {
    const tasks = await tasksFor(appId);
    const approve = tasks.find((t: any) => t.templateCode === 'APPROVE_AUTOMATIC_QUOTATION');
    expect(approve).toBeTruthy();
    expect(approve.assignedRole).toBe('TRAINING_DIRECTOR');
  });

  it('gives the machine no authority to approve what it issued', () => {
    // Two independent locks. First: the principal simply does not hold the
    // action — TRAINING_OPERATIONS issues and cannot approve.
    const p = autoQuotePrincipal();
    expect(p.bindings[0].role).toBe('TRAINING_OPERATIONS');
    // Second: it has no user id, so approveQuoteVersion() can never establish
    // that the approver is a different person from the issuer.
    expect(p.userId).toBeNull();
  });

  it('refuses an approval attempted as the automation itself', async () => {
    const d = await decisionRow(appId);
    await expect(
      approveQuoteVersion(db, autoQuoteContext(), d.quoteVersionId)
    ).rejects.toThrow();
  });

  it('accepts an approval from a real person who did not issue it', async () => {
    const d = await decisionRow(appId);
    await approveQuoteVersion(db, directorCtx, d.quoteVersionId, { note: 'Cohort confirmed by the school.' });
    const [qv] = await db.select().from(e.quoteVersions)
      .where(eq(e.quoteVersions.id, d.quoteVersionId));
    expect(qv.status).toBe('issued');
    expect(qv.approvedByUserId).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('reading the decision back', () => {
  it('distinguishes "has not run" from "ran and found no price"', async () => {
    const [orphan] = await db.insert(o.institutionApplications).values({
      ref: 'MMAKF-APP-2026-999998', audience: 'school',
      institutionName: 'Never Processed School', status: 'submitted',
    }).returning();

    // Null means the automation has not run. It must never render as the same
    // sentence as "it ran and there is no price".
    expect(await quotationDecision(db, orphan.id)).toBeNull();

    const decided = await autoQuoteApplication(db, autoQuoteContext(), orphan.id);
    const read = await quotationDecision(db, orphan.id);
    expect(read).not.toBeNull();
    expect(read!.outcome).toBe(decided.outcome);
  });
});
// ═════════════════════════════════════════════════════════════════════════════
// A DECISION A PERSON TOOK IS NOT UNDONE BY A MACHINE
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything below runs with a PUBLISHED framework in force — the describes
// above put two there. So an application that reaches the fee engine here gets
// a real quotation with a real figure, which is exactly what makes these tests
// worth having: the failure mode is not "nothing happens", it is a school being
// sent a quotation for an application MMAKF declined.
describe('an application the federation has closed is never quoted by a machine', () => {
  let seq = 0;

  async function closed(status: string, name: string) {
    seq += 1;
    const [row] = await db.insert(o.institutionApplications).values({
      ref: `MMAKF-APP-2026-99${String(seq).padStart(4, '0')}`,
      audience: 'school',
      institutionName: name,
      status: status as any,
      participantCount: 180,
      batchCount: 6,
      campusCount: 1,
      requirements: 'Two sessions a week for the middle school.',
      frequencyPerWeek: 2,
      durationWeeks: 24,
      mode: 'on_site',
    }).returning();
    return row;
  }

  it('refuses declined, withdrawn and expired — and writes NOTHING at all', async () => {
    for (const status of ['declined', 'withdrawn', 'expired']) {
      const app = await closed(status, `Closed ${status} School`);

      const r = await autoQuoteApplication(db, autoQuoteContext(), app.id);
      expect(r.outcome, `${status} was priced`).toBe('not_applicable');
      expect(r.totalMinor).toBeNull();
      expect(r.quoteId).toBeNull();
      expect(r.reason).toMatch(new RegExp(status));

      // Nothing written is the point. A row here would claim the application
      // for ever — including against the day somebody reopens it.
      expect(await decisionRow(app.id)).toBeNull();
      expect((await applicationRow(app.id)).status).toBe(status);
      const quotes = await db.select().from(e.quotes)
        .where(eq(e.quotes.institutionId, app.institutionId ?? -1));
      expect(quotes).toHaveLength(0);
    }
  });

  it('an application already quoted is not quoted a second time underneath the first', async () => {
    // issueQuote() re-versions and SUPERSEDES. A second automatic quotation
    // would replace the figure the institution is holding.
    const app = await closed('quoted', 'Already Quoted School');
    const r = await autoQuoteApplication(db, autoQuoteContext(), app.id);
    expect(r.outcome).toBe('not_applicable');
    expect(await decisionRow(app.id)).toBeNull();
  });

  it('the workflow fired for a closed application stops at its guard and tells nobody', async () => {
    const app = await closed('declined', 'Declined By Committee School');

    const out = await dispatchRequirementsComplete(db, {
      applicationId: app.id,
      ref: app.ref,
      contactEmail: 'head@declined.example',
      contactName: 'Head Teacher',
      institutionName: app.institutionName,
    });

    // FAILED, not quietly successful. A workflow asked to act on an application
    // the federation has closed is an anomaly somebody should be able to find,
    // and the run carries the sentence that explains it.
    expect(out[0].status).toBe('failed');
    expect(out[0].steps[0].action).toBe('require_application_open');
    expect(String(out[0].steps[0].error)).toMatch(/declined/i);

    expect((await applicationRow(app.id)).status).toBe('declined');
    expect(await decisionRow(app.id)).toBeNull();
    expect(await messagesFor('head@declined.example')).toHaveLength(0);
    expect(await tasksFor(app.id)).toHaveLength(0);
  });

  it('an application PAST quotation is a no-op the workflow records rather than a failure', async () => {
    // 'approved' is not a closed application — the guard lets it through — but
    // it is long past the point where a machine may issue a quotation. The
    // pricing step answers 'not_applicable', every branch is skipped, and the
    // run notes internally why it changed nothing.
    const app = await closed('approved', 'Approved Long Ago School');

    const out = await dispatchRequirementsComplete(db, {
      applicationId: app.id,
      ref: app.ref,
      contactEmail: 'head@approved.example',
      contactName: 'Head Teacher',
      institutionName: app.institutionName,
    });
    expect(out[0].status).toBe('succeeded');

    expect((await applicationRow(app.id)).status).toBe('approved');
    expect(await decisionRow(app.id)).toBeNull();
    expect(await messagesFor('head@approved.example')).toHaveLength(0);
    expect(await tasksFor(app.id)).toHaveLength(0);

    const notes = await db.select().from(o.applicationEvents).where(and(
      eq(o.applicationEvents.applicationId, app.id),
      eq(o.applicationEvents.kind, 'quotation_not_attempted')
    ));
    expect(notes).toHaveLength(1);
    expect(notes[0].visibleToApplicant).toBe(false);
    expect((notes[0].detail as any).reason).toMatch(/already carries a quotation/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE RETRY SWEEP IS THE PATH THAT REACHES IT
// ═════════════════════════════════════════════════════════════════════════════
//
// Not a hypothetical caller. A run that fails at any step is retried by
// `sweepWorkflowRetries()` hours or days later, from the context it was
// dispatched with, skipping the steps that already succeeded. The application
// it names can have been declined in between, and nothing in the resumed run
// would notice — the pricing step is skipped, and the steps that email the
// school and move the status are not.
//
// Both tests below fail the run the same way: the manual-quotation task
// template is switched off, so `create_task` throws in the middle of the manual
// branch. Everything after it — the school's message, the status change — is
// blocked. Then the template is switched back on and the sweep runs, which is
// exactly what happens in production when somebody fixes the thing that broke.
describe('a workflow resumed days later does not act on a world that has moved', () => {
  const sweepActor = { principal: systemIntakePrincipal() };
  const later = () => new Date(Date.now() + 6 * 3_600_000);

  async function template(active: boolean) {
    await db.update(o.taskTemplates).set({ active })
      .where(eq(o.taskTemplates.code, 'PREPARE_MANUAL_QUOTATION'));
  }

  /** Every message this address has been sent about a quotation. */
  async function pendingMessages(email: string) {
    return (await messagesFor(email))
      .filter((m: any) => m.template === 'application_quotation_pending');
  }

  /** An audience no published rule matches, so the manual branch is taken. */
  async function stalledApplication(name: string, email: string) {
    await template(false);
    const r = await apply({ institutionType: 'ngo', institutionName: name, contactEmail: email });
    await template(true);

    // The pricing step SUCCEEDED and the branch it chose then stalled. The
    // intake acknowledgement went out on its own separate run, which is why
    // only the quotation message is counted here.
    const d = await decisionRow(r.applicationId);
    expect(d.outcome).toBe('manual_quote_required');
    expect(d.totalMinor).toBeNull();
    expect((await applicationRow(r.applicationId)).status).not.toBe('awaiting_quotation');
    expect(await pendingMessages(email)).toHaveLength(0);
    return r;
  }

  it('the ordinary retry still finishes the job — the guard is not a blockade', async () => {
    const r = await stalledApplication('Hazaribagh Sports Trust', 'office@hst.example');

    const swept = await sweepWorkflowRetries(db, sweepActor, later());
    expect(swept.attempted).toBeGreaterThan(0);

    expect((await applicationRow(r.applicationId)).status).toBe('awaiting_quotation');
    expect(await pendingMessages('office@hst.example')).toHaveLength(1);
    const tasks = await tasksFor(r.applicationId);
    expect(tasks.some((t: any) => t.templateCode === 'PREPARE_MANUAL_QUOTATION')).toBe(true);
  });

  it('THE ATTACK: declined between the failure and the sweep, and it stops dead', async () => {
    const r = await stalledApplication('Ramgarh Community Trust', 'office@rct.example');

    // A PERSON DECIDES, in the window the retry queue leaves open.
    await db.update(o.institutionApplications)
      .set({ status: 'declined' })
      .where(eq(o.institutionApplications.id, r.applicationId));

    await sweepWorkflowRetries(db, sweepActor, later());

    // The decision stands.
    expect((await applicationRow(r.applicationId)).status).toBe('declined');
    // And the school is not told a quotation is being prepared for something
    // MMAKF has refused.
    expect(await pendingMessages('office@rct.example')).toHaveLength(0);
    expect((await tasksFor(r.applicationId))
      .some((t: any) => t.templateCode === 'PREPARE_MANUAL_QUOTATION')).toBe(false);

    // It stopped at the guard, by name, and said why.
    const runs = await db.select().from(o.workflowRuns)
      .where(eq(o.workflowRuns.subjectId, r.applicationId));
    const quoteRun = runs.find((x: any) => x.workflowCode === 'APPLICATION_AUTO_QUOTE');
    expect(quoteRun.status).not.toBe('succeeded');
    expect(String(quoteRun.error)).toMatch(/declined/i);

    const steps = await db.select().from(o.workflowSteps)
      .where(eq(o.workflowSteps.runId, quoteRun.id));
    expect(steps.some((s: any) => s.action === 'require_application_open' && s.status === 'failed')).toBe(true);
  });
});
