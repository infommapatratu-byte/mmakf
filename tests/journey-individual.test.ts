// THE INDIVIDUAL JOURNEY, end to end.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE GUARDS
// ─────────────────────────────────────────────────────────────────────────────
//
// A person who wants to train is not an institution, and is not yet a member.
//
// The tempting implementation gives every enquiry an institution row so that
// one pipeline query serves everybody. It fills the federation's institution
// register — the thing state administrators count and report on — with rows
// that are one person each. And the mirror mistake creates a `persons` row per
// enquiry, which fills the MEMBER register that /verify answers from with
// people who never trained a day.
//
// So the individual path goes through captureLead() and submitTrainingRequest()
// and creates NEITHER. Promotion to a canonical Person or Institution is a
// deliberate act somebody takes later, through identifyLead().
//
// ─────────────────────────────────────────────────────────────────────────────
// AND HOW IT IS REACHED
// ─────────────────────────────────────────────────────────────────────────────
//
// The second half of this file used to assert a boundary: the engine was real
// and nothing on the website reached it. /start/individual closed that gap, so
// the second half is now the positive assertion the old one asked for — the
// page, the handler, the intake, the workflow, the task, the acknowledgement,
// the event and the audit row, checked as a chain rather than as an import
// graph. The import graph is what let the old test pass while being wrong.
//
// Every name, address and figure is a TEST FIXTURE on the reserved .example
// domain. No MMAKF fee, standard or member is invented.

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
  captureLead, submitTrainingRequest, identifyLead, leadDetail, leadPipeline,
  normalisePhone, isEngagementError, AUDIENCES,
} from '../src/db/engagement';
import { installStandardAutomations, submitIndividualEnquiryWithAutomation } from '../src/db/automations';
import { systemIntakeContext, WIZARD_STEPS } from '../src/db/applications';
import type { Principal } from '../src/lib/rbac';

let db: any, client: any, JH: number;

const national: Principal = {
  userId: 1, label: 'admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: national };

/** The same system actor the public intake path uses. Nothing here is signed in. */
const intake = systemIntakeContext();

/** The individual's first enquiry. Asserted against throughout the first block. */
let lead: Awaited<ReturnType<typeof captureLead>>;
let request: any;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...g } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([{ id: 1, email: 'admin@mmakf.in', status: 'active' }]);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;

  // Installed so that "no workflow ran" below is a statement about the
  // individual path, not about an empty definitions table.
  await installStandardAutomations(db);

  lead = await captureLead(db, intake, {
    audience: 'individual',
    contactName: 'Rahul Mahto',
    contactEmail: 'rahul.mahto@example.com',
    contactPhone: '+91 98765 00099',
    city: 'Ramgarh',
    stateUnitId: JH,
    source: 'youtube',
    landingPath: '/programs',
  });

  request = await submitTrainingRequest(db, intake, {
    audience: 'individual',
    leadId: lead.leadId,
    mode: 'at_dojo',
    parameters: { participants: 1, experience: 'none' },
    notes: 'Would like to start Shotokan from the beginning.',
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LINKS THAT EXIST
// ════════════════════════════════════════════════════════════════════════════

describe('an individual enquiry becomes a lead and a request, and nothing else', () => {
  it('records the lead under a sequence-allocated reference', async () => {
    expect(lead.ref).toMatch(/^MMAKF-LEAD-\d{4}-\d{6}$/);
    expect(lead.matchedExisting).toBe(false);

    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, lead.leadId));
    expect(row.audience).toBe('individual');
    expect(row.contactName).toBe('Rahul Mahto');
    expect(row.contactEmail).toBe('rahul.mahto@example.com');
    // Normalised to the last ten digits at capture, so the same person typing
    // 09876500099 next month lands on this row instead of a second one.
    expect(row.contactPhone).toBe('9876500099');
    expect(row.firstSource).toBe('youtube');
    expect(row.firstLandingPath).toBe('/programs');
  });

  it('CREATES NO INSTITUTION — the assertion this journey exists for', async () => {
    // One person is not an organisation. An institution row here would be
    // counted in the federation's own institution register and reported to a
    // state unit as a client that does not exist.
    const institutions = await db.select().from(e.institutions);
    expect(institutions).toEqual([]);
  });

  it('CREATES NO PERSON either — an enquiry is not a member', async () => {
    // The persons table is the register /verify answers from. Filling it with
    // people who have not trained makes every verification answer less true.
    const persons = await db.select().from(s.persons);
    expect(persons).toEqual([]);

    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, lead.leadId));
    expect(row.personId).toBeNull();
    expect(row.institutionId).toBeNull();
  });

  it('creates a training request joined to the lead and to nothing else', async () => {
    const [req] = await db.select().from(e.trainingRequests)
      .where(eq(e.trainingRequests.id, request.id));
    expect(req.ref).toMatch(/^MMAKF-REQ-\d{4}-\d{6}$/);
    expect(req.audience).toBe('individual');
    expect(req.status).toBe('submitted');
    expect(req.leadId).toBe(lead.leadId);
    expect(req.institutionId).toBeNull();
    expect(req.personId).toBeNull();
    expect((req.parameters as any).participants).toBe(1);
  });

  it('moves the lead from new to qualifying when the request arrives', async () => {
    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, lead.leadId));
    expect(row.status).toBe('qualifying');
  });

  it('writes the enquiry and the request onto the lead history', async () => {
    const acts = await db.select().from(e.leadActivities)
      .where(eq(e.leadActivities.leadId, lead.leadId));
    const enquiry = acts.find((a: any) => a.kind === 'enquiry');
    expect(enquiry).toBeTruthy();
    expect(enquiry.summary).toMatch(/youtube/);
    expect(acts.some((a: any) => a.kind === 'request')).toBe(true);
  });

  it('shows the enquiry to an administrator through the pipeline', async () => {
    const pipeline = await leadPipeline(db, national, {});
    expect(pipeline.rows.some((r: any) => r.id === lead.leadId)).toBe(true);

    const detail = await leadDetail(db, national, lead.leadId);
    expect(detail.requests.some((r: any) => r.id === request.id)).toBe(true);
  });

  it('refuses an enquiry nobody could ever answer', async () => {
    // A lead with neither an address nor a number cannot be contacted, cannot be
    // matched to a later enquiry, and only makes the pipeline harder to read —
    // which is what stops the pipeline being worked at all.
    await expect(captureLead(db, intake, {
      audience: 'individual', contactName: 'Anonymous',
    })).rejects.toThrow(/email address or a telephone number/);

    try {
      await captureLead(db, intake, { audience: 'individual', contactName: 'Anonymous' });
    } catch (err) {
      expect(isEngagementError(err)).toBe(true);
      expect((err as any).code).toBe('no_contact');
    }
  });

  it('refuses a request it could never price rather than storing an unusable one', async () => {
    await expect(submitTrainingRequest(db, intake, {
      audience: 'individual', leadId: lead.leadId, parameters: {},
    })).rejects.toThrow(/cannot be priced without: participants/);

    await expect(submitTrainingRequest(db, intake, {
      audience: 'individual', leadId: lead.leadId, parameters: { participants: 0 },
    })).rejects.toThrow(/whole number greater than zero/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE SAME PERSON, AGAIN
// ════════════════════════════════════════════════════════════════════════════

describe('the same person coming back is the same conversation', () => {
  it('folds a second enquiry into the open lead, however the number is typed', async () => {
    expect(normalisePhone('0091-9876500099')).toBe('9876500099');

    const again = await captureLead(db, intake, {
      audience: 'individual',
      contactName: 'Rahul Mahto',
      contactPhone: '0091-9876500099',
      source: 'referral',
      landingPath: '/dojo-finder',
    });

    expect(again.matchedExisting).toBe(true);
    expect(again.leadId).toBe(lead.leadId);

    const rows = await db.select().from(e.leads)
      .where(eq(e.leads.contactPhone, '9876500099'));
    expect(rows.length).toBe(1);
  });

  it('keeps the channel that introduced them AND the one that brought them back', async () => {
    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, lead.leadId));
    // First touch never moves: it is the channel that did the work of finding
    // this person, and it is the one the federation is deciding whether to fund.
    expect(row.firstSource).toBe('youtube');
    expect(row.lastSource).toBe('referral');
  });

  it('still creates no institution and no person', async () => {
    expect(await db.select().from(e.institutions)).toEqual([]);
    expect(await db.select().from(s.persons)).toEqual([]);
  });

  it('promotion to a canonical record is a deliberate act, taken by somebody', async () => {
    // identifyLead() is the only door from "an enquiry" to "a record in the
    // federation's register", and it requires engagement:write. Nothing on the
    // automatic path can walk through it.
    const [person] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000001',
      fullName: 'Rahul Mahto',
      status: 'active',
    }).returning({ id: s.persons.id });

    await identifyLead(db, ctx, lead.leadId, { personId: person.id });

    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, lead.leadId));
    expect(row.personId).toBe(person.id);

    const acts = await db.select().from(e.leadActivities)
      .where(eq(e.leadActivities.leadId, lead.leadId));
    const change = acts.find((a: any) => a.kind === 'status_change');
    expect(change).toBeTruthy();
    // Attributed to the administrator who did it, not to the system.
    expect(change.byUserId).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE FRONT DOOR, AND WHAT IT SETS OFF
// ════════════════════════════════════════════════════════════════════════════
//
// This block used to assert the opposite of everything below it. It was written
// when the engine above worked and nothing on the website reached it, and it
// said so deliberately — "when an individual intake is wired, this test fails
// and has to be rewritten as the positive assertion."
//
// It did not fail, because it tested the wrong thing: it looked for a DIRECT
// import of captureLead() under src/pages, and the intake reaches it one hop
// further away, through submitIndividualEnquiry() in src/db/applications.ts.
// So the suite went on asserting that the individual had no front door for as
// long as the front door existed. These are the positive assertions it asked
// for, and they are made against the chain rather than against an import graph.

describe('the individual intake runs the whole chain', () => {
  // A SECOND enquiry, from a different person, submitted the way the page
  // submits it. The fixture above stays a bare captureLead() call, because the
  // first block is about what those two service functions do on their own.
  let wired: Awaited<ReturnType<typeof submitIndividualEnquiryWithAutomation>>;

  beforeAll(async () => {
    wired = await submitIndividualEnquiryWithAutomation(db, {
      answers: {
        participantIs: 'child',
        ageBand: '7-9',
        guardianRelationship: 'parent',
        guardianConfirmed: true,
        experience: 'none',
        objectives: ['shotokan', 'childrens'],
        mode: 'at_dojo',
        city: 'Ramgarh',
        stateName: 'Jharkhand',
        preferredArea: 'Near the station',
        sessionsPerWeek: '2',
        contactName: 'Sunita Devi',
        contactEmail: 'sunita.devi@example.com',
        contactPhone: '+91 98765 00123',
      },
      formNonce: 'fixture-nonce-0001',
      leadSource: 'direct',
      landingPath: '/start/individual',
    });
  });

  it('records the enquiry and returns the reference the page shows', () => {
    expect(wired.ref).toMatch(/^MMAKF-REQ-\d{4}-\d{6}$/);
    expect(wired.alreadyRecorded).toBe(false);
    expect(wired.involvesMinor).toBe(true);
    expect(wired.leadId).toBeTruthy();
  });

  it('STILL creates no institution and no person — the rule this file guards', async () => {
    // The whole point of wiring the front door was to reach captureLead(), not
    // to start manufacturing organisations. Re-asserted after the automation
    // because an automation is exactly where such a row would appear.
    expect(await db.select().from(e.institutions)).toEqual([]);

    // Asserted on THIS lead rather than on an empty persons table: a test
    // further up promotes the first enquirer through identifyLead(), which is
    // the deliberate act that is allowed to create a person. A bare
    // `persons === []` here would be asserting that the deliberate act had not
    // happened, which is a different claim and not this one.
    const [row] = await db.select().from(e.leads).where(eq(e.leads.id, wired.leadId!));
    expect(row.personId).toBeNull();
    expect(row.institutionId).toBeNull();
  });

  it('runs the workflow and puts the reply in somebody’s queue', async () => {
    const runs = await db.select().from(o.workflowRuns);
    expect(runs.length).toBeGreaterThan(0);

    const tasks = await db.select().from(o.tasks);
    const answering = tasks.filter((t: any) => t.subjectKind === 'training_request');
    expect(answering.length).toBeGreaterThan(0);

    // NULL, because MMAKF has published no turnaround. If a due date ever
    // appears here it was invented, and the federation would then report itself
    // as late against a standard it never set.
    expect(answering[0].dueAt).toBeNull();
  });

  it('queues the acknowledgement to the adult who enquired', async () => {
    const msgs = await db.select().from(g.notifications);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('publishes the domain event', async () => {
    const events = await db.select().from(g.domainEvents);
    expect(events.some((ev: any) => ev.eventType === 'TRAINING_ENQUIRY_SUBMITTED')).toBe(true);
  });

  it('carries nothing about the child in the event payload', async () => {
    // An event about a nine-year-old must not itself be a fact about a
    // nine-year-old. The feed carries the request identifier and no answers.
    const events = await db.select().from(g.domainEvents);
    const ev = events.find((x: any) => x.eventType === 'TRAINING_ENQUIRY_SUBMITTED')!;
    const payload = JSON.stringify(ev.payload ?? {});
    expect(payload).not.toMatch(/Sunita|7-9|sunita\.devi/);
  });

  it('WRITES THE AUDIT ROW — the gap this block used to assert', async () => {
    // captureLead() and submitTrainingRequest() still write none of their own.
    // submitIndividualEnquiry() writes it, which is why the intake had to be a
    // sibling in src/db/applications.ts rather than two service calls made from
    // a page.
    // `entityId` is TEXT on audit_events — the table records identifiers from
    // tables whose keys are not all integers — so the comparison is made as a
    // string. Comparing it as a number finds nothing and passes an emptiness
    // assertion, which is how a test like this quietly stops testing.
    const rows = await db.select().from(s.auditEvents);
    const aboutRequest = rows.filter((r: any) =>
      r.entityType === 'training_request' && r.entityId === String(wired.requestId));
    expect(aboutRequest.length).toBe(1);

    // The summary, not the answers. An audit row is read by more people than
    // the record it describes.
    const value = JSON.stringify(aboutRequest[0].newValue ?? {});
    expect(value).not.toMatch(/sunita\.devi|98765 00123/);
  });

  it('a resent form folds onto the same enquiry and dispatches nothing twice', async () => {
    const before = await db.select().from(g.notifications);

    const again = await submitIndividualEnquiryWithAutomation(db, {
      answers: {
        participantIs: 'child', ageBand: '7-9',
        guardianRelationship: 'parent', guardianConfirmed: true,
        experience: 'none', objectives: ['shotokan'], mode: 'at_dojo',
        city: 'Ramgarh', stateName: 'Jharkhand', preferredArea: 'Near the station',
        sessionsPerWeek: '2',
        contactName: 'Sunita Devi', contactEmail: 'sunita.devi@example.com',
      },
      formNonce: 'fixture-nonce-0001',
      leadSource: 'direct',
    });

    expect(again.alreadyRecorded).toBe(true);
    expect(again.ref).toBe(wired.ref);
    expect(again.automation).toEqual([]);

    // Nobody is acknowledged a second time for pressing Send twice.
    const after = await db.select().from(g.notifications);
    expect(after.length).toBe(before.length);
  });

  it('THE PAGE IS THE FRONT DOOR, and it is server-rendered', () => {
    // Asserted against the page rather than an import graph, because the import
    // graph is what let the previous version of this test be wrong.
    const page = readFileSync('src/pages/start/individual.astro', 'utf8');

    // It reaches the one handler, which reaches the one intake.
    expect(page).toMatch(/submitIndividualRequest/);

    // Progressive enhancement: a real POST form, and no client state machine.
    expect(page).toMatch(/<form[^>]*method="POST"/);
    expect(/<script/.test(page), 'the intake has grown a client-side script').toBe(false);

    // And the handler it calls is the one that runs the automation.
    const handler = readFileSync('src/pages/api/start/individual.ts', 'utf8');
    expect(handler).toMatch(/submitIndividualEnquiryWithAutomation/);
  });

  it('no surface imports captureLead() directly — rule 74 still holds', () => {
    // The successor to the old assertion, narrowed to what it can actually
    // prove. A page reaching captureLead() DIRECTLY would be the second intake;
    // reaching it through src/db/applications.ts is the first one.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(astro|ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk('src/pages');
    walk('src/components');

    const callers = files.filter((f) =>
      /import\s*\{[^}]*\bcaptureLead\b[^}]*\}\s*from/.test(readFileSync(f, 'utf8')));
    expect(callers, 'a surface is capturing leads outside the intake').toEqual([]);
  });

  it('the retired enquiry endpoint stores nothing, rather than storing it somewhere useless', () => {
    // It used to push a four-field object onto a Redis list that no admin screen
    // read — an enquiry that looked accepted and reached nobody. It now answers
    // 410 and points at the intake that does exist.
    const api = readFileSync('src/pages/api/enroll.ts', 'utf8');
    expect(api).toMatch(/status:\s*410/);
    expect(api).toMatch(/\/learn\/request/);
    expect(/pushToList/.test(api), 'the retired endpoint is storing enquiries again').toBe(false);
    expect(/from ['"]@\/db\//.test(api), 'the retired endpoint now touches the database').toBe(false);

    // And the CTA no longer offers a form that could not work: it links to the
    // intake instead of posting to a handler that answered every submission 400.
    const cta = readFileSync('src/components/EnrollCTA.astro', 'utf8');
    expect(/<form/.test(cta)).toBe(false);
    expect(cta).toMatch(/href=["']\/learn\/request["']/);
  });

  it('AND THE INSTITUTIONAL WIZARD CANNOT SERVE ONE — it is not a workaround', () => {
    // Somebody will suggest that an individual simply uses /learn/apply. They
    // cannot: the twenty-step form requires an institution name, and its type
    // list has no individual on it. Asserted against the step definitions rather
    // than the markup, because the steps are the single definition the form, the
    // server and the progress counter all render from.
    const identity = WIZARD_STEPS.find((step) => step.key === 'identity')!;
    const name = identity.fields.find((f) => f.name === 'institutionName')!;
    expect(name.required).toBe(true);

    const type = identity.fields.find((f) => f.name === 'institutionType')!;
    expect(type.options!.some((opt) => opt.value === 'individual')).toBe(false);

    // 'individual' is a real audience in the engine, and it now has its own
    // route — /start/individual, asserted above. This test survives because the
    // wizard must never become the answer for a person: the day somebody points
    // an individual at /learn/apply, the federation gets an institution row per
    // enquirer, which is the thing this file exists to prevent.
    expect(AUDIENCES).toContain('individual');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE ONE ENGINE
// ════════════════════════════════════════════════════════════════════════════

describe('there is one intake, not two', () => {
  it('no module outside src/db builds a lead, an institution or a request by hand', () => {
    // Rule 74, as a test. A second intake path would produce the duplicate
    // organisation and duplicate person the engagement module exists to prevent,
    // and it would do it silently.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(astro|ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk('src/pages');
    walk('src/components');

    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // A direct insert into one of the three tables the engine owns.
      return /\.insert\(\s*(s\.|e\.)?(leads|institutions|trainingRequests)\s*\)/.test(src);
    });
    expect(offenders, 'a surface is writing engagement records directly').toEqual([]);
  });
});
