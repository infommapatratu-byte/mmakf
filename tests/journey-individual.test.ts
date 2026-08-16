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
// AND WHERE IT STOPS
// ─────────────────────────────────────────────────────────────────────────────
//
// The second half of this file asserts the boundary. The engine below is real
// and works; the public enquiry form on ten pages does not reach it. That gap
// is asserted here rather than implied, so it cannot be forgotten and cannot be
// closed silently.
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
import { installStandardAutomations } from '../src/db/automations';
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
// WHERE THE INDIVIDUAL CHAIN STOPS
// ════════════════════════════════════════════════════════════════════════════

describe('what the individual path does NOT do', () => {
  it('runs no workflow and creates no task — no automation is triggered by a lead', async () => {
    // There is no INDIVIDUAL_ENQUIRY trigger. captureLead() is a service call
    // and nothing dispatches from it, so an individual enquiry reaches an
    // administrator only if somebody opens the lead pipeline and looks.
    const runs = await db.select().from(o.workflowRuns);
    expect(runs).toEqual([]);

    const tasks = await db.select().from(o.tasks);
    expect(tasks).toEqual([]);
  });

  it('queues no acknowledgement to the person who enquired', async () => {
    // The school path acknowledges. This one does not — the individual is told
    // nothing by the system, and only a human reply reaches them.
    const msgs = await db.select().from(g.notifications);
    expect(msgs).toEqual([]);
  });

  it('publishes no domain event', async () => {
    const events = await db.select().from(g.domainEvents);
    expect(events).toEqual([]);
  });

  it('WRITES NO AUDIT ROW for the lead it created', async () => {
    // A real gap, asserted so it is a fact rather than an assumption.
    //
    // resolveInstitution() writes an audit row when it creates an institution;
    // captureLead() and submitTrainingRequest() write none. The lead's own
    // activity trail records that the enquiry happened, but audit_events — the
    // table the federation reads when it asks "who created this record and on
    // whose authority?" — has nothing about this person at all.
    const rows = await db.select().from(s.auditEvents);
    const aboutLeads = rows.filter((r: any) =>
      r.entityType === 'lead' || r.entityType === 'training_request');
    expect(aboutLeads).toEqual([]);

    // The activity trail is what exists instead, and it is not attributable:
    // the row records what happened, not who was acting.
    const acts = await db.select().from(e.leadActivities)
      .where(and(eq(e.leadActivities.leadId, lead.leadId), eq(e.leadActivities.kind, 'enquiry')));
    expect(acts.length).toBeGreaterThan(0);
    expect(acts[0].byUserId).toBeNull();
  });

  it('NO PUBLIC SURFACE REACHES captureLead() — the individual has no front door', () => {
    // The boundary the federation raised, pinned as an assertion rather than
    // described in a comment.
    //
    // The engine above works. Nothing on the website reaches it for a person:
    // the retired /api/enroll answers 410 and touches no database, the CTA on
    // the public pages carries no form at all, and /training/individual is
    // editorial. An individual who wants to train can read, and can write to an
    // address. The system records nothing.
    //
    // When an individual intake is wired — through captureLead() or a sibling
    // of submitApplication(), never a parallel implementation — this test fails
    // and has to be rewritten as the positive assertion. That is the point of
    // writing it down.
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

    // Tested by IMPORT rather than by a bare mention of the name: two files
    // discuss captureLead() in a comment explaining why they do not call it, and
    // a test that cannot tell a comment from a call is a test that fails for the
    // wrong reason and gets deleted.
    const callers = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /import\s*\{[^}]*\bcaptureLead\b[^}]*\}\s*from/.test(src);
    });
    expect(callers, 'a surface now captures individual leads — rewrite this test').toEqual([]);
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

    // 'individual' is a real audience in the engine — it is the intake that has
    // no route to it, not the data model.
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
