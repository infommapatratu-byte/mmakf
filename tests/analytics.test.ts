// Federation analytics, against real Postgres.
//
// The claim these tests defend: EVERY FIGURE IS A COUNT OF ROWS THAT EXIST.
// So the fixture below is hand-built and every expected number is worked out
// from it by hand — never by re-running the module's own query. If an assertion
// here ever has to be "whatever the code returned", the test has stopped being
// evidence.
//
// The second claim: A TOTAL LEAKS AS QUIETLY AS A ROW. Scope isolation is
// asserted on every scoped surface, in both directions — the right numbers for
// your own unit, and a refusal for somebody else's.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  nationalDashboard, stateDashboard, districtDashboard, dojoDashboard,
  growthOverTime, annualReport, dataQuality, AnalyticsError,
} from '../src/db/analytics';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any;
let JH: number, MH: number;
let RMG: number, DHN: number, PUN: number;
let D1: number, D2: number, D3: number;
let P1: number, P2: number, P3: number, P4: number, P5: number;
let SYL: number, G9: number;
let GE1: number, GE2: number;
let EV1: number, EV2: number, CAT1: number, CAT2: number;
let E1: number, E2: number, E3: number;
let CO1: number;

/** The date credential validity is judged against throughout. */
const AS_AT = '2026-08-12';
const NOW = new Date('2026-08-12T09:00:00Z');

const ts = (iso: string) => new Date(`${iso}Z`);

// ─── Principals ─────────────────────────────────────────────────────────────

const superAdmin: Principal = {
  userId: 1, label: 'super-admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const federationAdmin: Principal = {
  userId: 2, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** National reach, but no finance and no safeguarding. */
const technicalDirector: Principal = {
  userId: 3, label: 'technical-director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 8, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

let jhAdmin: Principal, mhAdmin: Principal, rmgAdmin: Principal;
let d1Admin: Principal, d1Instructor: Principal;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // ── Hierarchy ─────────────────────────────────────────────────────────────
  [{ id: JH }] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand State Unit',
    status: 'active', charteredOn: '2026-01-01',
  }).returning({ id: s.stateUnits.id });

  [{ id: MH }] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-MH', state: 'Maharashtra', name: 'Maharashtra State Unit', status: 'active',
  }).returning({ id: s.stateUnits.id });

  [{ id: RMG }] = await db.insert(s.districtUnits).values({
    code: 'MMAKF-DIST-JH-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District Unit',
    status: 'active', charteredOn: '2026-01-05',
  }).returning({ id: s.districtUnits.id });

  [{ id: DHN }] = await db.insert(s.districtUnits).values({
    code: 'MMAKF-DIST-JH-DHN', stateUnitId: JH, district: 'Dhanbad', name: 'Dhanbad District Unit',
    status: 'draft',
  }).returning({ id: s.districtUnits.id });

  [{ id: PUN }] = await db.insert(s.districtUnits).values({
    code: 'MMAKF-DIST-MH-PUN', stateUnitId: MH, district: 'Pune', name: 'Pune District Unit',
    status: 'active',
  }).returning({ id: s.districtUnits.id });

  [{ id: D1 }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-RMG-001', name: 'Patratu Hombu', stateUnitId: JH, districtUnitId: RMG,
    status: 'active', affiliatedOn: '2026-01-10', affiliationExpiresOn: '2026-12-31',
  }).returning({ id: s.dojos.id });

  // Deliberately filed under a state with NO district — a real gap the data
  // quality report must find, and the reason a district total will not sum.
  [{ id: D2 }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-002', name: 'Ranchi Branch', stateUnitId: JH,
    status: 'provisional',
  }).returning({ id: s.dojos.id });

  [{ id: D3 }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-MH-PUN-001', name: 'Pune Dojo', stateUnitId: MH, districtUnitId: PUN,
    status: 'active', affiliatedOn: '2026-02-01',
  }).returning({ id: s.dojos.id });

  // ── People ────────────────────────────────────────────────────────────────
  const person = async (
    federationId: string, fullName: string, over: Record<string, unknown>
  ): Promise<number> => {
    const [r] = await db.insert(s.persons)
      .values({ federationId, fullName, ...over }).returning({ id: s.persons.id });
    return r.id;
  };

  P1 = await person('MMAKF-MEM-2026-000001', 'Anita Kumari', {
    stateUnitId: JH, districtUnitId: RMG, dojoId: D1, status: 'active',
    dob: '2000-01-01', createdAt: ts('2026-01-15T00:00:00'),
  });
  P2 = await person('MMAKF-MEM-2026-000002', 'Rohit Mahto', {
    stateUnitId: JH, districtUnitId: RMG, dojoId: D1, status: 'active',
    dob: null, createdAt: ts('2026-01-20T00:00:00'),
  });
  P3 = await person('MMAKF-MEM-2026-000003', 'Sunil Oraon', {
    stateUnitId: JH, dojoId: D2, status: 'active',
    dob: '2010-05-05', createdAt: ts('2026-03-10T00:00:00'),
  });
  P4 = await person('MMAKF-MEM-2026-000004', 'Meera Joshi', {
    stateUnitId: MH, districtUnitId: PUN, dojoId: D3, status: 'active',
    dob: '1999-09-09', createdAt: ts('2026-03-12T00:00:00'),
  });
  // In a district but no dojo, and not yet active.
  P5 = await person('MMAKF-MEM-2026-000005', 'Pending Applicant', {
    stateUnitId: JH, districtUnitId: RMG, status: 'pending',
    dob: null, createdAt: ts('2026-06-01T00:00:00'),
  });

  await db.update(s.dojos).set({ chiefInstructorPersonId: P3 }).where(eq(s.dojos.id, D1));

  // ── Memberships ───────────────────────────────────────────────────────────
  await db.insert(s.memberships).values([
    { personId: P1, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active' },
    // No end date — never lapses. A planted data-quality gap.
    { personId: P2, category: 'athlete', validFrom: '2026-01-01', validTo: null, status: 'active' },
    { personId: P3, category: 'instructor', validFrom: '2026-02-01', validTo: '2026-12-31', status: 'active' },
    { personId: P4, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active' },
    { personId: P1, category: 'dojo', validFrom: '2025-01-01', validTo: '2025-12-31', status: 'expired' },
  ]);

  // ── Credentials ───────────────────────────────────────────────────────────
  await db.insert(s.instructorQuals).values([
    { personId: P3, level: 'instructor', grantedOn: '2024-01-01', expiresOn: null, status: 'active' },
    // Status still says active; the DATE says otherwise. Must not be counted.
    { personId: P1, level: 'assistant', grantedOn: '2020-01-01', expiresOn: '2025-01-01', status: 'active' },
  ]);
  await db.insert(s.examinerQuals).values({
    personId: P1, level: 'A', scope: 'kyu_low', grantedOn: '2020-01-01', expiresOn: '2027-01-01', status: 'active',
  });
  await db.insert(s.officialQuals).values({
    personId: P4, kind: 'referee', level: 'B', grantedOn: '2023-01-01', expiresOn: null, status: 'active',
  });

  // ── Grading ───────────────────────────────────────────────────────────────
  [{ id: SYL }] = await db.insert(s.syllabusVersions).values({
    code: 'MMAKF-SYL-2026-01', title: 'Syllabus 2026', status: 'active',
  }).returning({ id: s.syllabusVersions.id });
  [{ id: G9 }] = await db.insert(s.gradeDefinitions).values({
    syllabusVersionId: SYL, kind: 'kyu', ordinal: 9, label: '9th Kyu',
  }).returning({ id: s.gradeDefinitions.id });

  [{ id: GE1 }] = await db.insert(s.gradingEvents).values({
    code: 'MMAKF-GRD-2026-000001', title: 'Ramgarh Kyu Grading', syllabusVersionId: SYL,
    status: 'locked', heldOn: '2026-03-01', stateUnitId: JH, districtUnitId: RMG, dojoId: D1,
    createdAt: ts('2026-02-01T00:00:00'),
  }).returning({ id: s.gradingEvents.id });

  [{ id: GE2 }] = await db.insert(s.gradingEvents).values({
    code: 'MMAKF-GRD-2026-000002', title: 'Pune Kyu Grading', syllabusVersionId: SYL,
    status: 'scheduled', heldOn: '2026-09-01', stateUnitId: MH,
    createdAt: ts('2026-04-01T00:00:00'),
  }).returning({ id: s.gradingEvents.id });

  await db.insert(s.gradingCandidates).values([
    { gradingEventId: GE1, personId: P1, gradeDefinitionId: G9, status: 'passed', outcome: 'pass', decidedAt: ts('2026-03-01T10:00:00') },
    { gradingEventId: GE1, personId: P2, gradeDefinitionId: G9, status: 'failed', outcome: 'fail', decidedAt: ts('2026-03-01T10:00:00') },
    { gradingEventId: GE2, personId: P4, gradeDefinitionId: G9, status: 'confirmed' },
  ]);

  await db.insert(s.rankRecords).values([
    { personId: P1, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9, awardedOn: '2026-03-01', status: 'active', gradingEventId: GE1 },
    // Carried over from paper — real, but traceable to no examination.
    { personId: P3, kind: 'kyu', gradeLabel: '8th Kyu', gradeOrdinal: 8, awardedOn: '2020-01-01', status: 'active', gradingEventId: null },
  ]);

  // ── Certificates ──────────────────────────────────────────────────────────
  await db.insert(s.certificates).values([
    {
      certificateNo: 'MMAKF-CERT-2026-000001', kind: 'kyu_grade', personId: P1, title: '9th Kyu',
      issuedOn: '2026-03-05', gradingEventId: GE1, issuingAuthority: 'MMAKF',
      status: 'issued', verifyToken: 'tok-0001', snapshot: {}, createdAt: ts('2026-03-05T00:00:00'),
    },
    {
      // Revoked, and traceable to no grading event.
      certificateNo: 'MMAKF-CERT-2026-000002', kind: 'kyu_grade', personId: P2, title: '9th Kyu',
      issuedOn: '2026-03-05', gradingEventId: null, issuingAuthority: 'MMAKF',
      status: 'revoked', revokedOn: '2026-05-01', revokedReason: 'Issued in error',
      verifyToken: 'tok-0002', snapshot: {}, createdAt: ts('2026-03-05T00:00:00'),
    },
    {
      // Blank verification token — unverifiable by anybody.
      certificateNo: 'MMAKF-CERT-2026-000003', kind: 'course_completion', personId: P4,
      title: 'Referee Course', issuedOn: '2026-04-01', issuingAuthority: 'MMAKF',
      status: 'issued', verifyToken: '   ', snapshot: {}, createdAt: ts('2026-04-01T00:00:00'),
    },
  ]);

  // ── Competition ───────────────────────────────────────────────────────────
  [{ id: EV1 }] = await db.insert(s.competitionEvents).values({
    code: 'MMAKF-EVT-2026-000001', title: 'Jharkhand State Championship', kind: 'state_championship',
    status: 'results_final', startsOn: '2026-02-10', stateUnitId: JH, districtUnitId: RMG,
    resultsFinalisedAt: ts('2026-02-12T18:00:00'), createdAt: ts('2026-01-05T00:00:00'),
  }).returning({ id: s.competitionEvents.id });

  [{ id: EV2 }] = await db.insert(s.competitionEvents).values({
    code: 'MMAKF-EVT-2026-000002', title: 'Pune Open', kind: 'open_national',
    status: 'published', startsOn: '2026-07-01', stateUnitId: MH, districtUnitId: PUN,
    createdAt: ts('2026-05-05T00:00:00'),
  }).returning({ id: s.competitionEvents.id });

  [{ id: CAT1 }] = await db.insert(s.eventCategories).values({
    eventId: EV1, code: 'CAD-F-KAT', label: 'Cadet Female Kata', discipline: 'kata',
  }).returning({ id: s.eventCategories.id });
  [{ id: CAT2 }] = await db.insert(s.eventCategories).values({
    eventId: EV2, code: 'SEN-F-KAT', label: 'Senior Female Kata', discipline: 'kata',
  }).returning({ id: s.eventCategories.id });

  [{ id: E1 }] = await db.insert(s.eventEntries).values({
    entryNo: 'MMAKF-ENT-2026-000001', eventId: EV1, categoryId: CAT1, personId: P1,
    dojoId: D1, stateUnitId: JH, status: 'confirmed', createdAt: ts('2026-01-20T00:00:00'),
  }).returning({ id: s.eventEntries.id });
  [{ id: E2 }] = await db.insert(s.eventEntries).values({
    entryNo: 'MMAKF-ENT-2026-000002', eventId: EV1, categoryId: CAT1, personId: P2,
    dojoId: D1, stateUnitId: JH, status: 'confirmed', createdAt: ts('2026-01-21T00:00:00'),
  }).returning({ id: s.eventEntries.id });
  [{ id: E3 }] = await db.insert(s.eventEntries).values({
    entryNo: 'MMAKF-ENT-2026-000003', eventId: EV2, categoryId: CAT2, personId: P4,
    dojoId: D3, stateUnitId: MH, status: 'draft', createdAt: ts('2026-05-10T00:00:00'),
  }).returning({ id: s.eventEntries.id });

  const [draw] = await db.insert(s.draws).values({
    categoryId: CAT1, format: 'kata_flag', entryCount: 2, algorithmVersion: 'v1',
  }).returning({ id: s.draws.id });

  await db.insert(s.matches).values([
    {
      drawId: draw.id, categoryId: CAT1, eventId: EV1, matchNo: 'M1', round: 'F',
      redEntryId: E1, blueEntryId: E2, status: 'completed', winnerEntryId: E1,
      endedAt: ts('2026-02-10T12:00:00'), createdAt: ts('2026-02-01T00:00:00'),
    },
    {
      drawId: draw.id, categoryId: CAT1, eventId: EV1, matchNo: 'M2', round: 'F',
      status: 'scheduled', createdAt: ts('2026-02-01T00:00:00'),
    },
  ]);

  await db.insert(s.competitionResults).values([
    { eventId: EV1, categoryId: CAT1, entryId: E1, personId: P1, placing: 1, medal: 'gold', status: 'final', finalisedAt: ts('2026-02-12T18:00:00'), createdAt: ts('2026-02-12T18:00:00') },
    { eventId: EV1, categoryId: CAT1, entryId: E2, personId: P2, placing: 2, medal: 'silver', status: 'final', finalisedAt: ts('2026-02-12T18:00:00'), createdAt: ts('2026-02-12T18:00:00') },
    // Attached to no person — it can never reach a passport or a ranking.
    { eventId: EV2, categoryId: CAT2, entryId: E3, personId: null, placing: 1, medal: 'gold', status: 'provisional', createdAt: ts('2026-07-02T00:00:00') },
  ]);

  // ── Academy ───────────────────────────────────────────────────────────────
  [{ id: CO1 }] = await db.insert(s.courses).values({
    slug: 'shotokan-foundations', title: 'Shotokan Foundations', status: 'published',
    publishedAt: ts('2026-02-01T00:00:00'), createdAt: ts('2026-01-01T00:00:00'),
  }).returning({ id: s.courses.id });
  await db.insert(s.courses).values({ slug: 'referee-level-1', title: 'Referee Level 1', status: 'draft' });

  await db.insert(s.enrolments).values([
    { courseId: CO1, personId: P1, status: 'active', enrolledAt: ts('2026-03-01T00:00:00') },
    { courseId: CO1, personId: P4, status: 'completed', enrolledAt: ts('2026-03-02T00:00:00'), completedAt: ts('2026-06-01T00:00:00') },
  ]);

  // ── Support and cases ─────────────────────────────────────────────────────
  await db.insert(s.supportTickets).values([
    { ticketNo: 'MMAKF-TKT-000001', category: 'membership', subject: 'Card', body: '…', raisedByPersonId: P1, status: 'open', createdAt: ts('2026-04-01T00:00:00') },
    { ticketNo: 'MMAKF-TKT-000002', category: 'membership', subject: 'Fee', body: '…', raisedByPersonId: P4, status: 'resolved', createdAt: ts('2026-04-02T00:00:00'), resolvedAt: ts('2026-04-05T00:00:00') },
    // Raised by nobody on the register — counts nationally, but belongs to no unit.
    { ticketNo: 'MMAKF-TKT-000003', category: 'general', subject: 'Enquiry', body: '…', raisedByPersonId: null, status: 'open', createdAt: ts('2026-04-03T00:00:00') },
  ]);

  await db.insert(s.disciplinaryCases).values([
    { caseNo: 'MMAKF-DISC-000001', summary: 'Conduct', receivedOn: '2026-02-01', subjectPersonId: P1, status: 'under_investigation', createdAt: ts('2026-02-01T00:00:00') },
    { caseNo: 'MMAKF-DISC-000002', summary: 'Conduct', receivedOn: '2026-01-01', subjectPersonId: P4, status: 'closed', closedOn: '2026-03-01', createdAt: ts('2026-01-01T00:00:00') },
  ]);

  await db.insert(s.safeguardingCases).values({
    caseNo: 'MMAKF-SG-000001', concernSummary: 'Concern raised', receivedOn: '2026-05-01',
    subjectPersonId: P2, status: 'triage', referredToAuthority: true, referredOn: '2026-05-02',
  });

  // ── Ledger ────────────────────────────────────────────────────────────────
  await db.insert(s.ledgerEntries).values([
    { account: 'membership_income', direction: 'credit', amountPaise: 50_000, description: 'Membership', occurredOn: '2026-01-15' },
    { account: 'gateway_fees', direction: 'debit', amountPaise: 1_180, description: 'Gateway fee', occurredOn: '2026-01-15' },
    { account: 'shop_income', direction: 'credit', amountPaise: 25_000, description: 'Shop', occurredOn: '2026-06-01' },
  ]);

  jhAdmin = { userId: 4, label: 'jh-admin', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }] };
  mhAdmin = { userId: 5, label: 'mh-admin', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: MH }] };
  rmgAdmin = { userId: 6, label: 'rmg-admin', bindings: [{ role: 'DISTRICT_ADMIN', scopeType: 'district', scopeId: RMG }] };
  d1Admin = { userId: 7, label: 'd1-admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: D1 }] };
  d1Instructor = { userId: 9, label: 'd1-instructor', bindings: [{ role: 'INSTRUCTOR', scopeType: 'dojo', scopeId: D1 }] };
});

// ─── National dashboard ─────────────────────────────────────────────────────

describe('nationalDashboard: every figure is a count of rows that exist', () => {
  it('matches the hand-inserted fixture exactly', async () => {
    const d = await nationalDashboard(db, federationAdmin, { asAt: AS_AT, now: NOW });
    const c = d.counts;

    expect(c.people).toBe(5);
    expect(c.peopleActive).toBe(4);
    expect(c.membersActive).toBe(4);
    expect(c.athletes).toBe(3);

    // Credential validity is date-aware: P1's instructor row still says
    // 'active' but expired in 2025, so only P3 counts.
    expect(c.instructors).toBe(1);
    expect(c.examiners).toBe(1);
    expect(c.officials).toBe(1);

    expect(c.stateUnits).toBe(2);
    expect(c.stateUnitsActive).toBe(2);
    expect(c.districtUnits).toBe(3);
    expect(c.districtUnitsActive).toBe(2);
    expect(c.dojos).toBe(3);

    expect(c.gradingEvents).toBe(2);
    expect(c.gradingsHeld).toBe(1);
    expect(c.gradingCandidates).toBe(3);
    expect(c.gradingCandidatesPassed).toBe(1);

    expect(c.certificates).toBe(3);
    expect(c.certificatesInIssue).toBe(2);
    expect(c.certificatesRevoked).toBe(1);

    expect(c.competitionEvents).toBe(2);
    expect(c.entries).toBe(3);
    expect(c.entriesConfirmed).toBe(2);
    expect(c.matches).toBe(2);
    expect(c.matchesCompleted).toBe(1);
    expect(c.resultsFinal).toBe(2);

    expect(c.courses).toBe(2);
    expect(c.coursesPublished).toBe(1);
    expect(c.enrolments).toBe(2);
    expect(c.enrolmentsActive).toBe(1);
    expect(c.enrolmentsCompleted).toBe(1);

    // T3 was raised by nobody on the register; it is still an open ticket.
    expect(c.openSupportTickets).toBe(2);
    expect(d.openCasesByKind.disciplinary).toBe(1);
  });

  it('reports every status the enum allows, zero included, never a gap', async () => {
    const d = await nationalDashboard(db, federationAdmin, { asAt: AS_AT, now: NOW });

    expect(Object.keys(d.dojosByStatus).sort()).toEqual([...s.unitStatus.enumValues].sort());
    expect(d.dojosByStatus).toMatchObject({
      draft: 0, provisional: 1, active: 2, suspended: 0, expired: 0, revoked: 0,
    });

    expect(Object.keys(d.eventsByStatus).length).toBe(s.eventStatus.enumValues.length);
    expect(d.eventsByStatus.results_final).toBe(1);
    expect(d.eventsByStatus.published).toBe(1);
    // A status nobody is in is 0, present, and not missing.
    expect(d.eventsByStatus.cancelled).toBe(0);
    expect('cancelled' in d.eventsByStatus).toBe(true);
  });

  it('gives every returned figure a table and a filter', async () => {
    const d = await nationalDashboard(db, federationAdmin, { asAt: AS_AT, now: NOW });
    for (const key of Object.keys(d.counts)) {
      expect(d.sources[key], `no source for ${key}`).toBeTruthy();
      expect(d.sources[key].table.length).toBeGreaterThan(0);
      expect(d.sources[key].filter.length).toBeGreaterThan(0);
    }
    expect(d.sources.gradingsHeld.filter).toMatch(/status = 'locked'/);
    expect(d.sources.athletes.filter).toMatch(/category = 'athlete'/);
  });

  it('refuses a caller with no national binding', async () => {
    await expect(nationalDashboard(db, jhAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(nationalDashboard(db, d1Admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(nationalDashboard(db, athlete)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(nationalDashboard(db, null as any)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('safeguarding counts are withheld, not merely hidden', () => {
  it('withholds the count from a national admin who cannot read the cases', async () => {
    const d = await nationalDashboard(db, federationAdmin, { asAt: AS_AT, now: NOW });
    expect(d.openCasesByKind.safeguarding).toBeUndefined();
    expect('openCases.safeguarding' in d.counts).toBe(false);

    const w = d.withheld.find((x) => x.key === 'openCases.safeguarding');
    expect(w).toBeTruthy();
    expect(w!.reason).toBe('not_authorised');
    expect(w!.detail).toMatch(/safeguarding:read/);
  });

  it('reports it to a principal who may read safeguarding casework', async () => {
    const d = await nationalDashboard(db, superAdmin, { asAt: AS_AT, now: NOW });
    expect(d.openCasesByKind.safeguarding).toBe(1);
    expect(d.withheld.find((x) => x.key === 'openCases.safeguarding')).toBeUndefined();
  });
});

// ─── Scope isolation ────────────────────────────────────────────────────────

describe('a total leaks as quietly as a row', () => {
  it('gives a state admin their own state and nobody else’s', async () => {
    const d = await stateDashboard(db, jhAdmin, JH, { asAt: AS_AT, now: NOW });
    expect(d.scope).toMatchObject({ kind: 'state', stateUnitId: JH });

    expect(d.counts.people).toBe(4);        // P1, P2, P3, P5 — not P4
    expect(d.counts.peopleActive).toBe(3);
    expect(d.counts.membersActive).toBe(3);
    expect(d.counts.athletes).toBe(2);
    expect(d.counts.instructors).toBe(1);
    expect(d.counts.examiners).toBe(1);
    expect(d.counts.officials).toBe(0);     // the only official is in Maharashtra
    expect(d.counts.stateUnits).toBe(1);
    expect(d.counts.districtUnits).toBe(2);
    expect(d.counts.districtUnitsActive).toBe(1);
    expect(d.counts.dojos).toBe(2);
    expect(d.counts.gradingEvents).toBe(1);
    expect(d.counts.certificates).toBe(2);
    expect(d.counts.certificatesRevoked).toBe(1);
    expect(d.counts.competitionEvents).toBe(1);
    expect(d.counts.entries).toBe(2);
    expect(d.counts.matches).toBe(2);
    expect(d.counts.resultsFinal).toBe(2);
    expect(d.counts.enrolments).toBe(1);
    expect(d.counts.openSupportTickets).toBe(1);   // the anonymous ticket is not theirs
    expect(d.dojosByStatus).toMatchObject({ active: 1, provisional: 1, revoked: 0 });
  });

  it('ATTACK: refuses a state admin reading another state’s totals', async () => {
    await expect(stateDashboard(db, jhAdmin, MH)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stateDashboard(db, mhAdmin, JH)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('ATTACK: refuses a district admin reading a district outside their scope', async () => {
    await expect(districtDashboard(db, rmgAdmin, PUN)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(districtDashboard(db, mhAdmin, RMG)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('ATTACK: refuses a dojo admin reading another dojo’s totals', async () => {
    await expect(dojoDashboard(db, d1Admin, D3)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dojoDashboard(db, d1Admin, D2)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets authority flow downward: a state admin may read a district inside their state', async () => {
    const d = await districtDashboard(db, jhAdmin, RMG, { asAt: AS_AT, now: NOW });
    expect(d.counts.people).toBe(3);        // P1, P2, P5
    expect(d.counts.peopleActive).toBe(2);
    expect(d.counts.dojos).toBe(1);
    expect(d.counts.competitionEvents).toBe(1);
    expect(d.counts.matches).toBe(2);
    expect(d.counts.instructors).toBe(0);   // P3 is in the state but no district
  });

  it('gives a dojo admin and an instructor the same view of their own dojo', async () => {
    const a = await dojoDashboard(db, d1Admin, D1, { asAt: AS_AT, now: NOW });
    const b = await dojoDashboard(db, d1Instructor, D1, { asAt: AS_AT, now: NOW });
    expect(a.counts).toEqual(b.counts);

    expect(a.counts.people).toBe(2);
    expect(a.counts.entries).toBe(2);
    expect(a.counts.gradingEvents).toBe(1);
    expect(a.counts.certificates).toBe(2);
    expect(a.counts.dojos).toBe(1);
    expect(a.counts.districtUnits).toBe(1);
  });

  it('measures a dojo with no district as a real zero from the database', async () => {
    const d = await dojoDashboard(db, jhAdmin, D2, { asAt: AS_AT, now: NOW });
    expect(d.counts.districtUnits).toBe(0);
    expect(d.counts.districtUnitsActive).toBe(0);
    expect(d.counts.people).toBe(1);        // P3
  });

  it('scoped totals sum to the national total — nothing is double-counted or lost', async () => {
    const nat = await nationalDashboard(db, federationAdmin, { asAt: AS_AT, now: NOW });
    const jh = await stateDashboard(db, federationAdmin, JH, { asAt: AS_AT, now: NOW });
    const mh = await stateDashboard(db, federationAdmin, MH, { asAt: AS_AT, now: NOW });

    // Every fixture person carries a state, so the states must account for all.
    expect(jh.counts.people + mh.counts.people).toBe(nat.counts.people);
    expect(jh.counts.dojos + mh.counts.dojos).toBe(nat.counts.dojos);
    expect(jh.counts.certificates + mh.counts.certificates).toBe(nat.counts.certificates);
  });

  it('refuses an unknown unit rather than returning an empty dashboard', async () => {
    await expect(stateDashboard(db, federationAdmin, 999_999)).rejects.toThrow(AnalyticsError);
    await expect(dojoDashboard(db, federationAdmin, 999_999)).rejects.toThrow(/Unknown dojo/);
  });
});

describe('a figure that cannot be narrowed is withheld, never substituted', () => {
  it('withholds federation-wide academy figures from a scoped dashboard', async () => {
    const d = await stateDashboard(db, jhAdmin, JH, { asAt: AS_AT, now: NOW });
    expect('courses' in d.counts).toBe(false);
    const w = d.withheld.find((x) => x.key === 'courses')!;
    expect(w.reason).toBe('not_scopable');
    expect(w.detail).toMatch(/federation-wide/);
  });

  it('withholds entries from a district, because an entry declares no district', async () => {
    const d = await districtDashboard(db, jhAdmin, RMG, { asAt: AS_AT, now: NOW });
    expect('entries' in d.counts).toBe(false);
    expect(d.withheld.find((x) => x.key === 'entries')!.detail).toMatch(/no district unit/);
  });

  it('withholds event and match figures from a dojo, because an event records no dojo', async () => {
    const d = await dojoDashboard(db, d1Admin, D1, { asAt: AS_AT, now: NOW });
    for (const key of ['competitionEvents', 'matches', 'matchesCompleted', 'eventsByStatus']) {
      expect(key in d.counts, `${key} should not be reported`).toBe(false);
      expect(d.withheld.find((x) => x.key === key), `${key} should be declared withheld`).toBeTruthy();
    }
    expect(d.eventsByStatus).toEqual({});
  });
});

// ─── Growth over time ───────────────────────────────────────────────────────

describe('growthOverTime returns a series with no gaps', () => {
  it('emits an explicit zero for a period in which nothing happened', async () => {
    const g = await growthOverTime(db, federationAdmin, {
      metric: 'persons', fromDate: '2026-01-01', toDate: '2026-06-30', granularity: 'month',
    });
    expect(g.buckets).toEqual([
      { bucket: '2026-01-01', count: 2 },
      { bucket: '2026-02-01', count: 0 },
      { bucket: '2026-03-01', count: 2 },
      { bucket: '2026-04-01', count: 0 },
      { bucket: '2026-05-01', count: 0 },
      { bucket: '2026-06-01', count: 1 },
    ]);
    expect(g.total).toBe(5);
    expect(g.source).toMatchObject({ table: 'persons', column: 'created_at' });
  });

  it('returns explicit zero buckets for a period with no rows at all', async () => {
    const g = await growthOverTime(db, federationAdmin, {
      metric: 'persons', fromDate: '2027-01-01', toDate: '2027-03-31', granularity: 'month',
    });
    expect(g.buckets).toEqual([
      { bucket: '2027-01-01', count: 0 },
      { bucket: '2027-02-01', count: 0 },
      { bucket: '2027-03-01', count: 0 },
    ]);
    expect(g.total).toBe(0);
  });

  it('buckets by day, including the last day of the range', async () => {
    const g = await growthOverTime(db, federationAdmin, {
      metric: 'persons', fromDate: '2026-01-15', toDate: '2026-01-20', granularity: 'day',
    });
    expect(g.buckets.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(g.buckets[0].bucket).toBe('2026-01-15');
    expect(g.buckets[5].bucket).toBe('2026-01-20');
  });

  it('buckets by week on Mondays, agreeing with date_trunc', async () => {
    const g = await growthOverTime(db, federationAdmin, {
      metric: 'persons', fromDate: '2026-01-12', toDate: '2026-01-20', granularity: 'week',
    });
    // 15 Jan 2026 is a Thursday, 20 Jan a Tuesday — different ISO weeks.
    expect(g.buckets).toEqual([
      { bucket: '2026-01-12', count: 1 },
      { bucket: '2026-01-19', count: 1 },
    ]);
  });

  it('buckets by year', async () => {
    const g = await growthOverTime(db, federationAdmin, {
      metric: 'certificates', fromDate: '2025-01-01', toDate: '2026-12-31', granularity: 'year',
    });
    expect(g.buckets).toEqual([
      { bucket: '2025-01-01', count: 0 },
      { bucket: '2026-01-01', count: 3 },
    ]);
  });

  it('applies scope in SQL, and refuses a scope the caller does not hold', async () => {
    const jh = await growthOverTime(db, jhAdmin, {
      metric: 'persons', fromDate: '2026-01-01', toDate: '2026-06-30',
      granularity: 'month', scope: { kind: 'state', id: JH },
    });
    expect(jh.total).toBe(4);                       // P1, P2, P3, P5 — not P4
    expect(jh.buckets.find((b) => b.bucket === '2026-03-01')!.count).toBe(1);

    await expect(growthOverTime(db, jhAdmin, {
      metric: 'persons', fromDate: '2026-01-01', toDate: '2026-06-30',
      granularity: 'month', scope: { kind: 'state', id: MH },
    })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(growthOverTime(db, jhAdmin, {
      metric: 'persons', fromDate: '2026-01-01', toDate: '2026-06-30', granularity: 'month',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses rather than answers when a metric cannot be narrowed to the scope', async () => {
    await expect(growthOverTime(db, d1Admin, {
      metric: 'competition_events', fromDate: '2026-01-01', toDate: '2026-12-31',
      granularity: 'month', scope: { kind: 'dojo', id: D1 },
    })).rejects.toThrow(/cannot be reported for a dojo/);
  });

  it('rejects bad input with a machine-readable code instead of guessing', async () => {
    const bad = async (input: any) => {
      try {
        await growthOverTime(db, federationAdmin, input);
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(AnalyticsError);
        return e.code as string;
      }
    };
    expect(await bad({ metric: 'nope', fromDate: '2026-01-01', toDate: '2026-12-31', granularity: 'month' })).toBe('unknown_metric');
    expect(await bad({ metric: 'persons', fromDate: '2026-01-01', toDate: '2026-12-31', granularity: 'fortnight' })).toBe('unknown_granularity');
    expect(await bad({ metric: 'persons', fromDate: '01/01/2026', toDate: '2026-12-31', granularity: 'month' })).toBe('bad_date');
    expect(await bad({ metric: 'persons', fromDate: '2026-12-31', toDate: '2026-01-01', granularity: 'month' })).toBe('bad_range');
  });
});

// ─── Annual report ──────────────────────────────────────────────────────────

describe('annualReport: every figure carries the query that produced it', () => {
  const section = (r: any, key: string) => r.sections.find((x: any) => x.key === key)!;
  const value = (r: any, sec: string, fig: string) =>
    section(r, sec).figures.find((f: any) => f.key === fig)!.value;

  it('reports the 2026 figures the fixture actually contains', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    expect(r.periodFrom).toBe('2026-01-01');
    expect(r.periodTo).toBe('2026-12-31');

    expect(value(r, 'membership', 'newRegistrations')).toBe(5);
    expect(value(r, 'membership', 'membershipsBeginning')).toBe(4);
    expect(value(r, 'membership', 'membershipsActiveAtYearEnd')).toBe(4);
    expect(value(r, 'membership', 'membershipsLapsingInYear')).toBe(3);

    expect(value(r, 'units', 'stateUnitsChartered')).toBe(1);
    expect(value(r, 'units', 'districtUnitsChartered')).toBe(1);
    expect(value(r, 'units', 'dojosAffiliated')).toBe(2);
    expect(value(r, 'units', 'dojoAffiliationsExpiring')).toBe(1);

    expect(value(r, 'gradings', 'gradingsHeldOn')).toBe(2);
    expect(value(r, 'gradings', 'gradingsLocked')).toBe(1);
    expect(value(r, 'gradings', 'candidatesDecided')).toBe(2);
    expect(value(r, 'gradings', 'candidatesPassed')).toBe(1);
    expect(value(r, 'gradings', 'candidatesFailed')).toBe(1);
    expect(value(r, 'gradings', 'candidatesReferred')).toBe(0);

    expect(value(r, 'certificates', 'issued')).toBe(3);
    expect(value(r, 'certificates', 'revoked')).toBe(1);

    expect(value(r, 'events', 'eventsStarting')).toBe(2);
    expect(value(r, 'events', 'eventsResultsFinal')).toBe(1);
    expect(value(r, 'events', 'entriesReceived')).toBe(3);
    expect(value(r, 'events', 'matchesCompleted')).toBe(1);

    expect(value(r, 'results', 'finalResults')).toBe(2);
    expect(value(r, 'results', 'gold')).toBe(1);
    expect(value(r, 'results', 'silver')).toBe(1);
    expect(value(r, 'results', 'bronze')).toBe(0);

    expect(value(r, 'education', 'coursesPublished')).toBe(1);
    expect(value(r, 'education', 'enrolments')).toBe(2);
    expect(value(r, 'education', 'completions')).toBe(1);

    expect(value(r, 'cases', 'disciplinaryReceived')).toBe(2);
    expect(value(r, 'cases', 'disciplinaryClosed')).toBe(1);
    expect(value(r, 'cases', 'supportTicketsRaised')).toBe(3);
    expect(value(r, 'cases', 'supportTicketsResolved')).toBe(1);
  });

  it('attributes medals to the state the entry declared', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    const sec = section(r, 'medalsByState');
    expect(sec.status).toBe('reported');
    expect(sec.rows).toEqual([
      { stateUnitId: JH, state: 'Jharkhand State Unit', gold: 1, silver: 1, bronze: 0, total: 2 },
    ]);
    // The provisional Maharashtra gold is not a result the federation stands behind.
    expect(value(r, 'medalsByState', 'medalsCounted')).toBe(2);
  });

  it('carries a table, a column and a filter on EVERY figure in EVERY section', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    expect(r.sections.length).toBeGreaterThan(8);
    for (const sec of r.sections) {
      expect(sec.figures.length, `${sec.key} has no figures`).toBeGreaterThan(0);
      for (const f of sec.figures) {
        expect(f.source.table, `${sec.key}.${f.key} has no table`).toBeTruthy();
        expect(f.source.filter, `${sec.key}.${f.key} has no filter`).toBeTruthy();
        expect(f.source.column, `${sec.key}.${f.key} has no column`).toBeTruthy();
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
    const passed = section(r, 'gradings').figures.find((f: any) => f.key === 'candidatesPassed')!;
    expect(passed.source).toMatchObject({ table: 'grading_candidates', column: 'decided_at' });
    expect(passed.source.filter).toMatch(/decided_at within 2026 and outcome = 'pass'/);
  });

  it('reports finance in integer paise, straight from the ledger', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    expect(value(r, 'finance', 'creditsPaise')).toBe(75_000);
    expect(value(r, 'finance', 'debitsPaise')).toBe(1_180);
    expect(value(r, 'finance', 'entries')).toBe(3);
    expect(Number.isInteger(value(r, 'finance', 'creditsPaise'))).toBe(true);

    expect(section(r, 'finance').rows).toEqual([
      { account: 'gateway_fees', direction: 'debit', amountPaise: 1_180, entries: 1 },
      { account: 'membership_income', direction: 'credit', amountPaise: 50_000, entries: 1 },
      { account: 'shop_income', direction: 'credit', amountPaise: 25_000, entries: 1 },
    ]);
  });

  it('withholds sections the reader may not see, and nulls their values', async () => {
    const r = await annualReport(db, technicalDirector, 2026, { now: NOW });

    const fin = section(r, 'finance');
    expect(fin.status).toBe('withheld');
    expect(fin.note).toMatch(/finance:read/);
    expect(fin.figures.every((f: any) => f.value === null)).toBe(true);
    expect(fin.rows).toEqual([]);

    const sg = section(r, 'safeguarding');
    expect(sg.status).toBe('withheld');
    expect(sg.note).toMatch(/safeguarding:read/);
    expect(sg.figures.every((f: any) => f.value === null)).toBe(true);

    // The rest of the report is unaffected.
    expect(value(r, 'certificates', 'issued')).toBe(3);
  });

  it('reports safeguarding to a principal who may read it', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    expect(section(r, 'safeguarding').status).toBe('reported');
    expect(value(r, 'safeguarding', 'received')).toBe(1);
    expect(value(r, 'safeguarding', 'closed')).toBe(0);
    expect(value(r, 'safeguarding', 'referredToAuthority')).toBe(1);
  });

  it('says "no records for this period" rather than printing a plausible zero', async () => {
    const r = await annualReport(db, superAdmin, 2019, { now: NOW });

    for (const sec of r.sections) {
      if (sec.status === 'withheld') continue;
      expect(sec.status, `${sec.key} should have no records for 2019`).toBe('no_records');
      expect(sec.note).toBe('No records for this period.');
      expect(sec.rows).toEqual([]);
      // NOT zero. A printed 0 reads as a measurement; null reads as absence.
      for (const f of sec.figures) {
        expect(f.value, `${sec.key}.${f.key} should be null, not 0`).toBeNull();
        // The source survives, so a reader can check the emptiness themselves.
        expect(f.source.table).toBeTruthy();
      }
    }
  });

  it('keeps a zero inside a section that DID have records — that zero is a measurement', async () => {
    const r = await annualReport(db, superAdmin, 2026, { now: NOW });
    expect(section(r, 'gradings').status).toBe('reported');
    expect(value(r, 'gradings', 'candidatesReferred')).toBe(0);
    expect(value(r, 'results', 'bronze')).toBe(0);
  });

  it('is national, and refuses anyone without national reach', async () => {
    await expect(annualReport(db, jhAdmin, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(annualReport(db, d1Admin, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(annualReport(db, athlete, 2026)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a year that is not a year', async () => {
    await expect(annualReport(db, superAdmin, 2026.5)).rejects.toThrow(AnalyticsError);
    await expect(annualReport(db, superAdmin, 26 as any)).rejects.toThrow(/four-digit year/);
  });
});

// ─── Data quality ───────────────────────────────────────────────────────────

describe('dataQuality finds the gaps that were deliberately planted', () => {
  const item = (r: any, key: string) => r.items.find((x: any) => x.key === key)!;

  it('counts every planted gap exactly, against the population it measured', async () => {
    const r = await dataQuality(db, superAdmin, { kind: 'national' }, { now: NOW });

    expect(item(r, 'personsWithoutDateOfBirth')).toMatchObject({ count: 2, total: 5 });
    expect(item(r, 'personsWithoutDojo')).toMatchObject({ count: 1, total: 5 });
    expect(item(r, 'activeRanksWithoutGradingEvent')).toMatchObject({ count: 1, total: 2 });
    expect(item(r, 'dojosWithoutChiefInstructor')).toMatchObject({ count: 2, total: 3 });
    expect(item(r, 'dojosWithoutDistrictUnit')).toMatchObject({ count: 1, total: 3 });
    expect(item(r, 'certificatesWithoutVerifyToken')).toMatchObject({ count: 1, total: 3 });
    expect(item(r, 'gradeCertificatesWithoutGradingEvent')).toMatchObject({ count: 1, total: 2 });
    expect(item(r, 'resultsWithoutPerson')).toMatchObject({ count: 1, total: 3 });
    expect(item(r, 'activeMembershipsWithoutExpiry')).toMatchObject({ count: 1, total: 4 });
  });

  it('finds a blank verification token, which is the only gap the NOT NULL column allows', async () => {
    const r = await dataQuality(db, superAdmin, { kind: 'national' }, { now: NOW });
    const it0 = item(r, 'certificatesWithoutVerifyToken');
    expect(it0.count).toBe(1);
    expect(it0.source.filter).toMatch(/btrim/);
    expect(it0.description).toMatch(/cannot be verified/);
  });

  it('explains every check in words, not just as a column name', async () => {
    const r = await dataQuality(db, superAdmin, { kind: 'national' }, { now: NOW });
    expect(r.items.length).toBeGreaterThanOrEqual(9);
    for (const i of r.items) {
      expect(i.description.length).toBeGreaterThan(30);
      expect(i.source.table).toBeTruthy();
      expect(i.source.filter).toBeTruthy();
      expect(i.count).toBeLessThanOrEqual(i.total);
    }
  });

  it('scopes to a state, and refuses another state', async () => {
    const r = await dataQuality(db, jhAdmin, { kind: 'state', id: JH }, { now: NOW });
    expect(item(r, 'personsWithoutDateOfBirth')).toMatchObject({ count: 2, total: 4 });
    expect(item(r, 'personsWithoutDojo')).toMatchObject({ count: 1, total: 4 });
    expect(item(r, 'dojosWithoutChiefInstructor')).toMatchObject({ count: 1, total: 2 });
    expect(item(r, 'gradeCertificatesWithoutGradingEvent')).toMatchObject({ count: 1, total: 2 });
    expect(item(r, 'certificatesWithoutVerifyToken')).toMatchObject({ count: 0, total: 2 });
    expect(item(r, 'resultsWithoutPerson')).toMatchObject({ count: 0, total: 2 });
    expect(item(r, 'activeMembershipsWithoutExpiry')).toMatchObject({ count: 1, total: 3 });

    await expect(dataQuality(db, jhAdmin, { kind: 'state', id: MH })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('withholds a check it cannot narrow, rather than reporting the national figure', async () => {
    const r = await dataQuality(db, jhAdmin, { kind: 'district', id: RMG }, { now: NOW });
    expect(r.items.find((x: any) => x.key === 'resultsWithoutPerson')).toBeUndefined();
    const w = r.withheld.find((x: any) => x.key === 'resultsWithoutPerson')!;
    expect(w.reason).toBe('not_scopable');
    expect(w.detail).toMatch(/district/);
  });
});
