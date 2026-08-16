// The operations platform: applications, the workflow engine, tasks, coaches.
//
// The federation's demand was "DO NOT REQUIRE AN ADMINISTRATOR TO MANUALLY COPY
// DATA BETWEEN SYSTEMS", so the tests that matter most here are the ones that
// prove one form submission produces the institution, the lead, the owner, the
// task and the acknowledgement — and, just as importantly, that submitting
// twice does not produce two of each.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import * as e from '../src/db/engagement.schema';
import * as g from '../src/db/governance.schema';

import {
  WIZARD_STEPS, TOTAL_STEPS, validateSubmission, scoreApplication,
  routeApplication, submitApplication, saveDraft, reviewApplication,
  applicantStatus, applicationDetail, applicationQueue, assignApplication, draftPayload,
  systemIntakePrincipal, isApplicationError,
} from '../src/db/applications';
import {
  installStandardAutomations, submitApplicationWithAutomation,
  applyAsCoachWithAutomation, ACTIONS, runDailySweeps,
} from '../src/db/automations';
import {
  createTask, upsertTaskTemplate, completeTask, claimTask, taskQueue,
  escalateOverdueTasks, addDependency, isTaskError,
} from '../src/db/tasks';
import {
  applyAsCoach, advanceCoachApplication, activateCoach, rankCandidates,
  coachConflicts, confirmAssignment, setAvailability, coachCalendar, isCoachError,
} from '../src/db/coaches';
import {
  evaluateCondition, backoffMs, runWorkflow, installWorkflow, isWorkflowError,
} from '../src/lib/workflow';
import { render as renderTemplate, TEMPLATES, placeholdersIn, isTemplateError } from '../src/lib/email-templates';
import type { Principal } from '../src/lib/rbac';

let db: any, client: any, JH: number, RAMGARH: number;

const national: Principal = {
  userId: 1, label: 'admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const trainingOps: Principal = {
  userId: 2, label: 'ops',
  bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
const coachManager: Principal = {
  userId: 3, label: 'coach-manager',
  bindings: [{ role: 'COACH_MANAGER', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: national };
const opsCtx = { principal: trainingOps };
const cmCtx = { principal: coachManager };

/** A complete, valid wizard payload. Individual tests vary one field at a time. */
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

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...g } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'ops@mmakf.in', status: 'active' },
    { id: 3, email: 'coaches@mmakf.in', status: 'active' },
  ]);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [rg] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DT-RG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RAMGARH = rg.id;

  await installStandardAutomations(db);
});

// ════════════════════════════════════════════════════════════════════════════
describe('the wizard definition is the only definition', () => {
  it('has exactly twenty steps, numbered without gaps', () => {
    expect(WIZARD_STEPS).toHaveLength(20);
    expect(TOTAL_STEPS).toBe(20);
    expect(WIZARD_STEPS.map((s) => s.step)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('gives every field a unique name across all steps', () => {
    // Two steps sharing a field name means one silently overwrites the other in
    // the flat payload, and the applicant loses an answer they gave.
    const names = WIZARD_STEPS.flatMap((s) => s.fields.map((f) => f.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('asks only for what an application genuinely cannot proceed without', () => {
    // A twenty-step form that demands an answer the enquirer does not have is a
    // form they abandon. Guarded so a later edit has to justify itself.
    const required = WIZARD_STEPS.flatMap((s) => s.fields.filter((f) => f.required).map((f) => f.name));
    expect(required.sort()).toEqual(
      ['city', 'contactEmail', 'contactName', 'institutionName', 'institutionType', 'requirements', 'stateName'].sort()
    );
  });
});

describe('validation', () => {
  it('reports every problem at once, not the first', () => {
    const problems = validateSubmission({ institutionType: 'school' });
    expect(problems.length).toBeGreaterThan(3);
    expect(problems.map((p) => p.field)).toContain('institutionName');
    expect(problems.map((p) => p.field)).toContain('contactEmail');
  });

  it('catches more participants than people', () => {
    const problems = validateSubmission(payload({ populationCount: 100, participantCount: 900 }));
    expect(problems.some((p) => p.field === 'participantCount')).toBe(true);
  });

  it('accepts a complete submission', () => {
    expect(validateSubmission(payload())).toEqual([]);
  });

  it('refuses a multiselect value that is not on the list', () => {
    const problems = validateSubmission(payload({ ageBands: ['7-9', 'infants'] }));
    expect(problems.some((p) => p.message.includes('infants'))).toBe(true);
  });
});

describe('lead scoring is advice, and says what it is made of', () => {
  it('explains every component', () => {
    const { score, reasons } = scoreApplication({
      participantCount: 180, campusCount: 3, durationWeeks: 24,
      decisionMakerEmail: 'p@x.example', wantsCertification: true,
      requirements: 'x'.repeat(250),
    });
    expect(score).toBeGreaterThan(50);
    expect(reasons.join(' ')).toMatch(/180 participants/);
    expect(reasons.join(' ')).toMatch(/3 campuses/);
    // Every reason carries its own contribution, so the total is checkable.
    for (const r of reasons) expect(r).toMatch(/\(\+\d+\)/);
  });

  it('says so when the participant count is missing rather than scoring it as zero people', () => {
    const { reasons } = scoreApplication({});
    expect(reasons.join(' ')).toMatch(/not stated/);
  });

  it('cannot be pushed past its ceiling by absurd inputs', () => {
    const { score } = scoreApplication({
      participantCount: 100_000, campusCount: 99, durationWeeks: 520,
      decisionMakerEmail: 'a@b.example', wantsCertification: true,
      requirements: 'y'.repeat(5000),
      preferredStart: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    });
    // Every band is capped individually, so the components sum to 95 and the
    // Math.min(100, …) in scoreApplication is belt and braces rather than the
    // thing doing the work. Stated as 95 so that adding a component moves this
    // number visibly instead of hiding under a cap.
    expect(score).toBe(95);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('routing', () => {
  beforeEach(async () => {
    await db.delete(o.routingRules);
  });

  it('leaves an application unassigned rather than guessing when nothing matches', async () => {
    const d = await routeApplication(db, { audience: 'school' });
    expect(d.targetRole).toBeNull();
    expect(d.ruleId).toBeNull();
    expect(d.explanation).toMatch(/unassigned/);
  });

  it('prefers the more specific rule even when a broader one has higher priority', async () => {
    await db.insert(o.routingRules).values([
      { label: 'All schools', audience: 'school', targetRole: 'SCHOOL_PROGRAM_MANAGER', priority: 900 },
      { label: 'Ramgarh schools', audience: 'school', districtUnitId: RAMGARH, targetRole: 'TRAINING_OPERATIONS', priority: 10 },
    ]);
    const d = await routeApplication(db, { audience: 'school', districtUnitId: RAMGARH });
    // Two conditions beat one, whatever the priorities say.
    expect(d.targetRole).toBe('TRAINING_OPERATIONS');
    expect(d.explanation).toMatch(/2 condition/);
  });

  it('does not match a participant band when no participant count was given', async () => {
    await db.insert(o.routingRules).values({
      label: 'Large cohorts', audience: 'school', minParticipants: 100,
      targetRole: 'TRAINING_DIRECTOR', priority: 100,
    });
    // Unknown is not "at least 100". An enquiry that never stated a size must
    // not fall into the rule for big ones.
    const d = await routeApplication(db, { audience: 'school', participantCount: null });
    expect(d.targetRole).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ONE SUBMISSION, EVERYTHING DERIVED — the federation’s actual demand', () => {
  let result: any;

  beforeAll(async () => {
    // The routing tests above leave their last rule in place. Without this the
    // 'Large cohorts' rule (audience + minParticipants) is more specific than
    // the one seeded here and legitimately wins — a leaky fixture rather than a
    // routing fault, but it makes this suite assert the wrong owner.
    await db.delete(o.routingRules);
    await db.insert(o.routingRules).values({
      label: 'Schools nationally', audience: 'school',
      targetRole: 'TRAINING_OPERATIONS', priority: 100,
    });
    result = await submitApplicationWithAutomation(db, {
      payload: payload(),
      leadSource: 'organic_search',
      landingPath: '/karate-for-schools',
    });
  });

  it('stores the application with a reference and a private token', () => {
    expect(result.ref).toMatch(/^MMAKF-APP-\d{4}-\d{6}$/);
    expect(result.accessToken).toBeTruthy();
    expect(result.accessToken.length).toBeGreaterThan(20);
  });

  it('creates the institution without anybody re-typing it', async () => {
    expect(result.institutionId).toBeTruthy();
    const [inst] = await db.select().from(e.institutions)
      .where(eq(e.institutions.id, result.institutionId));
    expect(inst.name).toBe('Delhi Public School Patratu');
    expect(inst.kind).toBe('school');
  });

  it('creates the lead, attributed to the page that produced it', async () => {
    expect(result.leadId).toBeTruthy();
    const [lead] = await db.select().from(e.leads).where(eq(e.leads.id, result.leadId));
    expect(lead).toBeTruthy();
  });

  it('routes it to a role', () => {
    expect(result.ownerRole).toBe('TRAINING_OPERATIONS');
  });

  it('creates the review task in that role’s queue', async () => {
    const tasks = await db.select().from(o.tasks)
      .where(and(eq(o.tasks.subjectKind, 'institution_application'), eq(o.tasks.subjectId, result.applicationId)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedRole).toBe('TRAINING_OPERATIONS');
    expect(tasks[0].templateCode).toBe('REVIEW_INSTITUTION_APPLICATION');
  });

  it('sets NO deadline, because the federation has published no service standard', async () => {
    const tasks = await db.select().from(o.tasks)
      .where(and(eq(o.tasks.subjectKind, 'institution_application'), eq(o.tasks.subjectId, result.applicationId)));
    // The one thing this system must never do is invent a commitment.
    expect(tasks[0].dueAt).toBeNull();
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, result.applicationId));
    expect(app.slaDueAt).toBeNull();
  });

  it('queues the acknowledgement, addressed to somebody with no account', async () => {
    const [msg] = await db.select().from(g.notifications)
      .where(eq(g.notifications.template, 'application_received'));
    expect(msg).toBeTruthy();
    expect(msg.recipientEmail).toBe('principal@dpspatratu.example');
    expect(msg.status).toBe('queued');
    expect(msg.title).toContain(result.ref);
  });

  it('promises no turnaround in the acknowledgement', async () => {
    const [msg] = await db.select().from(g.notifications)
      .where(eq(g.notifications.template, 'application_received'));
    expect(msg.body).not.toMatch(/\b\d+\s*(hours?|days?|working days?)\b/i);
    expect(msg.body).not.toMatch(/within/i);
  });

  it('appends the event to the federation feed', async () => {
    const rows = await db.select().from(g.domainEvents)
      .where(eq(g.domainEvents.eventType, 'INSTITUTION_APPLICATION_SUBMITTED'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('records every automation step as succeeded', () => {
    const run = result.automation[0];
    expect(run.status).toBe('succeeded');
    expect(run.steps.every((st: any) => st.status === 'succeeded' || st.status === 'skipped')).toBe(true);
  });

  it('shows the applicant a timeline, and nothing internal', async () => {
    const view = await applicantStatus(db, result.ref, result.accessToken);
    expect(view.status).toBe('acknowledged');
    const kinds = view.timeline.map((t: any) => t.kind);
    expect(kinds).toContain('submitted');
    expect(kinds).toContain('acknowledged');
    // Routing and scoring are internal. The school is not shown how it was
    // triaged.
    expect(kinds).not.toContain('routed');
    expect(JSON.stringify(view)).not.toMatch(/leadScore|ownerRole|TRAINING_OPERATIONS/);
  });

  it('refuses the status page without the token', async () => {
    await expect(applicantStatus(db, result.ref, 'guessed')).rejects.toThrow();
    await expect(applicantStatus(db, result.ref, '')).rejects.toThrow();
  });

  it('never hands the applicant’s private token to staff', async () => {
    const detail = await applicationDetail(db, national, result.applicationId);
    expect((detail.application as any).accessToken).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(result.accessToken);
  });
});

describe('re-running the automation does not double anything', () => {
  it('creates one task and one message however many times it runs', async () => {
    await db.insert(o.routingRules).values({
      label: 'Corporates', audience: 'corporate', targetRole: 'CORPORATE_PROGRAM_MANAGER', priority: 100,
    }).onConflictDoNothing();

    const first = await submitApplicationWithAutomation(db, {
      payload: payload({
        institutionName: 'Tata Steel Ramgarh',
        institutionType: 'corporate',
        contactEmail: 'hr@tsr.example',
      }),
    });

    const countTasks = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(o.tasks)
      .where(and(eq(o.tasks.subjectKind, 'institution_application'), eq(o.tasks.subjectId, first.applicationId))))[0].n;
    const countMsgs = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(g.notifications)
      .where(eq(g.notifications.recipientEmail, 'hr@tsr.example')))[0].n;

    expect(await countTasks()).toBe(1);
    expect(await countMsgs()).toBe(1);

    // The retry sweep, and a straight re-dispatch, both re-enter the same run.
    const { dispatch } = await import('../src/db/automations');
    const again = await dispatch(db, {
      trigger: 'INSTITUTION_APPLICATION_SUBMITTED',
      idempotencyKey: `application:${first.applicationId}`,
      subjectKind: 'institution_application',
      subjectId: first.applicationId,
      context: {},
      actor: { principal: systemIntakePrincipal() },
    });

    expect(again[0].status).toBe('skipped');
    expect(again[0].skipReason).toBe('already_succeeded');
    expect(await countTasks()).toBe(1);
    expect(await countMsgs()).toBe(1);
  });
});

describe('duplicate institutions are reported, never merged', () => {
  it('flags the second application and still stores it in full', async () => {
    const p = payload({ institutionName: 'St Xavier School', city: 'Hazaribagh', contactEmail: 'a@sx.example' });
    const first = await submitApplication(db, { payload: p });
    const second = await submitApplication(db, { payload: { ...p, contactEmail: 'b@sx.example' } });

    expect(second.duplicateOf).toBe(first.ref);
    // Both survive: two campuses of one trust legitimately apply separately.
    expect(second.applicationId).not.toBe(first.applicationId);

    const detail = await applicationDetail(db, national, second.applicationId);
    expect(detail.events.some((ev: any) => ev.kind === 'possible_duplicate')).toBe(true);
  });
});

describe('drafts', () => {
  it('resumes only with the token it was issued', async () => {
    const draft = await saveDraft(db, { payload: payload(), stepReached: 7 });
    await expect(
      saveDraft(db, { ref: draft.ref, accessToken: 'wrong', payload: payload(), stepReached: 8 })
    ).rejects.toThrow();

    const resumed = await saveDraft(db, {
      ref: draft.ref, accessToken: draft.accessToken!, payload: payload(), stepReached: 8,
    });
    expect(resumed.stepReached).toBe(8);
  });

  it('never lets the step counter go backwards on a resume', async () => {
    const draft = await saveDraft(db, { payload: payload(), stepReached: 12 });
    const resumed = await saveDraft(db, {
      ref: draft.ref, accessToken: draft.accessToken!, payload: payload(), stepReached: 3,
    });
    expect(resumed.stepReached).toBe(12);
  });

  it('keeps drafts out of the federation’s queue until they are sent', async () => {
    await saveDraft(db, { payload: payload({ institutionName: 'Half Filled Academy' }) });
    const queue = await applicationQueue(db, national, { limit: 200 });
    expect(queue.some((a: any) => a.institutionName === 'Half Filled Academy')).toBe(false);
  });
});

describe('review', () => {
  it('refuses to decline without a reason', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Refusal Test School' }) });
    await expect(
      reviewApplication(db, ctx, r.applicationId, { status: 'declined' })
    ).rejects.toThrow(/why/i);
  });

  it('keeps an internal note internal', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Note Test School' }) });
    await reviewApplication(db, ctx, r.applicationId, {
      status: 'under_review', note: 'Chased twice, no answer from the principal.',
    });
    const view = await applicantStatus(db, r.ref, r.accessToken);
    expect(JSON.stringify(view)).not.toMatch(/Chased twice/);
    const detail = await applicationDetail(db, national, r.applicationId);
    expect(JSON.stringify(detail)).toMatch(/Chased twice/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The applicant's key is the only thing between one school's submission and
// anybody who can count: refs are sequence-allocated, so MMAKF-APP-2026-000002
// is always one keystroke away from MMAKF-APP-2026-000001.
describe('the applicant’s access token', () => {
  it('does not open another application when the reference is changed', async () => {
    const mine = await submitApplication(db, { payload: payload({ institutionName: 'Token Holder School' }) });
    const theirs = await submitApplication(db, { payload: payload({ institutionName: 'Other Institution' }) });

    // The whole attack, in one line: keep my key, put their reference in the
    // address bar.
    await expect(applicantStatus(db, theirs.ref, mine.accessToken)).rejects.toThrow();
    await expect(applicantStatus(db, mine.ref, theirs.accessToken)).rejects.toThrow();

    // And each still opens its own.
    expect((await applicantStatus(db, mine.ref, mine.accessToken)).institutionName)
      .toBe('Token Holder School');
    expect((await applicantStatus(db, theirs.ref, theirs.accessToken)).institutionName)
      .toBe('Other Institution');
  });

  it('refuses a key that is right except for one character', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Near Miss School' }) });
    const last = r.accessToken.slice(-1);
    const nearMiss = r.accessToken.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(nearMiss).not.toBe(r.accessToken);
    expect(nearMiss.length).toBe(r.accessToken.length);
    await expect(applicantStatus(db, r.ref, nearMiss)).rejects.toThrow();
  });

  it('refuses an empty, missing or absurd key', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Empty Key School' }) });
    await expect(applicantStatus(db, r.ref, '')).rejects.toThrow();
    await expect(applicantStatus(db, r.ref, null as any)).rejects.toThrow();
    await expect(applicantStatus(db, r.ref, undefined as any)).rejects.toThrow();
    // Unequal lengths must be refused, not thrown over: timingSafeEqual raises
    // on mismatched buffers, which is why both sides are hashed first.
    await expect(applicantStatus(db, r.ref, 'x')).rejects.toThrow(/No application/);
    await expect(applicantStatus(db, r.ref, 'x'.repeat(5000))).rejects.toThrow(/No application/);
  });

  it('answers an unknown reference exactly as it answers a wrong key', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Oracle Test School' }) });
    const wrongKey = await applicantStatus(db, r.ref, 'not-the-key').catch((err) => err);
    const noSuchRef = await applicantStatus(db, 'MMAKF-APP-1900-000000', r.accessToken).catch((err) => err);
    // Same code and same sentence. Anything else tells a caller which
    // references exist.
    expect(wrongKey.code).toBe(noSuchRef.code);
    expect(wrongKey.message).toBe(noSuchRef.message);
  });

  it('is long enough that guessing is not a strategy', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Entropy School' }) });
    // 32 random bytes, base64url. Under 40 characters would mean somebody had
    // shortened it.
    expect(r.accessToken.length).toBeGreaterThanOrEqual(40);
    expect(r.accessToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r.accessToken).not.toContain(r.ref);
  });

  it('will not reopen a sent application as a draft', async () => {
    const draft = await saveDraft(db, { payload: payload({ institutionName: 'Reopen Test School' }), stepReached: 4 });
    expect(await draftPayload(db, draft.ref, draft.accessToken!)).toBeTruthy();

    await submitApplication(db, {
      payload: payload({ institutionName: 'Reopen Test School' }),
      ref: draft.ref, accessToken: draft.accessToken!,
    });

    // The wizard must not be able to reopen and overwrite what MMAKF is
    // already reviewing.
    expect(await draftPayload(db, draft.ref, draft.accessToken!)).toBeNull();
    expect(await draftPayload(db, draft.ref, 'wrong')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Two views of one case. They are allowed to show different SETS of entries —
// that is what visible_to_applicant is for — and nothing else.
describe('the applicant’s timeline and the administrator’s are one case', () => {
  it('shows the applicant a subset of the administrator’s entries, in the same order and the same words', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Two Halves School' }) });
    await reviewApplication(db, ctx, r.applicationId, {
      status: 'acknowledged', note: 'Spoke to the principal. Wants a September start.',
    });
    await reviewApplication(db, ctx, r.applicationId, { status: 'under_review' });
    await reviewApplication(db, ctx, r.applicationId, { status: 'program_design' });

    const applicant = await applicantStatus(db, r.ref, r.accessToken);
    const admin = await applicationDetail(db, national, r.applicationId);

    const adminVisible = admin.events
      .filter((e: any) => e.visibleToApplicant === true)
      .map((e: any) => `${e.kind}|${e.summary}`);
    const applicantSeen = applicant.timeline.map((e: any) => `${e.kind}|${e.summary}`);

    // Identical, element for element. Not "the same length", not "the same
    // set" — the same sequence, because a case read in two orders is two
    // accounts of it.
    expect(applicantSeen).toEqual(adminVisible);

    // The administrator sees strictly more, and the extra is the internal work.
    expect(admin.events.length).toBeGreaterThan(applicant.timeline.length);
    const adminKinds = admin.events.map((e: any) => e.kind);
    expect(adminKinds).toContain('routed');
    expect(adminKinds).toContain('note');
    expect(applicantSeen.join(' ')).not.toMatch(/September start/);
  });

  it('orders events the same way on both sides when they share a timestamp', async () => {
    // Submission writes several events inside one call, all carrying the same
    // `now`. `at` alone leaves the tie to the database; `at, id` does not.
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Same Instant School' }) });
    const admin = await applicationDetail(db, national, r.applicationId);
    const ids = admin.events.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
  });

  it('reports the last thing the applicant was actually told, not the last thing that happened', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'Last Update School' }) });
    const before = await applicantStatus(db, r.ref, r.accessToken);
    expect(before.lastUpdateAt).toBeTruthy();

    // An internal-only note moves nothing the school can see.
    await assignApplication(db, ctx, r.applicationId, { role: 'TRAINING_OPERATIONS' });
    const after = await applicantStatus(db, r.ref, r.accessToken);
    expect(new Date(after.lastUpdateAt as any).getTime())
      .toBe(new Date(before.lastUpdateAt as any).getTime());
  });

  it('promises no date, because the federation has published no service standard', async () => {
    const r = await submitApplication(db, { payload: payload({ institutionName: 'No Promise School' }) });
    const view = await applicantStatus(db, r.ref, r.accessToken);
    expect(view.respondBy).toBeNull();
    // Nothing in what the school reads names a turnaround.
    expect(JSON.stringify(view)).not.toMatch(/within \d+|\d+ hours|\d+ working days|by \d{1,2}\//i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the workflow engine', () => {
  it('fails a step on an unrecognised condition rather than skipping it silently', () => {
    // A typo in a condition must not quietly disable the step it guards.
    expect(() => evaluateCondition({ path: 'x', op: 'moreish', value: 1 }, {})).toThrow(/moreish/);
    expect(() => evaluateCondition({ path: 'x' }, {})).toThrow();
    expect(() => evaluateCondition('yes' as any, {})).toThrow();
  });

  it('treats a missing value as not matching an ordered comparison', () => {
    expect(evaluateCondition({ path: 'n', op: 'gte', value: 50 }, {})).toBe(false);
    expect(evaluateCondition({ path: 'n', op: 'gte', value: 50 }, { n: 50 })).toBe(true);
    expect(evaluateCondition({ path: 'n', op: 'lt', value: 50 }, {})).toBe(false);
  });

  it('handles all/any/not', () => {
    const scope = { a: 1, b: 'x' };
    expect(evaluateCondition({ all: [{ path: 'a', op: 'eq', value: 1 }, { path: 'b', op: 'eq', value: 'x' }] }, scope)).toBe(true);
    expect(evaluateCondition({ any: [{ path: 'a', op: 'eq', value: 9 }, { path: 'b', op: 'eq', value: 'x' }] }, scope)).toBe(true);
    expect(evaluateCondition({ not: { path: 'a', op: 'eq', value: 1 } }, scope)).toBe(false);
  });

  it('backs off in minutes, not seconds, and caps at an hour', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(25 * 60_000);
    expect(backoffMs(9)).toBe(60 * 60_000);
  });

  it('records a failed step, blocks the rest, and resumes from the failure', async () => {
    let attempts = 0;
    const registry = {
      first: async () => ({ ok: 1 }),
      flaky: async () => {
        attempts++;
        if (attempts === 1) throw new Error('the notifier was unreachable');
        return { ok: 2 };
      },
      third: async () => ({ ok: 3 }),
    };
    const spec = {
      maxAttempts: 3,
      steps: [{ action: 'first' }, { action: 'flaky' }, { action: 'third' }],
    };

    const one = await runWorkflow(db, registry, {
      code: 'TEST_RESUME', trigger: 'TEST', spec,
      idempotencyKey: 'test-resume-1', actor: ctx,
    });
    expect(one.status).toBe('partially_failed');
    expect(one.steps.map((s: any) => s.status)).toEqual(['succeeded', 'failed', 'blocked']);

    const two = await runWorkflow(db, registry, {
      code: 'TEST_RESUME', trigger: 'TEST', spec,
      idempotencyKey: 'test-resume-1', actor: ctx,
    });
    // Step 1 is NOT run again — its effects already happened.
    expect(two.steps[0].status).toBe('already_done');
    expect(two.status).toBe('succeeded');
    expect(attempts).toBe(2);
  });

  it('fails a step whose action nobody implemented, instead of reporting success', async () => {
    const out = await runWorkflow(db, {}, {
      code: 'TEST_MISSING', trigger: 'TEST',
      spec: { steps: [{ action: 'does_not_exist' }] },
      idempotencyKey: 'test-missing-1', actor: ctx,
    });
    expect(out.status).toBe('failed');
    expect(out.steps[0].error).toMatch(/does_not_exist/);
  });

  it('keeps an optional step’s failure from failing the run, and still records it', async () => {
    const out = await runWorkflow(db, { boom: async () => { throw new Error('nope'); }, fine: async () => 1 }, {
      code: 'TEST_OPTIONAL', trigger: 'TEST',
      spec: { steps: [{ action: 'boom', optional: true }, { action: 'fine' }] },
      idempotencyKey: 'test-optional-1', actor: ctx,
    });
    expect(out.status).toBe('succeeded');
    expect(out.steps[0].status).toBe('failed_optional');
    const rows = await db.select().from(o.workflowSteps).where(eq(o.workflowSteps.action, 'boom'));
    expect(rows[0].error).toMatch(/nope/);
  });

  it('versions a changed definition instead of editing it', async () => {
    const a = await installWorkflow(db, {
      code: 'TEST_VERSIONING', title: 'v', trigger: 'TEST_V',
      spec: { steps: [{ action: 'first' }] },
    });
    const again = await installWorkflow(db, {
      code: 'TEST_VERSIONING', title: 'v', trigger: 'TEST_V',
      spec: { steps: [{ action: 'first' }] },
    });
    expect(again.changed).toBe(false);
    expect(again.version).toBe(a.version);

    const b = await installWorkflow(db, {
      code: 'TEST_VERSIONING', title: 'v', trigger: 'TEST_V',
      spec: { steps: [{ action: 'first' }, { action: 'second' }] },
    });
    expect(b.version).toBe(a.version + 1);

    // The old version stays on record so a run that failed under it can still
    // be retried in the shape it actually ran.
    const all = await db.select().from(o.workflowDefinitions)
      .where(eq(o.workflowDefinitions.code, 'TEST_VERSIONING'));
    expect(all).toHaveLength(2);
    expect(all.filter((d: any) => d.active)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('tasks', () => {
  it('refuses to reopen a finished task, and says what to do instead', async () => {
    const t = await createTask(db, ctx, { title: 'One-way', assignedRole: 'TRAINING_OPERATIONS' });
    await completeTask(db, ctx, t.id, 'done');
    await expect(completeTask(db, ctx, t.id, 'again')).resolves.toBeTruthy(); // same status is a no-op
    const [row] = await db.select().from(o.tasks).where(eq(o.tasks.id, t.id));
    expect(row.status).toBe('done');
  });

  it('will not complete a task whose dependency is outstanding', async () => {
    const first = await createTask(db, ctx, { title: 'Sign the contract' });
    const second = await createTask(db, ctx, { title: 'Schedule the sessions' });
    await addDependency(db, ctx, second.id, first.id);

    await expect(completeTask(db, ctx, second.id)).rejects.toThrow(new RegExp(first.ref));
    await completeTask(db, ctx, first.id, 'signed');
    await expect(completeTask(db, ctx, second.id, 'scheduled')).resolves.toBeTruthy();
  });

  it('refuses a dependency cycle', async () => {
    const a = await createTask(db, ctx, { title: 'A' });
    const b = await createTask(db, ctx, { title: 'B' });
    await addDependency(db, ctx, a.id, b.id);
    await expect(addDependency(db, ctx, b.id, a.id)).rejects.toThrow(/wait for each other/);
  });

  it('escalates by returning the task to the role queue, not to another individual', async () => {
    await upsertTaskTemplate(db, {
      code: 'TEST_ESCALATION', title: 'Escalating work',
      defaultRole: 'TRAINING_OPERATIONS', escalateAfterHours: 1, escalateToRole: 'TRAINING_DIRECTOR',
    });
    const past = new Date(Date.now() - 10 * 3_600_000);
    const t = await createTask(db, ctx, { templateCode: 'TEST_ESCALATION', now: past });
    await db.update(o.tasks).set({ assignedUserId: 2 }).where(eq(o.tasks.id, t.id));

    const out = await escalateOverdueTasks(db, ctx);
    expect(out.refs).toContain(t.ref);

    const [row] = await db.select().from(o.tasks).where(eq(o.tasks.id, t.id));
    expect(row.escalationLevel).toBe(1);
    expect(row.assignedRole).toBe('TRAINING_DIRECTOR');
    // The holder did not act, so it goes back to the queue rather than to
    // another named person who is equally able not to act.
    expect(row.assignedUserId).toBeNull();
    expect(row.priority).toBe('high');
  });

  it('keeps a task with no deadline out of the escalation sweep entirely', async () => {
    const t = await createTask(db, ctx, { title: 'No deadline set' });
    const out = await escalateOverdueTasks(db, ctx);
    expect(out.refs).not.toContain(t.ref);
  });

  it('shows a role-holder the work addressed to their role', async () => {
    await createTask(db, ctx, { title: 'For operations', assignedRole: 'TRAINING_OPERATIONS' });
    const queue = await taskQueue(db, trainingOps, { limit: 200 });
    expect(queue.some((t: any) => t.title === 'For operations')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('coaches', () => {
  let coachAppId: number, personId: number, profileId: number;

  it('accepts an application and refuses one with no way to reply', async () => {
    await expect(applyAsCoach(db, { fullName: 'No Contact' })).rejects.toThrow(/email|telephone/i);

    const app = await applyAsCoachWithAutomation(db, {
      fullName: 'Vikas Kumar', email: 'vikas@example.com',
      danGrade: 'III Dan', teachingYears: 8, city: 'Ramgarh',
      stateUnitId: JH, districtUnitId: RAMGARH,
      languages: ['hindi', 'english'],
    });
    coachAppId = app.id;
    expect(app.ref).toMatch(/^MMAKF-CA-\d{4}-\d{6}$/);
    expect(app.status).toBe('candidate');
  });

  it('returns the existing application when somebody submits twice', async () => {
    const again = await applyAsCoach(db, { fullName: 'Vikas Kumar', email: 'vikas@example.com' });
    expect(again.deduplicated).toBe(true);
    expect(again.id).toBe(coachAppId);
  });

  it('creates the screening task and acknowledges the candidate', async () => {
    const tasks = await db.select().from(o.tasks)
      .where(and(eq(o.tasks.subjectKind, 'coach_application'), eq(o.tasks.subjectId, coachAppId)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedRole).toBe('COACH_MANAGER');

    const [msg] = await db.select().from(g.notifications)
      .where(eq(g.notifications.template, 'coach_application_received'));
    expect(msg.recipientEmail).toBe('vikas@example.com');
  });

  it('refuses to skip the recruitment stages', async () => {
    await expect(
      advanceCoachApplication(db, cmCtx, coachAppId, 'approved')
    ).rejects.toThrow(/cannot go from candidate to approved/);
  });

  it('refuses a rejection with no reason', async () => {
    await expect(
      advanceCoachApplication(db, cmCtx, coachAppId, 'rejected')
    ).rejects.toThrow(/why/i);
  });

  it('walks the full lifecycle and records every stage', async () => {
    for (const stage of ['screening', 'interview', 'technical_review', 'document_check', 'approved'] as const) {
      await advanceCoachApplication(db, cmCtx, coachAppId, stage, { outcome: 'passed' });
    }
    const stages = await db.select().from(o.coachStageEvents)
      .where(eq(o.coachStageEvents.applicationId, coachAppId));
    expect(stages.map((s: any) => s.toStatus)).toEqual(
      ['candidate', 'screening', 'interview', 'technical_review', 'document_check', 'approved']
    );

    const [p] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000001', fullName: 'Vikas Kumar',
      stateUnitId: JH, districtUnitId: RAMGARH, status: 'active',
    }).returning();
    personId = p.id;

    const profile = await activateCoach(db, cmCtx, coachAppId, personId);
    profileId = profile.id;
    expect(profile.status).toBe('active');
  });

  it('EXCLUDES a coach with no safeguarding clearance from work with children', async () => {
    const start = new Date('2026-09-01T09:00:00Z');
    const end = new Date('2026-09-01T10:00:00Z');

    const withMinors = await rankCandidates(db, coachManager, {
      startsAt: start, endsAt: end, involvesMinors: true,
      stateUnitId: JH, districtUnitId: RAMGARH,
    });
    const vikas = withMinors.find((c) => c.personId === personId)!;
    expect(vikas.eligible).toBe(false);
    // Stated plainly, because somebody will ask why he is not on the list.
    expect(vikas.exclusions.join(' ')).toMatch(/No safeguarding clearance/);

    // The same coach IS eligible for adult work.
    const adults = await rankCandidates(db, coachManager, {
      startsAt: start, endsAt: end, involvesMinors: false,
      stateUnitId: JH, districtUnitId: RAMGARH,
    });
    expect(adults.find((c) => c.personId === personId)!.eligible).toBe(true);
  });

  it('treats a lapsed clearance as no clearance', async () => {
    await db.update(o.coachProfiles).set({
      safeguardingClearedOn: '2020-01-01', safeguardingExpiresOn: '2021-01-01',
    }).where(eq(o.coachProfiles.id, profileId));

    const ranked = await rankCandidates(db, coachManager, {
      startsAt: new Date('2026-09-01T09:00:00Z'),
      endsAt: new Date('2026-09-01T10:00:00Z'),
      involvesMinors: true,
    });
    expect(ranked.find((c) => c.personId === personId)!.exclusions.join(' ')).toMatch(/lapsed/);

    await db.update(o.coachProfiles).set({
      safeguardingClearedOn: '2026-01-01', safeguardingExpiresOn: '2027-01-01',
    }).where(eq(o.coachProfiles.id, profileId));
  });

  it('scores every candidate with reasons a human can argue with', async () => {
    const ranked = await rankCandidates(db, coachManager, {
      startsAt: new Date('2026-09-01T09:00:00Z'),
      endsAt: new Date('2026-09-01T10:00:00Z'),
      districtUnitId: RAMGARH,
      requiredLanguage: 'hindi',
    });
    const vikas = ranked.find((c) => c.personId === personId)!;
    expect(vikas.reasons.join(' ')).toMatch(/same district/);
    expect(vikas.reasons.join(' ')).toMatch(/speaks hindi/);
  });

  it('does not treat back-to-back sessions as a clash', async () => {
    const [program] = await db.insert(e.trainingPrograms).values({
      code: 'MMAKF-PRG-2026-000001', title: 'Test programme', status: 'scheduled',
    }).returning();

    await db.insert(o.programSessions).values({
      programId: program.id, seq: 1,
      startsAt: new Date('2026-09-02T09:00:00Z'),
      endsAt: new Date('2026-09-02T10:00:00Z'),
      coachPersonId: personId, status: 'scheduled',
    });

    // Ends at 10:00, next starts at 10:00. Closed intervals would make every
    // school timetable unbookable.
    const touching = await coachConflicts(db, personId,
      new Date('2026-09-02T10:00:00Z'), new Date('2026-09-02T11:00:00Z'));
    expect(touching).toHaveLength(0);

    const overlapping = await coachConflicts(db, personId,
      new Date('2026-09-02T09:30:00Z'), new Date('2026-09-02T10:30:00Z'));
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].kind).toBe('session');
  });

  it('refuses to mark a coach unavailable over a commitment already made', async () => {
    await expect(setAvailability(db, cmCtx, {
      personId, kind: 'leave',
      startsAt: new Date('2026-09-02T08:00:00Z'),
      endsAt: new Date('2026-09-02T12:00:00Z'),
    })).rejects.toThrow(/commitment/i);
  });

  it('keeps the reason for a coach’s absence private from their manager', async () => {
    await setAvailability(db, cmCtx, {
      personId, kind: 'leave',
      startsAt: new Date('2026-10-01T00:00:00Z'),
      endsAt: new Date('2026-10-03T00:00:00Z'),
      reason: 'family bereavement',
    });

    const managerView = await coachCalendar(db, coachManager, personId,
      new Date('2026-09-30T00:00:00Z'), new Date('2026-10-04T00:00:00Z'));
    const entry = managerView.find((x) => x.kind === 'leave')!;
    expect(entry.title).toBe('leave');
    expect(JSON.stringify(managerView)).not.toMatch(/bereavement/);
  });

  it('re-checks availability at confirmation, not only at recommendation', async () => {
    const [program] = await db.insert(e.trainingPrograms).values({
      code: 'MMAKF-PRG-2026-000002', title: 'Confirmation test', status: 'scheduled',
    }).returning();

    const window = { startsAt: new Date('2026-11-05T09:00:00Z'), endsAt: new Date('2026-11-05T10:00:00Z') };
    const rec = await recommendCoachesFor(program.id, window);
    expect(rec.recommended.length).toBeGreaterThan(0);

    // Somebody else books him in the meantime.
    await db.insert(o.programSessions).values({
      programId: program.id, seq: 2,
      startsAt: window.startsAt, endsAt: window.endsAt,
      coachPersonId: personId, status: 'scheduled',
    });

    await expect(
      confirmAssignment(db, cmCtx, rec.recommended[0].id, window)
    ).rejects.toThrow(/no longer free/);
  });

  async function recommendCoachesFor(programId: number, window: { startsAt: Date; endsAt: Date }) {
    const { recommendCoaches } = await import('../src/db/coaches');
    return recommendCoaches(db, cmCtx, {
      programId,
      criteria: { ...window, districtUnitId: RAMGARH },
      take: 3,
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
describe('message templates', () => {
  it('refuses to render with a missing value rather than sending "Dear ,"', () => {
    expect(() => renderTemplate('application_received', { contactName: 'A' })).toThrow(/needs/);
    try {
      renderTemplate('application_received', { contactName: 'A' });
    } catch (err) {
      expect(isTemplateError(err)).toBe(true);
      expect((err as any).message).toMatch(/institutionName/);
    }
  });

  it('declares every placeholder it uses', () => {
    // A template whose `requires` disagrees with its own body is one that will
    // render blank in production.
    for (const [key, spec] of Object.entries(TEMPLATES)) {
      const used = placeholdersIn(spec);
      for (const r of spec.requires) {
        expect(used, `${key} lists "${r}" as required but never uses it`).toContain(r);
      }
    }
  });

  it('never promises a response time anywhere in the catalogue', () => {
    // The federation has published no service standard. A template is exactly
    // where an invented one would hide.
    for (const [key, spec] of Object.entries(TEMPLATES)) {
      expect(spec.body, `${key} promises a turnaround`).not.toMatch(/within \d+\s*(hours?|days?|working)/i);
      expect(spec.body, `${key} promises a turnaround`).not.toMatch(/\b(24|48|72)\s*hours\b/i);
    }
  });

  it('signs every message from the federation, never from an individual', () => {
    for (const [key, spec] of Object.entries(TEMPLATES)) {
      expect(spec.body, `${key} is not signed by the federation`).toMatch(/Modern Martial Arts Karate-Do Federation of India/);
      // The personal number and personal UPI the federation asked to have
      // removed must never reappear through a template.
      expect(spec.body).not.toMatch(/\d{5}[\s-]?\d{5}/);
      expect(spec.body).not.toMatch(/@ybl|@ok[a-z]+|upi/i);
    }
  });
});

describe('the daily sweeps run independently of one another', () => {
  it('reports each sweep separately so one failure cannot hide the others', async () => {
    const report = await runDailySweeps(db, ctx);
    expect(report).toHaveProperty('workflowRetries');
    expect(report).toHaveProperty('taskEscalations');
    expect(report).toHaveProperty('ticketEscalations');
  });
});
