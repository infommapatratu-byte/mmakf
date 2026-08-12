// Leads, institutions and training requests.
//
// The federation's instruction was: "One person must remain one Person. One
// institution must remain one Organization. Do not create duplicate customers
// for every enquiry." Most of this file is that one rule, attacked from the
// angles that actually break it in production — a phone number typed four
// different ways, a school name that exists in a dozen cities, and the same
// person coming back six months later.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  captureLead, resolveInstitution, identifyLead, submitTrainingRequest,
  leadPipeline, leadDetail, sourceAttribution,
  normaliseEmail, normalisePhone, normaliseName,
  AUDIENCES, REQUIRED_PARAMETERS, isEngagementError, EngagementError,
} from '../src/db/engagement';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number;

const national: Principal = {
  userId: 1, label: 'admin', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: 3, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});
const athlete: Principal = {
  userId: 4, label: 'athlete', bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: national };

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'jh@mmakf.in', status: 'active' },
    { id: 3, email: 'br@mmakf.in', status: 'active' },
  ]);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
});

describe('normalisation, where the duplicates actually come from', () => {
  it('folds the four ways an Indian mobile is typed into one', () => {
    const forms = ['9876543210', '+91 98765 43210', '09876543210', '0091-9876543210'];
    const normalised = forms.map(normalisePhone);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('9876543210');
  });

  it('refuses something too short to be a number rather than storing a fragment', () => {
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });

  it('lower-cases an email and NOTHING else', () => {
    expect(normaliseEmail('  Head@School.IN ')).toBe('head@school.in');
    // Deliberately not folded: dot-stripping and plus-addressing are one
    // provider's rules, and applying them universally MERGES TWO PEOPLE — a
    // worse failure than missing a duplicate.
    expect(normaliseEmail('a.b@gmail.com')).toBe('a.b@gmail.com');
    expect(normaliseEmail('a+school@gmail.com')).toBe('a+school@gmail.com');
    expect(normaliseEmail('not-an-email')).toBeNull();
  });

  it('folds punctuation and spacing in an institution name', () => {
    expect(normaliseName("St. Xavier's School")).toBe(normaliseName('St Xaviers  School'));
  });
});

describe('AN ENQUIRY DOES NOT CREATE A CUSTOMER', () => {
  it('folds a second enquiry from the same email into the open lead', async () => {
    const a = await captureLead(db, ctx, {
      audience: 'school', contactName: 'Principal', contactEmail: 'head@school.in',
      source: 'organic_search', landingPath: '/training/schools',
    });
    const b = await captureLead(db, ctx, {
      audience: 'school', contactEmail: 'HEAD@SCHOOL.IN', source: 'youtube',
    });

    expect(b.matchedExisting).toBe(true);
    expect(b.matchedOn).toBe('email');
    expect(b.leadId).toBe(a.leadId);

    const rows = await db.select().from(s.leads).where(eq(s.leads.contactEmail, 'head@school.in'));
    expect(rows.length).toBe(1);
  });

  it('folds on a phone number typed differently', async () => {
    const a = await captureLead(db, ctx, { audience: 'corporate', contactPhone: '+91 98111 22333' });
    const b = await captureLead(db, ctx, { audience: 'corporate', contactPhone: '09811122333' });
    expect(b.leadId).toBe(a.leadId);
    expect(b.matchedOn).toBe('phone');
  });

  it('KEEPS FIRST TOUCH and moves last touch', async () => {
    // The campaign that introduced somebody and the one that brought them back
    // are different facts, and the first is the one that did the work.
    const a = await captureLead(db, ctx, {
      audience: 'school', contactEmail: 'attribution@school.in', source: 'qr',
    });
    await captureLead(db, ctx, {
      audience: 'school', contactEmail: 'attribution@school.in', source: 'paid_search',
    });
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, a.leadId));
    expect(lead.firstSource).toBe('qr');
    expect(lead.lastSource).toBe('paid_search');
    expect(lead.firstLandingPath).toBeNull();
  });

  it('does NOT overwrite a known contact detail with nothing', async () => {
    const a = await captureLead(db, ctx, {
      audience: 'school', contactName: 'Named Person', contactEmail: 'keep@school.in',
      city: 'Ranchi',
    });
    await captureLead(db, ctx, { audience: 'school', contactEmail: 'keep@school.in' });
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, a.leadId));
    expect(lead.contactName).toBe('Named Person');
    expect(lead.city).toBe('Ranchi');
  });

  it('starts a NEW lead when the previous one was closed', async () => {
    // A school that bought a programme last year and enquires again is a new
    // opportunity, not a reopened one — folding it in would corrupt both the
    // pipeline and the attribution.
    const a = await captureLead(db, ctx, { audience: 'school', contactEmail: 'again@school.in' });
    await db.update(s.leads).set({ status: 'won' }).where(eq(s.leads.id, a.leadId));

    const b = await captureLead(db, ctx, { audience: 'school', contactEmail: 'again@school.in' });
    expect(b.matchedExisting).toBe(false);
    expect(b.leadId).not.toBe(a.leadId);
  });

  it('records every touch as an activity, so the history survives the folding', async () => {
    const a = await captureLead(db, ctx, { audience: 'ngo', contactEmail: 'history@ngo.in', source: 'referral' });
    await captureLead(db, ctx, { audience: 'ngo', contactEmail: 'history@ngo.in', source: 'social' });
    const acts = await db.select().from(s.leadActivities).where(eq(s.leadActivities.leadId, a.leadId));
    expect(acts.length).toBe(2);
  });

  it('REFUSES an enquiry with no way to answer it', async () => {
    await expect(captureLead(db, ctx, { audience: 'school', contactName: 'Anonymous' }))
      .rejects.toThrow(/needs an email address or a telephone number/);
  });

  it('refuses an unknown audience', async () => {
    await expect(captureLead(db, ctx, { audience: 'aliens' as any, contactEmail: 'x@y.in' }))
      .rejects.toThrow(/Unknown audience/);
  });

  it('an unrecognised source is recorded as unknown, not as the caller typed it', async () => {
    const a = await captureLead(db, ctx, {
      audience: 'club', contactEmail: 'src@club.in', source: 'facebook-ad' as any,
    });
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, a.leadId));
    expect(lead.firstSource).toBe('unknown');
  });
});

describe('one institution stays one institution', () => {
  it('matches an existing school by name within the same city', async () => {
    const a = await resolveInstitution(db, ctx, {
      name: "St. Xavier's School", kind: 'school', city: 'Ranchi', stateUnitId: JH,
    });
    const b = await resolveInstitution(db, ctx, {
      name: 'St Xaviers School', kind: 'school', city: 'ranchi', stateUnitId: JH,
    });
    expect(b.created).toBe(false);
    expect(b.institutionId).toBe(a.institutionId);
  });

  it('does NOT merge the same name in a different city', async () => {
    // "St Xavier's School" exists in a dozen cities and they are a dozen
    // different clients.
    const a = await resolveInstitution(db, ctx, {
      name: "St. Xavier's School", kind: 'school', city: 'Ranchi', stateUnitId: JH,
    });
    const b = await resolveInstitution(db, ctx, {
      name: "St. Xavier's School", kind: 'school', city: 'Patna', stateUnitId: BR,
    });
    expect(b.created).toBe(true);
    expect(b.institutionId).not.toBe(a.institutionId);
  });

  it('does not merge a school with a corporate of the same name', async () => {
    const a = await resolveInstitution(db, ctx, { name: 'Acme', kind: 'school', city: 'Ranchi' });
    const b = await resolveInstitution(db, ctx, { name: 'Acme', kind: 'corporate', city: 'Ranchi' });
    expect(b.institutionId).not.toBe(a.institutionId);
  });

  it('refuses a nameless institution', async () => {
    await expect(resolveInstitution(db, ctx, { name: '   ', kind: 'school' }))
      .rejects.toThrow(/needs a name/);
  });

  it('a lead is NOT a person until somebody identifies it', async () => {
    const a = await captureLead(db, ctx, { audience: 'school', contactEmail: 'notaperson@school.in' });
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.id, a.leadId));
    expect(lead.personId).toBeNull();
    expect(lead.institutionId).toBeNull();

    // The member register must not fill with people who never trained.
    const persons = await db.select().from(s.persons);
    expect(persons.length).toBe(0);

    const inst = await resolveInstitution(db, ctx, { name: 'Identified School', kind: 'school', city: 'Ranchi' });
    await identifyLead(db, ctx, a.leadId, { institutionId: inst.institutionId });
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, a.leadId));
    expect(after.institutionId).toBe(inst.institutionId);
    expect(after.status).toBe('qualifying');
  });

  it('identification refuses with no target', async () => {
    const a = await captureLead(db, ctx, { audience: 'school', contactEmail: 'notarget@school.in' });
    await expect(identifyLead(db, ctx, a.leadId, {})).rejects.toThrow(/institution or a person/);
  });
});

describe('training requests', () => {
  it('refuses a request it could never price, naming what is missing', async () => {
    await expect(
      submitTrainingRequest(db, ctx, { audience: 'school', parameters: { ageGroups: '6-14' } })
    ).rejects.toThrow(/cannot be priced without: participants/);
  });

  it('refuses a participant count that is not a whole positive number', async () => {
    for (const bad of [0, -5, 2.5, 'many', NaN]) {
      await expect(
        submitTrainingRequest(db, ctx, {
          audience: 'corporate', parameters: { participants: bad as any },
        })
      ).rejects.toThrow(/whole number greater than zero/);
    }
  });

  it('records the request and advances the lead', async () => {
    const lead = await captureLead(db, ctx, { audience: 'school', contactEmail: 'req@school.in' });
    const req = await submitTrainingRequest(db, ctx, {
      audience: 'school', leadId: lead.leadId,
      parameters: { participants: 400, ageGroups: '6-14', campuses: 2 },
      mode: 'on_site',
    });
    expect(req.ref).toMatch(/^MMAKF-REQ-/);
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, lead.leadId));
    expect(after.status).toBe('qualifying');
  });

  it('every audience has a required-parameter list, including the empty one', () => {
    for (const a of AUDIENCES) {
      expect(REQUIRED_PARAMETERS[a], `${a} has no parameter policy`).toBeDefined();
    }
  });
});

describe('the pipeline is scoped', () => {
  beforeAll(async () => {
    const jh = await captureLead(db, ctx, { audience: 'school', contactEmail: 'jh-lead@school.in' });
    await db.update(s.leads).set({ stateUnitId: JH }).where(eq(s.leads.id, jh.leadId));
    const br = await captureLead(db, ctx, { audience: 'school', contactEmail: 'br-lead@school.in' });
    await db.update(s.leads).set({ stateUnitId: BR }).where(eq(s.leads.id, br.leadId));
  });

  it('a state administrator sees their own state and not another', async () => {
    const jh = await leadPipeline(db, jhAdmin());
    const emails = jh.rows.map((r: any) => r.contactEmail);
    expect(emails).toContain('jh-lead@school.in');
    expect(emails).not.toContain('br-lead@school.in');
  });

  it('an UNLOCATED lead is national-only — the fail-closed reading', async () => {
    // An enquiry with no unit could belong to any state, and showing it to
    // every state administrator discloses one state's prospects to another.
    const jh = await leadPipeline(db, jhAdmin());
    expect(jh.rows.every((r: any) => r.stateUnitId === JH)).toBe(true);

    const nat = await leadPipeline(db, national);
    expect(nat.rows.some((r: any) => r.stateUnitId === null)).toBe(true);
  });

  it('refuses a caller without the authority', async () => {
    await expect(leadPipeline(db, athlete)).rejects.toThrow(/engagement:read/);
  });

  it('says when the list was truncated rather than implying it is complete', async () => {
    const r = await leadPipeline(db, national, { limit: 1 });
    expect(r.rows.length).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it('a state administrator cannot read another state\'s lead by id', async () => {
    const nat = await leadPipeline(db, national);
    const br = nat.rows.find((r: any) => r.contactEmail === 'br-lead@school.in')!;
    await expect(leadDetail(db, jhAdmin(), br.id)).rejects.toThrow(/Forbidden/);
    await expect(leadDetail(db, brAdmin(), br.id)).resolves.toBeTruthy();
  });
});

describe('attribution', () => {
  it('counts FIRST touch, and reports the denominator with it', async () => {
    const rows = await sourceAttribution(db, national);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // "1 of 1" and "340 of 340" are both 100% and mean entirely different
      // things, so a bare percentage is never reported.
      expect(r.wonOf).toMatch(/^\d+ of \d+$/);
      expect(r.total).toBeGreaterThan(0);
    }
    const qr = rows.find((r: any) => r.source === 'qr');
    expect(qr, 'the QR lead was attributed to paid_search — last touch, not first').toBeTruthy();
  });

  it('errors are identified by shape', () => {
    expect(isEngagementError(new EngagementError('x', 'y'))).toBe(true);
    expect(isEngagementError(new Error('y'))).toBe(false);
  });
});
