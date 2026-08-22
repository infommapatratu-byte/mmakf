// The defects an adversarial review found in the identity foundation, and the
// regressions that would let each of them back in.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS SEPARATE FROM tests/identity.test.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Every test below passed on the broken code, because the broken code was not
// what tests/identity.test.ts was looking at. That suite asserts the rules the
// module MEANS to enforce; these assert the specific ways it failed to, each
// with the concrete input that reached the wrong outcome. Keeping them together
// under their own header is what stops the next reader assuming the coverage
// above already covered this.
//
// Two of the four are security defects and both were in code that carried a
// comment claiming the opposite:
//
//  · decideDuplicate() re-checked scope with assertCanAnywhere() — the same gate
//    it had already asserted — so the per-record check could never refuse, and a
//    state administrator could decide a candidate in another state by id.
//  · decideProfileChange() skipped the four-eyes rule whenever the actor could
//    not be named, so ONE shared office login could file a change of date of
//    birth and approve its own request.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  computeMatchKey, detectPersonDuplicates, duplicateQueue, decideDuplicate,
  requestProfileChange, decideProfileChange,
  assertRelationship, decideRelationship, grantGuardianCapability,
  dependantsOf, guardianCan, isIdentityError,
} from '../src/db/identity';
import { validateApplication, UNRESOLVED_CHOICE, EMPTY_GEOGRAPHY } from '../src/lib/registration';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let ASSAM: number, KERALA: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

/** National, named. The control case. */
const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** A second named account, so a four-eyes decision has somebody to be. */
const admin2: Principal = {
  userId: 2, label: 'another federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = admin): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

let seq = 700000;
async function person(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name,
    matchKey: computeMatchKey(name),
    status: 'active',
    ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

beforeAll(async () => {
  const pg = new PGlite();
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  for (const id of [1, 2, 3, 42]) {
    await db.insert(s.users).values({
      id, email: `u${id}@test.invalid`, status: 'active',
    }).onConflictDoNothing();
  }

  const [a] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-AS', state: 'Assam', name: 'Assam', status: 'active',
  }).returning({ id: s.stateUnits.id });
  ASSAM = a.id;
  const [k] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-KL', state: 'Kerala', name: 'Kerala', status: 'active',
  }).returning({ id: s.stateUnits.id });
  KERALA = k.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM guardian_authorizations');
  await db.execute?.('DELETE FROM person_relationships');
  await db.execute?.('DELETE FROM duplicate_candidates');
  await db.execute?.('DELETE FROM profile_change_requests');
  await db.execute?.('DELETE FROM person_contacts');
  await db.execute?.('DELETE FROM persons');
});

// ─── 1. The duplicate-decision IDOR ─────────────────────────────────────────

describe('decideDuplicate refuses a caller with no authority over either record', () => {
  /** Bound to Kerala only. duplicateQueue() correctly shows them nothing. */
  const kerala = (): Principal => ({
    userId: 42, label: 'kerala administrator',
    bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: KERALA }],
  });

  async function assamPair() {
    const a = await person('Ritu Sharma', { dob: '2005-04-11', stateUnitId: ASSAM });
    const b = await person('Sharma Ritu', { dob: '2005-04-11', stateUnitId: ASSAM });
    await detectPersonDuplicates(db, b);
    const rows = await db.select().from(s.duplicateCandidates);
    return { a, b, candidateId: rows[0].id as number };
  }

  it('hides the candidate from the queue — which was already true', async () => {
    const { candidateId } = await assamPair();
    const visible = await duplicateQueue(db, kerala());
    expect(visible.map((r: any) => r.id)).not.toContain(candidateId);
  });

  it('REFUSES the decision, which it did not', async () => {
    // The hole: the negative branch called assertCanAnywhere() — the gate the
    // function had already asserted at the top — so it could never fail. A
    // Kerala administrator decided an Assam-only candidate, and the row recorded
    // them as the decider.
    const { candidateId } = await assamPair();

    await expect(decideDuplicate(db, ctx(kerala()), {
      candidateId, decision: 'distinct', reason: 'Not the same person',
    })).rejects.toThrow(ForbiddenError);

    const after = await db.select().from(s.duplicateCandidates)
      .where(eq(s.duplicateCandidates.id, candidateId));
    expect(after[0].status).toBe('open');
    expect(after[0].decidedByUserId).toBeNull();
  });

  it('still allows an administrator who does hold the scope', async () => {
    // The refusal must not be a blockade: the Assam administrator decides it.
    const { candidateId } = await assamPair();
    const assam: Principal = {
      userId: 3, label: 'assam administrator',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: ASSAM }],
    };
    await decideDuplicate(db, ctx(assam), {
      candidateId, decision: 'distinct', reason: 'Brothers — checked with the dojo',
    });
    const after = await db.select().from(s.duplicateCandidates)
      .where(eq(s.duplicateCandidates.id, candidateId));
    expect(after[0].status).toBe('distinct');
  });

  it('refuses a surviving record on a "two different people" decision', async () => {
    // A row reading "these are two different people, and the surviving record is
    // #2" is self-contradictory, and both the audit entry and the domain event
    // carried it.
    const { a, candidateId } = await assamPair();
    await expect(decideDuplicate(db, ctx(), {
      candidateId, decision: 'distinct', reason: 'Different people', mergedIntoId: a,
    })).rejects.toThrow(/cannot also name a surviving record/);

    const after = await db.select().from(s.duplicateCandidates)
      .where(eq(s.duplicateCandidates.id, candidateId));
    expect(after[0].status).toBe('open');
  });
});

// ─── 2. Four eyes, and an actor who has no eyes ─────────────────────────────

describe('a governed change cannot be decided by an unattributable credential', () => {
  /** What identify() returns for the shared office password: no userId. */
  const shared: Principal = {
    userId: null, label: 'shared:mmakf_admin',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };

  it('refuses when the DECIDER cannot be named', async () => {
    // The hole: both halves of the guard were `!= null`, so a null userId
    // matched nothing and skipped the rule. One shared login filed a change of
    // date of birth and approved it — the two-person control defeated by the
    // absence of a name rather than by anybody's authority.
    const p = await person('Ravi Sharma', { dob: '2001-01-01', stateUnitId: ASSAM });
    const r = await requestProfileChange(db, ctx(shared), {
      personId: p, field: 'dob', newValue: '2008-02-02',
    });

    await expect(decideProfileChange(db, ctx(shared), {
      requestId: r.id, decision: 'approved', reason: 'Seen',
    })).rejects.toThrow(/named account/);

    const after = await db.select().from(s.persons).where(eq(s.persons.id, p));
    expect(after[0].dob).toBe('2001-01-01');          // untouched
  });

  it('refuses when the REQUESTER cannot be named, even for a named decider', async () => {
    const p = await person('Ravi Sharma', { dob: '2001-01-01', stateUnitId: ASSAM });
    const r = await requestProfileChange(db, ctx(shared), {
      personId: p, field: 'dob', newValue: '2008-02-02',
    });
    await expect(decideProfileChange(db, ctx(admin), {
      requestId: r.id, decision: 'approved', reason: 'Seen',
    })).rejects.toThrow(/re-filed from a named account/);
  });

  it('still lets two DIFFERENT named accounts complete a change', async () => {
    // The guard must not become a blockade — the ordinary path still works.
    const p = await person('Ravi Sharma', { dob: '2001-01-01', stateUnitId: ASSAM });
    const r = await requestProfileChange(db, ctx(admin), {
      personId: p, field: 'dob', newValue: '2001-03-02',
    });
    const out = await decideProfileChange(db, ctx(admin2), {
      requestId: r.id, decision: 'approved', reason: 'Certificate seen',
    });
    expect(out.applied).toBe(true);
    const after = await db.select().from(s.persons).where(eq(s.persons.id, p));
    expect(after[0].dob).toBe('2001-03-02');
  });

  it('reports every refusal as an IdentityError, not a crash', async () => {
    const p = await person('Ravi Sharma', { dob: '2001-01-01', stateUnitId: ASSAM });
    const r = await requestProfileChange(db, ctx(shared), {
      personId: p, field: 'dob', newValue: '2008-02-02',
    });
    try {
      await decideProfileChange(db, ctx(shared), {
        requestId: r.id, decision: 'approved', reason: 'Seen',
      });
      expect.unreachable();
    } catch (err) {
      expect(isIdentityError(err)).toBe(true);
    }
  });
});

// ─── 3. dependantsOf and guardianCan must agree about "live" ────────────────

describe('dependantsOf honours the relationship validity window', () => {
  async function relationship(window: { validFrom?: string; validTo?: string }) {
    const parent = await person('Meera Sharma', { stateUnitId: ASSAM });
    const child = await person('Anaya Sharma', { dob: '2015-04-04', stateUnitId: ASSAM });
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
      validFrom: window.validFrom ?? null,
    });
    // `validTo` is set directly because assertRelationship() does not accept one
    // — only revokeRelationship() writes it. That is a real (small) gap in the
    // module, noted here rather than worked around silently; what is under test
    // is whether dependantsOf() and guardianCan() AGREE about a closed window,
    // however the window got closed.
    if (window.validTo) {
      await db.update(s.personRelationships)
        .set({ validTo: window.validTo })
        .where(eq(s.personRelationships.id, r.id));
    }
    await decideRelationship(db, ctx(), {
      relationshipId: r.id, decision: 'verified', reason: 'Birth certificate seen',
    });
    await grantGuardianCapability(db, ctx(), {
      relationshipId: r.id, capability: 'view_profile',
    });
    return { parent, child };
  }

  it('excludes a relationship that is not yet in force', async () => {
    // The disagreement: dependantsOf() filtered on status alone, so the page
    // rendered a card headed "verified" on which a GRANTED capability printed as
    // "Not granted" — because guardianCan() was refusing on the window. Those
    // are different facts and the page promises to tell them apart.
    const { parent, child } = await relationship({ validFrom: '2099-01-01' });

    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);

    const listed = await dependantsOf(db, parent);
    expect(listed.map((d: any) => d.personId)).not.toContain(child);
  });

  it('excludes a relationship whose window has closed', async () => {
    const { parent, child } = await relationship({ validTo: '2000-01-01' });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);
    const listed = await dependantsOf(db, parent);
    expect(listed.map((d: any) => d.personId)).not.toContain(child);
  });

  it('includes one that is in force, and the two functions then agree', async () => {
    const { parent, child } = await relationship({ validFrom: '2020-01-01' });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(true);
    const listed = await dependantsOf(db, parent);
    expect(listed.map((d: any) => d.personId)).toContain(child);
  });
});

// ─── 4. "None of these" must be an answer somebody can give ────────────────

describe('the unresolved-locality escape hatch is honoured', () => {
  const base = {
    type: 'Athlete',
    name: 'Ravi Sharma',
    email: 'ravi@example.in',
    phone: '9876543210',
    state: 'Assam',
    district: 'Kamrup',
    dob: '2000-05-05',
    gender: 'Male',
    dojo: 'Guwahati Dojo',
    instructor: 'A Sensei',
    // Required for an Athlete — see TYPE_FIELDS. A fixture missing them fails
    // for the wrong reason and tells you nothing about the locality rule.
    emergencyName: 'Meera Sharma',
    emergencyPhone: '9876500000',
    consentAccuracy: 'on',
    consentDataUse: 'on',
  };

  const geoWithCandidates = {
    ...EMPTY_GEOGRAPHY,
    loaded: true,
    localityCandidates: [
      { value: '101', label: 'Kamrup (district)' },
      { value: '102', label: 'Kamrup (city)' },
    ],
  };

  it('accepts UNRESOLVED_CHOICE and records no area', async () => {
    // /api/register ADVERTISES this value as the way out of an ambiguous
    // locality; the validator rejected it, so the documented escape was the one
    // answer that could not be given — and an applicant whose village is not in
    // the register could not complete a registration at all.
    const r = validateApplication(
      { ...base, city: 'Kamrup', cityAreaId: UNRESOLVED_CHOICE },
      ['Assam'], new Date('2026-08-17T00:00:00Z'), { geo: geoWithCandidates }
    );
    expect(r.errors.cityAreaId).toBeUndefined();
    expect(r.ok).toBe(true);
    // No id recorded — the free text carries the place, and the address lands in
    // the re-resolution backlog.
    expect(r.cleaned.cityAreaId).toBeUndefined();
    expect(r.cleaned.city).toBe('Kamrup');
  });

  it('still refuses an id that was never on offer', async () => {
    // The escape hatch must not become a hole: an arbitrary admin_areas key is
    // still rejected.
    const r = validateApplication(
      { ...base, city: 'Kamrup', cityAreaId: '999' },
      ['Assam'], new Date('2026-08-17T00:00:00Z'), { geo: geoWithCandidates }
    );
    expect(r.ok).toBe(false);
    expect(r.errors.cityAreaId).toMatch(/not one of them/);
  });

  it('accepts a candidate that WAS on offer', async () => {
    const r = validateApplication(
      { ...base, city: 'Kamrup', cityAreaId: '102' },
      ['Assam'], new Date('2026-08-17T00:00:00Z'), { geo: geoWithCandidates }
    );
    expect(r.ok).toBe(true);
    expect(r.cleaned.cityAreaId).toBe('102');
  });
});

// ─── 5. The two crashes ─────────────────────────────────────────────────────

describe('the state components are called with the props they declare', () => {
  // EmptyState dereferences action.href unconditionally and declares no
  // `description`; ErrorState requires `safe`. Both new admin pages got this
  // wrong, so each returned a 500 in its ORDINARY empty state — and immediately
  // after a reviewer decided the last item in the queue.
  const PAGES = [
    'src/pages/admin/duplicates.astro',
    'src/pages/admin/profile-changes.astro',
  ];

  it('passes EmptyState a required action and no bogus description', () => {
    for (const f of PAGES) {
      const src = readFileSync(f, 'utf8');
      const blocks = [...src.matchAll(/<EmptyState[\s\S]*?\/>/g)].map((m) => m[0]);
      expect(blocks.length, `${f} renders no EmptyState`).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(b, `${f}: EmptyState without action would throw on action.href`).toMatch(/action=/);
        expect(b, `${f}: EmptyState has no 'description' prop`).not.toMatch(/description=/);
      }
    }
  });

  it('passes ErrorState its required safe sentence', () => {
    for (const f of PAGES) {
      const src = readFileSync(f, 'utf8');
      const blocks = [...src.matchAll(/<ErrorState[\s\S]*?\/>/g)].map((m) => m[0]);
      expect(blocks.length, `${f} renders no ErrorState`).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(b, `${f}: ErrorState must say what is safe`).toMatch(/safe=/);
        expect(b, `${f}: ErrorState has no 'description' prop`).not.toMatch(/description=/);
      }
    }
  });
});
