// The regulatory engine — source integrity, lifecycle, and time.
//
// The brief this was built to says: for every regulation, prove the valid case,
// the invalid case, the boundary case, the expired policy, the future policy and
// the historical policy. Those six are §4 below, and they are the reason the
// whole subsystem resolves rules by DATE rather than by status.
//
// The other suites here are the refusals — the ones that stop the engine
// becoming the thing it was built to prevent:
//
//   · academy material cannot become MMAKF policy by anybody setting a dropdown;
//   · a rule nobody approved decides NOTHING, and says so in its own words;
//   · a missing fact is not a failed condition;
//   · a determination pins the rule VERSION, so amending a rule next year cannot
//     restate what was decided this year.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  recordSourceDocument, recordSourceProvision, markSourceProvision, listSourceProvisions,
  createInstrument, draftInstrumentVersion, addProvision, adoptSourceProvision,
  advanceInstrumentState, publishInstrumentVersion,
  defineRule, draftRuleVersion, approveRuleVersion, publishRuleVersion,
  ruleInForceOn, evaluate, recordDetermination, supersedeDetermination,
  determinationsForPerson, provenanceChain, publicRegister, rulesFor,
  inForceOn, isPolicyError,
} from '../src/db/policy';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let PERSON: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const technical: Principal = {
  userId: 2, label: 'technical director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const president: Principal = {
  userId: 3, label: 'president',
  bindings: [{ role: 'PRESIDENT', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 4, label: 'an athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = admin): AuditContext =>
  ({ principal: p, reason: 'test', authority: 'test' });

/** A source document and one provision off it, as the register records them. */
async function academySource(ref: string, over: Record<string, any> = {}) {
  const doc = await recordSourceDocument(db, ctx(), {
    code: `KAB-DOC-${ref}`,
    layer: 'academy_source',
    sourceOrg: 'Karate Academy Bharat',
    sourceTitle: 'Rules & Regulation',
    sourceUrl: 'https://www.karateacademy.in/karate-academy/rules-regulation',
    sourceSection: 'Rules of Dojo',
    retrievedOn: '2026-08-17',
    content: 'Be in Uniform (GI) appropriately. (NF/WKF Approved)',
    fetchEvidence: 'text/html · 200',
  });
  return recordSourceProvision(db, ctx(), {
    ref,
    sourceDocumentId: doc.id,
    topic: 'uniform',
    sourceExcerpt: 'Be in Uniform (GI) appropriately. (NF/WKF Approved)',
    normalizedRule: 'A student shall train in a gi meeting national-federation / WKF approval.',
    confidence: 'verbatim',
    ...over,
  });
}

/** An instrument with one drafted version, ready to be approved. */
async function instrumentWithVersion(code: string, opts: Record<string, any> = {}) {
  const inst = await createInstrument(db, ctx(), {
    code,
    title: 'Instructor Appointment Regulation',
    instrumentType: 'regulation',
    subjectArea: 'instructor',
    ...opts,
  });
  const version = await draftInstrumentVersion(db, ctx(), {
    instrumentId: inst.id, version: '1.0', bodyMarkdown: '# Instructor Appointment Regulation',
  });
  return { inst, version };
}

/** Draft → approved → published, with real dates. */
async function publishedInstrument(code: string, from = '2026-04-01', opts: Record<string, any> = {}) {
  const { inst, version } = await instrumentWithVersion(code, opts);
  await advanceInstrumentState(db, ctx(), version.id, 'governance_review');
  await advanceInstrumentState(db, ctx(president), version.id, 'approved', {
    approvedByPersonId: PERSON, approvedOn: '2026-03-01',
  });
  const published = await publishInstrumentVersion(db, ctx(), version.id, { effectiveFrom: from });
  return { inst, version: published };
}

/**
 * A rule in force from `from` to `to`, on the given instrument.
 *
 * The 4th Kyu instructor-intern requirement, which is KAB-012.1 in the source
 * register — the most concrete rule the academy publishes and the one this
 * engine was shaped around. `grade_rank` counts upward from white so that a
 * higher number is a higher grade; the register's warning about comparing belt
 * COLOURS as strings is why the fact is numeric.
 */
async function ruleInForce(
  code: string,
  instrumentId: number,
  instrumentVersionId: number,
  from: string,
  to: string | null = null,
  over: Record<string, any> = {}
) {
  const rule = await defineRule(db, ctx(), {
    code, title: 'Minimum grade for instructor intern',
    instrumentId, subjectKind: 'instructor_application',
  });
  const v = await draftRuleVersion(db, ctx(), {
    ruleId: rule.id,
    version: over.version ?? '1.0',
    instrumentVersionId,
    conditions: over.conditions ?? [
      { fact: 'grade_rank', op: 'gte', value: 6, label: 'holds 4th Kyu (Brown) or above' },
    ],
    refusalReason: over.refusalReason ?? 'The published minimum grade for this pathway is 4th Kyu.',
    ...(over.outcomeUnmet ? { outcomeUnmet: over.outcomeUnmet } : {}),
    ...(over.outcomeMet ? { outcomeMet: over.outcomeMet } : {}),
  });
  await approveRuleVersion(db, ctx(president), v.id, {
    approvedByPersonId: PERSON, approvedOn: '2026-03-01',
  });
  return {
    rule,
    version: await publishRuleVersion(db, ctx(), v.id, { effectiveFrom: from, effectiveTo: to }),
  };
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
});

beforeEach(async () => {
  // Order matters: children before parents.
  await db.delete(s.policyDeterminations);
  await db.delete(s.policyRuleVersions);
  await db.delete(s.policyRules);
  await db.delete(s.policyProvisions);
  await db.delete(s.policyInstrumentVersions);
  await db.delete(s.policyInstruments);
  await db.delete(s.sourceProvisions);
  await db.delete(s.sourceDocuments);
  await db.delete(s.persons);

  const [p] = await db.insert(s.persons).values({
    federationId: 'MMAKF-MEM-2026-000001', fullName: 'Approving officer', status: 'active',
  }).returning({ id: s.persons.id });
  PERSON = p.id;
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Source integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('the source register', () => {
  it('records the URL, the excerpt and a checksum of what was read', async () => {
    const provision = await academySource('KAB-001.3');
    const [doc] = await db.select().from(s.sourceDocuments)
      .where(eq(s.sourceDocuments.id, provision.sourceDocumentId));

    expect(doc.sourceUrl).toContain('karateacademy.in');
    expect(doc.retrievedOn).toBe('2026-08-17');
    // 64 hex characters — the text as it stood when it was read. Without this,
    // "the website says X" is unfalsifiable a year later.
    expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provision.sourceExcerpt).toContain('WKF Approved');
  });

  it('refuses to hold an MMAKF instrument as source material', async () => {
    await expect(recordSourceDocument(db, ctx(), {
      code: 'X', layer: 'mmakf_regulation' as any, sourceOrg: 'MMAKF',
      sourceTitle: 'Ours', sourceUrl: 'https://mmakf.in/x', retrievedOn: '2026-08-17',
    })).rejects.toMatchObject({ code: 'bad_layer' });
  });

  it('will not record a provision without both the excerpt and the normalisation', async () => {
    const doc = await recordSourceDocument(db, ctx(), {
      code: 'KAB-DOC-FEE', layer: 'academy_source', sourceOrg: 'Karate Academy Bharat',
      sourceTitle: 'Fee Structure', sourceUrl: 'https://www.karateacademy.in/fee-structure',
      retrievedOn: '2026-08-17',
    });
    await expect(recordSourceProvision(db, ctx(), {
      ref: 'KAB-010.1', sourceDocumentId: doc.id, topic: 'fees',
      sourceExcerpt: '', normalizedRule: 'Admission fee is ₹500.', confidence: 'verbatim',
    })).rejects.toMatchObject({ code: 'no_excerpt' });

    await expect(recordSourceProvision(db, ctx(), {
      ref: 'KAB-010.1', sourceDocumentId: doc.id, topic: 'fees',
      sourceExcerpt: 'Admission Fees: 500', normalizedRule: '  ', confidence: 'verbatim',
    })).rejects.toMatchObject({ code: 'no_normalisation' });
  });

  it('inherits the layer from the document, so a provision cannot claim a different provenance', async () => {
    const p = await academySource('KAB-001.6');
    expect(p.layer).toBe('academy_source');
    expect(p.adoptionStatus).toBe('not_adopted');
  });

  it('refuses to let anybody set a provision to "adopted" directly', async () => {
    await academySource('KAB-001.1');
    await expect(markSourceProvision(db, ctx(), 'KAB-001.1', 'adopted' as any))
      .rejects.toMatchObject({ code: 'adoption_not_a_status' });
  });

  it('requires a stated reason before flagging or rejecting published material', async () => {
    await academySource('KAB-003');
    await expect(markSourceProvision(db, ctx(), 'KAB-003', 'flagged_not_adoptable'))
      .rejects.toMatchObject({ code: 'reason_required' });

    const flagged = await markSourceProvision(
      db, ctx(), 'KAB-003', 'flagged_not_adoptable',
      'Conditions a child\'s access to sport on a parent\'s private conduct. Not adoptable — see gap analysis §4.2.'
    );
    expect(flagged.adoptionStatus).toBe('flagged_not_adoptable');
    expect(flagged.adoptionNote).toContain('gap analysis');
  });

  it('keeps flagged material in the register rather than deleting it', async () => {
    await academySource('KAB-003');
    await markSourceProvision(db, ctx(), 'KAB-003', 'flagged_not_adoptable', 'not adoptable');
    const rows = await listSourceProvisions(db, admin, { adoptionStatus: 'flagged_not_adoptable' });
    expect(rows).toHaveLength(1);
    expect(rows[0].document.sourceUrl).toContain('karateacademy.in');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Adoption is an event, not a checkbox
// ─────────────────────────────────────────────────────────────────────────────

describe('adoption', () => {
  it('refuses to carry flagged-not-adoptable material into an instrument', async () => {
    await academySource('KAB-003');
    await markSourceProvision(db, ctx(), 'KAB-003', 'flagged_not_adoptable', 'see gap analysis §4.2');
    const { version } = await instrumentWithVersion('MMAKF-CODE-STUDENT');

    await expect(adoptSourceProvision(db, ctx(), {
      sourceRef: 'KAB-003', instrumentVersionId: version.id, clauseRef: '2.1',
      text: 'Members shall abstain from …', adoptedByPersonId: PERSON, adoptedOn: '2026-03-01',
    })).rejects.toMatchObject({ code: 'flagged_not_adoptable' });
  });

  it('does not adopt on citation — only on publication', async () => {
    await academySource('KAB-001.3');
    const { version } = await instrumentWithVersion('MMAKF-CODE-DOJO');

    await adoptSourceProvision(db, ctx(), {
      sourceRef: 'KAB-001.3', instrumentVersionId: version.id, clauseRef: '3.1',
      text: 'A member shall train in a gi meeting the WKF specification.',
      adoptedByPersonId: PERSON, adoptedOn: '2026-03-01',
    });

    // Cited, drafted, and NOT yet policy: the instrument binds nobody.
    let [src] = await db.select().from(s.sourceProvisions)
      .where(eq(s.sourceProvisions.ref, 'KAB-001.3'));
    expect(src.adoptionStatus).toBe('under_review');

    await advanceInstrumentState(db, ctx(), version.id, 'governance_review');
    await advanceInstrumentState(db, ctx(president), version.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-10',
    });
    await publishInstrumentVersion(db, ctx(), version.id, { effectiveFrom: '2026-04-01' });

    [src] = await db.select().from(s.sourceProvisions)
      .where(eq(s.sourceProvisions.ref, 'KAB-001.3'));
    expect(src.adoptionStatus).toBe('adopted');
  });

  it('records who adopted it and when, alongside the source it came from', async () => {
    await academySource('KAB-012.1');
    const { version } = await instrumentWithVersion('MMAKF-REG-INSTRUCTOR');
    const clause = await adoptSourceProvision(db, ctx(), {
      sourceRef: 'KAB-012.1', instrumentVersionId: version.id, clauseRef: '4.2',
      text: 'An applicant for the instructor-intern pathway shall hold 4th Kyu or above.',
      adoptedByPersonId: PERSON, adoptedOn: '2026-03-01',
      adoptionNote: 'Adopted as published by Karate Academy Bharat.',
    });
    expect(clause.derivation).toBe('source_derived');
    expect(clause.adoptedByPersonId).toBe(PERSON);
    expect(clause.adoptedOn).toBe('2026-03-01');
    expect(clause.sourceProvisionId).toBeTruthy();
  });

  it('will not let a clause claim to be somebody else\'s rule without naming them', async () => {
    const { version } = await instrumentWithVersion('MMAKF-POL-ANTIDOPING');
    await expect(addProvision(db, ctx(), {
      instrumentVersionId: version.id, clauseRef: '1.1',
      text: 'Doping is prohibited.', derivation: 'external_reference',
    })).rejects.toMatchObject({ code: 'no_external_body' });

    const ok = await addProvision(db, ctx(), {
      instrumentVersionId: version.id, clauseRef: '1.1',
      text: 'The National Anti-Doping Rules apply to every MMAKF event.',
      derivation: 'external_reference', externalBody: 'NADA India',
      externalCitation: 'National Anti-Doping Rules',
    });
    expect(ok.externalBody).toBe('NADA India');
  });

  it('freezes a published version against further clauses', async () => {
    const { version } = await publishedInstrument('MMAKF-REG-FROZEN');
    await expect(addProvision(db, ctx(), {
      instrumentVersionId: version.id, clauseRef: '9.9',
      text: 'A clause slipped in after approval.', derivation: 'proposed',
    })).rejects.toMatchObject({ code: 'version_frozen' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Lifecycle and approval
// ─────────────────────────────────────────────────────────────────────────────

describe('the instrument lifecycle', () => {
  it('refuses a jump from draft straight to approved', async () => {
    const { version } = await instrumentWithVersion('MMAKF-REG-JUMP');
    await expect(advanceInstrumentState(db, ctx(president), version.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    })).rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('refuses an approval with nobody\'s name on it', async () => {
    const { version } = await instrumentWithVersion('MMAKF-REG-ANON');
    await advanceInstrumentState(db, ctx(), version.id, 'governance_review');
    await expect(advanceInstrumentState(db, ctx(president), version.id, 'approved', {
      approvedOn: '2026-03-01',
    })).rejects.toMatchObject({ code: 'no_approver' });
  });

  it('refuses to publish anything that has not been approved', async () => {
    const { version } = await instrumentWithVersion('MMAKF-REG-UNAPPROVED');
    await expect(publishInstrumentVersion(db, ctx(), version.id, { effectiveFrom: '2026-04-01' }))
      .rejects.toMatchObject({ code: 'not_approved' });
  });

  it('refuses a rule that would take effect before it was approved', async () => {
    const { version } = await instrumentWithVersion('MMAKF-REG-BACKDATED');
    await advanceInstrumentState(db, ctx(), version.id, 'governance_review');
    await advanceInstrumentState(db, ctx(president), version.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    });
    await expect(publishInstrumentVersion(db, ctx(), version.id, { effectiveFrom: '2026-01-01' }))
      .rejects.toMatchObject({ code: 'backdated' });
  });

  it('checksums the text it publishes', async () => {
    const { version } = await publishedInstrument('MMAKF-REG-HASHED');
    expect(version.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version.publishedAt).toBeTruthy();
  });

  it('closes the predecessor exactly where the successor begins', async () => {
    const { inst, version: v1 } = await publishedInstrument('MMAKF-REG-SUCCESSION', '2026-04-01');

    const v2 = await draftInstrumentVersion(db, ctx(), {
      instrumentId: inst.id, version: '2.0', bodyMarkdown: '# Second edition',
    });
    await advanceInstrumentState(db, ctx(), v2.id, 'governance_review');
    await advanceInstrumentState(db, ctx(president), v2.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2027-02-01',
    });
    const published2 = await publishInstrumentVersion(db, ctx(), v2.id, { effectiveFrom: '2027-04-01' });

    const [closed] = await db.select().from(s.policyInstrumentVersions)
      .where(eq(s.policyInstrumentVersions.id, v1.id));

    expect(closed.state).toBe('superseded');
    expect(closed.effectiveTo).toBe('2027-04-01');
    expect(published2.supersedesVersionId).toBe(v1.id);

    // No gap and no overlap: the last day of v1 is the day before v2 starts.
    expect(inForceOn('2027-03-31', closed.effectiveFrom, closed.effectiveTo)).toBe(true);
    expect(inForceOn('2027-04-01', closed.effectiveFrom, closed.effectiveTo)).toBe(false);
    expect(inForceOn('2027-04-01', published2.effectiveFrom, published2.effectiveTo)).toBe(true);
  });

  it('will not bring a rule into force under an unpublished instrument', async () => {
    const { inst, version } = await instrumentWithVersion('MMAKF-REG-UNREADABLE');
    const rule = await defineRule(db, ctx(), {
      code: 'RULE-UNREADABLE', title: 'A rule under a regulation nobody can read',
      instrumentId: inst.id, subjectKind: 'instructor_application',
    });
    const rv = await draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '1.0', instrumentVersionId: version.id,
      conditions: [{ fact: 'grade_rank', op: 'gte', value: 6 }],
    });
    await approveRuleVersion(db, ctx(president), rv.id, {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    });
    await expect(publishRuleVersion(db, ctx(), rv.id, { effectiveFrom: '2026-04-01' }))
      .rejects.toMatchObject({ code: 'instrument_not_published' });
  });

  it('refuses a rule with no instrument behind it', async () => {
    await expect(defineRule(db, ctx(), {
      code: 'RULE-ORPHAN', title: 'Hard-coded by another name',
      instrumentId: 999_999, subjectKind: 'instructor_application',
    })).rejects.toMatchObject({ code: 'no_instrument' });
  });

  it('rejects a condition the engine cannot read', async () => {
    const { inst } = await publishedInstrument('MMAKF-REG-BADCOND');
    const rule = await defineRule(db, ctx(), {
      code: 'RULE-BADCOND', title: 'x', instrumentId: inst.id, subjectKind: 'x',
    });
    await expect(draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '1.0',
      conditions: [{ fact: 'grade', op: 'matches_regex' as any, value: '.*' }],
    })).rejects.toMatchObject({ code: 'bad_conditions' });

    await expect(draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '1.1', conditions: [],
    })).rejects.toMatchObject({ code: 'bad_conditions' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — The six cases the brief requires of every regulation
// ─────────────────────────────────────────────────────────────────────────────

describe('rule evaluation', () => {
  const facts = (rank: number) => ({ grade_rank: rank });

  it('VALID CASE — a subject meeting every condition is eligible', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-A');
    await ruleInForce('RULE-A', inst.id, version.id, '2026-04-01');

    const r = await evaluate(db, { ruleCode: 'RULE-A', facts: facts(7), on: '2026-06-01' });
    expect(r.outcome).toBe('eligible');
    expect(r.ruleVersion).toBe('1.0');
    expect(r.instrumentCode).toBe('MMAKF-REG-EVAL-A');
    expect(r.approvedOn).toBe('2026-03-01');
    expect(r.appealable).toBe(true);
  });

  it('INVALID CASE — a subject failing a condition is ineligible, with the published reason', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-B');
    await ruleInForce('RULE-B', inst.id, version.id, '2026-04-01');

    const r = await evaluate(db, { ruleCode: 'RULE-B', facts: facts(3), on: '2026-06-01' });
    expect(r.outcome).toBe('ineligible');
    expect(r.reason).toContain('4th Kyu');
    expect(r.conditions[0].met).toBe(false);
    expect(r.conditions[0].actual).toBe(3);
    // A refusal must be challengeable.
    expect(r.appealable).toBe(true);
  });

  it('BOUNDARY CASE — exactly at the threshold passes, one below does not', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-C');
    await ruleInForce('RULE-C', inst.id, version.id, '2026-04-01');

    expect((await evaluate(db, { ruleCode: 'RULE-C', facts: facts(6), on: '2026-06-01' })).outcome)
      .toBe('eligible');
    expect((await evaluate(db, { ruleCode: 'RULE-C', facts: facts(5), on: '2026-06-01' })).outcome)
      .toBe('ineligible');
  });

  it('BOUNDARY CASE — the first day of the window is in force, the last is not', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-D');
    await ruleInForce('RULE-D', inst.id, version.id, '2026-04-01', '2027-04-01');

    // Effective from, inclusive.
    expect((await evaluate(db, { ruleCode: 'RULE-D', facts: facts(7), on: '2026-04-01' })).outcome)
      .toBe('eligible');
    // The day before the end, still in force.
    expect((await evaluate(db, { ruleCode: 'RULE-D', facts: facts(7), on: '2027-03-31' })).outcome)
      .toBe('eligible');
    // Effective to, EXCLUSIVE — the rule is gone on this day.
    expect((await evaluate(db, { ruleCode: 'RULE-D', facts: facts(7), on: '2027-04-01' })).outcome)
      .toBe('no_rule_in_force');
  });

  it('EXPIRED POLICY — after the window, nothing is decided against the subject', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-E');
    await ruleInForce('RULE-E', inst.id, version.id, '2026-04-01', '2026-10-01');

    const r = await evaluate(db, { ruleCode: 'RULE-E', facts: facts(1), on: '2026-12-01' });
    expect(r.outcome).toBe('no_rule_in_force');
    expect(r.reason).toContain('absence of policy');
    // Emphatically NOT 'ineligible': a lapsed rule refuses nobody.
    expect(r.outcome).not.toBe('ineligible');
  });

  it('FUTURE POLICY — a rule that has not started yet decides nothing', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-F');
    await ruleInForce('RULE-F', inst.id, version.id, '2027-04-01');

    const r = await evaluate(db, { ruleCode: 'RULE-F', facts: facts(1), on: '2026-06-01' });
    expect(r.outcome).toBe('no_rule_in_force');
  });

  it('HISTORICAL POLICY — amending a rule does not restate what was already decided', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-EVAL-G');
    const { rule, version: v1 } = await ruleInForce('RULE-G', inst.id, version.id, '2026-04-01');

    // Decided under v1, at 4th Kyu. Eligible.
    const before = await evaluate(db, { ruleCode: 'RULE-G', facts: facts(6), on: '2026-06-01' });
    expect(before.outcome).toBe('eligible');
    const determination = await recordDetermination(db, ctx(), {
      evaluation: before, subjectType: 'application', subjectId: 'APP-1',
      personId: PERSON, facts: facts(6),
    });

    // MMAKF raises the bar to 2nd Dan from 2027.
    const v2 = await draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '2.0', instrumentVersionId: version.id,
      conditions: [{ fact: 'grade_rank', op: 'gte', value: 12, label: 'holds 2nd Dan or above' }],
      refusalReason: 'The minimum grade for this pathway is 2nd Dan from 1 April 2027.',
    });
    await approveRuleVersion(db, ctx(president), v2.id, {
      approvedByPersonId: PERSON, approvedOn: '2027-02-01',
    });
    await publishRuleVersion(db, ctx(), v2.id, { effectiveFrom: '2027-04-01' });

    // The past is unchanged …
    const replay = await evaluate(db, { ruleCode: 'RULE-G', facts: facts(6), on: '2026-06-01' });
    expect(replay.outcome).toBe('eligible');
    expect(replay.ruleVersion).toBe('1.0');

    // … the future is not.
    const now = await evaluate(db, { ruleCode: 'RULE-G', facts: facts(6), on: '2027-06-01' });
    expect(now.outcome).toBe('ineligible');
    expect(now.ruleVersion).toBe('2.0');

    // And the determination still points at the version that produced it.
    const [stored] = await db.select().from(s.policyDeterminations)
      .where(eq(s.policyDeterminations.id, determination.id));
    expect(stored.ruleVersionId).toBe(v1.id);
    expect(stored.outcome).toBe('eligible');
  });
});

describe('the engine refuses rather than guesses', () => {
  it('reports an unapproved rule as unapproved, never as a refusal', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-DRAFTY');
    const rule = await defineRule(db, ctx(), {
      code: 'RULE-DRAFT', title: 'Maturity assessment',
      instrumentId: inst.id, subjectKind: 'instructor_application',
    });
    // Drafted with a window, never approved — exactly the E.2 situation the gap
    // analysis blocks at §4.3.
    const rv = await draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '0.1', instrumentVersionId: version.id,
      conditions: [{ fact: 'maturity_score', op: 'gte', value: 20 }],
      outcomeMet: 'requires_review',
    });
    await db.update(s.policyRuleVersions)
      .set({ effectiveFrom: '2026-01-01' })
      .where(eq(s.policyRuleVersions.id, rv.id));

    const r = await evaluate(db, { ruleCode: 'RULE-DRAFT', facts: { maturity_score: 35 }, on: '2026-06-01' });
    expect(r.outcome).toBe('not_approved');
    expect(r.reason).toContain('decides nothing');
    expect(r.appealable).toBe(false);
  });

  it('distinguishes an unknown rule from a rule with no version in force', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-UNKNOWN');
    expect(await ruleInForceOn(db, 'RULE-NOT-A-THING', '2026-06-01'))
      .toMatchObject({ status: 'unknown_rule' });

    await defineRule(db, ctx(), {
      code: 'RULE-BARE', title: 'Defined, never versioned',
      instrumentId: inst.id, subjectKind: 'instructor_application',
    });
    expect(await ruleInForceOn(db, 'RULE-BARE', '2026-06-01'))
      .toMatchObject({ status: 'no_version' });
    expect(version.state).toBe('published');
  });

  it('treats a missing fact as a missing fact, not as a failed condition', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-MISSING');
    await ruleInForce('RULE-MISSING', inst.id, version.id, '2026-04-01');

    const r = await evaluate(db, { ruleCode: 'RULE-MISSING', facts: {}, on: '2026-06-01' });
    expect(r.outcome).toBe('insufficient_facts');
    expect(r.reason).toContain('grade_rank');
    expect(r.conditions[0].missing).toBe(true);
    // Nobody is refused for a record the federation never asked them for.
    expect(r.outcome).not.toBe('ineligible');
  });

  it('refuses to order two things that cannot be ordered', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-COLOURS');
    await ruleInForce('RULE-COLOURS', inst.id, version.id, '2026-04-01', null, {
      conditions: [{ fact: 'belt', op: 'gte', value: 'brown' }],
    });
    // 'brown' > 'black' is true in JavaScript and meaningless in karate.
    await expect(evaluate(db, { ruleCode: 'RULE-COLOURS', facts: { belt: 'black' }, on: '2026-06-01' }))
      .rejects.toMatchObject({ code: 'uncomparable' });
  });

  it('can flag for a human instead of refusing', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-REVIEW');
    await ruleInForce('RULE-REVIEW', inst.id, version.id, '2026-04-01', null, {
      conditions: [{ fact: 'prior_sanction', op: 'exists' }],
      outcomeMet: 'requires_review',
      outcomeUnmet: 'eligible',
    });
    const flagged = await evaluate(db, {
      ruleCode: 'RULE-REVIEW', facts: { prior_sanction: 'suspended 2025' }, on: '2026-06-01',
    });
    // Nobody is sanctioned on an automatic flag — it routes to a person.
    expect(flagged.outcome).toBe('requires_review');
  });

  it('will not let a rule declare an engine state as its own outcome', async () => {
    const { inst } = await publishedInstrument('MMAKF-REG-SNEAKY');
    const rule = await defineRule(db, ctx(), {
      code: 'RULE-SNEAKY', title: 'x', instrumentId: inst.id, subjectKind: 'x',
    });
    await expect(draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '1.0',
      conditions: [{ fact: 'a', op: 'exists' }],
      outcomeMet: 'not_approved' as any,
    })).rejects.toMatchObject({ code: 'bad_outcome' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Determinations, and the chain behind them
// ─────────────────────────────────────────────────────────────────────────────

describe('determinations', () => {
  it('will not file an absence of policy against a person\'s record', async () => {
    const nothing = await evaluate(db, { ruleCode: 'RULE-NONE', facts: {}, on: '2026-06-01' });
    await expect(recordDetermination(db, ctx(), {
      evaluation: nothing, subjectType: 'application', subjectId: 'APP-9',
      personId: PERSON, facts: {},
    })).rejects.toMatchObject({ code: 'not_a_finding' });
  });

  it('answers the whole chain — rule, version, instrument, approver, source URL', async () => {
    await academySource('KAB-012.1');
    const inst = await createInstrument(db, ctx(), {
      code: 'MMAKF-REG-CHAIN', title: 'Instructor Appointment Regulation',
      instrumentType: 'regulation', subjectArea: 'instructor',
    });
    const iv = await draftInstrumentVersion(db, ctx(), {
      instrumentId: inst.id, version: '1.0', bodyMarkdown: '# Instructor Appointment Regulation',
    });
    await adoptSourceProvision(db, ctx(), {
      sourceRef: 'KAB-012.1', instrumentVersionId: iv.id, clauseRef: '4.2',
      text: 'An applicant shall hold 4th Kyu or above.',
      adoptedByPersonId: PERSON, adoptedOn: '2026-03-01',
    });
    await advanceInstrumentState(db, ctx(), iv.id, 'governance_review');
    await advanceInstrumentState(db, ctx(president), iv.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    });
    const published = await publishInstrumentVersion(db, ctx(), iv.id, { effectiveFrom: '2026-04-01' });
    await ruleInForce('RULE-CHAIN', inst.id, published.id, '2026-04-01');

    const e = await evaluate(db, { ruleCode: 'RULE-CHAIN', facts: { grade_rank: 3 }, on: '2026-06-01' });
    const det = await recordDetermination(db, ctx(), {
      evaluation: e, subjectType: 'application', subjectId: 'APP-77',
      personId: PERSON, facts: { grade_rank: 3 },
    });

    const chain = await provenanceChain(db, admin, det.ref);

    expect(chain.determination.outcome).toBe('ineligible');
    expect(chain.rule.code).toBe('RULE-CHAIN');
    expect(chain.ruleVersion.approvedByPersonId).toBe(PERSON);
    expect(chain.instrument.code).toBe('MMAKF-REG-CHAIN');
    expect(chain.instrumentVersion.effectiveFrom).toBe('2026-04-01');
    expect(chain.instrumentVersion.approvedOn).toBe('2026-03-01');
    expect(chain.instrumentVersion.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    // Was it MMAKF's rule or the Academy's? The chain says, with the URL.
    const derived = chain.provisions.find((p: any) => p.provision.derivation === 'source_derived');
    expect(derived.source.ref).toBe('KAB-012.1');
    expect(derived.source.layer).toBe('academy_source');
    expect(derived.document.sourceUrl).toContain('karateacademy.in');
    expect(derived.document.retrievedOn).toBe('2026-08-17');
    expect(chain.gaps).toHaveLength(0);
  });

  it('names the missing links rather than omitting them', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-GAPPY');
    // A rule that cites no instrument version — the chain has a hole in it.
    const rule = await defineRule(db, ctx(), {
      code: 'RULE-GAPPY', title: 'x', instrumentId: inst.id, subjectKind: 'x',
    });
    const rv = await draftRuleVersion(db, ctx(), {
      ruleId: rule.id, version: '1.0',
      conditions: [{ fact: 'grade_rank', op: 'gte', value: 6 }],
    });
    await approveRuleVersion(db, ctx(president), rv.id, {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    });
    await publishRuleVersion(db, ctx(), rv.id, { effectiveFrom: '2026-04-01' });

    const e = await evaluate(db, { ruleCode: 'RULE-GAPPY', facts: { grade_rank: 2 }, on: '2026-06-01' });
    const det = await recordDetermination(db, ctx(), {
      evaluation: e, subjectType: 'application', subjectId: 'APP-8', personId: PERSON, facts: { grade_rank: 2 },
    });
    const chain = await provenanceChain(db, admin, det.ref);
    expect(chain.gaps.join(' ')).toContain('no approved text');
    expect(version.state).toBe('published');
  });

  it('supersedes a determination rather than editing it', async () => {
    const { inst, version } = await publishedInstrument('MMAKF-REG-APPEAL');
    await ruleInForce('RULE-APPEAL', inst.id, version.id, '2026-04-01');

    const wrong = await evaluate(db, { ruleCode: 'RULE-APPEAL', facts: { grade_rank: 2 }, on: '2026-06-01' });
    const first = await recordDetermination(db, ctx(), {
      evaluation: wrong, subjectType: 'application', subjectId: 'APP-5',
      personId: PERSON, facts: { grade_rank: 2 },
    });

    // The grade proof turns up: the applicant did hold 4th Kyu all along.
    const right = await evaluate(db, { ruleCode: 'RULE-APPEAL', facts: { grade_rank: 6 }, on: '2026-06-01' });
    const second = await supersedeDetermination(db, ctx(), first.ref, {
      evaluation: right, subjectType: 'application', subjectId: 'APP-5',
      personId: PERSON, facts: { grade_rank: 6 },
    });

    const [original] = await db.select().from(s.policyDeterminations)
      .where(eq(s.policyDeterminations.id, first.id));
    expect(original.outcome).toBe('ineligible');          // history intact
    expect(original.supersededByDeterminationId).toBe(second.id);
    expect(second.outcome).toBe('eligible');

    const all = await determinationsForPerson(db, admin, PERSON);
    expect(all).toHaveLength(2);

    await expect(supersedeDetermination(db, ctx(), first.ref, {
      evaluation: right, subjectType: 'application', subjectId: 'APP-5',
      personId: PERSON, facts: { grade_rank: 6 },
    })).rejects.toMatchObject({ code: 'already_superseded' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — What the public may see
// ─────────────────────────────────────────────────────────────────────────────

describe('the public register', () => {
  it('shows only what is published, public and in force on the day asked for', async () => {
    await publishedInstrument('MMAKF-REG-PUBLIC', '2026-04-01');

    // A draft — approved by nobody.
    await instrumentWithVersion('MMAKF-REG-DRAFT-ONLY');

    // Published, but internal.
    await publishedInstrument('MMAKF-REG-INTERNAL', '2026-04-01', { classification: 'official' });

    const before = await publicRegister(db, '2026-03-01');
    expect(before).toHaveLength(0);

    const after = await publicRegister(db, '2026-06-01');
    expect(after.map((r: any) => r.instrument.code)).toEqual(['MMAKF-REG-PUBLIC']);
  });

  it('reports honestly that a workflow is governed by nothing yet', async () => {
    const rules = await rulesFor(db, admin, 'grading_entry', '2026-06-01');
    expect(rules).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Authority
// ─────────────────────────────────────────────────────────────────────────────

describe('authority', () => {
  it('keeps the source register away from anybody without source:write', async () => {
    await expect(recordSourceDocument(db, ctx(athlete), {
      code: 'X', layer: 'academy_source', sourceOrg: 'x', sourceTitle: 'x',
      sourceUrl: 'https://example.in/x', retrievedOn: '2026-08-17',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a technical director draft but not approve', async () => {
    const inst = await createInstrument(db, ctx(technical), {
      code: 'MMAKF-REG-TECH', title: 'Grading Regulation',
      instrumentType: 'regulation', subjectArea: 'grading',
    });
    const v = await draftInstrumentVersion(db, ctx(technical), {
      instrumentId: inst.id, version: '1.0', bodyMarkdown: '# Grading',
    });
    await advanceInstrumentState(db, ctx(technical), v.id, 'governance_review');

    await expect(advanceInstrumentState(db, ctx(technical), v.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a president approve but not publish', async () => {
    const { version } = await instrumentWithVersion('MMAKF-REG-PREZ');
    await advanceInstrumentState(db, ctx(), version.id, 'governance_review');
    await advanceInstrumentState(db, ctx(president), version.id, 'approved', {
      approvedByPersonId: PERSON, approvedOn: '2026-03-01',
    });
    await expect(publishInstrumentVersion(db, ctx(president), version.id, { effectiveFrom: '2026-04-01' }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reports its own refusals as PolicyError, not as a generic throw', async () => {
    try {
      await recordSourceDocument(db, ctx(), {
        code: 'Y', layer: 'academy_source', sourceOrg: 'x', sourceTitle: 'x',
        sourceUrl: 'not-a-url', retrievedOn: '2026-08-17',
      });
      expect.unreachable('should have refused');
    } catch (e) {
      expect(isPolicyError(e)).toBe(true);
      expect((e as any).code).toBe('bad_url');
    }
  });
});
