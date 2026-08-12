// The affiliation lifecycle, against real Postgres.
//
// The invariants these tests exist to protect:
//   · a dojo cannot be chartered without passing review;
//   · a dojo cannot be affiliated to an instructor the register cannot identify;
//   · nothing about the criteria for affiliation is invented by the code;
//   · nothing is ever deleted, so the public directory can say a dojo WAS
//     affiliated and no longer is.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  applyForAffiliation, beginDocumentReview, recordDocumentReview, recordTechnicalReview,
  grantCharter, grantProvisional, renewCharter, markRenewalDue, charterStanding,
  dueForRenewal, lapseExpiredCharters, suspendAffiliation, reinstateAffiliation,
  revokeAffiliation, submitAffiliationEvidence, acceptAffiliationEvidence,
  affiliationDossier, assessAffiliation, affiliationStage, affiliationHistory,
  publicDirectory, AffiliationError, type AffiliationCriteria,
} from '../src/db/affiliation';
import type { Principal } from '../src/lib/rbac';

let db: any;
let JH: number, BR: number, RAMGARH: number;
let RANKED: number, UNRANKED: number;

const NOW = new Date('2026-08-12T00:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Holds dojo:approve, but only inside Jharkhand. */
const jhSecretary: Principal = {
  userId: 2, label: 'jh-secretary',
  bindings: [{ role: 'GENERAL_SECRETARY', scopeType: 'state', scopeId: 0 }],
};
/** Holds dojo:write but NOT dojo:approve, anywhere. */
const jhStateAdmin: Principal = {
  userId: 3, label: 'jh-state-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 0 }],
};
const member: Principal = {
  userId: 4, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};

const ctx = (principal: Principal) => ({ principal });

let seq = 0;
/** An application filed and accepted, sitting at stage `application`. */
async function applied(over: Record<string, unknown> = {}) {
  return applyForAffiliation(db, ctx(national), {
    name: `Dojo ${++seq}`,
    stateUnitId: JH,
    chiefInstructorPersonId: RANKED,
    city: 'Ramgarh',
    ...over,
  } as any, NOW);
}

/** An application carried through both reviews to provisional. */
async function provisional(over: Record<string, unknown> = {}) {
  const d = await applied(over);
  const unit = { kind: 'dojo' as const, id: d.id };
  await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
  await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Documents in order.', now: NOW });
  await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspection satisfactory.', now: NOW });
  return { dojo: d, unit };
}

/** A fully chartered dojo. Backdates the charter when the term has already run out. */
async function chartered(validUntil: string | null = '2027-08-11', over: Record<string, unknown> = {}) {
  const { dojo, unit } = await provisional(over);
  const charteredOn = validUntil && validUntil < '2026-08-12' ? '2025-01-01' : '2026-08-12';
  await grantCharter(db, ctx(national), {
    unit, charteredOn, validUntil, reason: 'Charter granted by the executive.', now: NOW,
  });
  return { dojo, unit, charteredOn };
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
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  BR = br.id;
  const [rmg] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DIST-JH-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RAMGARH = rmg.id;

  jhSecretary.bindings[0].scopeId = JH;
  jhStateAdmin.bindings[0].scopeId = JH;

  const ranked = await createPerson(db, ctx(national), { fullName: 'Ranked Sensei', stateUnitId: JH });
  RANKED = ranked.id;
  await db.insert(s.rankRecords).values({
    personId: RANKED, kind: 'dan', gradeLabel: 'Sandan', gradeOrdinal: 3,
    awardedOn: '2019-04-01', status: 'active',
  });

  const unranked = await createPerson(db, ctx(national), { fullName: 'Unranked Applicant', stateUnitId: JH });
  UNRANKED = unranked.id;
});

// ─── Application ────────────────────────────────────────────────────────────

describe('application: the chief instructor must be in the register', () => {
  it('ATTACK: refuses an instructor who is not a registered person at all', async () => {
    await expect(applyForAffiliation(db, ctx(national), {
      name: 'Ghost Dojo', stateUnitId: JH, chiefInstructorPersonId: 999_999,
    }, NOW)).rejects.toThrow(/not in the federation register/i);

    // And the dojo was not created as a side effect of the refusal.
    const rows = await db.select().from(s.dojos).where(eq(s.dojos.name, 'Ghost Dojo'));
    expect(rows.length).toBe(0);
  });

  // THE CARDINAL RULE. "A chief instructor must hold an active rank" is a real
  // eligibility rule, and MMAKF has not published it. Applied unasked it refuses
  // — at the door, before any officer sees the file — a club whose instructor
  // was graded abroad, graded under a predecessor body, or whose grade simply
  // has not been keyed into the register yet. That is failing a real applicant
  // against a threshold nobody approved, and it is the single most damaging
  // thing this module could do.
  it('ATTACK: does not refuse an unranked chief instructor against a rule nobody published', async () => {
    const d = await applyForAffiliation(db, ctx(national), {
      name: 'Unranked Dojo', stateUnitId: JH, chiefInstructorPersonId: UNRANKED,
    }, NOW);

    expect(d.stage).toBe('application');
    expect(d.chiefInstructor.hasActiveRank).toBe(false);
    expect(d.chiefInstructor.requirementApplied).toBeNull();
    // And it does not go quietly: the shortfall is stated, and stated as
    // unjudged rather than as a pass.
    expect(d.chiefInstructor.requirementNote).toMatch(/no rank or qualification requirement/i);
    expect(d.chiefInstructor.requirementNote).toMatch(/NO active rank on record/);
    expect(d.chiefInstructor.requirementNote).toMatch(/reported, not refused/i);

    // The reviewing officer can reconstruct it from stored data, not from a
    // return value that was thrown away at the end of the request.
    const trail = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityId, `dojo:${d.id}`));
    const filed = trail.find((r: any) => r.newValue?.stage === 'application');
    expect(filed.newValue.chiefInstructor.hasActiveRank).toBe(false);
    expect(filed.newValue.chiefInstructor.requirementNote).toMatch(/NO active rank on record/);
  });

  it('applies a rank requirement the federation DOES publish, and cites the instrument', async () => {
    await expect(applyForAffiliation(db, ctx(national), {
      name: 'Unranked Dojo Two', stateUnitId: JH, chiefInstructorPersonId: UNRANKED,
      instructorRequirement: { instrument: 'Bye-law 7(2)', requireActiveRank: true },
    }, NOW)).rejects.toThrow(/holds no active rank.*Bye-law 7\(2\)/s);
  });

  it('a revoked rank is not an active rank, once a rank requirement is published', async () => {
    const p = await createPerson(db, ctx(national), { fullName: 'Revoked Sensei', stateUnitId: JH });
    await db.insert(s.rankRecords).values({
      personId: p.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1,
      awardedOn: '2015-01-01', status: 'revoked', revokedReason: 'Withdrawn.',
    });
    await expect(applyForAffiliation(db, ctx(national), {
      name: 'Revoked Dojo', stateUnitId: JH, chiefInstructorPersonId: p.id,
      instructorRequirement: { instrument: 'Bye-law 7(2)', requireActiveRank: true },
    }, NOW)).rejects.toThrow(/holds no active rank/i);

    // Unpublished, the same instructor is not refused — only reported.
    const ok = await applyForAffiliation(db, ctx(national), {
      name: 'Revoked Dojo Unruled', stateUnitId: JH, chiefInstructorPersonId: p.id,
    }, NOW);
    expect(ok.chiefInstructor.hasActiveRank).toBe(false);
  });

  it('measures a published minimum grade rather than assuming one, and says what it measured', async () => {
    // Sandan, ordinal 3. The threshold is the federation's, not the code's.
    await expect(applyForAffiliation(db, ctx(national), {
      name: 'Under-graded Dojo', stateUnitId: JH, chiefInstructorPersonId: RANKED,
      instructorRequirement: { instrument: 'Council Resolution 4/2026', minimumGradeOrdinal: 5 },
    }, NOW)).rejects.toThrow(/ordinal 5 \(highest on record: 3\)/);

    // No minimum published: the same instructor passes and the grade is reported.
    const d = await applyForAffiliation(db, ctx(national), {
      name: 'Ungraded-rule Dojo', stateUnitId: JH, chiefInstructorPersonId: RANKED,
    }, NOW);
    expect(d.chiefInstructor.highestGradeOrdinal).toBe(3);
  });

  it('accepts a real instructor and records the rank it relied on', async () => {
    const d = await applied({ name: 'Hombu Ramgarh', districtUnitId: RAMGARH });
    expect(d.stage).toBe('application');
    expect(d.status).toBe('draft');
    expect(d.chiefInstructor.activeRanks[0].grade).toBe('Sandan');
    // An application is not an affiliation: no dates are set.
    expect(d.affiliatedOn).toBeNull();
    expect(d.affiliationExpiresOn).toBeNull();
    expect(d.code).toMatch(/^MMAKF-DOJO-\d{4}-\d{6}$/);
  });

  it('refuses an application filed by someone with no authority in that state', async () => {
    await expect(applyForAffiliation(db, ctx(member), {
      name: 'Unauthorised', stateUnitId: JH, chiefInstructorPersonId: RANKED,
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('refuses a district that does not belong to the named state', async () => {
    await expect(applyForAffiliation(db, ctx(national), {
      name: 'Wrong District', stateUnitId: BR, districtUnitId: RAMGARH, chiefInstructorPersonId: RANKED,
    }, NOW)).rejects.toThrow(/does not belong to the given state/i);
  });
});

// ─── The state machine ──────────────────────────────────────────────────────

describe('THE INVARIANT: no charter without passing review', () => {
  it('ATTACK: an application cannot be chartered directly', async () => {
    const d = await applied();
    await expect(grantCharter(db, ctx(national), {
      unit: { kind: 'dojo', id: d.id }, charteredOn: '2026-08-12',
      reason: 'Skipping the queue.', now: NOW,
    })).rejects.toThrow(/cannot move to chartered/i);

    const st = await affiliationStage(db, { kind: 'dojo', id: d.id });
    expect(st.stage).toBe('application');
    expect(st.status).toBe('draft');
  });

  it('ATTACK: an application half-way through review cannot be chartered', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    await expect(grantCharter(db, ctx(national), {
      unit, charteredOn: '2026-08-12', reason: 'Impatient.', now: NOW,
    })).rejects.toThrow(/cannot move to chartered/i);
  });

  it('walks the full lifecycle and records every step', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };

    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    expect((await affiliationStage(db, unit)).stage).toBe('document_review');

    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    expect((await affiliationStage(db, unit)).stage).toBe('technical_review');

    await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspected.', now: NOW });
    const prov = await affiliationStage(db, unit);
    expect(prov.stage).toBe('provisional');
    expect(prov.status).toBe('provisional');

    const c = await grantCharter(db, ctx(national), {
      unit, charteredOn: '2026-08-12', validUntil: '2027-08-11', reason: 'Executive resolution 12/2026.', now: NOW,
    });
    expect(c.stage).toBe('chartered');
    expect(c.status).toBe('active');
    expect(c.validUntil).toBe('2027-08-11');

    const history = await affiliationHistory(db, national, unit);
    expect(history.map((h: any) => h.to)).toEqual([
      'application', 'document_review', 'technical_review', 'provisional', 'chartered',
    ]);
    expect(history.every((h: any) => Boolean(h.reason) || h.to === 'application')).toBe(true);
    expect(history.at(-1).actor).toBe('federation-admin');
  });

  it('sends an incomplete dossier back to the applicant instead of refusing it', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'returned', reason: 'Missing venue consent.', now: NOW });
    expect((await affiliationStage(db, unit)).stage).toBe('application');
  });

  it('refuses any transition with no reason recorded', async () => {
    const d = await applied();
    await expect(beginDocumentReview(db, ctx(national), {
      unit: { kind: 'dojo', id: d.id }, reason: '   ', now: NOW,
    })).rejects.toThrow(/must record the reason/i);
  });

  it('treats revocation as terminal — it cannot be quietly walked back', async () => {
    const { unit } = await chartered();
    await revokeAffiliation(db, ctx(national), { unit, reason: 'Safeguarding breach found proven.', now: NOW });
    await expect(renewCharter(db, ctx(national), {
      unit, validUntil: '2028-01-01', reason: 'Undo.', now: NOW,
    })).rejects.toThrow(/terminal state/i);
  });

  it('reports the stage of a unit that predates this module from its status column', async () => {
    const [legacy] = await db.insert(s.dojos).values({
      code: 'MMAKF-DOJO-LEGACY-1', name: 'Legacy Dojo', stateUnitId: JH, status: 'active',
      affiliatedOn: '2020-01-01', affiliationExpiresOn: '2030-01-01',
    }).returning();
    const st = await affiliationStage(db, { kind: 'dojo', id: legacy.id });
    expect(st.stage).toBe('chartered');
  });
});

// ─── Criteria are configuration ─────────────────────────────────────────────

describe('affiliation criteria are configuration, never code', () => {
  it('says plainly that no criteria are configured, and that the officer decided', async () => {
    const d = await applied();
    const a = await assessAffiliation(db, national, { kind: 'dojo', id: d.id }, null, NOW);
    expect(a.criteriaConfigured).toBe(false);
    expect(a.checks).toEqual([]);
    expect(a.decisionRestsWith).toBe('reviewing_officer');
    expect(a.note).toMatch(/no affiliation criteria/i);
    expect(a.note).toMatch(/rests entirely with the reviewing officer/i);
  });

  it('passes review with no criteria set, and stores that fact with the decision', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    const r = await recordDocumentReview(db, ctx(national), {
      unit, decision: 'passed', reason: 'Officer satisfied.', now: NOW,
    });
    expect(r.assessment.criteriaConfigured).toBe(false);

    const history = await affiliationHistory(db, national, unit);
    expect(history.at(-1).detail.assessment.decisionRestsWith).toBe('reviewing_officer');
  });

  it('measures a configured member minimum against the register', async () => {
    const d = await applied();
    const criteria: AffiliationCriteria = {
      code: 'MMAKF-BYELAW-AFFIL', version: '2026-01',
      criteria: [{
        key: 'members', label: 'Registered members', requirement: 'At least 3 registered members.',
        measure: 'registered_members', minimum: 3,
      }],
    };

    const before = await assessAffiliation(db, national, { kind: 'dojo', id: d.id }, criteria, NOW);
    expect(before.checks[0].satisfied).toBe(false);
    expect(before.checks[0].detail).toMatch(/0 active members registered, 3 required/);

    for (let i = 0; i < 3; i++) {
      const p = await createPerson(db, ctx(national), { fullName: `Student ${d.id}-${i}`, stateUnitId: JH, dojoId: d.id });
      await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, p.id));
    }
    const after = await assessAffiliation(db, national, { kind: 'dojo', id: d.id }, criteria, NOW);
    expect(after.checks[0].satisfied).toBe(true);
  });

  it('reports the measurement but refuses to judge when the federation set no threshold', async () => {
    const d = await applied();
    const a = await assessAffiliation(db, national, { kind: 'dojo', id: d.id }, {
      code: 'MMAKF-BYELAW-AFFIL', version: '2026-01',
      criteria: [{ key: 'members', label: 'Registered members', requirement: 'Sufficient members.', measure: 'registered_members' }],
    }, NOW);
    expect(a.checks[0].satisfied).toBeNull();
    expect(a.checks[0].detail).toMatch(/no minimum/i);
    expect(a.undetermined).toEqual(['Registered members']);
  });

  it('leaves a criterion no stored record can measure to the officer', async () => {
    const d = await applied();
    const a = await assessAffiliation(db, national, { kind: 'dojo', id: d.id }, {
      code: 'MMAKF-BYELAW-AFFIL', version: '2026-01',
      criteria: [{ key: 'mat_area', label: 'Training area', requirement: 'A safe training area.' }],
    }, NOW);
    expect(a.checks[0].satisfied).toBeNull();
    expect(a.checks[0].detail).toMatch(/reviewing officer must assess it/i);
  });

  it('ATTACK: a configured criterion the applicant fails blocks the pass', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    const criteria: AffiliationCriteria = {
      code: 'MMAKF-BYELAW-AFFIL', version: '2026-01',
      criteria: [{
        key: 'insurance', label: 'Public liability insurance', requirement: 'A current policy.',
        measure: 'accepted_evidence', evidenceCategory: 'insurance',
      }],
    };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    await expect(recordDocumentReview(db, ctx(national), {
      unit, decision: 'passed', criteria, reason: 'Looks fine.', now: NOW,
    })).rejects.toThrow(/does not meet published criteria/i);

    // The override is permitted, and is recorded as an override.
    const r = await recordDocumentReview(db, ctx(national), {
      unit, decision: 'passed', criteria, overrideUnmet: true,
      reason: 'Policy sighted in hard copy at the inspection; scan to follow.', now: NOW,
    });
    expect(r.stage).toBe('technical_review');
    const history = await affiliationHistory(db, national, unit);
    expect(history.at(-1).detail.overrodeUnmetCriteria).toBe(true);
  });
});

// ─── Evidence ───────────────────────────────────────────────────────────────

describe('evidence is versioned and only counts once accepted', () => {
  it('submitted evidence does not satisfy a criterion until an officer accepts it', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    const criteria: AffiliationCriteria = {
      code: 'MMAKF-BYELAW-AFFIL', version: '2026-01',
      criteria: [{
        key: 'insurance', label: 'Public liability insurance', requirement: 'A current policy.',
        measure: 'accepted_evidence', evidenceCategory: 'insurance',
      }],
    };

    const { version } = await submitAffiliationEvidence(db, ctx(national), {
      unit, category: 'insurance', title: 'Public liability policy',
      fileUrl: 'https://example.invalid/p.pdf', fileSha256: 'abc123',
    }, NOW);
    expect(version.status).toBe('under_review');

    let a = await assessAffiliation(db, national, unit, criteria, NOW);
    expect(a.checks[0].satisfied).toBe(false);
    expect(a.checks[0].detail).toMatch(/submitted but not accepted/i);

    await acceptAffiliationEvidence(db, ctx(national), {
      unit, documentVersionId: version.id, reason: 'Verified against the insurer.',
    }, NOW);

    a = await assessAffiliation(db, national, unit, criteria, NOW);
    expect(a.checks[0].satisfied).toBe(true);
  });

  it('resubmission adds a version and never overwrites the one reviewed', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    const first = await submitAffiliationEvidence(db, ctx(national), { unit, category: 'venue', title: 'Venue consent' }, NOW);
    const second = await submitAffiliationEvidence(db, ctx(national), { unit, category: 'venue', title: 'Venue consent' }, NOW);
    expect(first.version.version).toBe('1');
    expect(second.version.version).toBe('2');

    const dossier = await affiliationDossier(db, national, unit);
    expect(dossier[0].versions.length).toBe(2);
    expect(dossier[0].classification).toBe('official');
  });

  it('ATTACK: cannot accept another unit’s document into this unit’s dossier', async () => {
    const a = await applied();
    const b = await applied();
    const { version } = await submitAffiliationEvidence(db, ctx(national), {
      unit: { kind: 'dojo', id: a.id }, category: 'venue', title: 'Venue consent',
    }, NOW);
    await expect(acceptAffiliationEvidence(db, ctx(national), {
      unit: { kind: 'dojo', id: b.id }, documentVersionId: version.id, reason: 'Wrong file.',
    }, NOW)).rejects.toThrow(/not part of this unit/i);
  });
});

// ─── Charter validity, renewal and lapse ────────────────────────────────────

describe('charter validity, renewal and lapse', () => {
  it('records a charter with no expiry rather than inventing a term', async () => {
    const { unit } = await provisional();
    const c = await grantCharter(db, ctx(national), {
      unit, charteredOn: '2026-08-12', reason: 'Charter granted; term not yet set by council.', now: NOW,
    });
    expect(c.charterHasExpiry).toBe(false);
    expect(c.note).toMatch(/no expiry/i);

    const st = await charterStanding(db, unit, { on: NOW });
    expect(st.validUntil).toBeNull();
    expect(st.renewalDue).toBeNull();
    expect(st.affiliated).toBe(true);
  });

  it('offers no renewal judgement until the federation supplies a window', async () => {
    const { unit } = await chartered('2026-09-01');
    const silent = await charterStanding(db, unit, { on: NOW });
    expect(silent.renewalDue).toBeNull();
    expect(silent.note).toMatch(/no renewal window/i);

    const configured = await charterStanding(db, unit, { on: NOW, renewalWindowDays: 30 });
    expect(configured.daysRemaining).toBe(20);
    expect(configured.renewalDue).toBe(true);
  });

  it('lists charters falling due inside a caller-supplied window', async () => {
    const { dojo } = await chartered('2026-09-30');
    const soon = await dueForRenewal(db, { withinDays: 60, kinds: ['dojo'], on: NOW });
    expect(soon.map((u) => u.code)).toContain(dojo.code);
    const later = await dueForRenewal(db, { withinDays: 7, kinds: ['dojo'], on: NOW });
    expect(later.map((u) => u.code)).not.toContain(dojo.code);
  });

  it('marks a renewal notice without withdrawing the charter', async () => {
    const { unit } = await chartered('2026-09-30');
    const r = await markRenewalDue(db, ctx(national), { unit, reason: 'Renewal notice issued.', now: NOW });
    expect(r.stage).toBe('renewal_due');
    // Still affiliated: a notice is not a withdrawal.
    expect(r.status).toBe('active');
  });

  it('moves an expired charter to lapsed on a scheduled sweep, and leaves current ones alone', async () => {
    const expiredUnit = await chartered('2026-01-31');
    const currentUnit = await chartered('2027-12-31');

    const sweep = await lapseExpiredCharters(db, ctx(national), { on: NOW, kinds: ['dojo'] });
    expect(sweep.lapsed.map((u) => u.code)).toContain(expiredUnit.dojo.code);
    expect(sweep.lapsed.map((u) => u.code)).not.toContain(currentUnit.dojo.code);

    const st = await affiliationStage(db, expiredUnit.unit);
    expect(st.stage).toBe('lapsed');
    expect(st.status).toBe('expired');
    // Never deletes.
    const row = await db.select().from(s.dojos).where(eq(s.dojos.id, expiredUnit.dojo.id));
    expect(row.length).toBe(1);
    expect((await affiliationStage(db, currentUnit.unit)).stage).toBe('chartered');
  });

  it('lapsing is reversible: a lapsed charter renews and keeps its original date', async () => {
    const { dojo, unit } = await chartered('2026-01-31');
    await lapseExpiredCharters(db, ctx(national), { on: NOW, kinds: ['dojo'] });
    expect((await affiliationStage(db, unit)).stage).toBe('lapsed');

    const r = await renewCharter(db, ctx(national), {
      unit, validUntil: '2027-08-11', reason: 'Renewal fee received and charter reissued.', now: NOW,
    });
    expect(r.stage).toBe('chartered');

    const st = await charterStanding(db, unit, { on: NOW });
    expect(st.affiliated).toBe(true);
    expect(st.validUntil).toBe('2027-08-11');
    // "Affiliated since" is not restarted by a renewal.
    expect(st.charteredOn).toBe('2025-01-01');
    void dojo;

    // The gap stays visible in the ledger.
    const history = await affiliationHistory(db, national, unit);
    expect(history.map((h: any) => h.to)).toContain('lapsed');
  });

  it('renews a charter that has not yet lapsed, without forcing it to expire first', async () => {
    const { unit } = await chartered('2026-09-30');
    const r = await renewCharter(db, ctx(national), {
      unit, validUntil: '2027-09-30', reason: 'Renewed on time.', now: NOW,
    });
    expect(r.stage).toBe('chartered');
    expect((await charterStanding(db, unit, { on: NOW })).validUntil).toBe('2027-09-30');
    // Renewing early is still a recorded act, not a silent field edit.
    const history = await affiliationHistory(db, national, unit);
    expect(history.at(-1).detail.renewal).toBe(true);
    expect(history.at(-1).reason).toBe('Renewed on time.');
  });

  it('says so when a renewal leaves the charter open-ended, rather than doing it quietly', async () => {
    const { unit } = await chartered('2026-09-30');
    const r = await renewCharter(db, ctx(national), {
      unit, reason: 'Renewed; the executive set no new term.', now: NOW,
    });
    expect(r.charterHasExpiry).toBe(false);
    expect(r.note).toMatch(/open-ended/i);
    // The expiry really is gone, so the sweep must no longer lapse it.
    expect((await charterStanding(db, unit, { on: NOW })).validUntil).toBe(null);
    const sweep = await lapseExpiredCharters(db, ctx(national), { on: NOW, kinds: ['dojo'] });
    expect(sweep.lapsed.map((u) => u.id)).not.toContain(unit.id);
  });

  it('refuses a renewal whose term ends before the charter began', async () => {
    const { unit } = await chartered('2026-09-30');
    await expect(renewCharter(db, ctx(national), {
      unit, validUntil: '2020-01-01', reason: 'Typo.', now: NOW,
    })).rejects.toThrow(/cannot expire before it starts/i);
  });

  it('refuses a charter that would expire before it starts', async () => {
    const { unit } = await provisional();
    await expect(grantCharter(db, ctx(national), {
      unit, charteredOn: '2026-08-12', validUntil: '2026-08-11', reason: 'Typo.', now: NOW,
    })).rejects.toThrow(/cannot expire before it starts/i);
  });

  it('a provisional affiliation is real, dated and lapses like any other', async () => {
    const d = await applied();
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    // Granted from technical review with a dated term, rather than the open-ended
    // provisional standing that recordTechnicalReview('passed') produces.
    const p = await grantProvisional(db, ctx(national), {
      unit, from: '2025-01-01', validUntil: '2026-08-11', reason: 'Provisional pending final inspection.', now: NOW,
    });
    expect(p.stage).toBe('provisional');
    expect(p.status).toBe('provisional');

    const sweep = await lapseExpiredCharters(db, ctx(national), { on: NOW, kinds: ['dojo'] });
    expect(sweep.lapsed.map((u) => u.id)).toContain(d.id);
    expect((await affiliationStage(db, unit)).stage).toBe('lapsed');
  });
});

// ─── Suspension and revocation ──────────────────────────────────────────────

describe('suspension and revocation preserve the record', () => {
  it('requires a reason to suspend', async () => {
    const { unit } = await chartered();
    await expect(suspendAffiliation(db, ctx(national), { unit, reason: '', now: NOW }))
      .rejects.toThrow(/must record its reason/i);
  });

  it('suspends and reinstates, with both acts on the record', async () => {
    const { unit } = await chartered();
    await suspendAffiliation(db, ctx(national), { unit, reason: 'Complaint under investigation.', until: '2026-12-31', now: NOW });
    expect((await affiliationStage(db, unit)).status).toBe('suspended');

    await reinstateAffiliation(db, ctx(national), { unit, reason: 'Complaint not upheld.', now: NOW });
    expect((await affiliationStage(db, unit)).stage).toBe('chartered');

    const history = await affiliationHistory(db, national, unit);
    expect(history.map((h: any) => h.to)).toContain('suspended');
    expect(history.find((h: any) => h.to === 'suspended').reason).toMatch(/under investigation/i);
  });

  it('requires a reason to revoke', async () => {
    const { unit } = await chartered();
    await expect(revokeAffiliation(db, ctx(national), { unit, reason: '  ', now: NOW }))
      .rejects.toThrow(/must record its reason/i);
  });

  it('revocation never deletes the dojo, and the reason survives with it', async () => {
    const { dojo, unit } = await chartered();
    await revokeAffiliation(db, ctx(national), { unit, reason: 'Affiliation revoked by the executive, 2026.', now: NOW });

    const rows = await db.select().from(s.dojos).where(eq(s.dojos.id, dojo.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('revoked');
    // The charter dates survive, so "was affiliated from … to …" is answerable.
    expect(rows[0].affiliatedOn).toBe('2026-08-12');

    const history = await affiliationHistory(db, national, unit);
    expect(history.at(-1).reason).toMatch(/revoked by the executive/i);
  });
});

// ─── Scope ──────────────────────────────────────────────────────────────────

describe('scope is enforced on every decision', () => {
  it('ATTACK: a state officer cannot charter a dojo in another state', async () => {
    const d = await applyForAffiliation(db, ctx(national), {
      name: 'Patna Dojo', stateUnitId: BR, chiefInstructorPersonId: RANKED,
    }, NOW);
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspected.', now: NOW });

    await expect(grantCharter(db, ctx(jhSecretary), {
      unit, charteredOn: '2026-08-12', reason: 'Not my state.', now: NOW,
    })).rejects.toThrow(/Forbidden/);

    // The Bihar dojo is untouched.
    expect((await affiliationStage(db, unit)).stage).toBe('provisional');
  });

  it('the same officer may charter inside their own state', async () => {
    const { unit } = await provisional();
    const c = await grantCharter(db, ctx(jhSecretary), {
      unit, charteredOn: '2026-08-12', validUntil: '2027-08-11', reason: 'State executive resolution.', now: NOW,
    });
    expect(c.stage).toBe('chartered');
  });

  it('ATTACK: a state administrator holds no chartering authority even at home', async () => {
    const { unit } = await provisional();
    await expect(grantCharter(db, ctx(jhStateAdmin), {
      unit, charteredOn: '2026-08-12', reason: 'Self-service charter.', now: NOW,
    })).rejects.toThrow(/Forbidden/);
  });

  it('a scoped sweep lapses only what the caller may act on, and says what it skipped', async () => {
    const bihar = await applyForAffiliation(db, ctx(national), {
      name: 'Gaya Dojo', stateUnitId: BR, chiefInstructorPersonId: RANKED,
    }, NOW);
    const unit = { kind: 'dojo' as const, id: bihar.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspected.', now: NOW });
    await grantCharter(db, ctx(national), {
      unit, charteredOn: '2025-01-01', validUntil: '2026-01-31', reason: 'Charter granted.', now: NOW,
    });

    const sweep = await lapseExpiredCharters(db, ctx(jhSecretary), { on: NOW, kinds: ['dojo'] });
    expect(sweep.skipped.map((u) => u.code)).toContain(bihar.code);
    expect(sweep.lapsed.map((u) => u.code)).not.toContain(bihar.code);
    expect((await affiliationStage(db, unit)).stage).toBe('chartered');
  });

  it('refuses the affiliation history to someone outside the unit’s scope', async () => {
    const { unit } = await chartered();
    await expect(affiliationHistory(db, member, unit)).rejects.toThrow(/Forbidden/);
  });
});

// ─── Public directory ───────────────────────────────────────────────────────

describe('public directory', () => {
  const PRIVATE_KEYS = ['addressLine', 'address_line', 'email', 'phone', 'dob', 'chiefInstructorPersonId'];

  it('lists a current charter with its validity so a parent can check it', async () => {
    const { dojo } = await chartered('2027-08-11', { name: 'Directory Current', addressLine: 'Flat 4, 12 Private Road' });
    const dir = await publicDirectory(db, { on: NOW });
    const entry = dir.find((e) => e.code === dojo.code)!;
    expect(entry).toBeTruthy();
    expect(entry.standing).toBe('chartered');
    expect(entry.affiliated).toBe(true);
    expect(entry.charterValidUntil).toBe('2027-08-11');
    expect(entry.charterCurrent).toBe(true);
    expect(entry.state).toBe('Jharkhand');
  });

  it('carries no private contact data', async () => {
    const { dojo } = await chartered('2027-08-11', { name: 'Directory Private', addressLine: 'Flat 9, 3 Home Lane' });
    const entry = (await publicDirectory(db, { on: NOW })).find((e) => e.code === dojo.code)!;
    for (const k of PRIVATE_KEYS) expect(Object.keys(entry)).not.toContain(k);
    expect(JSON.stringify(entry)).not.toMatch(/Home Lane/);
  });

  it('ATTACK: an applicant that has never been affiliated never appears', async () => {
    const applicant = await applied({ name: 'Directory Applicant' });
    const underReview = await applied({ name: 'Directory Under Review' });
    await beginDocumentReview(db, ctx(national), {
      unit: { kind: 'dojo', id: underReview.id }, reason: 'Received.', now: NOW,
    });

    const open = await publicDirectory(db, { on: NOW });
    const withFormer = await publicDirectory(db, { on: NOW, includeFormer: true });
    for (const dir of [open, withFormer]) {
      expect(dir.map((e) => e.code)).not.toContain(applicant.code);
      expect(dir.map((e) => e.code)).not.toContain(underReview.code);
    }
  });

  it('says a dojo WAS affiliated and no longer is, rather than vanishing', async () => {
    const { dojo, unit } = await chartered('2027-08-11', { name: 'Directory Revoked' });
    await revokeAffiliation(db, ctx(national), { unit, reason: 'Revoked by the executive.', now: NOW });

    expect((await publicDirectory(db, { on: NOW })).map((e) => e.code)).not.toContain(dojo.code);

    const entry = (await publicDirectory(db, { on: NOW, includeFormer: true })).find((e) => e.code === dojo.code)!;
    expect(entry.standing).toBe('revoked');
    expect(entry.affiliated).toBe(false);
    expect(entry.affiliatedSince).toBe('2026-08-12');
    expect(entry.note).toMatch(/was affiliated.*revoked/i);
  });

  it('does not present an out-of-date charter as current', async () => {
    // Chartered, then the expiry passes before the lapse sweep has run.
    const { dojo } = await chartered('2026-08-11', { name: 'Directory Stale' });
    const entry = (await publicDirectory(db, { on: NOW })).find((e) => e.code === dojo.code)!;
    expect(entry.charterCurrent).toBe(false);
    expect(entry.affiliated).toBe(false);
    expect(entry.note).toMatch(/has not yet been renewed/i);
  });

  it('does not present an out-of-date PROVISIONAL term as current either', async () => {
    const d = await applied({ name: 'Directory Stale Provisional' });
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    await grantProvisional(db, ctx(national), {
      unit, from: '2025-01-01', validUntil: '2026-08-11', reason: 'Provisional pending inspection.', now: NOW,
    });

    const entry = (await publicDirectory(db, { on: NOW })).find((e) => e.code === d.code)!;
    expect(entry.standing).toBe('provisional');
    expect(entry.affiliated).toBe(false);
    // Must not read as a live provisional affiliation beside affiliated:false.
    expect(entry.note).toMatch(/validity date has passed/i);
  });

  // A REFUSED APPLICANT IS NOT A FORMER AFFILIATE. The refusal lands the unit at
  // `revoked`, which the status column cannot tell apart from a charter the
  // federation withdrew — so the directory published a club whose paperwork was
  // thrown out as "This unit was affiliated. Its affiliation has been revoked."
  it('ATTACK: never publishes a refused applicant as a club that WAS affiliated', async () => {
    const d = await applied({ name: 'Refused Club' });
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Dossier received.', now: NOW });
    await recordDocumentReview(db, ctx(national), {
      unit, decision: 'refused', reason: 'Registration certificate found to be forged.', now: NOW,
    });

    for (const dir of [
      await publicDirectory(db, { on: NOW }),
      await publicDirectory(db, { includeFormer: true, on: NOW }),
    ]) {
      expect(dir.find((e) => e.name === 'Refused Club')).toBeUndefined();
    }

    // Absent from the directory, but NOT deleted: the refusal is still history,
    // with its reason, for anyone entitled to read the file.
    expect((await affiliationStage(db, unit)).stage).toBe('revoked');
    const trail = await affiliationHistory(db, national, unit);
    expect(trail.at(-1)!.reason).toMatch(/forged/i);
  });

  it('says when an affiliation carries no validity date at all, rather than showing a bare badge', async () => {
    const { unit } = await provisional({ name: 'Termless Club' });
    void unit;
    const e = (await publicDirectory(db, { on: NOW })).find((x) => x.name === 'Termless Club')!;
    expect(e.standing).toBe('provisional');
    expect(e.charterValidUntil).toBeNull();
    expect(e.note).toMatch(/no validity date/i);
  });

  it('filters by state', async () => {
    const jhDir = await publicDirectory(db, { on: NOW, stateUnitId: JH });
    expect(jhDir.length).toBeGreaterThan(0);
    expect(jhDir.every((e) => e.state === 'Jharkhand')).toBe(true);
  });

  it('exposes the same lifecycle for state and district units', async () => {
    // A district that HAS been chartered — otherwise it is a former applicant,
    // not a former affiliate, and the directory rightly refuses to list it.
    await db.update(s.districtUnits).set({ charteredOn: '2020-01-01' })
      .where(eq(s.districtUnits.id, RAMGARH));
    await revokeAffiliation(db, ctx(national), {
      unit: { kind: 'district', id: RAMGARH }, reason: 'District unit dissolved by resolution.', now: NOW,
    });
    const dir = await publicDirectory(db, { kind: 'district', on: NOW, includeFormer: true });
    const entry = dir.find((e) => e.code === 'MMAKF-DIST-JH-RMG')!;
    expect(entry.standing).toBe('revoked');
    expect(entry.district).toBe('Ramgarh');
    expect(AffiliationError).toBeTruthy();
  });
});

// ─── Authorisation: a refusal must not double as a read ─────────────────────

describe('authorisation is checked before anything is disclosed', () => {
  it('ATTACK: an unauthorised caller learns nothing about an applicant from a review', async () => {
    const d = await applied({ name: 'Probe Target' });
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });

    const criteria: AffiliationCriteria = {
      code: 'BYE-LAW-9', version: '2026',
      criteria: [{
        key: 'members', label: 'Minimum membership', requirement: '20 registered members',
        measure: 'registered_members', minimum: 20,
      }],
    };

    // The criteria check used to run BEFORE authorisation, so a stranger could
    // feed criteria in and read a club's membership numbers back out of the
    // refusal — a state disclosure dressed up as a validation error.
    const err = await recordDocumentReview(db, ctx(member), {
      unit, decision: 'passed', reason: 'Trying it on.', criteria, now: NOW,
    }).catch((e) => e);

    expect(err.message).toMatch(/Forbidden/);
    expect(err.message).not.toMatch(/does not meet published criteria/i);
    expect(err.message).not.toMatch(/members/i);
    // And nothing moved.
    expect((await affiliationStage(db, unit)).stage).toBe('document_review');
  });

  it('ATTACK: an assessment is not readable by someone with no authority over the unit', async () => {
    const { unit } = await provisional({ name: 'Private Numbers' });
    await expect(assessAffiliation(db, member, unit, {
      code: 'BYE-LAW-9', version: '2026',
      criteria: [{ key: 'm', label: 'Members', requirement: 'members', measure: 'registered_members' }],
    }, NOW)).rejects.toThrow(/Forbidden/);
  });
});

// ─── Integrity: official records are superseded, never edited ───────────────

describe('an accepted piece of evidence is an official record', () => {
  it('ATTACK: an acceptance cannot be re-taken, erasing the officer who gave it', async () => {
    const { unit } = await provisional({ name: 'Evidence Club' });
    const { version } = await submitAffiliationEvidence(db, ctx(national), {
      unit, category: 'registration', title: 'Society registration', bodyMarkdown: 'x',
    }, NOW);

    await acceptAffiliationEvidence(db, ctx(national), {
      unit, documentVersionId: version.id, acceptedByPersonId: RANKED,
      reason: 'Verified against the Registrar of Societies.',
    }, NOW);

    await expect(acceptAffiliationEvidence(db, ctx(national), {
      unit, documentVersionId: version.id, acceptedByPersonId: null, reason: 'On reflection.',
    }, NOW)).rejects.toThrow(/already been accepted/i);

    // The original acceptance is intact — officer, date and authority.
    const [row] = await db.select().from(s.documentVersions).where(eq(s.documentVersions.id, version.id));
    expect(row.approvedByPersonId).toBe(RANKED);
    expect(row.approvedUnder).toMatch(/Registrar of Societies/);

    // A second look appends a version; it does not overwrite the first.
    const again = await submitAffiliationEvidence(db, ctx(national), {
      unit, category: 'registration', title: 'Society registration', bodyMarkdown: 'y',
    }, NOW);
    expect(again.version.id).not.toBe(version.id);
    expect(again.version.status).toBe('under_review');
  });

  it('the audit row carries the officer and authority it recorded, not just a status', async () => {
    const { unit } = await provisional({ name: 'Evidence Club Two' });
    const { version } = await submitAffiliationEvidence(db, ctx(national), {
      unit, category: 'insurance', title: 'Public liability', bodyMarkdown: 'x',
    }, NOW);
    await acceptAffiliationEvidence(db, ctx(national), {
      unit, documentVersionId: version.id, acceptedByPersonId: RANKED, reason: 'Policy sighted.',
    }, NOW);

    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityId, String(version.id)));
    const approved = rows.find((r: any) => r.action === 'approve');
    expect(approved.newValue.approvedByPersonId).toBe(RANKED);
    expect(approved.newValue.approvedUnder).toMatch(/Policy sighted/);
    expect(approved.oldValue.status).toBe('under_review');
  });
});

describe('a standing is restored, never upgraded', () => {
  it('ATTACK: lifting a suspension does not turn a provisional affiliation into a charter', async () => {
    const { unit } = await provisional({ name: 'Suspended Provisional' });
    await grantProvisional(db, ctx(national), {
      unit, from: '2026-01-01', validUntil: '2026-12-31', reason: 'Provisional term set.', now: NOW,
    });
    await suspendAffiliation(db, ctx(national), { unit, reason: 'Complaint under investigation.', now: NOW });
    const back = await reinstateAffiliation(db, ctx(national), { unit, reason: 'Complaint not upheld.', now: NOW });

    // Two innocuous-looking calls used to produce a full charter that no
    // chartering decision anywhere in the file had authorised.
    expect(back.stage).toBe('provisional');
    expect(back.status).toBe('provisional');
    const e = (await publicDirectory(db, { on: NOW })).find((x) => x.name === 'Suspended Provisional')!;
    expect(e.standing).toBe('provisional');

    // And the ledger can be read back to show what was restored, and from what.
    const trail = await affiliationHistory(db, national, unit);
    expect(trail.at(-1)!.detail.suspendedFrom).toBe('provisional');
    expect(trail.at(-1)!.detail.restoredByCallerChoice).toBe(false);
  });

  it('restores a chartered unit to charter, and marks an officer who chose otherwise', async () => {
    const { unit } = await chartered('2027-08-11', { name: 'Suspended Charter' });
    await suspendAffiliation(db, ctx(national), { unit, reason: 'Safeguarding referral.', now: NOW });
    const back = await reinstateAffiliation(db, ctx(national), { unit, reason: 'Referral closed.', now: NOW });
    expect(back.stage).toBe('chartered');

    await suspendAffiliation(db, ctx(national), { unit, reason: 'Second referral.', now: NOW });
    const down = await reinstateAffiliation(db, ctx(national), {
      unit, to: 'provisional', reason: 'Returned to provisional pending re-inspection.', now: NOW,
    });
    expect(down.stage).toBe('provisional');
    const trail = await affiliationHistory(db, national, unit);
    expect(trail.at(-1)!.detail.restoredByCallerChoice).toBe(true);
    expect(trail.at(-1)!.detail.suspendedFrom).toBe('chartered');
  });

  it('refuses to guess the standing to restore when the records do not show it', async () => {
    const [legacy] = await db.insert(s.dojos).values({
      code: 'MMAKF-DOJO-LEGACY-SUSP', name: 'Legacy Suspended', stateUnitId: JH, status: 'suspended',
    }).returning();
    const unit = { kind: 'dojo' as const, id: legacy.id };

    await expect(reinstateAffiliation(db, ctx(national), { unit, reason: 'Lifted.', now: NOW }))
      .rejects.toThrow(/must be stated explicitly/i);

    const back = await reinstateAffiliation(db, ctx(national), {
      unit, to: 'provisional', reason: 'Lifted to provisional; the earlier standing is not on record.', now: NOW,
    });
    expect(back.stage).toBe('provisional');
  });
});

describe('a renewal renews something that exists', () => {
  it('ATTACK: a unit that has only ever been provisional cannot be renewed into a charter', async () => {
    const { unit } = await provisional({ name: 'Never Chartered' });
    await grantProvisional(db, ctx(national), {
      unit, from: '2026-01-01', validUntil: '2026-12-31', reason: 'Term set.', now: NOW,
    });
    await expect(renewCharter(db, ctx(national), {
      unit, validUntil: '2027-12-31', reason: 'Renewing.', now: NOW,
    })).rejects.toThrow(/never held a charter/i);
    expect((await affiliationStage(db, unit)).stage).toBe('provisional');
  });

  it('ATTACK: a renewal does not double as the lifting of a suspension', async () => {
    const { unit } = await chartered('2027-08-11', { name: 'Suspended Renewal' });
    await suspendAffiliation(db, ctx(national), { unit, reason: 'Under investigation.', now: NOW });
    await expect(renewCharter(db, ctx(national), {
      unit, validUntil: '2028-08-11', reason: 'Renewing.', now: NOW,
    })).rejects.toThrow(/suspended/i);
    expect((await affiliationStage(db, unit)).stage).toBe('suspended');
  });
});

describe('a provisional standing has a term, or says it has none', () => {
  it('passing technical review confers provisional standing with NO term, and says so', async () => {
    const d = await applied({ name: 'Fresh Provisional' });
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    const t = await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspected.', now: NOW });

    expect(t.stage).toBe('provisional');
    expect(t.provisionalTermRecorded).toBe(false);
    expect(t.termNote).toMatch(/no term recorded/i);
  });

  it('a term can then be recorded against it — and the sweep can reach it', async () => {
    const d = await applied({ name: 'Termed Later' });
    const unit = { kind: 'dojo' as const, id: d.id };
    await beginDocumentReview(db, ctx(national), { unit, reason: 'Received.', now: NOW });
    await recordDocumentReview(db, ctx(national), { unit, decision: 'passed', reason: 'Complete.', now: NOW });
    await recordTechnicalReview(db, ctx(national), { unit, decision: 'passed', reason: 'Inspected.', now: NOW });

    // Before the fix this was refused as a no-op, which left every unit coming
    // through the normal review path provisionally affiliated for ever: no start
    // date, no end date, and unreachable by the lapse sweep.
    const p = await grantProvisional(db, ctx(national), {
      unit, from: '2025-01-01', validUntil: '2026-08-11', reason: 'Six-month provisional period.', now: NOW,
    });
    expect(p.termHasExpiry).toBe(true);
    expect(p.validUntil).toBe('2026-08-11');

    const sweep = await lapseExpiredCharters(db, ctx(national), { on: NOW, kinds: ['dojo'] });
    expect(sweep.lapsed.map((u) => u.id)).toContain(d.id);
  });

  it('says so when a provisional term is left open-ended', async () => {
    const { unit } = await provisional({ name: 'Open Provisional' });
    const p = await grantProvisional(db, ctx(national), {
      unit, from: '2026-01-01', validUntil: null, reason: 'Pending inspection.', now: NOW,
    });
    expect(p.termHasExpiry).toBe(false);
    expect(p.note).toMatch(/will not lapse on a schedule/i);
  });

  it('refuses a provisional term that ends before it begins', async () => {
    const { unit } = await provisional({ name: 'Backwards Provisional' });
    await expect(grantProvisional(db, ctx(national), {
      unit, from: '2026-06-01', validUntil: '2026-01-01', reason: 'Nonsense.', now: NOW,
    })).rejects.toThrow(/cannot expire before it starts/i);
  });
});

describe('the ledger and the status column must agree', () => {
  it('ATTACK: reports a status changed outside the lifecycle instead of believing the ledger', async () => {
    const { unit } = await chartered('2027-01-01', { name: 'Drift Club' });
    // Another module — or a hand-run UPDATE — moves the column the ledger owns.
    await db.update(s.dojos).set({ status: 'suspended' }).where(eq(s.dojos.id, unit.id));

    const st = await affiliationStage(db, unit);
    // The column is what the rest of the federation acts on, so it wins: the
    // module does not go on offering `renewal_due` for a suspended dojo.
    expect(st.stage).toBe('suspended');
    expect(st.ledgerStage).toBe('chartered');
    expect(st.stageConsistent).toBe(false);
    expect(st.stageNote).toMatch(/changed outside the affiliation lifecycle/i);
    expect(st.nextStages).not.toContain('renewal_due');

    // And the disagreement travels with the charter view a caller actually reads.
    const standing = await charterStanding(db, unit, { on: NOW });
    expect(standing.stageConsistent).toBe(false);
    expect(standing.affiliated).toBe(false);
    expect(standing.note).toMatch(/changed outside the affiliation lifecycle/i);
  });
});
