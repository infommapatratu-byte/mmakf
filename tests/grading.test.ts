// The grading chain, against real Postgres.
//
// The invariant these tests exist to protect: NO CERTIFICATE CAN EXIST THAT IS
// NOT TRACEABLE TO AN EXAMINATION. Everything else here supports that claim.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  checkEligibility, applyForGrading, assignExaminer, recordScore, summariseScores,
  decideCandidate, issueGradeCertificate, lockGrading, recordLegacyGrade,
  verifyCredential, revokeCertificate, publicRegister, GradingError,
} from '../src/db/grading';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, DOJO: number, SYL: number;
let GRADE_9KYU: number, GRADE_8KYU: number, DAN1: number;
let EXAMINER_P: number, LAPSED_P: number, OBSERVER_P: number;

const NOW = new Date('2026-08-12T00:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const technical: Principal = {
  userId: 2, label: 'technical-director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 3, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const examinerOnly: Principal = {
  userId: 4, label: 'examiner',
  bindings: [{ role: 'EXAMINER', scopeType: 'national', scopeId: null }],
};

async function makePerson(name: string, over: Record<string, unknown> = {}) {
  return createPerson(db, { principal: national }, {
    fullName: name, stateUnitId: JH, dojoId: DOJO, ...over,
  } as any);
}

/** A grading event ready to take candidates. */
async function makeGrading(over: Record<string, unknown> = {}) {
  const [ev] = await db.insert(s.gradingEvents).values({
    code: `MMAKF-GRD-2026-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Kyu Grading',
    syllabusVersionId: SYL,
    status: 'registration_open',
    heldOn: '2026-08-12',
    ...over,
  }).returning();
  return ev;
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

  const [syl] = await db.insert(s.syllabusVersions).values({
    code: 'MMAKF-SYL-2026-01', title: 'Syllabus 2026', status: 'active', effectiveFrom: '2026-01-01',
  }).returning({ id: s.syllabusVersions.id });
  SYL = syl.id;

  // Grade definitions. Note 8th Kyu carries REAL configured rules; 9th Kyu
  // carries none — proving an unset rule is simply not checked.
  const [g9] = await db.insert(s.gradeDefinitions).values({
    syllabusVersionId: SYL, kind: 'kyu', ordinal: 9, label: '9th Kyu', beltColour: 'Orange',
  }).returning({ id: s.gradeDefinitions.id });
  GRADE_9KYU = g9.id;

  const [g8] = await db.insert(s.gradeDefinitions).values({
    syllabusVersionId: SYL, kind: 'kyu', ordinal: 8, label: '8th Kyu', beltColour: 'Red',
    previousGradeOrdinal: 9, minMonthsSincePrevious: 3, minAgeYears: 8,
  }).returning({ id: s.gradeDefinitions.id });
  GRADE_8KYU = g8.id;

  const [d1] = await db.insert(s.gradeDefinitions).values({
    syllabusVersionId: SYL, kind: 'dan', ordinal: 1, label: 'Shodan',
    requiresNationalApproval: true,
  }).returning({ id: s.gradeDefinitions.id });
  DAN1 = d1.id;

  // Examiners: one licensed, one lapsed, one with no licence at all.
  const ex = await makePerson('Licensed Examiner');
  EXAMINER_P = ex.id;
  await db.insert(s.examinerQuals).values({
    personId: EXAMINER_P, level: 'A', scope: 'kyu_low', grantedOn: '2020-01-01',
    expiresOn: '2027-01-01', status: 'active',
  });

  const lapsed = await makePerson('Lapsed Examiner');
  LAPSED_P = lapsed.id;
  await db.insert(s.examinerQuals).values({
    personId: LAPSED_P, level: 'A', scope: 'kyu_low', grantedOn: '2015-01-01',
    expiresOn: '2024-01-01', status: 'expired',
  });

  const obs = await makePerson('Observer');
  OBSERVER_P = obs.id;
});

describe('eligibility is computed from the syllabus, never assumed', () => {
  it('passes a grade whose rules the federation has not set', async () => {
    const p = await makePerson('Fresh Candidate');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));

    const r = await checkEligibility(db, p.id, GRADE_9KYU, NOW);
    expect(r.eligible).toBe(true);
    // Unset rules are reported as not set, not silently skipped.
    const notSet = r.checks.filter((c) => /not set by the syllabus|not required/.test(c.detail));
    expect(notSet.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses when the previous grade is not held', async () => {
    const p = await makePerson('No Previous Grade');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));

    const r = await checkEligibility(db, p.id, GRADE_8KYU, NOW);
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'previous_grade')!.passed).toBe(false);
  });

  it('refuses when the minimum interval has not elapsed, and states the numbers', async () => {
    const p = await makePerson('Too Soon');
    await db.update(s.persons).set({ status: 'active', dob: '2000-01-01' }).where(eq(s.persons.id, p.id));
    await db.insert(s.rankRecords).values({
      personId: p.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9,
      awardedOn: '2026-07-01', status: 'active',
    });

    const r = await checkEligibility(db, p.id, GRADE_8KYU, NOW);
    expect(r.eligible).toBe(false);
    const interval = r.checks.find((c) => c.rule === 'min_interval')!;
    expect(interval.passed).toBe(false);
    expect(interval.detail).toMatch(/1 months since 2026-07-01, 3 required/);
  });

  it('accepts once the interval has elapsed', async () => {
    const p = await makePerson('Ready');
    await db.update(s.persons).set({ status: 'active', dob: '2000-01-01' }).where(eq(s.persons.id, p.id));
    await db.insert(s.rankRecords).values({
      personId: p.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9,
      awardedOn: '2026-01-01', status: 'active',
    });
    const r = await checkEligibility(db, p.id, GRADE_8KYU, NOW);
    expect(r.eligible).toBe(true);
  });

  it('refuses below the minimum age and says the age it saw', async () => {
    const p = await makePerson('Too Young');
    await db.update(s.persons).set({ status: 'active', dob: '2021-01-01' }).where(eq(s.persons.id, p.id));
    await db.insert(s.rankRecords).values({
      personId: p.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9,
      awardedOn: '2026-01-01', status: 'active',
    });
    const r = await checkEligibility(db, p.id, GRADE_8KYU, NOW);
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'min_age')!.detail).toMatch(/age 5, minimum 8/);
  });

  it('refuses a grade under a syllabus that is not in force', async () => {
    const [draft] = await db.insert(s.syllabusVersions)
      .values({ code: 'MMAKF-SYL-DRAFT', title: 'Draft', status: 'draft' })
      .returning({ id: s.syllabusVersions.id });
    const [dg] = await db.insert(s.gradeDefinitions)
      .values({ syllabusVersionId: draft.id, kind: 'kyu', ordinal: 7, label: '7th Kyu' })
      .returning({ id: s.gradeDefinitions.id });

    const p = await makePerson('Draft Syllabus');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const r = await checkEligibility(db, p.id, dg.id, NOW);
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/not in force/i);
  });
});

describe('application', () => {
  it('stores the eligibility decision WITH its evidence', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Applicant');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));

    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);

    expect(c.status).toBe('eligible');
    expect(c.eligibilityResult.checks.length).toBeGreaterThan(3);
    expect(c.eligibilityResult.checkedAt).toBe(NOW.toISOString());
  });

  it('records an ineligible candidate rather than discarding them', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Ineligible');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));

    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_8KYU,
    }, NOW);
    expect(c.status).toBe('ineligible');
    expect(c.ineligibleReason).toBeTruthy();
  });

  it('refuses a duplicate entry', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Duplicate');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const args = { gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU };
    await applyForGrading(db, { principal: national }, args, NOW);
    await expect(applyForGrading(db, { principal: national }, args, NOW)).rejects.toThrow(/already entered/i);
  });

  it('ATTACK: refuses a grade from a different syllabus than the grading runs under', async () => {
    const [other] = await db.insert(s.syllabusVersions)
      .values({ code: 'MMAKF-SYL-OTHER', title: 'Other', status: 'active' })
      .returning({ id: s.syllabusVersions.id });
    const [og] = await db.insert(s.gradeDefinitions)
      .values({ syllabusVersionId: other.id, kind: 'kyu', ordinal: 6, label: '6th Kyu' })
      .returning({ id: s.gradeDefinitions.id });

    const ev = await makeGrading();
    const p = await makePerson('Mismatch');
    await expect(applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: og.id,
    }, NOW)).rejects.toThrow(/different syllabus/i);
  });

  it('refuses entry once registration is closed', async () => {
    const ev = await makeGrading({ status: 'locked' });
    const p = await makePerson('Late');
    await expect(applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW)).rejects.toThrow(/locked/i);
  });
});

describe('examiner authority', () => {
  it('appoints a licensed examiner and freezes their qualification', async () => {
    const ev = await makeGrading();
    const seat = await assignExaminer(db, { principal: national }, {
      gradingEventId: ev.id, personId: EXAMINER_P, role: 'examiner',
    });
    expect(seat.qualificationSnapshot.qualifications.length).toBe(1);
    expect(seat.qualificationSnapshot.asAt).toBe('2026-08-12');
  });

  it('ATTACK: refuses an examiner whose licence has expired', async () => {
    const ev = await makeGrading();
    await expect(assignExaminer(db, { principal: national }, {
      gradingEventId: ev.id, personId: LAPSED_P, role: 'examiner',
    })).rejects.toThrow(/not authorised|expired/i);
  });

  it('ATTACK: refuses someone holding no examiner qualification at all', async () => {
    const ev = await makeGrading();
    await expect(assignExaminer(db, { principal: national }, {
      gradingEventId: ev.id, personId: OBSERVER_P, role: 'examiner',
    })).rejects.toThrow(/holds no examiner qualification/i);
  });

  it('permits an unlicensed observer, who carries no authority', async () => {
    const ev = await makeGrading();
    await expect(assignExaminer(db, { principal: national }, {
      gradingEventId: ev.id, personId: OBSERVER_P, role: 'observer',
    })).resolves.toBeTruthy();
  });

  it('refuses an appointment by someone without grading authority', async () => {
    const ev = await makeGrading();
    await expect(assignExaminer(db, { principal: athlete }, {
      gradingEventId: ev.id, personId: EXAMINER_P, role: 'examiner',
    })).rejects.toThrow(/Forbidden/);
  });
});

describe('scoring', () => {
  async function readyCandidate() {
    const ev = await makeGrading();
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: EXAMINER_P, role: 'chief' });
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: OBSERVER_P, role: 'observer' });
    const p = await makePerson('Scored Candidate');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);
    return { ev, candidate: c, person: p };
  }

  it('records a score and keeps it per examiner', async () => {
    const { candidate } = await readyCandidate();
    await recordScore(db, { principal: technical }, {
      candidateId: candidate.id, examinerPersonId: EXAMINER_P,
      component: 'kihon', score: 80, maxScore: 100,
    });
    const summary = await summariseScores(db, candidate.id);
    expect(summary.overallPercent).toBe(80);
    expect(summary.examinersScoring).toBe(1);
  });

  it('ATTACK: an examiner not on the panel cannot score', async () => {
    const { candidate } = await readyCandidate();
    await expect(recordScore(db, { principal: technical }, {
      candidateId: candidate.id, examinerPersonId: LAPSED_P, component: 'kihon', score: 90,
    })).rejects.toThrow(/not appointed/i);
  });

  it('ATTACK: an observer cannot score', async () => {
    const { candidate } = await readyCandidate();
    await expect(recordScore(db, { principal: technical }, {
      candidateId: candidate.id, examinerPersonId: OBSERVER_P, component: 'kihon', score: 90,
    })).rejects.toThrow(/observer cannot record/i);
  });

  it('refuses a score above its own maximum, or a negative one', async () => {
    const { candidate } = await readyCandidate();
    await expect(recordScore(db, { principal: technical }, {
      candidateId: candidate.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: 120, maxScore: 100,
    })).rejects.toThrow(/exceeds the maximum/i);
    await expect(recordScore(db, { principal: technical }, {
      candidateId: candidate.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: -5,
    })).rejects.toThrow(/non-negative/i);
  });

  it('re-scoring updates that examiner only, never another examiner', async () => {
    const { ev, candidate } = await readyCandidate();
    const second = await makePerson('Second Examiner');
    await db.insert(s.examinerQuals).values({
      personId: second.id, level: 'B', scope: 'kyu_low', grantedOn: '2021-01-01', status: 'active',
    });
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: second.id, role: 'examiner' });

    await recordScore(db, { principal: technical }, { candidateId: candidate.id, examinerPersonId: EXAMINER_P, component: 'kata', score: 60 });
    await recordScore(db, { principal: technical }, { candidateId: candidate.id, examinerPersonId: second.id, component: 'kata', score: 90 });
    await recordScore(db, { principal: technical }, { candidateId: candidate.id, examinerPersonId: EXAMINER_P, component: 'kata', score: 70 });

    const rows = await db.select().from(s.gradingScores).where(eq(s.gradingScores.candidateId, candidate.id));
    expect(rows.length).toBe(2);                                   // not three
    expect(rows.find((r: any) => r.examinerPersonId === EXAMINER_P).score).toBe(70);
    expect(rows.find((r: any) => r.examinerPersonId === second.id).score).toBe(90);
  });
});

describe('THE INVARIANT: no certificate without an examination', () => {
  async function examined(outcome: 'pass' | 'fail' = 'pass') {
    const ev = await makeGrading();
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: EXAMINER_P, role: 'chief' });
    const p = await makePerson('Certificate Candidate');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);
    await recordScore(db, { principal: technical }, {
      candidateId: c.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: 85,
    });
    await decideCandidate(db, { principal: national }, { candidateId: c.id, outcome }, NOW);
    return { ev, candidate: c, person: p };
  }

  it('ATTACK: a pass cannot be recorded before any examiner has scored', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Unscored');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);

    await expect(decideCandidate(db, { principal: national }, {
      candidateId: c.id, outcome: 'pass',
    }, NOW)).rejects.toThrow(/before any examiner has scored/i);
  });

  it('ATTACK: a certificate cannot be issued for a candidate who did not pass', async () => {
    const { candidate } = await examined('fail');
    await expect(issueGradeCertificate(db, { principal: national }, candidate.id, NOW))
      .rejects.toThrow(/only be issued for a recorded pass/i);
  });

  it('ATTACK: an ineligible candidate cannot be examined at all', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Not Eligible');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_8KYU,
    }, NOW);
    expect(c.status).toBe('ineligible');
    await expect(decideCandidate(db, { principal: national }, {
      candidateId: c.id, outcome: 'pass',
    }, NOW)).rejects.toThrow(/found ineligible/i);
  });

  it('issues a certificate that carries its whole provenance, and awards the rank', async () => {
    const { candidate, person } = await examined('pass');
    const cert = await issueGradeCertificate(db, { principal: national }, candidate.id, NOW);

    expect(cert.certificateNo).toMatch(/^MMAKF-CERT-2026-\d{6}$/);
    expect(cert.snapshot.provenance).toBe('examined');
    expect(cert.snapshot.grade).toBe('9th Kyu');
    expect(cert.snapshot.syllabusVersion).toBe('MMAKF-SYL-2026-01');
    expect(cert.snapshot.examiners.length).toBe(1);
    expect(cert.gradingEventId).toBeTruthy();

    const [rank] = await db.select().from(s.rankRecords).where(and(
      eq(s.rankRecords.personId, person.id), eq(s.rankRecords.status, 'active')
    ));
    expect(rank.gradeLabel).toBe('9th Kyu');
    expect(rank.gradingEventId).toBe(cert.gradingEventId);
  });

  it('is idempotent — a retry returns the same certificate', async () => {
    const { candidate } = await examined('pass');
    const a = await issueGradeCertificate(db, { principal: national }, candidate.id, NOW);
    const b = await issueGradeCertificate(db, { principal: national }, candidate.id, NOW);
    expect(b.id).toBe(a.id);
    const all = await db.select().from(s.certificates).where(eq(s.certificates.id, a.id));
    expect(all.length).toBe(1);
  });

  it('refuses issuance by someone without certificate authority', async () => {
    const { candidate } = await examined('pass');
    await expect(issueGradeCertificate(db, { principal: examinerOnly }, candidate.id, NOW))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('locking', () => {
  it('refuses to lock while candidates have no decision', async () => {
    const ev = await makeGrading();
    const p = await makePerson('Undecided');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);

    await expect(lockGrading(db, { principal: national }, ev.id, NOW))
      .rejects.toThrow(/no decision recorded/i);
  });

  it('locks a fully decided grading, after which scores are immutable', async () => {
    const ev = await makeGrading();
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: EXAMINER_P, role: 'chief' });
    const p = await makePerson('Lockable');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);
    await recordScore(db, { principal: technical }, { candidateId: c.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: 75 });
    await decideCandidate(db, { principal: national }, { candidateId: c.id, outcome: 'pass' }, NOW);

    await lockGrading(db, { principal: national }, ev.id, NOW);

    await expect(recordScore(db, { principal: technical }, {
      candidateId: c.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: 99,
    })).rejects.toThrow(/locked/i);
    await expect(lockGrading(db, { principal: national }, ev.id, NOW)).rejects.toThrow(/already locked/i);
  });
});

describe('legacy records are admitted, and always disclosed', () => {
  it('requires evidence to be stated', async () => {
    const p = await makePerson('Legacy Holder');
    await expect(recordLegacyGrade(db, { principal: national }, {
      personId: p.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1,
      awardedOn: '2005-06-01', evidence: '   ',
    }, NOW)).rejects.toThrow(/evidence/i);
  });

  it('records the grade with NO grading event, and marks it unverified', async () => {
    const p = await makePerson('Historic Dan');
    const rank = await recordLegacyGrade(db, { principal: national }, {
      personId: p.id, kind: 'dan', gradeLabel: 'Nidan', gradeOrdinal: 2,
      awardedOn: '2008-03-15', awardedBy: 'MMAKF', evidence: 'Paper certificate held at the national office',
    }, NOW);

    // No examination is invented for it.
    expect(rank.gradingEventId).toBeNull();
    expect(rank.syllabusVersion).toBe('UNVERIFIED_LEGACY_RECORD');

    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'rank_record'));
    expect(JSON.stringify(audit)).toMatch(/Paper certificate held/);
  });
});

describe('public verification', () => {
  async function issued() {
    const ev = await makeGrading();
    await assignExaminer(db, { principal: national }, { gradingEventId: ev.id, personId: EXAMINER_P, role: 'chief' });
    const p = await makePerson('Verified Holder');
    await db.update(s.persons).set({
      status: 'active', email: 'private@example.in', phone: '9999999999', dob: '2000-01-01',
    }).where(eq(s.persons.id, p.id));
    const c = await applyForGrading(db, { principal: national }, {
      gradingEventId: ev.id, personId: p.id, gradeDefinitionId: GRADE_9KYU,
    }, NOW);
    await recordScore(db, { principal: technical }, { candidateId: c.id, examinerPersonId: EXAMINER_P, component: 'kihon', score: 88 });
    await decideCandidate(db, { principal: national }, { candidateId: c.id, outcome: 'pass' }, NOW);
    return issueGradeCertificate(db, { principal: national }, c.id, NOW);
  }

  it('verifies by number and by token, and reports the provenance', async () => {
    const cert = await issued();
    const byNo = await verifyCredential(db, { certificateNo: cert.certificateNo }, { on: NOW });
    const byToken = await verifyCredential(db, { token: cert.verifyToken }, { on: NOW });

    expect(byNo.status).toBe('valid');
    expect(byNo.provenance).toBe('examined');
    expect(byNo.grade).toBe('9th Kyu');
    expect(byToken.certificateNo).toBe(cert.certificateNo);
  });

  it('NEVER returns private data', async () => {
    const cert = await issued();
    const r = await verifyCredential(db, { certificateNo: cert.certificateNo }, { on: NOW });
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain('private@example.in');
    expect(dumped).not.toContain('9999999999');
    expect(dumped).not.toContain('2000-01-01');
    expect(Object.keys(r)).not.toContain('overallScore');
    expect(dumped).not.toMatch(/examiner/i);
  });

  it('reports not_found identically for an unknown number', async () => {
    const r = await verifyCredential(db, { certificateNo: 'MMAKF-CERT-2026-999999' }, { on: NOW });
    expect(r).toEqual({ status: 'not_found' });
  });

  it('reports a revoked certificate as REVOKED rather than hiding it', async () => {
    const cert = await issued();
    await revokeCertificate(db, { principal: national }, cert.id, 'Issued in error', NOW);

    const r = await verifyCredential(db, { certificateNo: cert.certificateNo }, { on: NOW });
    expect(r.status).toBe('revoked');
    expect(r.revokedReason).toBe('Issued in error');
    expect(r.grade).toBe('9th Kyu');    // still says what it was

    // The rank it evidenced is revoked with it.
    const [rank] = await db.select().from(s.rankRecords).where(eq(s.rankRecords.id, cert.rankRecordId));
    expect(rank.status).toBe('revoked');
  });

  it('requires a reason to revoke', async () => {
    const cert = await issued();
    await expect(revokeCertificate(db, { principal: national }, cert.id, '  ', NOW))
      .rejects.toThrow(/reason/i);
  });

  it('logs every lookup, without storing a raw IP', async () => {
    await verifyCredential(db, { certificateNo: 'MMAKF-CERT-2026-000001' }, { ipHash: 'abc123', on: NOW });
    const rows = await db.select().from(s.verificationLog);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('203.0.113');
  });

  it('discloses a legacy record as unverified at verification time', async () => {
    const p = await makePerson('Legacy Verified');
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    const rank = await recordLegacyGrade(db, { principal: national }, {
      personId: p.id, kind: 'dan', gradeLabel: 'Sandan', gradeOrdinal: 3,
      awardedOn: '2010-01-01', evidence: 'Register entry',
    }, NOW);

    const [cert] = await db.insert(s.certificates).values({
      certificateNo: 'MMAKF-CERT-LEGACY-0001', kind: 'dan_grade', personId: p.id,
      title: 'Sandan', issuedOn: '2010-01-01',
      issuingAuthority: 'MMAKF', status: 'issued', rankRecordId: rank.id,
      verifyToken: 'legacy-token-test-0001',
      snapshot: { grade: 'Sandan', holder: 'Legacy Verified', awardedOn: '2010-01-01', provenance: 'legacy' },
    }).returning();

    const r = await verifyCredential(db, { certificateNo: cert.certificateNo }, { on: NOW });
    expect(r.status).toBe('valid');
    expect(r.provenance).toBe('unverified_legacy');
    expect(r.note).toMatch(/legacy record/i);
  });
});

describe('the public register is DERIVED, not hand-typed', () => {
  it('lists active members with their active grade and its provenance', async () => {
    const rows = await publicRegister(db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r: any) => r.provenance === 'examined')).toBe(true);
    expect(rows.some((r: any) => r.provenance === 'unverified_legacy')).toBe(true);
  });

  it('exposes no contact details or dates of birth', async () => {
    const rows = await publicRegister(db);
    const keys = Object.keys(rows[0]);
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('dob');
    expect(JSON.stringify(rows)).not.toContain('private@example.in');
  });

  it('drops a revoked grade from the register', async () => {
    const before = await publicRegister(db);
    const target = before.find((r: any) => r.provenance === 'examined');

    const [rank] = await db.select().from(s.rankRecords).where(and(
      eq(s.rankRecords.gradeLabel, target.gradeLabel),
      eq(s.rankRecords.status, 'active')
    ));
    await db.update(s.rankRecords).set({ status: 'revoked' }).where(eq(s.rankRecords.id, rank.id));

    const after = await publicRegister(db);
    expect(after.length).toBe(before.length - 1);
  });
});
