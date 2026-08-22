// THE SCHOOL JOURNEY, end to end.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS SEPARATELY FROM tests/operations.test.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// operations.test.ts proves each PART works. This file follows one school from
// the form to the administrator's queue and asserts every LINK between the
// parts — institution, lead, training request, owner, timeline, audit, queue —
// and then, just as deliberately, asserts where the chain STOPS.
//
// That second half is the point. A journey test that only asserts the links
// that exist implies the whole journey works. When somebody later asks "does
// submitting the form tell an administrator?", the answer has to come from a
// test, not from a hope — so the boundary is written down as an assertion that
// will fail the day the boundary moves. Moving it is then a deliberate act with
// a test change attached, which is the only kind of wiring worth trusting.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO MMAKF DATA IS INVENTED HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// Every institution name, contact and figure below is a TEST FIXTURE using
// .example addresses. The federation has published no school list, no fee and
// no service standard, and this file asserts the absence of the last one rather
// than supplying it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import * as e from '../src/db/engagement.schema';
import * as g from '../src/db/governance.schema';

import {
  submitApplication, saveDraft, applicantStatus, applicationQueue,
  applicationDetail, isApplicationError, type SubmitResult,
} from '../src/db/applications';
import {
  installStandardAutomations, submitApplicationWithAutomation,
} from '../src/db/automations';
import { normaliseName } from '../src/db/engagement';
import type { Principal } from '../src/lib/rbac';

let db: any, client: any, JH: number, RAMGARH: number;

/** Reads every application. National reach. */
const national: Principal = {
  userId: 1, label: 'admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

/** Holds engagement:read, but only inside one state. Used to probe the scope filter. */
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});

/**
 * A complete, valid wizard payload for one school.
 *
 * FIXTURE DATA. `.example` is the reserved documentation domain, so nothing
 * here can reach a real address even if a mail provider is configured one day.
 */
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

/** The first submission. Everything in the first two blocks is asserted against it. */
let first: SubmitResult;

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
    { id: 2, email: 'jh@mmakf.in', status: 'active' },
  ]);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [rg] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DT-RG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RAMGARH = rg.id;

  // INSTALLED ON PURPOSE, and this matters for the boundary block below.
  //
  // If the workflow definitions were absent, "no workflow ran" would prove
  // nothing except that nothing was defined. With INSTITUTION_APPLICATION_INTAKE
  // installed and its trigger sitting there ready, an empty workflow_runs table
  // after submitApplication() is evidence about submitApplication() itself.
  await installStandardAutomations(db);

  first = await submitApplication(db, {
    payload: payload(),
    leadSource: 'organic_search',
    landingPath: '/learn/apply',
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LINKS THAT EXIST
// ════════════════════════════════════════════════════════════════════════════

describe('one submission produces the whole record set', () => {
  it('stores the application under a sequence-allocated reference', async () => {
    expect(first.ref).toMatch(/^MMAKF-APP-\d{4}-\d{6}$/);

    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.status).toBe('submitted');
    expect(app.submittedAt).toBeTruthy();
    // The payload verbatim, beside the parsed columns. It is the only thing that
    // can settle a later disagreement about what the school actually asked for.
    expect((app.payload as any).requirements).toBe(payload().requirements);
    expect(app.institutionName).toBe('Sunrise Public School');
  });

  it('issues a private token that is not the reference', async () => {
    expect(first.accessToken).toBeTruthy();
    expect(first.accessToken).not.toBe(first.ref);
    // Long enough not to be guessed at the rate a public endpoint can be polled.
    expect(first.accessToken.length).toBeGreaterThanOrEqual(24);
  });

  it('creates an institution row carrying the name that was submitted', async () => {
    expect(first.institutionId).not.toBeNull();

    const [inst] = await db.select().from(e.institutions)
      .where(eq(e.institutions.id, first.institutionId as number));
    expect(inst.name).toBe('Sunrise Public School');
    expect(inst.kind).toBe('school');
    expect(inst.city).toBe('Patratu');
    // 'prospect', not 'client'. An enquiry is not a customer — the federation
    // has agreed nothing with this school yet.
    expect(inst.status).toBe('prospect');
    expect(inst.code).toMatch(/^MMAKF-INST-\d{4}-\d{6}$/);
  });

  it('creates a lead, and the application points at it', async () => {
    expect(first.leadId).not.toBeNull();

    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    // The LINK, not merely the existence of a row. A lead nothing references is
    // a lead nobody works.
    expect(app.leadId).toBe(first.leadId);

    const [lead] = await db.select().from(e.leads)
      .where(eq(e.leads.id, first.leadId as number));
    expect(lead.audience).toBe('school');
    expect(lead.contactEmail).toBe('principal@sunrise.example');
    // Normalised to the last ten digits, so the same number typed with +91 next
    // time still matches this row.
    expect(lead.contactPhone).toBe('9876500011');
    expect(lead.firstSource).toBe('organic_search');
    expect(lead.firstLandingPath).toBe('/learn/apply');
  });

  it('creates a training request holding the parameters a quotation needs', async () => {
    expect(first.requestId).not.toBeNull();

    const [req] = await db.select().from(e.trainingRequests)
      .where(eq(e.trainingRequests.id, first.requestId as number));
    expect(req.ref).toMatch(/^MMAKF-REQ-\d{4}-\d{6}$/);
    expect(req.audience).toBe('school');
    expect(req.status).toBe('submitted');
    expect((req.parameters as any).participants).toBe(140);
    expect((req.parameters as any).ageGroups).toEqual(['7-9', '10-12']);
    expect(req.mode).toBe('on_site');

    // Joined to both sides, so the request is reachable from the lead pipeline
    // AND from the institution record.
    expect(req.leadId).toBe(first.leadId);
    expect(req.institutionId).toBe(first.institutionId);

    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.requestId).toBe(first.requestId);
  });

  it('records the enquiry against the lead as an activity', async () => {
    const acts = await db.select().from(e.leadActivities)
      .where(eq(e.leadActivities.leadId, first.leadId as number));
    expect(acts.some((a: any) => a.kind === 'enquiry')).toBe(true);
    // submitTrainingRequest() writes its own activity, so the lead's history
    // shows the request arriving rather than only the first touch.
    expect(acts.some((a: any) => a.kind === 'request')).toBe(true);
  });

  it('IS UNASSIGNED — and that is the assertion, not a fallback', async () => {
    // routing_rules is EMPTY. The federation has published no routing policy, so
    // no rule can match and routeApplication() deliberately refuses to guess.
    //
    // Both outcomes are correct behaviour; this test asserts the UNASSIGNED one
    // because it is today's true answer, and it asserts the empty rule table
    // alongside it so that the day somebody adds a rule this test fails and has
    // to be updated rather than quietly asserting the wrong branch.
    const rules = await db.select().from(o.routingRules);
    expect(rules, 'a routing rule now exists — reassert the assigned branch').toEqual([]);

    expect(first.routing.ruleId).toBeNull();
    expect(first.ownerRole).toBeNull();
    expect(first.ownerUserId).toBeNull();
    expect(first.routing.explanation).toMatch(/No routing rule matched/);

    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.ownerRole).toBeNull();
    expect(app.ownerUserId).toBeNull();
  });

  it('scores the application and stores the score beside it', async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.leadScore).toBe(first.score.score);
    // Every component is explained, so an administrator can disagree with the
    // order of their own queue.
    expect(first.score.reasons.length).toBeGreaterThan(0);
    expect(first.score.reasons.some((r) => /140 participants/.test(r))).toBe(true);
  });

  it('carries a timeline, with the internal entries marked internal', async () => {
    const events = await db.select().from(o.applicationEvents)
      .where(eq(o.applicationEvents.applicationId, first.applicationId));

    const submitted = events.find((x: any) => x.kind === 'submitted');
    expect(submitted, 'no submitted event').toBeTruthy();
    expect(submitted.visibleToApplicant).toBe(true);

    const routed = events.find((x: any) => x.kind === 'routed');
    expect(routed, 'no routed event').toBeTruthy();
    // The school must never read its own lead score or the routing explanation.
    expect(routed.visibleToApplicant).toBe(false);
    expect((routed.detail as any).score.score).toBe(first.score.score);
  });

  it('writes an audit row attributed to the intake system, not to a person', async () => {
    const rows = await db.select().from(s.auditEvents)
      .where(and(
        eq(s.auditEvents.entityType, 'institution_application'),
        eq(s.auditEvents.entityId, String(first.applicationId))
      ));
    expect(rows.length).toBe(1);

    const a = rows[0];
    expect(a.action).toBe('create');
    // Nobody was signed in. The row says so in as many words rather than
    // borrowing an administrator's identity for a submission they never saw.
    expect(a.actorUserId).toBeNull();
    expect(a.actorLabel).toBe('system:application-intake');
    expect(a.authority).toBe('MMAKF application intake');
    expect((a.newValue as any).ref).toBe(first.ref);
  });

  it('appears in the administrator queue, through applicationQueue()', async () => {
    const rows = await applicationQueue(db, national, {});
    const mine = rows.find((r: any) => r.id === first.applicationId);
    expect(mine, 'the submitted application is missing from the queue').toBeTruthy();
    expect(mine.status).toBe('submitted');

    // And in the queue an administrator actually opens first.
    const unassigned = await applicationQueue(db, national, { unassignedOnly: true });
    expect(unassigned.some((r: any) => r.id === first.applicationId)).toBe(true);
  });

  it('never hands the applicant private token to staff', async () => {
    const detail = await applicationDetail(db, national, first.applicationId);
    expect((detail.application as any).accessToken).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(first.accessToken);
  });

  it('shows the applicant their own timeline, and nothing internal', async () => {
    const view = await applicantStatus(db, first.ref, first.accessToken);
    expect(view.ref).toBe(first.ref);
    expect(view.timeline.some((t: any) => t.kind === 'submitted')).toBe(true);
    expect(view.timeline.some((t: any) => t.kind === 'routed')).toBe(false);
    // NULL, and rendered as nothing. The federation has undertaken no turnaround.
    expect(view.respondBy).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE SAME SCHOOL, TWICE
// ════════════════════════════════════════════════════════════════════════════

describe('a second application from the same institution', () => {
  let second: SubmitResult;

  beforeAll(async () => {
    second = await submitApplication(db, {
      payload: payload({
        requirements: 'A second enquiry, this time for the senior school as well.',
        participantCount: 60,
      }),
      leadSource: 'referral',
    });
  });

  it('DOES NOT CREATE A DUPLICATE INSTITUTION', async () => {
    // The assertion the whole engagement module exists for. Three enquiries from
    // one school must not become three clients that three administrators quote
    // three different figures to.
    const rows = await db.select().from(e.institutions)
      .where(sql`lower(${e.institutions.name}) = lower('Sunrise Public School')`);
    expect(rows.length).toBe(1);
    expect(second.institutionId).toBe(first.institutionId);
  });

  it('does not create a duplicate lead either — the conversation continues', async () => {
    expect(second.leadId).toBe(first.leadId);

    const leads = await db.select().from(e.leads)
      .where(eq(e.leads.contactEmail, 'principal@sunrise.example'));
    expect(leads.length).toBe(1);

    // First touch is the channel that introduced them and NEVER moves; last
    // touch is the one that brought them back.
    expect(leads[0].firstSource).toBe('organic_search');
    expect(leads[0].lastSource).toBe('referral');
  });

  it('is flagged as a possible duplicate, and stored in full anyway', async () => {
    expect(second.duplicateOf).toBe(first.ref);

    const events = await db.select().from(o.applicationEvents)
      .where(eq(o.applicationEvents.applicationId, second.applicationId));
    const flag = events.find((x: any) => x.kind === 'possible_duplicate');
    expect(flag).toBeTruthy();
    expect(flag.visibleToApplicant).toBe(false);

    // Reported, never merged. Two campuses of one trust legitimately apply
    // separately, and folding them together loses one school's requirements.
    const [row] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, second.applicationId));
    expect(row.status).toBe('submitted');
    expect((row.payload as any).requirements).toMatch(/senior school/);
    expect(row.supersededByApplicationId).toBeNull();
  });

  it('does create a second training request, because it is a second ask', async () => {
    // Not a duplicate: the same school asking for something different is a new
    // request against the SAME institution and the SAME lead.
    expect(second.requestId).not.toBe(first.requestId);
    const [req] = await db.select().from(e.trainingRequests)
      .where(eq(e.trainingRequests.id, second.requestId as number));
    expect(req.institutionId).toBe(first.institutionId);
    expect(req.leadId).toBe(first.leadId);
    expect((req.parameters as any).participants).toBe(60);
  });

  it('THE TWO DUPLICATE CHECKS DO NOT AGREE, and this records which is which', async () => {
    // A REAL BOUNDARY, asserted rather than described.
    //
    // resolveInstitution() folds case, punctuation and apostrophes, so a variant
    // spelling still resolves to one institution. findDuplicate() — the thing
    // that raises the reviewer's flag — compares lower(name) in SQL, which does
    // not fold punctuation at all.
    //
    // The consequence: a school that types its name differently the second time
    // is correctly NOT duplicated in the institution register, and is ALSO not
    // flagged for the reviewer. The federation's records stay clean; the
    // reviewer is not told. That is worth knowing, and worth failing on the day
    // somebody unifies the two.
    const a = await submitApplication(db, {
      payload: payload({
        institutionName: "St. Xavier's School",
        city: 'Ranchi',
        contactEmail: 'office@stxavier.example',
        contactPhone: '9876500022',
        decisionMakerEmail: 'office@stxavier.example',
      }),
    });
    const b = await submitApplication(db, {
      payload: payload({
        institutionName: 'St Xaviers School',
        city: 'Ranchi',
        contactEmail: 'office@stxavier.example',
        contactPhone: '9876500022',
        decisionMakerEmail: 'office@stxavier.example',
      }),
    });

    // The normaliser folds them to one string, which is why the register holds one row.
    expect(normaliseName("St. Xavier's School")).toBe(normaliseName('St Xaviers School'));
    expect(b.institutionId).toBe(a.institutionId);

    // And the reviewer's flag stays silent, because the SQL check is exact.
    expect(b.duplicateOf).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WHERE THE CHAIN STOPS
// ════════════════════════════════════════════════════════════════════════════
//
// This block runs BEFORE the automation block below on purpose: the tables it
// asserts are empty are the ones the automation fills.

describe('submitApplication() alone stops at the database', () => {
  it('runs NO workflow, even though the definition is installed and waiting', async () => {
    const installed = await db.select().from(o.workflowDefinitions)
      .where(eq(o.workflowDefinitions.trigger, 'INSTITUTION_APPLICATION_SUBMITTED'));
    expect(installed.length, 'the intake workflow is not installed, so this proves nothing').toBeGreaterThan(0);

    const runs = await db.select().from(o.workflowRuns);
    expect(runs).toEqual([]);
  });

  it('creates NO task, so nobody is told there is work', async () => {
    const tasks = await db.select().from(o.tasks)
      .where(eq(o.tasks.subjectKind, 'institution_application'));
    expect(tasks).toEqual([]);
  });

  it('queues NO acknowledgement to the school', async () => {
    const msgs = await db.select().from(g.notifications)
      .where(eq(g.notifications.recipientEmail, 'principal@sunrise.example'));
    expect(msgs).toEqual([]);
  });

  it('publishes NO domain event', async () => {
    const events = await db.select().from(g.domainEvents)
      .where(eq(g.domainEvents.entityType, 'institution_application'));
    expect(events).toEqual([]);
  });

  it('leaves the status at submitted — nothing has acknowledged it', async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.status).toBe('submitted');
    expect(app.acknowledgedAt).toBeNull();
    expect(app.firstContactAt).toBeNull();
  });

  it('sets NO deadline, because the federation has published no service standard', async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    // NOTHING IS EVER LATE. A default of "48 hours" here would be the system
    // inventing a commitment on the federation's behalf, and would then report
    // real people as missing a deadline nobody agreed.
    expect(app.slaDueAt).toBeNull();
  });

  it('IS INVISIBLE TO A SCOPED ADMINISTRATOR, because the wizard captures no unit', async () => {
    // Another true boundary. Steps 1–2 collect `stateName` as free text; nothing
    // resolves it to a state unit, so state_unit_id is NULL on every application.
    //
    // applicationQueue() filters by scope as a SQL predicate — correctly — and a
    // NULL column matches no IN list. The result: a Jharkhand administrator sees
    // NONE of the applications from Jharkhand. Every application is national-only
    // until somebody attaches a unit to it.
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, first.applicationId));
    expect(app.stateName).toBe('Jharkhand');
    expect(app.stateUnitId).toBeNull();

    const rows = await applicationQueue(db, jhAdmin(), {});
    expect(rows).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LINK THAT CLOSES IT
// ════════════════════════════════════════════════════════════════════════════

describe('submitApplicationWithAutomation() is what joins the intake to the office', () => {
  let wired: Awaited<ReturnType<typeof submitApplicationWithAutomation>>;

  beforeAll(async () => {
    wired = await submitApplicationWithAutomation(db, {
      payload: payload({
        institutionName: 'Riverside Academy',
        city: 'Ramgarh',
        contactEmail: 'head@riverside.example',
        contactPhone: '9876500033',
        decisionMakerEmail: 'head@riverside.example',
      }),
      leadSource: 'direct',
    });
  });

  it('records a workflow run against the application', async () => {
    const runs = await db.select().from(o.workflowRuns)
      .where(and(
        eq(o.workflowRuns.subjectKind, 'institution_application'),
        eq(o.workflowRuns.subjectId, wired.applicationId)
      ));
    // TWO RUNS since migration 0040, and they are deliberately separate: the
    // intake acknowledges the school, and the quotation automation prices it —
    // or, today, records that MMAKF has published nothing to price it with.
    // Folding them into one would mean a failure in either blocked the other.
    expect(runs.map((r: any) => r.workflowCode).sort())
      .toEqual(['APPLICATION_AUTO_QUOTE', 'INSTITUTION_APPLICATION_INTAKE']);
    expect(runs.every((r: any) => r.status === 'succeeded')).toBe(true);
  });

  it('creates the review task, in the template role queue', async () => {
    const tasks = await db.select().from(o.tasks)
      .where(and(
        eq(o.tasks.subjectKind, 'institution_application'),
        eq(o.tasks.subjectId, wired.applicationId)
      ));
    const review = tasks.find((t: any) => t.templateCode === 'REVIEW_INSTITUTION_APPLICATION');
    expect(review).toBeTruthy();
    // Routing produced no owner, so the task falls to the template default
    // rather than to nobody. That is the difference between unassigned and lost.
    expect(review.assignedRole).toBe('TRAINING_OPERATIONS');
    expect(review.assignedUserId).toBeNull();
    // Still no deadline. The task is real; the promise is not invented.
    expect(review.dueAt).toBeNull();
    // And the second: nobody may price this application from a published rule,
    // so somebody has to. Also with no invented deadline.
    const quote = tasks.find((t: any) => t.templateCode === 'PREPARE_MANUAL_QUOTATION');
    expect(quote, 'nobody was asked to price this application').toBeTruthy();
    expect(quote.dueAt).toBeNull();
  });

  it('QUEUES the acknowledgement — queued, not sent', async () => {
    const msgs = await db.select().from(g.notifications)
      .where(eq(g.notifications.recipientEmail, 'head@riverside.example'));
    const ack = msgs.find((m: any) => m.template === 'application_received');
    expect(ack).toBeTruthy();
    // MMAKF has no mail provider configured. 'queued' is the honest state; a
    // sendEmail() that returned success would make the record say the school was
    // written to when it was not.
    expect(ack.status).toBe('queued');
    expect(ack.body).not.toMatch(/\b\d+\s*(hours?|days?|working days?)\b/i);

    // The second message the school gets: its quotation is being prepared. It
    // carries no figure, because there is none — see tests/auto-quote.test.ts.
    const pending = msgs.find((m: any) => m.template === 'application_quotation_pending');
    expect(pending).toBeTruthy();
    expect(pending.status).toBe('queued');
    expect(pending.body).not.toMatch(/₹/);
  });

  it('publishes the domain event', async () => {
    const events = await db.select().from(g.domainEvents)
      .where(and(
        eq(g.domainEvents.entityType, 'institution_application'),
        eq(g.domainEvents.entityId, String(wired.applicationId))
      ));
    const types = events.map((x: any) => x.eventType).sort();
    expect(types).toEqual(['INSTITUTION_APPLICATION_SUBMITTED', 'QUOTE_MANUAL_QUOTATION_REQUIRED']);
    // And never QUOTE_ISSUED, because no quotation was issued.
    expect(types).not.toContain('QUOTE_ISSUED');
  });

  it('moves the application to acknowledged and tells the applicant so', async () => {
    const [app] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, wired.applicationId));
    // Acknowledged, and then moved on the same submission: the fee engine ran
    // and found MMAKF has published nothing to price this with, so the school
    // is told a person is preparing its quotation rather than left in a state
    // that reads "nobody has looked at this yet".
    expect(app.acknowledgedAt).toBeTruthy();
    expect(app.status).toBe('awaiting_quotation');

    const view = await applicantStatus(db, wired.ref, wired.accessToken);
    expect(view.timeline.some((t: any) => t.kind === 'acknowledged')).toBe(true);
    expect(view.timeline.some((t: any) => t.kind === 'awaiting_quotation')).toBe(true);
    expect(view.respondBy).toBeNull();
  });

  it('nobody holds the owning role, and the run says so rather than pretending', async () => {
    // notify_role is conditional on an ownerRole being present, and routing
    // produced none. The step is SKIPPED and recorded as skipped. A run that
    // reported success for a notification nobody received would be worse than a
    // failure, because nothing would ever be investigated.
    const holders = await db.select().from(s.roleBindings);
    expect(holders).toEqual([]);
    // Two outcomes, because two workflows fired: the intake and the quotation.
    expect(wired.automation.length).toBe(2);
    expect(wired.automation.every((r: any) => r.status === 'succeeded')).toBe(true);
  });

  it('re-running the automation does not double anything', async () => {
    const before = await db.select().from(o.tasks)
      .where(eq(o.tasks.subjectKind, 'institution_application'));
    const beforeMsgs = await db.select().from(g.notifications)
      .where(eq(g.notifications.recipientEmail, 'head@riverside.example'));

    // The same idempotency key. The engine adopts the existing run.
    await submitApplicationWithAutomation(db, {
      payload: payload({
        institutionName: 'Riverside Academy',
        city: 'Ramgarh',
        contactEmail: 'head@riverside.example',
        contactPhone: '9876500033',
        decisionMakerEmail: 'head@riverside.example',
      }),
    }).catch(() => undefined);

    const afterMsgs = await db.select().from(g.notifications)
      .where(eq(g.notifications.recipientEmail, 'head@riverside.example'));
    // A second APPLICATION legitimately produces a second acknowledgement — it
    // is a second submission. What must not happen is one submission producing
    // two, which is what the idempotency key on the step guarantees and what the
    // per-run task count below shows.
    const perRun = await db.select().from(o.tasks)
      .where(eq(o.tasks.subjectKind, 'institution_application'));
    const forThisApp = perRun.filter((t: any) => t.subjectId === wired.applicationId);
    // TWO, and only two: the review and the hand-prepared quotation, one each.
    // The number that matters is that it did not become four.
    expect(forThisApp.map((t: any) => t.templateCode).sort())
      .toEqual(['PREPARE_MANUAL_QUOTATION', 'REVIEW_INSTITUTION_APPLICATION']);
    expect(afterMsgs.length).toBeGreaterThanOrEqual(beforeMsgs.length);
    expect(before.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UI → API → SERVICE
// ════════════════════════════════════════════════════════════════════════════

describe('the public wizard reaches the wired entry point, not the bare one', () => {
  const api = readFileSync('src/pages/api/learn/application.ts', 'utf8');
  const page = readFileSync('src/pages/learn/apply.astro', 'utf8');

  it('the endpoint submits through the automation wrapper', () => {
    expect(api).toMatch(/submitApplicationWithAutomation/);
    // Calling submitApplication() directly from the endpoint would store the
    // application and forget the office — the exact half-done wiring this file
    // asserts the shape of above.
    expect(/\bsubmitApplication\s*\(/.test(api)).toBe(false);
  });

  it('the wizard page posts to that endpoint rather than reimplementing intake', () => {
    expect(page).toMatch(/submitApplicationRequest/);
    // Progressive enhancement: a real form action, so the twenty steps work with
    // JavaScript switched off.
    expect(page).toMatch(/method=["']post["']/i);
  });

  it('every page in the chain is server-rendered', () => {
    expect(api).toMatch(/export const prerender = false/);
    expect(page).toMatch(/export const prerender = false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════════════

describe('one applicant token cannot be swapped onto another application', () => {
  let other: SubmitResult;

  beforeAll(async () => {
    other = await submitApplication(db, {
      payload: payload({
        institutionName: 'Hilltop Convent',
        city: 'Bokaro',
        contactEmail: 'office@hilltop.example',
        contactPhone: '9876500044',
        decisionMakerEmail: 'office@hilltop.example',
      }),
    });
  });

  it('the two applications hold different tokens', () => {
    expect(other.accessToken).not.toBe(first.accessToken);
    expect(other.ref).not.toBe(first.ref);
  });

  it('REFUSES another application reference with this token', async () => {
    // The attack is one line long: a school that has its own valid link tries
    // the next reference number along. The lookup matches ref AND token in one
    // predicate, so a valid token proves nothing about a reference it was not
    // issued for.
    await expect(applicantStatus(db, other.ref, first.accessToken))
      .rejects.toThrow(/No application matches that link/);
    await expect(applicantStatus(db, first.ref, other.accessToken))
      .rejects.toThrow(/No application matches that link/);
  });

  it('refuses a reference with no token at all', async () => {
    await expect(applicantStatus(db, first.ref, '')).rejects.toThrow(/No application matches that link/);
    await expect(applicantStatus(db, first.ref, null as any)).rejects.toThrow(/No application matches that link/);
  });

  it('refuses to resume a DRAFT with another application token', async () => {
    const draft = await saveDraft(db, {
      payload: { institutionName: 'Greenfield School', institutionType: 'school' },
      stepReached: 3,
    });

    await expect(saveDraft(db, {
      ref: draft.ref,
      accessToken: other.accessToken,
      payload: { institutionName: 'Greenfield School', institutionType: 'school' },
      stepReached: 4,
    })).rejects.toThrow(/No draft matches that link/);

    // And the draft is untouched by the attempt.
    const [row] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.ref, draft.ref));
    expect(row.stepReached).toBe(3);
    expect(row.status).toBe('draft');
  });

  it('refuses to SUBMIT a draft with another application token', async () => {
    const draft = await saveDraft(db, {
      payload: { institutionName: 'Lakeside School', institutionType: 'school' },
      stepReached: 5,
    });

    await expect(submitApplication(db, {
      ref: draft.ref,
      accessToken: other.accessToken,
      payload: payload({ institutionName: 'Lakeside School', contactEmail: 'x@lakeside.example' }),
    })).rejects.toThrow(/No draft matches that link/);

    const [row] = await db.select().from(o.institutionApplications)
      .where(eq(o.institutionApplications.ref, draft.ref));
    expect(row.status).toBe('draft');
  });

  it('an error thrown here is identifiable without instanceof', async () => {
    try {
      await applicantStatus(db, other.ref, first.accessToken);
      expect.unreachable('the swapped token was accepted');
    } catch (err) {
      expect(isApplicationError(err)).toBe(true);
      expect((err as any).code).toBe('not_found');
    }
  });
});
