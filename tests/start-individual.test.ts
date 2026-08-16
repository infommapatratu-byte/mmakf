// The individual and parent intake, end to end.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// tests/journey-individual.test.ts asserts the shape of the engine — a lead, a
// request, and neither an institution nor a person. This file asserts the thing
// that was missing: that a PUBLIC FORM reaches it, and that reaching it produces
// the whole chain rather than a row nobody is told about.
//
// So the assertions run in both directions. The positive ones prove the lead,
// the request, the routing, the task, the queued acknowledgement, the domain
// event and the audit row all exist after one submission. The negative ones
// prove what the submission still refuses to create.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CHILD ASSERTIONS ARE THE POINT
// ─────────────────────────────────────────────────────────────────────────────
//
// The form deliberately does not ask for a child's name, date of birth, school
// or medical history. A comment saying so decays; a test saying so does not, and
// the second half of this file fails the day somebody adds one of those fields.
//
// Every name, town and address below is a TEST FIXTURE on the reserved .example
// domain. No MMAKF fee, service standard, centre or member is invented anywhere
// in this file — and the fee assertions prove the system says "a quotation is
// needed" precisely because the federation has published no rules.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import * as e from '../src/db/engagement.schema';
import * as g from '../src/db/governance.schema';

import {
  INDIVIDUAL_STEPS, relevantIndividualSteps, relevantFields, optionsOf,
  validateIndividual, summariseIndividual, describeIndividual, pruneIndividual,
  participantIsMinor, individualFeePreview, stepAfter,
  submitIndividualEnquiry, type IndividualAnswers,
} from '../src/db/applications';
import {
  installStandardAutomations, submitIndividualEnquiryWithAutomation,
  STANDARD_WORKFLOWS, STANDARD_TASK_TEMPLATES, ACTIONS,
} from '../src/db/automations';
import { TEMPLATES } from '../src/lib/email-templates';
import { EVENT_TYPES } from '../src/lib/domain-events';

let db: any, client: any;

/** An adult beginner in Ramgarh. Fixture data on the reserved .example domain. */
const ADULT: IndividualAnswers = {
  participantIs: 'me',
  ageBand: 'adult',
  experience: 'none',
  objectives: ['shotokan', 'self_defence'],
  mode: 'at_dojo',
  city: 'Ramgarh',
  stateName: 'Jharkhand',
  preferredArea: 'Near the bus stand',
  sessionsPerWeek: '2',
  preferredTimes: ['weekday_evening'],
  contactName: 'Rahul Mahto',
  contactEmail: 'rahul.mahto@example.com',
  contactPhone: '+91 98765 00099',
};

/** A parent arranging training for a nine-year-old. */
const PARENT: IndividualAnswers = {
  participantIs: 'child',
  ageBand: '7-9',
  guardianRelationship: 'parent',
  guardianConfirmed: true,
  emergencyContactName: 'Sunita Devi',
  emergencyContactPhone: '9876500088',
  experience: 'none',
  objectives: ['childrens', 'kihon'],
  mode: 'at_dojo',
  city: 'Ranchi',
  stateName: 'Jharkhand',
  sessionsPerWeek: '2',
  contactName: 'Sunita Devi',
  contactEmail: 'sunita.devi@example.com',
};

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...g } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([{ id: 1, email: 'admin@mmakf.in', status: 'active' }]);
  await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active',
  });
  await installStandardAutomations(db);
});

// ════════════════════════════════════════════════════════════════════════════
// THE QUESTIONS ASKED DEPEND ON THE ANSWERS GIVEN
// ════════════════════════════════════════════════════════════════════════════

describe('the form asks only what the answers so far make relevant', () => {
  it('never offers "Adults" as the age of a child', () => {
    const step = INDIVIDUAL_STEPS.find((x) => x.key === 'age_child')!;
    const field = step.fields.find((f) => f.name === 'ageBand')!;
    const values = optionsOf(field, { participantIs: 'child' }).map((opt) => opt.value);
    expect(values).not.toContain('adult');
    expect(values).toContain('7-9');
  });

  it('does not ask a seven-year-old’s parent for a grade — the case the federation named', () => {
    const keys = relevantIndividualSteps(PARENT).map((x) => x.key);
    expect(keys).not.toContain('grade');
    // Nor about competition, which was not among the objectives.
    expect(keys).not.toContain('competition');
    // But it does ask who is responsible.
    expect(keys).toContain('guardian');
  });

  it('asks for a grade the moment somebody says they have trained', () => {
    const keys = relevantIndividualSteps({ ...ADULT, experience: 'training_now' }).map((x) => x.key);
    expect(keys).toContain('grade');
  });

  it('asks about competition only when competition is one of the objectives', () => {
    expect(relevantIndividualSteps(ADULT).map((x) => x.key)).not.toContain('competition');
    expect(
      relevantIndividualSteps({ ...ADULT, objectives: ['competition'] }).map((x) => x.key)
    ).toContain('competition');
  });

  it('does not ask somebody training online which part of town suits them', () => {
    const step = INDIVIDUAL_STEPS.find((x) => x.key === 'location')!;
    const online = relevantFields(step, { ...ADULT, mode: 'online' }).map((f) => f.name);
    const atCentre = relevantFields(step, { ...ADULT, mode: 'at_dojo' }).map((f) => f.name);
    expect(online).not.toContain('preferredArea');
    expect(atCentre).toContain('preferredArea');
  });

  it('never asks an adult about children’s karate, and always offers it for a child', () => {
    const field = INDIVIDUAL_STEPS.find((x) => x.key === 'objectives')!
      .fields.find((f) => f.name === 'objectives')!;
    expect(optionsOf(field, ADULT).map((opt) => opt.value)).not.toContain('childrens');
    expect(optionsOf(field, PARENT).map((opt) => opt.value)).toContain('childrens');
  });

  it('guardian questions appear for a sixteen-year-old enquiring about themselves', () => {
    // Being asked about by a parent is not what makes somebody a minor — the age
    // band is. A seventeen-year-old filling the form in for themselves still
    // reaches the responsible-adult step.
    const self = { ...ADULT, ageBand: '16-18' };
    expect(participantIsMinor(self)).toBe(true);
    expect(relevantIndividualSteps(self).map((x) => x.key)).toContain('guardian');
  });

  it('steps are addressed by key, so a branch appearing does not renumber the rest', () => {
    // The Back button carries a key. If it carried a number, answering "a child"
    // would insert the guardian step and every later number would move.
    expect(stepAfter(ADULT, 'who', 1)).toBe('age_self');
    expect(stepAfter(PARENT, 'who', 1)).toBe('age_child');
    expect(stepAfter(PARENT, 'age_child', 1)).toBe('guardian');
    expect(stepAfter(ADULT, 'age_self', 1)).toBe('experience');
  });

  it('forgets an answer to a question it has stopped asking', () => {
    // Somebody chooses a centre, names a locality, then switches to online. The
    // locality is dropped rather than stored, so no administrator ever reads
    // "online, near the bus stand" — a contradiction the enquirer never wrote.
    const switched = pruneIndividual({ ...ADULT, mode: 'online' });
    expect(switched.preferredArea).toBeUndefined();
    expect(pruneIndividual(ADULT).preferredArea).toBe('Near the bus stand');
  });

  it('requires nothing of a question this enquirer is never shown', () => {
    // guardianConfirmed is required — but only of somebody who reaches it.
    expect(validateIndividual(ADULT)).toEqual([]);
    expect(validateIndividual(PARENT)).toEqual([]);

    const noConsent = { ...PARENT };
    delete (noConsent as any).guardianConfirmed;
    expect(validateIndividual(noConsent).map((p) => p.field)).toContain('guardianConfirmed');
  });

  it('refuses an enquiry nobody could ever answer, before it reaches the database', () => {
    const unreachable = { ...ADULT, contactEmail: '', contactPhone: '' };
    const problems = validateIndividual(unreachable);
    expect(problems.some((p) => /email address or a telephone number/.test(p.message))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE RUNNING SUMMARY
// ════════════════════════════════════════════════════════════════════════════

describe('the enquirer reads their own answers back', () => {
  it('says what has been understood, in words, and only what was answered', () => {
    const line = describeIndividual(ADULT);
    expect(line).toMatch(/^Adult, Ramgarh, Jharkhand, beginner/);
    expect(line).toMatch(/twice a week/);
    expect(line).toMatch(/at a centre near Near the bus stand|at a centre/);
    // Nothing appears that was not answered.
    expect(line).not.toMatch(/undefined|null|—/);
  });

  it('produces nothing at all from no answers, rather than a row of defaults', () => {
    expect(summariseIndividual({})).toEqual([]);
    expect(describeIndividual({})).toBe('Nothing answered yet.');
  });

  it('describes a child as a child, and names the responsible adult’s role', () => {
    const line = describeIndividual(PARENT);
    expect(line).toMatch(/^Child, 7 to 9/);
    expect(line).toMatch(/arranged by the parent/);
    // And never the child, who has no name in this system.
    expect(line).not.toMatch(/Sunita/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE FEE
// ════════════════════════════════════════════════════════════════════════════

describe('no figure the fee engine did not produce', () => {
  it('says a quotation is needed, because MMAKF has published no framework', async () => {
    const preview = await individualFeePreview(db, ADULT);
    expect(preview.kind).toBe('no_framework');
    expect(preview.message).toMatch(/quotation/i);
    // No number of any kind reaches the surface.
    expect(JSON.stringify(preview)).not.toMatch(/\d+[\d,]*\.\d{2}|₹/);
    expect((preview as any).totalMinor).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ONE SUBMISSION, THE WHOLE CHAIN
// ════════════════════════════════════════════════════════════════════════════

describe('an adult’s enquiry becomes every record it should, and none it should not', () => {
  let result: any;

  beforeAll(async () => {
    result = await submitIndividualEnquiryWithAutomation(db, {
      answers: ADULT,
      formNonce: 'fixture-adult-0001',
      leadSource: 'youtube',
      landingPath: '/start/individual',
    });
  });

  it('returns a request reference allocated from the federation sequence', () => {
    expect(result.ref).toMatch(/^MMAKF-REQ-\d{4}-\d{6}$/);
    expect(result.alreadyRecorded).toBe(false);
  });

  it('creates the lead, with the channel that introduced them', async () => {
    const [lead] = await db.select().from(e.leads).where(eq(e.leads.id, result.leadId));
    expect(lead.audience).toBe('individual');
    expect(lead.contactEmail).toBe('rahul.mahto@example.com');
    // Normalised to the last ten digits, so the same person typing it another
    // way next month lands on this row instead of a second one.
    expect(lead.contactPhone).toBe('9876500099');
    expect(lead.firstSource).toBe('youtube');
    expect(lead.city).toBe('Ramgarh');
  });

  it('routes the enquiry to the state unit it named, rather than leaving it national', async () => {
    // leadPipeline() shows an unlocated lead nationally only, which means a
    // Jharkhand administrator would never see this enquiry.
    const [lead] = await db.select().from(e.leads).where(eq(e.leads.id, result.leadId));
    expect(lead.stateUnitId).not.toBeNull();
    expect(result.stateUnitId).toBe(lead.stateUnitId);
  });

  it('creates the training request, joined to the lead and to nothing else', async () => {
    const [req] = await db.select().from(e.trainingRequests)
      .where(eq(e.trainingRequests.id, result.requestId));
    expect(req.audience).toBe('individual');
    expect(req.leadId).toBe(result.leadId);
    expect(req.institutionId).toBeNull();
    expect(req.personId).toBeNull();
    expect(req.mode).toBe('at_dojo');
    expect((req.parameters as any).participants).toBe(1);
    expect((req.parameters as any).objectives).toEqual(['shotokan', 'self_defence']);
    expect((req.parameters as any).involvesMinor).toBe(false);
    expect((req.parameters as any).guardian).toBeNull();
  });

  it('CREATES NO INSTITUTION and NO PERSON — one person is not an organisation, and an enquiry is not a member', async () => {
    expect(await db.select().from(e.institutions)).toEqual([]);
    expect(await db.select().from(s.persons)).toEqual([]);
  });

  it('runs the workflow, so the enquiry does not wait for somebody to think of looking', async () => {
    const runs = await db.select().from(o.workflowRuns);
    expect(runs.length).toBeGreaterThan(0);
    expect(result.automation.length).toBeGreaterThan(0);
  });

  it('creates a task for a human, in the training office queue', async () => {
    const tasks = await db.select().from(o.tasks);
    const mine = tasks.find((t: any) => t.subjectId === result.requestId && t.subjectKind === 'training_request');
    expect(mine, 'no task was created for the enquiry').toBeTruthy();
    expect(mine.templateCode).toBe('ANSWER_TRAINING_ENQUIRY');
    expect(mine.assignedRole).toBe('TRAINING_OPERATIONS');
    // NULL. The federation has published no turnaround, so nothing is ever late.
    expect(mine.dueAt).toBeNull();
    expect(mine.escalateAt).toBeNull();
  });

  it('queues an acknowledgement to the person who asked', async () => {
    const msgs = await db.select().from(g.notifications);
    const ack = msgs.find((m: any) => m.template === 'training_enquiry_received');
    expect(ack, 'nothing was queued for the enquirer').toBeTruthy();
    expect(ack.recipientEmail).toBe('rahul.mahto@example.com');
    // QUEUED, not sent: MMAKF has no mail provider configured and this system
    // does not claim to have delivered anything.
    expect(ack.status).toBe('queued');
    expect(ack.body).toMatch(/MMAKF-REQ-/);
    expect(ack.body).toMatch(/Ramgarh/);
    // No promised turnaround anywhere in it.
    expect(ack.body).not.toMatch(/within \d+\s*(hours?|days?|working)/i);
  });

  it('publishes the fact on the federation’s own feed', async () => {
    const events = await db.select().from(g.domainEvents);
    const mine = events.find((x: any) => x.eventType === 'TRAINING_ENQUIRY_SUBMITTED');
    expect(mine, 'the enquiry never reached the event feed').toBeTruthy();
    expect(mine.entityType).toBe('training_request');
    expect(mine.classification).toBe(EVENT_TYPES.TRAINING_ENQUIRY_SUBMITTED.floor);
  });

  it('writes an audit row, so "who created this and on whose authority" has an answer', async () => {
    const rows = await db.select().from(s.auditEvents);
    // entityId is stored as TEXT — the audit table is written to by modules whose
    // keys are not all integers, so the comparison is made on the string.
    const mine = rows.find((r: any) => r.entityType === 'training_request' && String(r.entityId) === String(result.requestId));
    expect(mine, 'the enquiry created a record with no audit trail').toBeTruthy();
    expect(mine.action).toBe('create');
    // Attributed to the intake actor, which is the truth: nobody was signed in.
    expect(String(mine.actorLabel ?? mine.actor ?? '')).toMatch(/application-intake/);
  });

  it('writes the enquiry, the request and the routing onto the lead history', async () => {
    const acts = await db.select().from(e.leadActivities)
      .where(eq(e.leadActivities.leadId, result.leadId));
    const kinds = acts.map((a: any) => a.kind);
    expect(kinds).toContain('enquiry');
    expect(kinds).toContain('request');
    expect(kinds).toContain('status_change');
    expect(acts.some((a: any) => /training office queue/.test(a.summary))).toBe(true);
  });

  it('a resent form is the same enquiry, not a second one', async () => {
    const again = await submitIndividualEnquiryWithAutomation(db, {
      answers: ADULT,
      formNonce: 'fixture-adult-0001',
    });
    expect(again.alreadyRecorded).toBe(true);
    expect(again.ref).toBe(result.ref);
    // And nothing ran a second time: the enquirer is not acknowledged twice.
    expect(again.automation).toEqual([]);

    const requests = await db.select().from(e.trainingRequests);
    const sameNonce = requests.filter((r: any) => (r.parameters as any).formNonce === 'fixture-adult-0001');
    expect(sameNonce.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE CHILD
// ════════════════════════════════════════════════════════════════════════════

describe('a parent’s enquiry records the adult, and the minimum about the child', () => {
  let result: any;

  beforeAll(async () => {
    result = await submitIndividualEnquiryWithAutomation(db, {
      answers: PARENT,
      formNonce: 'fixture-parent-0001',
      landingPath: '/start/individual',
    });
  });

  it('records the guardian, their relationship and their affirmation', async () => {
    const [req] = await db.select().from(e.trainingRequests)
      .where(eq(e.trainingRequests.id, result.requestId));
    const guardian = (req.parameters as any).guardian;
    expect(guardian).toBeTruthy();
    expect(guardian.relationship).toBe('parent');
    expect(guardian.confirmedAt).toBeTruthy();
    expect(guardian.emergencyContactName).toBe('Sunita Devi');
    expect((req.parameters as any).involvesMinor).toBe(true);
    expect((req.parameters as any).ageBand).toBe('7-9');
  });

  it('addresses the LEAD to the adult, never to the child', async () => {
    const [lead] = await db.select().from(e.leads).where(eq(e.leads.id, result.leadId));
    expect(lead.contactName).toBe('Sunita Devi');
    expect(lead.contactEmail).toBe('sunita.devi@example.com');
  });

  it('HOLDS NO NAME, DATE OF BIRTH, SCHOOL OR MEDICAL DETAIL FOR THE CHILD', () => {
    // The decision, as a test. An age band answers every question the federation
    // has at enquiry stage; a date of birth answers none of them better while
    // being the single most useful field to anybody who should not have it.
    const asked = INDIVIDUAL_STEPS.flatMap((step) => step.fields.map((f) => `${f.name} ${f.label}`));
    const forbidden = /child.?(name|s name)|date of birth|dob|birthday|school name|medical|allerg|medication|photograph|gender/i;
    const offenders = asked.filter((f) => forbidden.test(f));
    expect(offenders, 'the form now asks something about a child it does not need').toEqual([]);
  });

  it('puts nothing about the child on the event feed', async () => {
    const events = await db.select().from(g.domainEvents);
    const mine = events.filter((x: any) => x.eventType === 'TRAINING_ENQUIRY_SUBMITTED');
    for (const ev of mine) {
      const payload = JSON.stringify(ev.payload ?? {});
      expect(payload).not.toMatch(/7-9|Sunita|Ranchi/);
    }
  });

  it('still creates no institution and no person', async () => {
    expect(await db.select().from(e.institutions)).toEqual([]);
    expect(await db.select().from(s.persons)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ONE ENGINE, AND THE PUBLIC FORM THAT REACHES IT
// ════════════════════════════════════════════════════════════════════════════

describe('the intake is the engine, not a copy of it', () => {
  it('the page and the endpoint write nothing themselves', () => {
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    const api = readFileSync('src/pages/api/start/individual.ts', 'utf8');
    for (const [name, src] of [['page', page], ['endpoint', api]] as const) {
      expect(/\.insert\(/.test(src), `${name} inserts a row directly`).toBe(false);
      expect(/\.update\(/.test(src), `${name} updates a row directly`).toBe(false);
    }
  });

  it('the form is server-rendered and works with JavaScript switched off', () => {
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    expect(page).toMatch(/<form method="POST"/);
    // No client script at all: nothing to fail, nothing to hydrate.
    expect(/<script/.test(page), 'the intake now depends on a client script').toBe(false);
    expect(page).toMatch(/export const prerender = false/);
  });

  it('the question set has ONE definition, and it is not in the template', () => {
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    expect(page).toMatch(/INDIVIDUAL_STEPS/);
    // The relevance rules live beside the questions. A rule in the template is a
    // rule the validator does not know about.
    expect(/when:\s*\(a\)/.test(page), 'a relevance rule has leaked into the template').toBe(false);
  });

  it('the workflow, the task template and the message template all exist and agree', () => {
    const wf = STANDARD_WORKFLOWS.find((w) => w.code === 'INDIVIDUAL_ENQUIRY_INTAKE')!;
    expect(wf.trigger).toBe('TRAINING_ENQUIRY_SUBMITTED');

    // Every action a step names is one the registry implements. A typo here is
    // a workflow that fails on its first real submission.
    for (const step of wf.spec.steps) {
      expect(Object.keys(ACTIONS), `unknown action ${step.action}`).toContain(step.action);
    }
    // Every template a step sends is one that exists.
    for (const step of wf.spec.steps) {
      if (step.action === 'send_message') {
        expect(TEMPLATES[(step.params as any).template as string]).toBeTruthy();
      }
      if (step.action === 'create_task') {
        const code = (step.params as any).templateCode as string;
        expect(STANDARD_TASK_TEMPLATES.some((t) => t.code === code)).toBe(true);
      }
      if (step.action === 'record_event') {
        expect(Object.keys(EVENT_TYPES)).toContain((step.params as any).eventType as string);
      }
    }
  });

  it('shows what has been understood on EVERY question, not only at the end', () => {
    // The property that makes this a configuration rather than a form. A summary
    // that appears only on the review tells somebody at the end that ten answers
    // ago it misunderstood them, which is exactly too late to be useful.
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    expect(page).toMatch(/!isReview && summary\.length/);
    expect(page).toMatch(/summariseIndividual/);
  });

  it('promises no turnaround anywhere on the surface', () => {
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    expect(page).not.toMatch(/within \d+\s*(hours?|days?|working)/i);
    expect(page).not.toMatch(/\b(24|48|72)\s*hours\b/i);
    // And it says outright that no response time has been published.
    expect(page).toMatch(/not published a (standard )?response time/i);
  });

  it('quotes no fee of its own', () => {
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    // No rupee figure is written into the template. Every amount it can render
    // comes out of formatINR() applied to something computeFee() returned.
    expect(/₹\s*[\d]/.test(page), 'a rupee figure is hardcoded in the intake').toBe(false);
    expect(page).toMatch(/formatINR/);
  });
});

describe('a person now has a front door', () => {
  it('the enquiry engine is reachable from a public route', async () => {
    // The gap tests/journey-individual.test.ts pinned. The surface does not call
    // captureLead() itself — that would be a second intake — it calls the
    // sibling of submitApplication() that does.
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');
    expect(page).toMatch(/submitIndividualRequest/);

    const api = readFileSync('src/pages/api/start/individual.ts', 'utf8');
    expect(api).toMatch(/submitIndividualEnquiryWithAutomation/);

    // And the enquiry it produces is a real row, not a shape.
    const leads = await db.select().from(e.leads);
    expect(leads.length).toBeGreaterThan(0);
  });
});
