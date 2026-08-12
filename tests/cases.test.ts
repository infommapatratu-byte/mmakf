// Safeguarding, disciplinary, medical and support casework, against real Postgres.
//
// The invariants these tests exist to protect are not "the feature works". They
// are: a child-protection file is unreachable by national administration; a
// reporter promised anonymity is anonymous in the record AND in the audit spine;
// a case can concern someone who is not a member; medical data never reaches an
// athlete-facing read; a case note is never rewritten; a sanction never exists
// without a decision.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import { publicAthleteProfile, athletePassport } from '../src/db/athletes';
import * as cases from '../src/db/cases';
import {
  reportConcern, assignOfficer, recordAction, referToAuthority, closeCase,
  getSafeguardingCase, listSafeguardingCases,
  raiseCase, investigate, scheduleHearing, decide, appeal, getDisciplinaryCase,
  recordClearance, recordInjury, recordReturnToPlay, fitnessToCompete, medicalHistory,
  raiseTicket, assignTicket, respondToTicket, resolveTicket, ticketStanding,
  addCaseNote, listCaseNotes, redactForSubject, subjectCaseView, hasSafeguardingAccess,
  CaseError,
} from '../src/db/cases';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any, JH: number, DOJO: number, OTHER_DOJO: number;

const NOW = new Date('2026-08-12T00:00:00Z');
const TODAY = '2026-08-12';

const superAdmin: Principal = {
  userId: 1, label: 'super-admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const federationAdmin: Principal = {
  userId: 2, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const safeguardingOfficer: Principal = {
  userId: 3, label: 'safeguarding-officer',
  bindings: [{ role: 'SAFEGUARDING_OFFICER', scopeType: 'national', scopeId: null }],
};
const president: Principal = {
  userId: 4, label: 'president',
  bindings: [{ role: 'PRESIDENT', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 5, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/** Bound to DOJO only — the scope boundary for medical records. */
let dojoAdmin: Principal;
let otherDojoAdmin: Principal;

const SG = { principal: safeguardingOfficer, reason: 'safeguarding casework' };
const DISC = { principal: federationAdmin, reason: 'disciplinary casework' };

async function makePerson(name: string, over: Record<string, unknown> = {}) {
  return createPerson(db, { principal: superAdmin }, {
    fullName: name, stateUnitId: JH, dojoId: DOJO, ...over,
  } as any);
}

/** A user row linked to a person, so a principal can be recognised as "self". */
async function makeUserFor(personId: number, email: string): Promise<Principal> {
  const [u] = await db.insert(s.users).values({ email, personId }).returning({ id: s.users.id });
  return { userId: u.id, label: email, bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }] };
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;
  const [d2] = await db.insert(s.dojos)
    .values({ code: 'DJ-2', name: 'Branch', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  OTHER_DOJO = d2.id;

  dojoAdmin = {
    userId: 6, label: 'dojo-admin',
    bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: DOJO }],
  };
  otherDojoAdmin = {
    userId: 7, label: 'other-dojo-admin',
    bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: OTHER_DOJO }],
  };
});

// ───────────────────────────────────────────────────────────────────────────

describe('safeguarding access is NOT national administrative access', () => {
  async function aCase() {
    return reportConcern(db, SG, {
      concernSummary: 'Concern about conduct at a training session',
      concernKind: 'conduct',
      reporterName: 'Named Reporter',
      reporterContact: 'reporter@example.in',
      subjectDescription: 'A child attending the class',
      subjectIsMinor: true,
    }, NOW);
  }

  it('refuses a FEDERATION_ADMIN — the case file is closed to national administration', async () => {
    const c = await aCase();
    await expect(getSafeguardingCase(db, federationAdmin, c.id)).rejects.toThrow(ForbiddenError);
    await expect(listSafeguardingCases(db, federationAdmin)).rejects.toThrow(ForbiddenError);
    expect(hasSafeguardingAccess(federationAdmin)).toBe(false);
  });

  it('refuses a PRESIDENT and an ATHLETE too', async () => {
    const c = await aCase();
    await expect(getSafeguardingCase(db, president, c.id)).rejects.toThrow(ForbiddenError);
    await expect(getSafeguardingCase(db, athlete, c.id)).rejects.toThrow(ForbiddenError);
  });

  it('admits the safeguarding officer and the super admin, and nobody else', async () => {
    const c = await aCase();
    expect((await getSafeguardingCase(db, safeguardingOfficer, c.id)).caseNo).toBe(c.caseNo);
    expect((await getSafeguardingCase(db, superAdmin, c.id)).caseNo).toBe(c.caseNo);
    expect(hasSafeguardingAccess(safeguardingOfficer)).toBe(true);
    expect(hasSafeguardingAccess(superAdmin)).toBe(true);
  });

  it('refuses a FEDERATION_ADMIN the case notes as well as the case', async () => {
    const c = await aCase();
    await addCaseNote(db, SG, { caseKind: 'safeguarding', caseId: c.id, note: 'Internal note' }, NOW);
    await expect(listCaseNotes(db, federationAdmin, 'safeguarding', c.id)).rejects.toThrow(ForbiddenError);
    expect((await listCaseNotes(db, safeguardingOfficer, 'safeguarding', c.id)).length).toBe(1);
  });

  it('keeps the concern text out of the worklist a colleague could see over a shoulder', async () => {
    await aCase();
    const rows = await listSafeguardingCases(db, safeguardingOfficer);
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain('Concern about conduct');
    expect(dumped).not.toContain('Named Reporter');
    expect(dumped).not.toContain('reporter@example.in');
  });
});

describe('a reporter who needs to be anonymous is anonymous', () => {
  it('accepts an anonymous report and returns no reporter identity', async () => {
    const receipt = await reportConcern(db, { principal: athlete }, {
      concernSummary: 'Anonymous concern about supervision at a competition',
      reporterAnonymous: true,
      // Supplied anyway — the module must refuse to keep it.
      reporterName: 'Should Never Be Stored',
      reporterContact: 'never@example.in',
      subjectDescription: 'A junior competitor',
      subjectIsMinor: true,
    }, NOW);

    expect(receipt.caseNo).toMatch(/^MMAKF-SG-2026-\d{6}$/);
    expect(receipt.reporterAnonymous).toBe(true);
    const dumped = JSON.stringify(receipt);
    expect(dumped).not.toContain('Should Never Be Stored');
    expect(dumped).not.toContain('never@example.in');
    expect(Object.keys(receipt)).not.toContain('reporterName');
    expect(Object.keys(receipt)).not.toContain('reporterContact');
  });

  it('never STORES the identity either — anonymity is enforced at write time', async () => {
    const receipt = await reportConcern(db, { principal: athlete }, {
      concernSummary: 'Second anonymous concern',
      reporterAnonymous: true,
      reporterName: 'Also Never Stored',
      reporterContact: 'alsonever@example.in',
    }, NOW);

    const row = await getSafeguardingCase(db, safeguardingOfficer, receipt.id);
    expect(row.reporterName).toBeNull();
    expect(row.reporterContact).toBeNull();
    expect(row.reporterAnonymous).toBe(true);
    expect(JSON.stringify(row)).not.toContain('Also Never Stored');
  });

  it('does not deanonymise the reporter through the audit spine', async () => {
    // A signed-in user reporting anonymously: audit_events.actor_user_id would
    // identify them, which would make the promise of anonymity false.
    const receipt = await reportConcern(db, { principal: athlete }, {
      concernSummary: 'Third anonymous concern',
      reporterAnonymous: true,
    }, NOW);

    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'safeguarding_case'),
      eq(s.auditEvents.entityId, String(receipt.id))
    ));
    expect(audit.length).toBe(1);
    expect(audit[0].actorUserId).toBeNull();
    expect(audit[0].actorLabel).toBe('anonymous-reporter');
    expect(audit[0].actorLabel).not.toBe('athlete');
  });

  it('keeps the concern text out of the audit spine, which is read far more widely', async () => {
    await reportConcern(db, SG, {
      concernSummary: 'AUDIT-LEAK-CANARY: detailed allegation text',
    }, NOW);
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'safeguarding_case'));
    expect(JSON.stringify(audit)).not.toContain('AUDIT-LEAK-CANARY');
  });

  it('reporting is not gated — a principal with no role at all may still report', async () => {
    const nobody: Principal = { userId: null, label: 'anonymous', bindings: [] };
    const receipt = await reportConcern(db, { principal: nobody }, {
      concernSummary: 'A concern raised by someone with no account',
      receivedVia: 'telephone',
    }, NOW);
    expect(receipt.status).toBe('received');
  });

  it('still requires the concern to say what it is', async () => {
    await expect(reportConcern(db, SG, { concernSummary: '   ' }, NOW))
      .rejects.toThrow(/what the concern is/i);
  });
});

describe('a safeguarding subject need not be a member', () => {
  it('accepts a case about a person with no persons row at all', async () => {
    const receipt = await reportConcern(db, SG, {
      concernSummary: 'Concern about an adult spectator at a tournament',
      subjectDescription: 'An unidentified adult spectator, approximately 40 years old',
      subjectIsMinor: false,
      // No subjectPersonId, no aboutPersonId. Deliberately.
    }, NOW);

    const row = await getSafeguardingCase(db, safeguardingOfficer, receipt.id);
    expect(row.subjectPersonId).toBeNull();
    expect(row.aboutPersonId).toBeNull();
    expect(row.subjectDescription).toMatch(/unidentified adult spectator/);
    expect(row.status).toBe('received');
  });

  it('accepts a case about a child who is not and may never be a member', async () => {
    const receipt = await reportConcern(db, SG, {
      concernSummary: 'Concern raised by a parent about their child at a taster session',
      subjectDescription: 'A child attending a taster session, not enrolled',
      subjectIsMinor: true,
    }, NOW);
    const row = await getSafeguardingCase(db, safeguardingOfficer, receipt.id);
    expect(row.subjectIsMinor).toBe(true);
    expect(row.subjectPersonId).toBeNull();
  });
});

describe('safeguarding casework', () => {
  async function openCase() {
    const r = await reportConcern(db, SG, {
      concernSummary: 'Casework fixture concern',
      subjectDescription: 'A child',
      subjectIsMinor: true,
    }, NOW);
    return r.id;
  }

  it('assigns an officer and moves the case into triage', async () => {
    const id = await openCase();
    const officer = await makePerson('Safeguarding Officer');
    const row = await assignOfficer(db, SG, { caseId: id, officerPersonId: officer.id }, NOW);
    expect(row.assignedOfficerPersonId).toBe(officer.id);
    expect(row.status).toBe('triage');
  });

  it('refuses to assign someone who does not exist', async () => {
    const id = await openCase();
    await expect(assignOfficer(db, SG, { caseId: id, officerPersonId: 999_999 }, NOW))
      .rejects.toThrow(CaseError);
  });

  it('APPENDS each action rather than rewriting the log', async () => {
    const id = await openCase();
    await recordAction(db, SG, { caseId: id, action: 'Spoke to the instructor', on: '2026-08-12' }, NOW);
    await recordAction(db, SG, { caseId: id, action: 'Contacted the parent', on: '2026-08-13' }, NOW);

    const row = await getSafeguardingCase(db, safeguardingOfficer, id);
    expect(row.actionsTaken).toBe('2026-08-12 — Spoke to the instructor\n2026-08-13 — Contacted the parent');
    expect(row.status).toBe('under_investigation');

    // The notes are the record; both survive intact.
    const notes = await listCaseNotes(db, safeguardingOfficer, 'safeguarding', id);
    expect(notes.map((n: any) => n.note)).toEqual(['Spoke to the instructor', 'Contacted the parent']);
  });

  it('evidences an external referral, naming the authority and the date', async () => {
    const id = await openCase();
    const before = await getSafeguardingCase(db, safeguardingOfficer, id);
    expect(before.referredToAuthority).toBe(false);

    const row = await referToAuthority(db, SG, {
      caseId: id,
      referredTo: 'District Child Welfare Committee, Ramgarh',
      referredOn: '2026-08-14',
    }, NOW);

    expect(row.referredToAuthority).toBe(true);
    expect(row.referredTo).toBe('District Child Welfare Committee, Ramgarh');
    expect(row.referredOn).toBe('2026-08-14');

    // The referral is provable from the audit spine on its own.
    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'safeguarding_case'),
      eq(s.auditEvents.entityId, String(id))
    ));
    expect(JSON.stringify(audit)).toMatch(/District Child Welfare Committee/);
  });

  it('requires a referral to name the authority', async () => {
    const id = await openCase();
    await expect(referToAuthority(db, SG, { caseId: id, referredTo: '  ' }, NOW))
      .rejects.toThrow(/name the authority/i);
  });

  it('refuses to record a second referral over the first', async () => {
    const id = await openCase();
    await referToAuthority(db, SG, { caseId: id, referredTo: 'Police', referredOn: '2026-08-14' }, NOW);
    await expect(referToAuthority(db, SG, { caseId: id, referredTo: 'Someone else' }, NOW))
      .rejects.toThrow(/already referred/i);
  });

  it('closes with a stated outcome, and says when no review interval was configured', async () => {
    const id = await openCase();
    const row = await closeCase(db, SG, { caseId: id, outcome: 'No further action; instructor briefed' }, NOW);
    expect(row.status).toBe('closed');
    expect(row.closedOn).toBe(TODAY);
    expect(row.reviewDueOn).toBeNull();
    expect(row.reviewNote).toMatch(/has not configured a review interval/i);
  });

  it('refuses to close without an outcome, and refuses to close twice', async () => {
    const id = await openCase();
    await expect(closeCase(db, SG, { caseId: id, outcome: ' ' }, NOW)).rejects.toThrow(/stated outcome/i);
    await closeCase(db, SG, { caseId: id, outcome: 'Concluded' }, NOW);
    await expect(closeCase(db, SG, { caseId: id, outcome: 'Again' }, NOW)).rejects.toThrow(/closed on/i);
  });

  it('refuses further action on a closed case', async () => {
    const id = await openCase();
    await closeCase(db, SG, { caseId: id, outcome: 'Concluded' }, NOW);
    await expect(recordAction(db, SG, { caseId: id, action: 'Late action' }, NOW))
      .rejects.toThrow(/closed/i);
  });

  it('refuses every write to a principal without safeguarding:write', async () => {
    const id = await openCase();
    await expect(assignOfficer(db, { principal: federationAdmin }, { caseId: id, officerPersonId: 1 }, NOW))
      .rejects.toThrow(ForbiddenError);
    await expect(recordAction(db, { principal: federationAdmin }, { caseId: id, action: 'x' }, NOW))
      .rejects.toThrow(ForbiddenError);
    await expect(referToAuthority(db, { principal: federationAdmin }, { caseId: id, referredTo: 'x' }, NOW))
      .rejects.toThrow(ForbiddenError);
    await expect(closeCase(db, { principal: federationAdmin }, { caseId: id, outcome: 'x' }, NOW))
      .rejects.toThrow(ForbiddenError);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('case notes are APPEND-ONLY', () => {
  it('exposes no edit and no delete path for a note', () => {
    const edits = Object.keys(cases).filter(
      (k) => /note/i.test(k) && /(edit|update|delete|remove|amend|redactNote|purge)/i.test(k)
    );
    expect(edits).toEqual([]);
    // And nothing generic that would let a caller reach one either.
    expect(Object.keys(cases)).not.toContain('updateCaseNote');
    expect(Object.keys(cases)).not.toContain('deleteCaseNote');
  });

  it('leaves earlier notes byte-identical after every later mutation', async () => {
    const r = await reportConcern(db, SG, { concernSummary: 'Append-only fixture' }, NOW);
    await addCaseNote(db, SG, { caseKind: 'safeguarding', caseId: r.id, note: 'First note' }, NOW);
    const before = await listCaseNotes(db, safeguardingOfficer, 'safeguarding', r.id);

    const officer = await makePerson('Note Officer');
    await assignOfficer(db, SG, { caseId: r.id, officerPersonId: officer.id }, NOW);
    await recordAction(db, SG, { caseId: r.id, action: 'An action' }, NOW);
    await referToAuthority(db, SG, { caseId: r.id, referredTo: 'An authority' }, NOW);
    await closeCase(db, SG, { caseId: r.id, outcome: 'Done' }, NOW);

    const after = await listCaseNotes(db, safeguardingOfficer, 'safeguarding', r.id);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].note).toBe('First note');
    expect(String(after[0].at)).toBe(String(before[0].at));
    // Nothing was deleted: every earlier id is still present.
    for (const b of before) expect(after.some((a: any) => a.id === b.id)).toBe(true);
  });

  it('refuses an empty note', async () => {
    const r = await reportConcern(db, SG, { concernSummary: 'Empty note fixture' }, NOW);
    await expect(addCaseNote(db, SG, { caseKind: 'safeguarding', caseId: r.id, note: '  ' }, NOW))
      .rejects.toThrow(/cannot be empty/i);
  });

  it('defaults a note to confidential, so sharing must be a deliberate act', async () => {
    const r = await reportConcern(db, SG, { concernSummary: 'Default classification fixture' }, NOW);
    const note = await addCaseNote(db, SG, { caseKind: 'safeguarding', caseId: r.id, note: 'A note' }, NOW);
    expect(note.classification).toBe('confidential');
  });

  it('refuses to park a note on a case that does not exist yet', async () => {
    // `case_id` carries no foreign key, so an unchecked write lands a note on an
    // id `serial` has not issued. When it is issued, the new case is born
    // already holding a note written before it existed — and a safeguarding file
    // whose contents predate it cannot evidence what was known and when.
    await expect(addCaseNote(db, SG,
      { caseKind: 'safeguarding', caseId: 900_001, note: 'Planted ahead of the case' }, NOW))
      .rejects.toThrow(/Unknown safeguarding case/i);
    await expect(addCaseNote(db, DISC,
      { caseKind: 'disciplinary', caseId: 900_002, note: 'Planted ahead of the case' }, NOW))
      .rejects.toThrow(/Unknown disciplinary case/i);

    const planted = await db.select().from(s.caseNotes);
    expect(planted.some((n: any) => n.caseId === 900_001 || n.caseId === 900_002)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('disciplinary: a sanction requires a decision, a decision requires a hearing', () => {
  async function openCase(subjectPersonId?: number) {
    return raiseCase(db, DISC, {
      summary: 'Alleged breach of the code of conduct at a national event',
      allegedBreachOf: 'Code of Conduct',
      subjectPersonId: subjectPersonId ?? null,
    }, NOW);
  }

  it('REFUSES a sanction with no decision behind it', async () => {
    const c = await openCase();
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);

    await expect(decide(db, DISC, {
      caseId: c.id,
      decision: '   ',
      sanction: 'Suspended from competition for six months',
    }, NOW)).rejects.toThrow(/sanction cannot be recorded without the decision/i);

    // And nothing was written.
    const row = await getDisciplinaryCase(db, federationAdmin, c.id);
    expect(row.sanction).toBeNull();
    expect(row.decision).toBeNull();
    expect(row.decidedOn).toBeNull();
  });

  it('REFUSES a decision before a hearing date exists', async () => {
    const c = await openCase();
    await expect(decide(db, DISC, { caseId: c.id, decision: 'Upheld' }, NOW))
      .rejects.toThrow(/cannot be entered before the case has been heard/i);
  });

  it('records the decision and sanction once a hearing has been held', async () => {
    const c = await openCase();
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    const row = await decide(db, DISC, {
      caseId: c.id,
      decision: 'Allegation upheld',
      sanction: 'Suspended from competition',
      sanctionFrom: '2026-09-02',
      sanctionTo: '2027-03-01',
    }, NOW);

    expect(row.status).toBe('decided');
    expect(row.decision).toBe('Allegation upheld');
    expect(row.sanction).toBe('Suspended from competition');
    expect(row.decidedOn).toBe(TODAY);
  });

  it('refuses a sanction that ends before it starts', async () => {
    const c = await openCase();
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await expect(decide(db, DISC, {
      caseId: c.id, decision: 'Upheld', sanction: 'Suspension',
      sanctionFrom: '2026-10-01', sanctionTo: '2026-09-01',
    }, NOW)).rejects.toThrow(/cannot end before it starts/i);
  });

  it('refuses to decide the same case twice', async () => {
    const c = await openCase();
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await decide(db, DISC, { caseId: c.id, decision: 'Upheld' }, NOW);
    await expect(decide(db, DISC, { caseId: c.id, decision: 'Changed my mind' }, NOW))
      .rejects.toThrow(/decided on/i);
  });

  it('records WHO and WHY at every step', async () => {
    const c = await openCase();
    const inv = await makePerson('Investigator');
    await investigate(db, { principal: federationAdmin, reason: 'Appointed by the general secretary' },
      { caseId: c.id, investigatorPersonId: inv.id }, NOW);
    await scheduleHearing(db, { principal: federationAdmin, reason: 'Panel convened' },
      { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await decide(db, { principal: federationAdmin, reason: 'Panel majority' },
      { caseId: c.id, decision: 'Upheld' }, NOW);

    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'disciplinary_case'),
      eq(s.auditEvents.entityId, String(c.id))
    ));
    const reasons = audit.map((a: any) => a.reason);
    expect(reasons).toContain('Appointed by the general secretary');
    expect(reasons).toContain('Panel convened');
    expect(reasons).toContain('Panel majority');
    expect(audit.every((a: any) => a.actorLabel === 'federation-admin')).toBe(true);
  });

  it('refuses a step with no reason recorded', async () => {
    const c = await openCase();
    await expect(scheduleHearing(db, { principal: federationAdmin },
      { caseId: c.id, hearingOn: '2026-09-01' }, NOW)).rejects.toThrow(/record the reason/i);
  });

  it('refuses to appoint the subject as their own investigator', async () => {
    const p = await makePerson('Case Subject');
    const c = await openCase(p.id);
    await expect(investigate(db, DISC, { caseId: c.id, investigatorPersonId: p.id }, NOW))
      .rejects.toThrow(/cannot be its investigator/i);
  });

  it('refuses an appeal against a case with no decision', async () => {
    const c = await openCase();
    await expect(appeal(db, DISC, { caseId: c.id, lodgedOn: '2026-09-10' }, NOW))
      .rejects.toThrow(/no decision on record to appeal against/i);
  });

  it('lodges an appeal, then records its outcome', async () => {
    const c = await openCase();
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await decide(db, DISC, { caseId: c.id, decision: 'Upheld', sanction: 'Warning' }, NOW);

    const lodged = await appeal(db, DISC, { caseId: c.id, lodgedOn: '2026-09-10' }, NOW);
    expect(lodged.status).toBe('appealed');
    expect(lodged.appealLodgedOn).toBe('2026-09-10');

    const heard = await appeal(db, DISC, { caseId: c.id, outcome: 'Appeal dismissed', decidedOn: '2026-10-01' }, NOW);
    expect(heard.status).toBe('appeal_heard');
    expect(heard.appealOutcome).toBe('Appeal dismissed');
    expect(heard.appealDecidedOn).toBe('2026-10-01');
    // The original decision is not rewritten by the appeal.
    expect(heard.decision).toBe('Upheld');
    expect(heard.sanction).toBe('Warning');
  });

  it('is closed to a SAFEGUARDING_OFFICER — the two case systems do not bleed', async () => {
    const c = await openCase();
    await expect(getDisciplinaryCase(db, safeguardingOfficer, c.id)).rejects.toThrow(ForbiddenError);
    await expect(raiseCase(db, SG, { summary: 'x' }, NOW)).rejects.toThrow(ForbiddenError);
  });

  it('is closed to an ATHLETE and an unbound principal', async () => {
    const c = await openCase();
    await expect(getDisciplinaryCase(db, athlete, c.id)).rejects.toThrow(ForbiddenError);
    await expect(getDisciplinaryCase(db, { userId: null, label: 'nobody', bindings: [] }, c.id))
      .rejects.toThrow(ForbiddenError);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('medical data never reaches an athlete-facing read', () => {
  const CLINICAL = 'CLINICAL-CANARY: suspected anterior cruciate ligament tear';
  let personId: number, federationId: string;

  beforeAll(async () => {
    const p = await makePerson('Medical Subject');
    personId = p.id;
    federationId = p.federationId;
    await db.update(s.persons).set({ status: 'active', dob: '2004-01-01' })
      .where(eq(s.persons.id, personId));

    await recordInjury(db, { principal: superAdmin }, {
      personId, injurySite: 'left knee', summary: CLINICAL,
      recordedOn: '2026-06-01', injuryOccurredOn: '2026-06-01',
    }, NOW);
    // A clearance too, so the fitness verdict actually reaches its "cleared"
    // projection. Without one it returns early on `no_record` and a leak in the
    // projection would go unmeasured.
    await recordClearance(db, { principal: superAdmin }, {
      personId, clearanceStatus: 'cleared', recordedOn: '2026-07-01',
      clearanceValidTo: '2027-07-01', summary: CLINICAL,
      documentUrl: 'https://example.invalid/CLINICAL-DOC-CANARY.pdf',
    }, NOW);
    await recordReturnToPlay(db, { principal: superAdmin }, {
      personId, recordedOn: '2026-07-01', returnToPlayOn: '2026-07-01',
    }, NOW);
  });

  it('does not appear in the PUBLIC athlete profile', async () => {
    const profile = await publicAthleteProfile(db, federationId);
    expect(profile).not.toBeNull();
    const dumped = JSON.stringify(profile);
    expect(dumped).not.toContain('CLINICAL-CANARY');
    expect(dumped).not.toContain('left knee');
    expect(Object.keys(profile!)).not.toContain('medical');
  });

  it('does not appear in the ATHLETE PASSPORT, which is the widest athlete read there is', async () => {
    const passport = await athletePassport(db, federationAdmin, federationId);
    expect(passport).not.toBeNull();
    const dumped = JSON.stringify(passport);
    expect(dumped).not.toContain('CLINICAL-CANARY');
    expect(dumped).not.toContain('left knee');
    expect(Object.keys(passport!)).not.toContain('medical');
    expect(Object.keys(passport!)).not.toContain('medicalRecords');
    expect(Object.keys(passport!)).not.toContain('injuries');
  });

  it('does not appear in the fitness VERDICT either — that returns a decision, not a record', async () => {
    const r = await fitnessToCompete(db, superAdmin, personId, TODAY);
    // Reached the cleared projection, so the assertions below are measuring it.
    expect(r.status).toBe('cleared');
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain('CLINICAL-CANARY');
    expect(dumped).not.toContain('CLINICAL-DOC-CANARY');
    expect(dumped).not.toContain('left knee');
    expect(Object.keys(r)).not.toContain('summary');
    expect(Object.keys(r)).not.toContain('injurySite');
    expect(Object.keys(r)).not.toContain('documentUrl');
    expect(Object.keys(r)).not.toContain('recordedByPersonId');
  });

  it('does not appear in the NOT-CLEARED projection either', async () => {
    const p = await makePerson('Not Cleared Canary');
    await recordClearance(db, { principal: superAdmin }, {
      personId: p.id, clearanceStatus: 'not_cleared', recordedOn: '2026-07-01',
      summary: 'CLINICAL-CANARY: withheld from competition',
      documentUrl: 'https://example.invalid/CLINICAL-DOC-CANARY.pdf',
    }, NOW);
    const r = await fitnessToCompete(db, superAdmin, p.id, TODAY);
    expect(r.status).toBe('not_cleared');
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain('CLINICAL-CANARY');
    expect(dumped).not.toContain('CLINICAL-DOC-CANARY');
  });

  it('appears ONLY through the one function named for it', async () => {
    const history = await medicalHistory(db, superAdmin, personId);
    expect(JSON.stringify(history)).toContain('CLINICAL-CANARY');
  });
});

describe('fitness to compete', () => {
  async function subject(name: string) {
    const p = await makePerson(name);
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    return p.id;
  }

  it('reports NO RECORD as its own state, and does not invent a requirement', async () => {
    const id = await subject('No Medical Record');
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).toBe('no_record');
    expect(r.reason).toMatch(/has not configured whether one is required/i);
    expect(r.checks.find((c) => c.rule === 'clearance_on_record')!.passed).toBe(false);
  });

  it('reports CLEARED against a valid clearance, and says what it saw', async () => {
    const id = await subject('Cleared Athlete');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2026-01-01', clearanceValidTo: '2027-01-01',
    }, NOW);
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).toBe('cleared');
    expect(r.clearanceRecordedOn).toBe('2026-01-01');
    expect(r.clearanceValidTo).toBe('2027-01-01');
    expect(r.reason).toMatch(/valid to 2027-01-01/);
  });

  it('reports NOT CLEARED once the clearance has expired, with the dates', async () => {
    const id = await subject('Expired Clearance');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2024-01-01', clearanceValidTo: '2025-01-01',
    }, NOW);
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).toBe('not_cleared');
    expect(r.reason).toMatch(/expired on 2025-01-01, before 2026-08-12/);
  });

  it('reports NOT CLEARED for a restricted clearance rather than treating it as a pass', async () => {
    const id = await subject('Restricted Clearance');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'restricted', recordedOn: '2026-01-01',
    }, NOW);
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).toBe('not_cleared');
    expect(r.reason).toMatch(/is restricted/);
  });

  it('will not extend a clearance past an injury it was never given on', async () => {
    const id = await subject('Injured After Clearance');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2026-01-01', clearanceValidTo: '2027-01-01',
    }, NOW);
    await recordInjury(db, { principal: superAdmin }, {
      personId: id, recordedOn: '2026-06-01', injurySite: 'shoulder',
    }, NOW);

    // The unresolved injury is always REPORTED, and the clearance is never
    // extended over it. What it MEANS is MMAKF's rule to write, so unconfigured
    // the answer is `undetermined` and grants nothing — see the attack block at
    // the foot of this file. With the rule configured, it is a refusal.
    const unconfigured = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(unconfigured.status).toBe('undetermined');
    expect(unconfigured.status).not.toBe('cleared');

    const r = await fitnessToCompete(db, superAdmin, id, TODAY, { injuryLapsesClearance: true });
    expect(r.status).toBe('not_cleared');
    expect(r.reason).toMatch(/no return to play has been recorded/i);
    expect(r.checks.find((c) => c.rule === 'no_unresolved_injury')!.passed).toBe(false);
  });

  it('clears again once a return to play is recorded', async () => {
    const id = await subject('Returned To Play');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2026-01-01', clearanceValidTo: '2027-01-01',
    }, NOW);
    await recordInjury(db, { principal: superAdmin }, { personId: id, recordedOn: '2026-06-01' }, NOW);
    await recordReturnToPlay(db, { principal: superAdmin }, {
      personId: id, recordedOn: '2026-07-01', returnToPlayOn: '2026-07-01',
    }, NOW);

    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).toBe('cleared');
    expect(r.checks.find((c) => c.rule === 'no_unresolved_injury')!.passed).toBe(true);
  });

  it('answers AS AT the date asked, not as at today', async () => {
    const id = await subject('As At Athlete');
    await recordClearance(db, { principal: superAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2026-05-01', clearanceValidTo: '2027-01-01',
    }, NOW);
    // Before the clearance was recorded, there was no clearance.
    expect((await fitnessToCompete(db, superAdmin, id, '2026-04-01')).status).toBe('no_record');
    expect((await fitnessToCompete(db, superAdmin, id, '2026-05-02')).status).toBe('cleared');
  });

  it('is scope-checked: an administrator of another dojo is refused', async () => {
    const id = await subject('Scoped Athlete');
    await recordClearance(db, { principal: dojoAdmin }, {
      personId: id, clearanceStatus: 'cleared', recordedOn: '2026-01-01',
    }, NOW);
    expect((await fitnessToCompete(db, dojoAdmin, id, TODAY)).status).toBe('cleared');

    await expect(fitnessToCompete(db, otherDojoAdmin, id, TODAY)).rejects.toThrow(ForbiddenError);
    await expect(medicalHistory(db, otherDojoAdmin, id)).rejects.toThrow(ForbiddenError);
    await expect(recordInjury(db, { principal: otherDojoAdmin }, { personId: id }, NOW))
      .rejects.toThrow(ForbiddenError);
  });

  it('refuses an ATHLETE principal the medical history of another person', async () => {
    const id = await subject('Private Athlete');
    await expect(medicalHistory(db, athlete, id)).rejects.toThrow(ForbiddenError);
    await expect(fitnessToCompete(db, athlete, id, TODAY)).rejects.toThrow(ForbiddenError);
  });

  it('keeps clinical text out of the audit spine', async () => {
    const id = await subject('Audit Medical');
    await recordInjury(db, { principal: superAdmin }, {
      personId: id, summary: 'MEDICAL-AUDIT-CANARY', injurySite: 'ribs',
    }, NOW);
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'medical_record'));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('MEDICAL-AUDIT-CANARY');
    expect(JSON.stringify(audit)).not.toContain('ribs');
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('support tickets: the SLA is configuration, not a guess', () => {
  it('sets no deadline when no service standard is supplied, and says so', async () => {
    const { ticket, serviceStandard } = await raiseTicket(db, { principal: athlete }, {
      category: 'membership', subject: 'Cannot download my certificate',
      body: 'The download link does not work.', contactEmail: 'member@example.in',
    }, NOW);

    expect(ticket.ticketNo).toMatch(/^MMAKF-TKT-2026-\d{6}$/);
    expect(ticket.slaDueAt).toBeNull();
    expect(serviceStandard.configured).toBe(false);
    expect(serviceStandard.slaDueAt).toBeNull();
    expect(serviceStandard.note).toMatch(/no service standard configured/i);

    const standing = await ticketStanding(db, federationAdmin, ticket.id, NOW);
    // Not false — unmeasured. A breach statistic about a rule nobody set is a lie.
    expect(standing.met).toBeNull();
    expect(standing.note).toMatch(/no service standard configured/i);
  });

  it('applies a deadline when the federation supplies one', async () => {
    const { ticket, serviceStandard } = await raiseTicket(db, { principal: athlete }, {
      category: 'membership', subject: 'With a standard', body: 'Body', slaHours: 48,
    }, NOW);
    expect(serviceStandard.configured).toBe(true);
    expect(new Date(ticket.slaDueAt).toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('refuses a nonsensical service standard rather than rounding it into existence', async () => {
    await expect(raiseTicket(db, { principal: athlete }, {
      category: 'x', subject: 'y', body: 'z', slaHours: 0,
    }, NOW)).rejects.toThrow(/positive whole number/i);
    await expect(raiseTicket(db, { principal: athlete }, {
      category: 'x', subject: 'y', body: 'z', slaHours: 1.5,
    }, NOW)).rejects.toThrow(/positive whole number/i);
  });

  it('assigns, responds and resolves — and never moves the first response time', async () => {
    const { ticket } = await raiseTicket(db, { principal: athlete }, {
      category: 'grading', subject: 'Question about a grading', body: 'When is the next grading?',
    }, NOW);

    const assigned = await assignTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, assignedToUserId: 2, department: 'Membership' }, NOW);
    expect(assigned.status).toBe('in_progress');

    const first = new Date('2026-08-12T10:00:00Z');
    const second = new Date('2026-08-13T10:00:00Z');
    const r1 = await respondToTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, response: 'The grading calendar has not been published yet.' }, first);
    const r2 = await respondToTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, response: 'Following up.' }, second);

    expect(new Date(r1.firstResponseAt).toISOString()).toBe(first.toISOString());
    expect(new Date(r2.firstResponseAt).toISOString()).toBe(first.toISOString());

    const resolved = await resolveTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, resolution: 'Answered; calendar link sent when published.' }, second);
    expect(resolved.status).toBe('resolved');
    expect(new Date(resolved.firstResponseAt).toISOString()).toBe(first.toISOString());

    // Responses are kept as append-only notes, like every other case kind.
    const notes = await db.select().from(s.caseNotes).where(and(
      eq(s.caseNotes.caseKind, 'support'), eq(s.caseNotes.caseId, ticket.id)
    ));
    expect(notes.length).toBe(2);
  });

  it('refuses an empty response, an empty resolution, and a second resolution', async () => {
    const { ticket } = await raiseTicket(db, { principal: athlete },
      { category: 'other', subject: 'S', body: 'B' }, NOW);
    await expect(respondToTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, response: ' ' }, NOW)).rejects.toThrow(/cannot be empty/i);
    await expect(resolveTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, resolution: ' ' }, NOW)).rejects.toThrow(/how it was resolved/i);
    await resolveTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, resolution: 'Done' }, NOW);
    await expect(resolveTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, resolution: 'Again' }, NOW)).rejects.toThrow(/already resolved/i);
  });

  it('measures against the deadline when there is one', async () => {
    const { ticket } = await raiseTicket(db, { principal: athlete },
      { category: 'other', subject: 'S', body: 'B', slaHours: 24 }, NOW);
    const late = await ticketStanding(db, federationAdmin, ticket.id, new Date('2026-08-15T00:00:00Z'));
    expect(late.met).toBe(false);

    await respondToTicket(db, { principal: federationAdmin },
      { ticketId: ticket.id, response: 'Answered' }, new Date('2026-08-12T06:00:00Z'));
    const met = await ticketStanding(db, federationAdmin, ticket.id, new Date('2026-08-15T00:00:00Z'));
    expect(met.met).toBe(true);
  });

  it('lets anyone raise a ticket, but not anyone handle one', async () => {
    const { ticket } = await raiseTicket(db, { principal: { userId: null, label: 'nobody', bindings: [] } },
      { category: 'other', subject: 'From nobody', body: 'Help' }, NOW);
    expect(ticket.status).toBe('open');

    await expect(assignTicket(db, { principal: athlete },
      { ticketId: ticket.id, assignedToUserId: 1 }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(respondToTicket(db, { principal: athlete },
      { ticketId: ticket.id, response: 'x' }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(resolveTicket(db, { principal: athlete },
      { ticketId: ticket.id, resolution: 'x' }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(ticketStanding(db, athlete, ticket.id, NOW)).rejects.toThrow(ForbiddenError);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('what a case subject may see of their own case', () => {
  it('is BUILT from an allowlist — a column added tomorrow cannot leak through it', () => {
    const view = redactForSubject('safeguarding', {
      caseNo: 'MMAKF-SG-2026-000001',
      status: 'closed',
      receivedOn: '2026-08-01',
      closedOn: '2026-08-20',
      outcome: 'No further action',
      concernSummary: 'CONCERN-TEXT-CANARY',
      reporterName: 'REPORTER-NAME-CANARY',
      reporterContact: 'REPORTER-CONTACT-CANARY',
      assignedOfficerPersonId: 42,
      referredToAuthority: true,
      referredTo: 'AUTHORITY-CANARY',
      someColumnAddedNextYear: 'FUTURE-COLUMN-CANARY',
    }, []);

    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain('CONCERN-TEXT-CANARY');
    expect(dumped).not.toContain('REPORTER-NAME-CANARY');
    expect(dumped).not.toContain('REPORTER-CONTACT-CANARY');
    expect(dumped).not.toContain('AUTHORITY-CANARY');
    expect(dumped).not.toContain('FUTURE-COLUMN-CANARY');
    expect(dumped).not.toContain('42');

    // But the subject still gets what they are owed.
    expect(view.outcome).toBe('No further action');
    expect(view.closedOn).toBe('2026-08-20');
    expect(view.referredToAuthority).toBe(true);
  });

  it('shares only notes explicitly marked shareable, and NAMES what is withheld', () => {
    const view = redactForSubject('safeguarding',
      { caseNo: 'X', status: 'closed', receivedOn: '2026-08-01', outcome: 'Concluded' },
      [
        { at: new Date('2026-08-02T00:00:00Z'), note: 'INTERNAL-NOTE-CANARY', classification: 'confidential' },
        { at: new Date('2026-08-03T00:00:00Z'), note: 'RESTRICTED-NOTE-CANARY', classification: 'highly_restricted' },
        { at: new Date('2026-08-04T00:00:00Z'), note: 'Shared with you: the outcome letter', classification: 'member' },
      ]
    );

    expect(view.sharedNotes.length).toBe(1);
    expect(view.sharedNotes[0].note).toMatch(/outcome letter/);
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain('INTERNAL-NOTE-CANARY');
    expect(dumped).not.toContain('RESTRICTED-NOTE-CANARY');

    expect(view.withheld.join(' ')).toMatch(/identity of anyone who reported/i);
    expect(view.withheld.join(' ')).toMatch(/2 case note\(s\) not marked for disclosure/);
  });

  it('lets the subject open their own case with no case permissions at all', async () => {
    const subject = await makePerson('Self Viewing Subject');
    const selfPrincipal = await makeUserFor(subject.id, 'self-subject@example.in');

    const r = await reportConcern(db, SG, {
      concernSummary: 'SELF-VIEW-CONCERN-CANARY',
      reporterName: 'SELF-VIEW-REPORTER-CANARY',
      reporterContact: 'selfreporter@example.in',
      subjectPersonId: subject.id,
    }, NOW);
    await addCaseNote(db, SG, { caseKind: 'safeguarding', caseId: r.id, note: 'SELF-VIEW-INTERNAL-CANARY' }, NOW);
    await addCaseNote(db, SG, {
      caseKind: 'safeguarding', caseId: r.id,
      note: 'Your case has been reviewed.', classification: 'member',
    }, NOW);
    await closeCase(db, SG, { caseId: r.id, outcome: 'No further action' }, NOW);

    // The subject holds MEMBER only — no safeguarding:read whatsoever.
    await expect(getSafeguardingCase(db, selfPrincipal, r.id)).rejects.toThrow(ForbiddenError);

    const view = await subjectCaseView(db, selfPrincipal, 'safeguarding', r.id);
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain('SELF-VIEW-CONCERN-CANARY');
    expect(dumped).not.toContain('SELF-VIEW-REPORTER-CANARY');
    expect(dumped).not.toContain('selfreporter@example.in');
    expect(dumped).not.toContain('SELF-VIEW-INTERNAL-CANARY');
    expect(view.outcome).toBe('No further action');
    expect(view.sharedNotes.map((n) => n.note)).toEqual(['Your case has been reviewed.']);
  });

  it('refuses a stranger who is neither the subject nor a case handler', async () => {
    const subject = await makePerson('Another Subject');
    const stranger = await makePerson('Unrelated Person');
    const strangerPrincipal = await makeUserFor(stranger.id, 'stranger@example.in');

    const r = await reportConcern(db, SG, {
      concernSummary: 'Stranger test', subjectPersonId: subject.id,
    }, NOW);

    await expect(subjectCaseView(db, strangerPrincipal, 'safeguarding', r.id))
      .rejects.toThrow(ForbiddenError);
    // Including a FEDERATION_ADMIN, who is not a safeguarding case handler.
    await expect(subjectCaseView(db, federationAdmin, 'safeguarding', r.id))
      .rejects.toThrow(ForbiddenError);
  });

  it('gives a disciplinary subject the decision and sanction, never the allegation as reported', async () => {
    const subject = await makePerson('Disciplinary Subject');
    const selfPrincipal = await makeUserFor(subject.id, 'disc-subject@example.in');

    const c = await raiseCase(db, DISC, {
      summary: 'DISC-ALLEGATION-CANARY',
      subjectPersonId: subject.id,
      complainantPersonId: null,
    }, NOW);
    await addCaseNote(db, DISC, { caseKind: 'disciplinary', caseId: c.id, note: 'DISC-INTERNAL-CANARY' }, NOW);
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await decide(db, DISC, {
      caseId: c.id, decision: 'Allegation upheld', sanction: 'Formal warning',
      sanctionFrom: '2026-09-02', sanctionTo: '2027-09-01',
    }, NOW);

    const view = await subjectCaseView(db, selfPrincipal, 'disciplinary', c.id);
    expect(view.outcome).toBe('Allegation upheld');
    expect(view.sanction).toEqual({ sanction: 'Formal warning', from: '2026-09-02', to: '2027-09-01' });
    expect(view.hearingOn).toBe('2026-09-01');
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain('DISC-ALLEGATION-CANARY');
    expect(dumped).not.toContain('DISC-INTERNAL-CANARY');
    expect(view.sharedNotes).toEqual([]);
  });

  it('lets the case handler produce the disclosure for a subject who is not a member', async () => {
    const r = await reportConcern(db, SG, {
      concernSummary: 'Non-member subject',
      subjectDescription: 'A child who is not enrolled',
    }, NOW);
    await closeCase(db, SG, { caseId: r.id, outcome: 'Referred and closed' }, NOW);

    const view = await subjectCaseView(db, safeguardingOfficer, 'safeguarding', r.id);
    expect(view.outcome).toBe('Referred and closed');
    expect(view.caseKind).toBe('safeguarding');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Review pass — attacks on the module as first built.

describe('ATTACK: anonymity survives the whole audit row, not just the actor id', () => {
  it('does not deanonymise an anonymous reporter through the IP hash or the request id', async () => {
    // `actor_ip_hash` is a hash of a 32-bit space, and the SAME hash is written
    // for every other action that user takes. One self-join on that column names
    // the "anonymous" reporter without breaking the hash at all.
    const ctx = { principal: athlete, ip: '203.0.113.9', requestId: 'req-deanon-1' };

    const receipt = await reportConcern(db, ctx,
      { concernSummary: 'Anonymous, reported from a known address', reporterAnonymous: true }, NOW);

    const [ev] = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'safeguarding_case'),
      eq(s.auditEvents.entityId, String(receipt.id))
    ));
    expect(ev.actorUserId).toBeNull();
    expect(ev.actorIpHash).toBeNull();
    expect(ev.requestId).toBeNull();
  });

  it('leaves nothing on the anonymous row that matches a named row from the same session', async () => {
    const ctx = { principal: athlete, ip: '198.51.100.7', requestId: 'req-correlate-1' };

    // The same user, same request context, does something ordinary and signed.
    const { ticket } = await raiseTicket(db, ctx,
      { category: 'other', subject: 'Named action', body: 'B' }, NOW);
    const anon = await reportConcern(db, ctx,
      { concernSummary: 'Anonymous from the same session', reporterAnonymous: true }, NOW);

    const [named] = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'support_ticket'), eq(s.auditEvents.entityId, String(ticket.id))));
    const [secret] = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'safeguarding_case'), eq(s.auditEvents.entityId, String(anon.id))));

    expect(named.actorIpHash).not.toBeNull();       // the named row is unaffected
    expect(secret.actorIpHash).toBeNull();
    expect(secret.actorIpHash).not.toBe(named.actorIpHash);
    expect(secret.requestId).not.toBe(named.requestId);
    expect(secret.actorRole).toBeNull();            // "the only ATHLETE who reported that day"
  });
});

describe('ATTACK: the person a safeguarding concern is ABOUT is not its subject', () => {
  it('does not open the case — or the fact of a referral — to the person complained of', async () => {
    const child = await makePerson('Child At Risk');
    const accused = await makePerson('Person Complained Of');
    const accusedPrincipal = await makeUserFor(accused.id, 'complained-of@example.in');

    const r = await reportConcern(db, SG, {
      concernSummary: 'Concern about an instructor',
      subjectPersonId: child.id,
      aboutPersonId: accused.id,
      subjectIsMinor: true,
    }, NOW);
    await referToAuthority(db, SG,
      { caseId: r.id, referredTo: 'State Child Welfare Committee' }, NOW);

    // Telling the person under investigation that the authorities have been
    // informed is how evidence and children get interfered with. Whether they
    // are told is the safeguarding officer's decision, never a self-service read.
    await expect(subjectCaseView(db, accusedPrincipal, 'safeguarding', r.id))
      .rejects.toThrow(ForbiddenError);
  });

  it('still opens it to the child the concern is FOR', async () => {
    const child = await makePerson('Child Who May See');
    const childPrincipal = await makeUserFor(child.id, 'child-view@example.in');
    const r = await reportConcern(db, SG,
      { concernSummary: 'Concern', subjectPersonId: child.id }, NOW);
    const view = await subjectCaseView(db, childPrincipal, 'safeguarding', r.id);
    expect(view.caseNo).toBe((await getSafeguardingCase(db, safeguardingOfficer, r.id)).caseNo);
  });
});

describe('ATTACK: case ids are not enumerable by anyone who asks', () => {
  it('gives a stranger the same refusal for a missing case as for one they may not see', async () => {
    const stranger = await makePerson('Enumerating Stranger');
    const strangerPrincipal = await makeUserFor(stranger.id, 'enumerator@example.in');
    const real = await reportConcern(db, SG, { concernSummary: 'A real case' }, NOW);

    const onReal = await subjectCaseView(db, strangerPrincipal, 'safeguarding', real.id).catch((e) => e);
    const onMissing = await subjectCaseView(db, strangerPrincipal, 'safeguarding', real.id + 500000).catch((e) => e);

    // Distinguishable errors are an existence oracle: a stranger walks the id
    // space and learns exactly which safeguarding cases the federation holds.
    expect(onReal).toBeInstanceOf(ForbiddenError);
    expect(onMissing).toBeInstanceOf(ForbiddenError);
    expect((onMissing as Error).name).toBe((onReal as Error).name);
  });

  it('still tells an actual case handler that the case does not exist', async () => {
    await expect(subjectCaseView(db, safeguardingOfficer, 'safeguarding', 999999))
      .rejects.toThrow(/Unknown safeguarding case/i);
  });
});

describe('ATTACK: a support ticket is not national just because the desk is', () => {
  async function ticketFrom(dojoId: number, canary: string) {
    const raiser = await makePerson(`Ticket Raiser ${canary}`, { dojoId });
    const { ticket } = await raiseTicket(db, { principal: athlete }, {
      category: 'other', subject: 'Private matter', body: canary,
      contactEmail: `${canary}@example.in`, contactPhone: '+91-99999-00000',
      confidential: true, raisedByPersonId: raiser.id,
    }, NOW);
    return ticket;
  }

  it('refuses a dojo administrator a confidential ticket raised in another dojo', async () => {
    const t = await ticketFrom(OTHER_DOJO, 'TICKET-CANARY-A');
    // dojoAdmin holds person:read_pii — but only inside DOJO.
    await expect(ticketStanding(db, dojoAdmin, t.id, NOW)).rejects.toThrow(ForbiddenError);
    await expect(respondToTicket(db, { principal: dojoAdmin },
      { ticketId: t.id, response: 'peeking' }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(assignTicket(db, { principal: dojoAdmin },
      { ticketId: t.id, assignedToUserId: 1 }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(resolveTicket(db, { principal: dojoAdmin },
      { ticketId: t.id, resolution: 'closed' }, NOW)).rejects.toThrow(ForbiddenError);
  });

  it('admits the administrator the ticket actually belongs to', async () => {
    const t = await ticketFrom(OTHER_DOJO, 'TICKET-CANARY-B');
    const st = await ticketStanding(db, otherDojoAdmin, t.id, NOW);
    expect(st.ticketNo).toBe(t.ticketNo);
  });

  it('falls closed on a ticket whose raiser cannot be resolved — national desk only', async () => {
    const { ticket } = await raiseTicket(db, { principal: { userId: null, label: 'nobody', bindings: [] } },
      { category: 'other', subject: 'From a non-member', body: 'Help' }, NOW);
    // No raiser row means no unit, so no scoped desk can claim it.
    await expect(ticketStanding(db, dojoAdmin, ticket.id, NOW)).rejects.toThrow(ForbiddenError);
    await expect(ticketStanding(db, otherDojoAdmin, ticket.id, NOW)).rejects.toThrow(ForbiddenError);
    expect((await ticketStanding(db, federationAdmin, ticket.id, NOW)).ticketNo).toBe(ticket.ticketNo);
  });
});

describe('ATTACK: an unanswered ticket has not met the standard', () => {
  it('reports neither met nor breached while the deadline is still running', async () => {
    const { ticket } = await raiseTicket(db, { principal: athlete },
      { category: 'other', subject: 'S', body: 'B', slaHours: 24 }, NOW);

    const early = await ticketStanding(db, federationAdmin, ticket.id, new Date('2026-08-12T01:00:00Z'));
    // `met: true` here would count every unanswered ticket in the country as a
    // success in any "standard met %" figure built on this function.
    expect(early.met).toBeNull();
    expect(early.note).toMatch(/no response/i);

    const late = await ticketStanding(db, federationAdmin, ticket.id, new Date('2026-08-15T00:00:00Z'));
    expect(late.met).toBe(false);
  });
});

describe('ATTACK: an appeal outcome is a decision, not a draft', () => {
  it('refuses to rewrite an appeal outcome once one is recorded', async () => {
    const c = await raiseCase(db, DISC, { summary: 'Rewritable appeal' }, NOW);
    await scheduleHearing(db, DISC, { caseId: c.id, hearingOn: '2026-09-01' }, NOW);
    await decide(db, DISC, { caseId: c.id, decision: 'Upheld', sanction: 'Warning' }, NOW);
    await appeal(db, DISC, { caseId: c.id, lodgedOn: '2026-09-10' }, NOW);
    await appeal(db, DISC, { caseId: c.id, outcome: 'Appeal dismissed', decidedOn: '2026-10-01' }, NOW);

    await expect(appeal(db, DISC,
      { caseId: c.id, outcome: 'Appeal allowed, sanction quashed', decidedOn: '2026-11-01' }, NOW))
      .rejects.toThrow(/already/i);

    const row = await getDisciplinaryCase(db, federationAdmin, c.id);
    expect(row.appealOutcome).toBe('Appeal dismissed');
    expect(row.appealDecidedOn).toBe('2026-10-01');
  });
});

describe('ATTACK: no injury rule the federation never wrote', () => {
  async function injuredAfterClearance(name: string) {
    const p = await makePerson(name);
    await recordClearance(db, { principal: superAdmin }, {
      personId: p.id, clearanceStatus: 'cleared', recordedOn: '2026-01-01', clearanceValidTo: '2027-01-01',
    }, NOW);
    await recordInjury(db, { principal: superAdmin }, {
      personId: p.id, recordedOn: '2026-06-01', injurySite: 'shoulder',
    }, NOW);
    return p.id;
  }

  it('will not declare a person NOT CLEARED on a rule that was never configured', async () => {
    const id = await injuredAfterClearance('Unconfigured Injury Rule');
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);

    // "An injury lapses a clearance until a return to play is recorded" is a
    // medical policy. It is a defensible one — and it is still MMAKF's to make.
    expect(r.status).toBe('undetermined');
    expect(r.reason).toMatch(/not configured/i);
    expect(r.checks.find((c) => c.rule === 'no_unresolved_injury')!.passed).toBe(false);
    expect(r.checks.find((c) => c.rule === 'no_unresolved_injury')!.detail).toMatch(/not configured/i);
  });

  it('grants nothing on the undetermined state — it is not a clearance', async () => {
    const id = await injuredAfterClearance('Undetermined Grants Nothing');
    const r = await fitnessToCompete(db, superAdmin, id, TODAY);
    expect(r.status).not.toBe('cleared');
  });

  it('applies the rule, and says it applied it, once the federation configures it', async () => {
    const id = await injuredAfterClearance('Configured Injury Rule');
    const r = await fitnessToCompete(db, superAdmin, id, TODAY, { injuryLapsesClearance: true });
    expect(r.status).toBe('not_cleared');
    expect(r.reason).toMatch(/no return to play/i);
  });

  it('honours the opposite configuration just as faithfully', async () => {
    const id = await injuredAfterClearance('Injury Does Not Lapse');
    const r = await fitnessToCompete(db, superAdmin, id, TODAY, { injuryLapsesClearance: false });
    expect(r.status).toBe('cleared');
    expect(r.checks.find((c) => c.rule === 'no_unresolved_injury')!.passed).toBe(true);
  });

  it('carries no clinical text in the undetermined projection either', async () => {
    const p = await makePerson('Undetermined Canary');
    await recordClearance(db, { principal: superAdmin }, {
      personId: p.id, clearanceStatus: 'cleared', recordedOn: '2026-01-01',
    }, NOW);
    await recordInjury(db, { principal: superAdmin }, {
      personId: p.id, recordedOn: '2026-06-01', injurySite: 'left knee',
      summary: 'UNDETERMINED-CLINICAL-CANARY',
    }, NOW);
    const r = await fitnessToCompete(db, superAdmin, p.id, TODAY);
    expect(r.status).toBe('undetermined');
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain('UNDETERMINED-CLINICAL-CANARY');
    expect(dumped).not.toContain('left knee');
  });
});
