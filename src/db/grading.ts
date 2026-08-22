// The grading chain — the federation's core authority.
//
// AUTHORISED PERSON → ELIGIBILITY → APPLICATION → PANEL → EXAMINATION →
// SCORECARD → DECISION → APPROVAL → CERTIFICATE → CREDENTIAL → VERIFICATION
//
// This module exists to make one thing true: **no certificate can exist that is
// not traceable to an examination.** The current public register is seven
// hand-typed rows, and a credential-verification service a parent is told to
// trust cannot be repaired by editing that list. It is repaired by making the
// chain above the only way a credential comes into being.
//
// The one exception is deliberate and visible: grades awarded before this system
// existed are real, and refusing to record them would erase decades of the
// federation's history. They are admitted through `recordLegacyGrade()`, which
// marks them UNVERIFIED_LEGACY_RECORD and says so at every verification. That is
// honest. Silently promoting them to examined records would not be.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan, assertCanAnywhere, can, type Principal } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class GradingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GradingError';
    this.code = code;
  }
}

// ─── Identifiers ────────────────────────────────────────────────────────────

async function nextRef(db: DB, prefix: string, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix, year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, prefix), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF-${prefix}-${year}-${String((rows[0]?.next ?? 1) - 1).padStart(6, '0')}`;
}

// ─── Eligibility ────────────────────────────────────────────────────────────

export interface EligibilityResult {
  eligible: boolean;
  /** Every rule checked, whether it passed, and the value it saw. */
  checks: Array<{ rule: string; passed: boolean; detail: string }>;
  reasons: string[];
  checkedAt: string;
}

/**
 * Decide whether a person may present for a grade.
 *
 * Every rule comes from the GRADE DEFINITION, which MMAKF configures. Nothing
 * here invents a minimum interval, a minimum age or an attendance requirement —
 * an unset rule is simply not checked, and the result says so rather than
 * failing the candidate against a threshold nobody approved.
 *
 * The full check list is returned and stored, so a refusal months later can be
 * explained from the record instead of re-derived from rules that may since have
 * changed.
 */
export async function checkEligibility(
  db: DB,
  personId: number,
  gradeDefinitionId: number,
  on: Date = new Date()
): Promise<EligibilityResult> {
  const checks: EligibilityResult['checks'] = [];
  const reasons: string[] = [];

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new GradingError('unknown_person', 'Unknown person');

  const grade = (await db.select().from(s.gradeDefinitions)
    .where(eq(s.gradeDefinitions.id, gradeDefinitionId)).limit(1))[0];
  if (!grade) throw new GradingError('unknown_grade', 'Unknown grade definition');

  const syllabus = (await db.select().from(s.syllabusVersions)
    .where(eq(s.syllabusVersions.id, grade.syllabusVersionId)).limit(1))[0];

  // The syllabus itself must be in force. Examining against a draft or a
  // superseded edition produces a certificate that means nothing.
  const syllabusActive = syllabus?.status === 'active' || syllabus?.status === 'approved';
  checks.push({
    rule: 'syllabus_in_force',
    passed: syllabusActive,
    detail: syllabus ? `syllabus ${syllabus.code} is ${syllabus.status}` : 'no syllabus version',
  });
  if (!syllabusActive) reasons.push('The syllabus for this grade is not in force.');

  // Person must be active.
  const personActive = person.status === 'active';
  checks.push({ rule: 'person_active', passed: personActive, detail: `person status ${person.status}` });
  if (!personActive) reasons.push('Membership record is not active.');

  // Current rank of the same kind, and its date.
  const current = (await db.select().from(s.rankRecords)
    .where(and(
      eq(s.rankRecords.personId, personId),
      eq(s.rankRecords.kind, grade.kind),
      eq(s.rankRecords.status, 'active')
    ))
    .orderBy(desc(s.rankRecords.awardedOn)).limit(1))[0];

  // Previous grade, when the federation has set one.
  if (grade.previousGradeOrdinal != null) {
    const holds = current && current.gradeOrdinal === grade.previousGradeOrdinal;
    checks.push({
      rule: 'previous_grade',
      passed: Boolean(holds),
      detail: current ? `holds ${current.gradeLabel}` : 'holds no active grade of this kind',
    });
    if (!holds) reasons.push(`This grade requires the holder to be at ordinal ${grade.previousGradeOrdinal} first.`);
  } else {
    checks.push({ rule: 'previous_grade', passed: true, detail: 'not required by the syllabus' });
  }

  // Minimum interval since the last award.
  if (grade.minMonthsSincePrevious != null) {
    if (!current) {
      checks.push({ rule: 'min_interval', passed: false, detail: 'no previous award to measure from' });
      reasons.push('No previous grade on record to measure the minimum interval from.');
    } else {
      const since = new Date(`${current.awardedOn}T00:00:00Z`);
      const months = (on.getUTCFullYear() - since.getUTCFullYear()) * 12
        + (on.getUTCMonth() - since.getUTCMonth());
      const passed = months >= grade.minMonthsSincePrevious;
      checks.push({
        rule: 'min_interval',
        passed,
        detail: `${months} months since ${current.awardedOn}, ${grade.minMonthsSincePrevious} required`,
      });
      if (!passed) {
        reasons.push(`${grade.minMonthsSincePrevious} months are required since the previous grade; ${months} have elapsed.`);
      }
    }
  } else {
    checks.push({ rule: 'min_interval', passed: true, detail: 'not set by the syllabus' });
  }

  // Minimum age.
  if (grade.minAgeYears != null) {
    if (!person.dob) {
      checks.push({ rule: 'min_age', passed: false, detail: 'no date of birth on record' });
      reasons.push('A date of birth is required to check the minimum age for this grade.');
    } else {
      const dob = new Date(`${person.dob}T00:00:00Z`);
      let age = on.getUTCFullYear() - dob.getUTCFullYear();
      const m = on.getUTCMonth() - dob.getUTCMonth();
      if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
      const passed = age >= grade.minAgeYears;
      checks.push({ rule: 'min_age', passed, detail: `age ${age}, minimum ${grade.minAgeYears}` });
      if (!passed) reasons.push(`Minimum age for this grade is ${grade.minAgeYears}; the candidate is ${age}.`);
    }
  } else {
    checks.push({ rule: 'min_age', passed: true, detail: 'not set by the syllabus' });
  }

  // Attendance since the previous award.
  if (grade.minSessionsSincePrevious != null) {
    const sinceDate = current?.awardedOn ?? '1900-01-01';
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.sessionAttendance)
      .innerJoin(s.trainingSessions, eq(s.sessionAttendance.sessionId, s.trainingSessions.id))
      .where(and(
        eq(s.sessionAttendance.personId, personId),
        eq(s.sessionAttendance.present, true),
        sql`${s.trainingSessions.heldOn} >= ${sinceDate}`
      ));
    const attended = Number(rows[0]?.n ?? 0);
    const passed = attended >= grade.minSessionsSincePrevious;
    checks.push({
      rule: 'min_sessions',
      passed,
      detail: `${attended} sessions recorded since ${sinceDate}, ${grade.minSessionsSincePrevious} required`,
    });
    if (!passed) {
      reasons.push(`${grade.minSessionsSincePrevious} recorded sessions are required; ${attended} are on record.`);
    }
  } else {
    checks.push({ rule: 'min_sessions', passed: true, detail: 'not set by the syllabus' });
  }

  return {
    eligible: reasons.length === 0,
    checks,
    reasons,
    checkedAt: on.toISOString(),
  };
}

// ─── Application ────────────────────────────────────────────────────────────

/**
 * Enter a candidate for a grading.
 *
 * The eligibility decision is stored WITH its evidence. An ineligible candidate
 * is still recorded — refusals are part of the history, and a candidate is owed
 * an explanation.
 */
export async function applyForGrading(
  db: DB,
  ctx: AuditContext,
  input: {
    gradingEventId: number;
    personId: number;
    gradeDefinitionId: number;
    presentedByPersonId?: number | null;
    dojoId?: number | null;
  },
  now: Date = new Date()
) {
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new GradingError('unknown_person', 'Unknown person');

  assertCan(ctx.principal, 'grading:read', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, input.gradingEventId)).limit(1))[0];
  if (!event) throw new GradingError('unknown_event', 'Unknown grading event');

  if (!['scheduled', 'registration_open'].includes(event.status)) {
    throw new GradingError('registration_closed', `This grading is ${event.status.replace(/_/g, ' ')}.`);
  }

  const grade = (await db.select().from(s.gradeDefinitions)
    .where(eq(s.gradeDefinitions.id, input.gradeDefinitionId)).limit(1))[0];
  if (!grade) throw new GradingError('unknown_grade', 'Unknown grade definition');

  // The grade must belong to the syllabus this grading is being run under.
  if (grade.syllabusVersionId !== event.syllabusVersionId) {
    throw new GradingError(
      'syllabus_mismatch',
      'That grade belongs to a different syllabus version from the one this grading is running under.'
    );
  }

  const eligibility = await checkEligibility(db, input.personId, input.gradeDefinitionId, now);

  let row;
  try {
    [row] = await db.insert(s.gradingCandidates).values({
      gradingEventId: input.gradingEventId,
      personId: input.personId,
      gradeDefinitionId: input.gradeDefinitionId,
      status: eligibility.eligible ? 'eligible' : 'ineligible',
      eligibilityCheckedAt: now,
      eligibilityResult: eligibility,
      ineligibleReason: eligibility.eligible ? null : eligibility.reasons.join(' '),
      presentedByPersonId: input.presentedByPersonId ?? null,
      dojoId: input.dojoId ?? person.dojoId ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GradingError('already_entered', 'This candidate is already entered for this grading.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'grading_candidate',
    entityId: row.id,
    action: 'create',
    newValue: { personId: input.personId, grade: grade.label, eligible: eligibility.eligible },
  });

  return { ...row, eligibility };
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/**
 * Appoint an examiner, verifying their authority AS AT the grading date.
 *
 * An expired or suspended examiner qualification must never silently produce a
 * valid official result — that is how a federation ends up unable to defend a
 * certificate. The qualification is snapshotted at appointment so the record
 * shows the authority held on the day, even after the licence later lapses.
 */
export async function assignExaminer(
  db: DB,
  ctx: AuditContext,
  input: { gradingEventId: number; personId: number; role: 'chief' | 'examiner' | 'assessor' | 'observer' }
) {
  assertCanAnywhere(ctx.principal, 'grading:approve');

  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, input.gradingEventId)).limit(1))[0];
  if (!event) throw new GradingError('unknown_event', 'Unknown grading event');

  const quals = await db.select().from(s.examinerQuals)
    .where(eq(s.examinerQuals.personId, input.personId));

  const onDate = event.heldOn ?? new Date().toISOString().slice(0, 10);
  const valid = quals.filter((q: any) =>
    q.status === 'active' &&
    (!q.expiresOn || q.expiresOn >= onDate) &&
    (!q.grantedOn || q.grantedOn <= onDate)
  );

  // Observers carry no authority, so they need no licence.
  if (input.role !== 'observer' && valid.length === 0) {
    const why = quals.length === 0
      ? 'holds no examiner qualification'
      : `examiner qualification is ${quals[0].status}${quals[0].expiresOn ? `, expired ${quals[0].expiresOn}` : ''}`;
    throw new GradingError('examiner_not_authorised', `Cannot appoint: this person ${why}.`);
  }

  let row;
  try {
    [row] = await db.insert(s.gradingPanel).values({
      gradingEventId: input.gradingEventId,
      personId: input.personId,
      role: input.role,
      qualificationSnapshot: { asAt: onDate, qualifications: valid },
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GradingError('already_on_panel', 'That person is already on this panel.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'grading_panel',
    entityId: row.id,
    action: 'create',
    newValue: { gradingEventId: input.gradingEventId, personId: input.personId, role: input.role },
  });
  return row;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Record one examiner's score for one component.
 *
 * Scores are stored PER EXAMINER and never merged on the way in, so a panel
 * disagreement stays visible and an appeal can see who marked what. Re-scoring
 * the same component updates that examiner's own row; it never touches another
 * examiner's.
 */
export async function recordScore(
  db: DB,
  ctx: AuditContext,
  input: {
    candidateId: number;
    examinerPersonId: number;
    component: string;
    score: number;
    maxScore?: number;
    gradeRequirementId?: number | null;
    comment?: string | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'grading:score');

  const candidate = (await db.select().from(s.gradingCandidates)
    .where(eq(s.gradingCandidates.id, input.candidateId)).limit(1))[0];
  if (!candidate) throw new GradingError('unknown_candidate', 'Unknown candidate');

  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, candidate.gradingEventId)).limit(1))[0];

  if (event?.lockedAt) {
    throw new GradingError('locked', 'This grading has been locked. Scores can no longer be changed.');
  }

  // The scorer must actually be on the panel with scoring authority.
  const seat = (await db.select().from(s.gradingPanel).where(and(
    eq(s.gradingPanel.gradingEventId, candidate.gradingEventId),
    eq(s.gradingPanel.personId, input.examinerPersonId)
  )).limit(1))[0];
  if (!seat) throw new GradingError('not_on_panel', 'That examiner is not appointed to this grading.');
  if (seat.role === 'observer') throw new GradingError('observer_cannot_score', 'An observer cannot record scores.');

  if (!Number.isInteger(input.score) || input.score < 0) {
    throw new GradingError('bad_score', 'A score must be a non-negative integer.');
  }
  const maxScore = input.maxScore ?? 100;
  if (input.score > maxScore) {
    throw new GradingError('bad_score', `Score ${input.score} exceeds the maximum of ${maxScore}.`);
  }

  // Explicit read-then-write rather than ON CONFLICT: uniqueness is enforced by
  // a PAIR of partial indexes (see technical.schema.ts), which a single
  // conflict target cannot name.
  const reqId = input.gradeRequirementId ?? null;
  const existing = (await db.select().from(s.gradingScores).where(and(
    eq(s.gradingScores.candidateId, input.candidateId),
    eq(s.gradingScores.examinerPersonId, input.examinerPersonId),
    reqId == null
      ? and(eq(s.gradingScores.component, input.component), sql`${s.gradingScores.gradeRequirementId} IS NULL`)
      : eq(s.gradingScores.gradeRequirementId, reqId)
  )).limit(1))[0];

  if (existing) {
    const [updated] = await db.update(s.gradingScores).set({
      score: input.score,
      maxScore,
      comment: input.comment ?? null,
      recordedAt: new Date(),
    }).where(eq(s.gradingScores.id, existing.id)).returning();
    return updated;
  }

  const [row] = await db.insert(s.gradingScores).values({
    candidateId: input.candidateId,
    examinerPersonId: input.examinerPersonId,
    gradeRequirementId: reqId,
    component: input.component,
    score: input.score,
    maxScore,
    comment: input.comment ?? null,
  }).returning();

  return row;
}

export interface ScoreSummary {
  components: Array<{ component: string; examiners: number; total: number; max: number; percent: number }>;
  overallPercent: number;
  examinersScoring: number;
}

/**
 * Aggregate a candidate's scores.
 *
 * Deliberately a plain mean across examiners per component, and NOT a weighted
 * formula: how MMAKF weights kihon against kata is technical policy, and
 * `gradeRequirements.weight` is where it belongs once the federation sets it.
 * Inventing a formula here would put an unapproved pass mark into every
 * certificate.
 */
export async function summariseScores(db: DB, candidateId: number): Promise<ScoreSummary> {
  const rows = await db.select().from(s.gradingScores)
    .where(eq(s.gradingScores.candidateId, candidateId));

  const byComponent = new Map<string, { sum: number; max: number; examiners: Set<number> }>();
  for (const r of rows) {
    const entry = byComponent.get(r.component) ?? { sum: 0, max: 0, examiners: new Set<number>() };
    entry.sum += r.score ?? 0;
    entry.max += r.maxScore ?? 0;
    entry.examiners.add(r.examinerPersonId);
    byComponent.set(r.component, entry);
  }

  const components = [...byComponent.entries()].map(([component, e]) => ({
    component,
    examiners: e.examiners.size,
    total: e.sum,
    max: e.max,
    percent: e.max > 0 ? Math.round((e.sum / e.max) * 100) : 0,
  }));

  const totalSum = components.reduce((n, c) => n + c.total, 0);
  const totalMax = components.reduce((n, c) => n + c.max, 0);
  const allExaminers = new Set(rows.map((r: any) => r.examinerPersonId));

  return {
    components,
    overallPercent: totalMax > 0 ? Math.round((totalSum / totalMax) * 100) : 0,
    examinersScoring: allExaminers.size,
  };
}

// ─── Decision ───────────────────────────────────────────────────────────────

/**
 * Record the panel's decision.
 *
 * The outcome is stated by the examining authority, not computed by this module
 * from a pass mark nobody approved. The score summary is stored alongside it so
 * the decision is explainable from the underlying records — which is the actual
 * requirement.
 */
export async function decideCandidate(
  db: DB,
  ctx: AuditContext,
  input: {
    candidateId: number;
    outcome: 'pass' | 'fail' | 'refer';
    referredComponents?: string[];
    examinerNotes?: string;
    candidateFeedback?: string;
  },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'grading:approve');

  const candidate = (await db.select().from(s.gradingCandidates)
    .where(eq(s.gradingCandidates.id, input.candidateId)).limit(1))[0];
  if (!candidate) throw new GradingError('unknown_candidate', 'Unknown candidate');

  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, candidate.gradingEventId)).limit(1))[0];
  if (event?.lockedAt) throw new GradingError('locked', 'This grading has been locked.');

  if (candidate.status === 'ineligible') {
    throw new GradingError('ineligible', 'This candidate was found ineligible and cannot be examined.');
  }
  if (input.outcome === 'refer' && !input.referredComponents?.length) {
    throw new GradingError('refer_needs_components', 'A referral must name the components to be re-examined.');
  }

  const summary = await summariseScores(db, input.candidateId);
  // A decision with no scores behind it is the thing this whole module exists to
  // prevent — it is a certificate with no examination.
  if (input.outcome === 'pass' && summary.examinersScoring === 0) {
    throw new GradingError(
      'no_scores',
      'A pass cannot be recorded before any examiner has scored this candidate.'
    );
  }

  const [row] = await db.update(s.gradingCandidates).set({
    status: input.outcome === 'pass' ? 'passed' : input.outcome === 'fail' ? 'failed' : 'referred',
    outcome: input.outcome,
    overallScore: summary.overallPercent,
    referredComponents: input.referredComponents ?? null,
    examinerNotes: input.examinerNotes ?? null,
    candidateFeedback: input.candidateFeedback ?? null,
    decidedAt: now,
    updatedAt: now,
  }).where(eq(s.gradingCandidates.id, input.candidateId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'grading_candidate',
    entityId: input.candidateId,
    action: 'approve',
    oldValue: { status: candidate.status },
    newValue: { status: row.status, outcome: input.outcome, summary },
  });

  return { ...row, summary };
}

// ─── Certificate ────────────────────────────────────────────────────────────

/**
 * Award the rank and issue the certificate for a passed candidate.
 *
 * THE INVARIANT: this is the only path by which an examined certificate comes
 * into existence, and it refuses anything that is not a recorded pass. That is
 * what makes a certificate mean something.
 *
 * Idempotent — a retry returns the certificate already issued rather than
 * issuing a second one.
 */
export async function issueGradeCertificate(
  db: DB,
  ctx: AuditContext,
  candidateId: number,
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'certificate:issue');

  const candidate = (await db.select().from(s.gradingCandidates)
    .where(eq(s.gradingCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) throw new GradingError('unknown_candidate', 'Unknown candidate');

  if (candidate.certificateId) {
    const existing = (await db.select().from(s.certificates)
      .where(eq(s.certificates.id, candidate.certificateId)).limit(1))[0];
    if (existing) return existing;
  }

  if (candidate.outcome !== 'pass') {
    throw new GradingError(
      'not_passed',
      'A certificate can only be issued for a recorded pass. This candidate has no pass on record.'
    );
  }

  const grade = (await db.select().from(s.gradeDefinitions)
    .where(eq(s.gradeDefinitions.id, candidate.gradeDefinitionId)).limit(1))[0];
  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, candidate.gradingEventId)).limit(1))[0];
  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.id, candidate.personId)).limit(1))[0];
  const syllabus = (await db.select().from(s.syllabusVersions)
    .where(eq(s.syllabusVersions.id, event.syllabusVersionId)).limit(1))[0];

  // Supersede the previous active rank of this kind — never overwrite it.
  await db.update(s.rankRecords).set({ status: 'superseded' }).where(and(
    eq(s.rankRecords.personId, candidate.personId),
    eq(s.rankRecords.kind, grade.kind),
    eq(s.rankRecords.status, 'active')
  ));

  const awardedOn = event.heldOn ?? now.toISOString().slice(0, 10);
  const [rank] = await db.insert(s.rankRecords).values({
    personId: candidate.personId,
    kind: grade.kind,
    gradeLabel: grade.label,
    gradeOrdinal: grade.ordinal,
    awardedOn,
    gradingEventId: event.id,
    syllabusVersion: syllabus?.code ?? null,
    score: candidate.overallScore ?? null,
    status: 'active',
  }).returning();

  const certificateNo = await nextRef(db, 'CERT', new Date(awardedOn).getFullYear());
  const panel = await db.select().from(s.gradingPanel)
    .where(eq(s.gradingPanel.gradingEventId, event.id));

  const [certificate] = await db.insert(s.certificates).values({
    certificateNo,
    kind: grade.kind === 'dan' ? 'dan_grade' : 'kyu_grade',
    personId: candidate.personId,
    title: `${grade.label} — ${grade.kind === 'dan' ? 'Dan' : 'Kyu'} Grade`,
    issuedOn: awardedOn,
    validFrom: awardedOn,
    syllabusVersionId: event.syllabusVersionId,
    gradingEventId: event.id,
    rankRecordId: rank.id,
    issuingAuthority: 'Modern Martial Arts Karate-Do Federation of India',
    signedByPersonId: event.chiefExaminerPersonId ?? null,
    status: 'issued',
    verifyToken: crypto.randomBytes(18).toString('base64url'),
    // Frozen: a later name correction or syllabus revision must not silently
    // alter a document already in someone's hands.
    snapshot: {
      certificateNo,
      holder: person?.fullName ?? null,
      federationId: person?.federationId ?? null,
      grade: grade.label,
      kind: grade.kind,
      awardedOn,
      gradingEvent: { code: event.code, title: event.title, venue: event.venue },
      syllabusVersion: syllabus?.code ?? null,
      examiners: panel
        .filter((p: any) => p.role !== 'observer')
        .map((p: any) => ({ personId: p.personId, role: p.role })),
      overallScore: candidate.overallScore,
      issuedAt: now.toISOString(),
      provenance: 'examined',
    },
  }).returning();

  await db.update(s.gradingCandidates)
    .set({ certificateId: certificate.id, rankRecordId: rank.id, updatedAt: now })
    .where(eq(s.gradingCandidates.id, candidateId));

  await writeAudit(db, ctx, {
    entityType: 'certificate',
    entityId: certificate.id,
    action: 'create',
    newValue: { certificateNo, personId: candidate.personId, grade: grade.label, rankRecordId: rank.id },
  });

  return certificate;
}

/**
 * Lock a grading. After this, scores and decisions are immutable.
 *
 * The point of no return, recorded explicitly so the boundary between "still
 * being marked" and "official" is a fact rather than a convention.
 */
export async function lockGrading(db: DB, ctx: AuditContext, gradingEventId: number, now: Date = new Date()) {
  assertCanAnywhere(ctx.principal, 'grading:approve');

  const event = (await db.select().from(s.gradingEvents)
    .where(eq(s.gradingEvents.id, gradingEventId)).limit(1))[0];
  if (!event) throw new GradingError('unknown_event', 'Unknown grading event');
  if (event.lockedAt) throw new GradingError('already_locked', 'This grading is already locked.');

  const undecided = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.gradingCandidates)
    .where(and(
      eq(s.gradingCandidates.gradingEventId, gradingEventId),
      inArray(s.gradingCandidates.status, ['applied', 'eligibility_check', 'eligible', 'confirmed', 'examined'])
    ));
  if (Number(undecided[0]?.n ?? 0) > 0) {
    throw new GradingError(
      'candidates_undecided',
      `${undecided[0].n} candidate(s) have no decision recorded. Decide or withdraw them before locking.`
    );
  }

  await db.update(s.gradingEvents).set({
    status: 'locked',
    lockedAt: now,
    lockedByUserId: ctx.principal.userId ?? null,
    updatedAt: now,
  }).where(eq(s.gradingEvents.id, gradingEventId));

  await writeAudit(db, ctx, {
    entityType: 'grading_event',
    entityId: gradingEventId,
    action: 'finalize',
    oldValue: { status: event.status },
    newValue: { status: 'locked' },
  });
}

// ─── Legacy records ─────────────────────────────────────────────────────────

/**
 * Admit a grade awarded before this system existed.
 *
 * Decades of real gradings predate any digital record, and refusing to carry
 * them would erase the federation's history. But they were not examined through
 * this chain, and pretending otherwise would defeat its entire purpose.
 *
 * So they are admitted, marked UNVERIFIED_LEGACY_RECORD, and every verification
 * says so. The distinction is visible to the public, not buried in a column.
 * `evidence` records whatever the federation actually holds — a certificate
 * number, a photograph, a register entry.
 */
export async function recordLegacyGrade(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    kind: 'kyu' | 'dan';
    gradeLabel: string;
    gradeOrdinal: number;
    awardedOn: string;
    awardedBy?: string;
    evidence: string;
  },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'rank:award');

  if (!input.evidence?.trim()) {
    throw new GradingError(
      'evidence_required',
      'A legacy grade requires a note of what evidence the federation holds for it.'
    );
  }

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new GradingError('unknown_person', 'Unknown person');

  await db.update(s.rankRecords).set({ status: 'superseded' }).where(and(
    eq(s.rankRecords.personId, input.personId),
    eq(s.rankRecords.kind, input.kind),
    eq(s.rankRecords.status, 'active')
  ));

  const [rank] = await db.insert(s.rankRecords).values({
    personId: input.personId,
    kind: input.kind,
    gradeLabel: input.gradeLabel,
    gradeOrdinal: input.gradeOrdinal,
    awardedOn: input.awardedOn,
    // No grading event, deliberately: there was none, and inventing one would be
    // the fabrication this module exists to prevent.
    gradingEventId: null,
    syllabusVersion: 'UNVERIFIED_LEGACY_RECORD',
    status: 'active',
  }).returning();

  await writeAudit(db, { ...ctx, reason: input.evidence }, {
    entityType: 'rank_record',
    entityId: rank.id,
    action: 'create',
    newValue: {
      provenance: 'UNVERIFIED_LEGACY_RECORD',
      grade: input.gradeLabel,
      awardedOn: input.awardedOn,
      awardedBy: input.awardedBy ?? null,
      evidence: input.evidence,
    },
  });

  return rank;
}

// ─── Public verification ────────────────────────────────────────────────────

export interface VerificationResult {
  status: 'valid' | 'expired' | 'revoked' | 'suspended' | 'not_found';
  /**
   * How the credential came to exist. The public sees this.
   *
   * `programme` is NOT a weaker `examined` and it is not a legacy record at all.
   * It is a different KIND of document: a course-completion certificate rests on
   * an attendance register, confers no rank, and has no examination behind it
   * because none was ever held. See the note in verifyCredential().
   */
  provenance?: 'examined' | 'programme' | 'unverified_legacy';
  certificateNo?: string;
  holderName?: string;
  federationId?: string;
  /** What the document says it is. A programme certificate carries no grade. */
  title?: string;
  grade?: string;
  awardedOn?: string;
  issuingAuthority?: string;
  syllabusVersion?: string;
  revokedReason?: string;
  note?: string;
}

/**
 * Verify a credential publicly.
 *
 * Returns ONLY what a stranger is entitled to know: that the credential exists,
 * whose it is, what it says, and whether it still stands. No contact details, no
 * date of birth, no scores, no examiner names.
 *
 * A revoked certificate reports as REVOKED rather than vanishing — a credential
 * that simply disappeared would be indistinguishable from one that never
 * existed, which is exactly what someone presenting a revoked certificate would
 * prefer.
 */
export async function verifyCredential(
  db: DB,
  lookup: { certificateNo?: string; token?: string },
  opts: { ipHash?: string | null; on?: Date } = {}
): Promise<VerificationResult> {
  const on = opts.on ?? new Date();
  const today = on.toISOString().slice(0, 10);

  const where = lookup.token
    ? eq(s.certificates.verifyToken, lookup.token)
    : eq(s.certificates.certificateNo, (lookup.certificateNo ?? '').trim().toUpperCase());

  const cert = (await db.select().from(s.certificates).where(where).limit(1))[0];

  await db.insert(s.verificationLog).values({
    lookupKind: 'certificate',
    lookupValue: (lookup.certificateNo ?? lookup.token ?? '').slice(0, 80),
    found: Boolean(cert),
    resultStatus: cert?.status ?? 'not_found',
    ipHash: opts.ipHash ?? null,
  }).catch(() => { /* logging must never break verification */ });

  if (!cert) return { status: 'not_found' };

  const snapshot = (cert.snapshot ?? {}) as Record<string, any>;

  // THREE KINDS OF DOCUMENT, AND THE THIRD ONE USED TO BE SWALLOWED.
  //
  // This read `provenance === 'examined' ? 'examined' : 'unverified_legacy'`,
  // which was safe while every certificate in the system came out of a grading.
  // Two modules then began minting COURSE COMPLETION certificates —
  // src/db/programme-lifecycle.ts for a school cohort's attendance
  // (`provenance: 'programme'`, `confersRank: false`, no rank record, no
  // examination) and src/db/academy.ts for an online course — and every one of
  // them verified publicly as `unverified_legacy`, under the sentence "This
  // GRADE predates the federation's digital examination records".
  //
  // That is the federation, on its own public endpoint, describing a 2026
  // attendance certificate as an old unexamined RANK. It is wrong in both
  // directions at once: it invents a grade the document does not claim, and it
  // ages a document issued this year. An employer reading it is being told
  // something MMAKF cannot defend, which is the exact failure this endpoint
  // exists to prevent.
  //
  // The certificate KIND is read as well as the snapshot, deliberately. The
  // snapshot is free-form jsonb written by whichever module issued the row; the
  // `kind` column is an enum the database enforces. Where they agree it costs
  // nothing, and where a future issuer forgets the snapshot key the enum still
  // stops a completion certificate being reported as a grade.
  const provenance: 'examined' | 'programme' | 'unverified_legacy' =
    snapshot.provenance === 'examined'
      ? 'examined'
      : (snapshot.provenance === 'programme' || cert.kind === 'course_completion')
        ? 'programme'
        : 'unverified_legacy';

  const NOTE = {
    examined: undefined,
    programme:
      'This certificate records ATTENDANCE at a federation programme. It is not an examination result, ' +
      'it confers no rank or grade, and the attendance figures it was issued on are printed on the document itself.',
    unverified_legacy:
      'This grade predates the federation’s digital examination records and is held as a legacy record. ' +
      'It has not been verified against an examination scorecard.',
  } as const;

  const base: VerificationResult = {
    status: 'valid',
    provenance,
    certificateNo: cert.certificateNo,
    holderName: snapshot.holder ?? undefined,
    federationId: snapshot.federationId ?? undefined,
    title: cert.title ?? undefined,
    // NEVER carried for a programme certificate, whatever a snapshot says. A
    // grade is the one field an enquirer reads as a rank claim, and this
    // document makes none.
    grade: provenance === 'programme' ? undefined : (snapshot.grade ?? undefined),
    awardedOn: snapshot.awardedOn ?? cert.issuedOn,
    issuingAuthority: cert.issuingAuthority,
    syllabusVersion: snapshot.syllabusVersion ?? undefined,
    note: NOTE[provenance],
  };

  if (cert.status === 'revoked') {
    return { ...base, status: 'revoked', revokedReason: cert.revokedReason ?? undefined };
  }
  if (cert.status === 'suspended') return { ...base, status: 'suspended' };
  if (cert.validTo && cert.validTo < today) return { ...base, status: 'expired' };

  return base;
}

/** Revoke a certificate. Never deletes; the reason is mandatory and public. */
export async function revokeCertificate(
  db: DB,
  ctx: AuditContext,
  certificateId: number,
  reason: string,
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'certificate:revoke');
  if (!reason?.trim()) throw new GradingError('reason_required', 'Revocation requires a reason.');

  const before = (await db.select().from(s.certificates)
    .where(eq(s.certificates.id, certificateId)).limit(1))[0];
  if (!before) throw new GradingError('unknown_certificate', 'Unknown certificate');

  await db.update(s.certificates).set({
    status: 'revoked',
    revokedOn: now.toISOString().slice(0, 10),
    revokedReason: reason.trim(),
  }).where(eq(s.certificates.id, certificateId));

  // The rank the certificate evidenced is revoked with it, or the register would
  // still show a grade whose certificate has been withdrawn.
  if (before.rankRecordId) {
    await db.update(s.rankRecords)
      .set({ status: 'revoked', revokedReason: reason.trim() })
      .where(eq(s.rankRecords.id, before.rankRecordId));
  }

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'certificate',
    entityId: certificateId,
    action: 'revoke',
    oldValue: { status: before.status },
    newValue: { status: 'revoked' },
  });
}

// ─── Public register ────────────────────────────────────────────────────────

/**
 * The public member register, DERIVED from authoritative records.
 *
 * Replaces a hand-typed list. A person appears only if they hold an active
 * membership and an active rank; the grade shown is the one on the rank record,
 * and its provenance travels with it so a legacy entry is never mistaken for an
 * examined one.
 *
 * No contact details, no date of birth, no address — verification is a lookup,
 * not a directory of members' personal data.
 */
export async function publicRegister(db: DB, limit = 500) {
  const rows = await db
    .select({
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      city: s.persons.city,
      stateUnitId: s.persons.stateUnitId,
      dojoId: s.persons.dojoId,
      gradeLabel: s.rankRecords.gradeLabel,
      gradeKind: s.rankRecords.kind,
      awardedOn: s.rankRecords.awardedOn,
      syllabusVersion: s.rankRecords.syllabusVersion,
      gradingEventId: s.rankRecords.gradingEventId,
    })
    .from(s.persons)
    .innerJoin(s.rankRecords, and(
      eq(s.rankRecords.personId, s.persons.id),
      eq(s.rankRecords.status, 'active')
    ))
    .where(eq(s.persons.status, 'active'))
    .limit(limit);

  return rows.map((r: any) => ({
    ...r,
    provenance: r.gradingEventId ? 'examined' : 'unverified_legacy',
  }));
}
