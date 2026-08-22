// /admin/guardianships — the screen that populates the capability table.
//
// Two halves, because two different things can be wrong:
//
//  · The QUEUE and the grant path are real functions, so they are executed
//    against a real Postgres. That is where the double gate and the scope filter
//    are actually proved.
//  · The PAGE cannot be imported and run here, so it is read as source — the
//    technique tests/portal.test.ts and tests/identity-surfaces.test.ts already
//    use. A source assertion proves a call is present, not that every path
//    reaches it; tests/routes-live.test.ts fetches the route over HTTP for the
//    part this cannot reach.
//
// The invariant the whole screen exists to serve: VERIFYING A RELATIONSHIP
// GRANTS NOTHING. If that ever stops being true, the parent-facing page starts
// showing children's records to whoever was attached to them.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  relationshipQueue, capabilitiesOn, extraActionFor,
  assertRelationship, decideRelationship, revokeRelationship,
  grantGuardianCapability, guardianCan,
  GUARDIAN_CAPABILITIES, computeMatchKey,
} from '../src/db/identity';
import { ADMIN_GROUPS } from '../src/lib/surface';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const PAGE = 'src/pages/admin/guardianships.astro';
const read = () => readFileSync(PAGE, 'utf8');

let db: any;
let ASSAM: number, KERALA: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

/** Holds guardian:verify nationally. Holds neither medical nor safeguarding. */
const operational: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Holds guardian:verify AND safeguarding:write. */
const safeguarding: Principal = {
  userId: 2, label: 'safeguarding officer',
  bindings: [{ role: 'SAFEGUARDING_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Holds everything, including medical. */
const root: Principal = {
  userId: 3, label: 'super admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Holds guardian:verify, but only over Kerala. */
const kerala = (): Principal => ({
  userId: 4, label: 'kerala administrator',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: KERALA }],
});
/** Holds nothing relevant. */
const member: Principal = {
  userId: 5, label: 'a member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = operational): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

let seq = 900000;
async function person(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name, matchKey: computeMatchKey(name), status: 'active', ...over,
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

  for (const id of [1, 2, 3, 4, 5]) {
    await db.insert(s.users).values({ id, email: `u${id}@test.invalid`, status: 'active' })
      .onConflictDoNothing();
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
  await db.execute?.('DELETE FROM persons');
});

async function claim(over: { subjectState?: number } = {}) {
  const parent = await person('Meera Sharma', { stateUnitId: ASSAM });
  const child = await person('Anaya Sharma', {
    dob: '2015-04-04', stateUnitId: over.subjectState ?? ASSAM,
  });
  const r = await assertRelationship(db, ctx(), {
    holderPersonId: parent, subjectPersonId: child, type: 'authorized_guardian',
  });
  return { parent, child, relationshipId: r.id };
}

// ─── The queue ──────────────────────────────────────────────────────────────

describe('the guardianship queue', () => {
  it('refuses a reader without guardian:verify', async () => {
    await expect(relationshipQueue(db, member)).rejects.toThrow();
  });

  it('lists claims awaiting a decision', async () => {
    const { relationshipId } = await claim();
    const rows = await relationshipQueue(db, operational, { status: ['asserted'] });
    expect(rows.map((r: any) => r.id)).toContain(relationshipId);
  });

  it('scopes on the SUBJECT — authority over a guardianship is authority over the child', async () => {
    // The adult is in Assam and the child is in Kerala. A Kerala administrator
    // must see it (it is their child); an Assam-only one must not.
    const { relationshipId } = await claim({ subjectState: KERALA });

    const keralaSees = await relationshipQueue(db, kerala(), { status: ['asserted'] });
    expect(keralaSees.map((r: any) => r.id)).toContain(relationshipId);

    const assamOnly: Principal = {
      userId: 4, label: 'assam administrator',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: ASSAM }],
    };
    const assamSees = await relationshipQueue(db, assamOnly, { status: ['asserted'] });
    expect(assamSees.map((r: any) => r.id)).not.toContain(relationshipId);
  });
});

// ─── Verifying grants nothing ───────────────────────────────────────────────

describe('verifying a relationship grants nothing', () => {
  it('leaves every capability ungranted', async () => {
    const { parent, child, relationshipId } = await claim();
    await decideRelationship(db, ctx(), {
      relationshipId, decision: 'verified', reason: 'Birth certificate seen',
    });

    expect(await capabilitiesOn(db, relationshipId)).toHaveLength(0);
    for (const cap of GUARDIAN_CAPABILITIES) {
      expect(await guardianCan(db, {
        guardianPersonId: parent, subjectPersonId: child, capability: cap,
      }), `verification granted ${cap}`).toBe(false);
    }
  });

  it('refuses a decision with no reason', async () => {
    const { relationshipId } = await claim();
    await expect(decideRelationship(db, ctx(), {
      relationshipId, decision: 'verified', reason: '   ',
    })).rejects.toThrow(/reason/);
  });

  it('refuses a grant on a claim that has not been verified', async () => {
    const { relationshipId } = await claim();
    await expect(grantGuardianCapability(db, ctx(), {
      relationshipId, capability: 'view_profile',
    })).rejects.toThrow(/VERIFIED/);
  });
});

// ─── The double gate ────────────────────────────────────────────────────────

describe('the double gate on the sensitive capabilities', () => {
  it('names exactly the two that need more than guardian:verify', () => {
    expect(extraActionFor('view_medical')).toBe('medical:read');
    expect(extraActionFor('view_safeguarding')).toBe('safeguarding:write');
    for (const cap of GUARDIAN_CAPABILITIES) {
      if (cap === 'view_medical' || cap === 'view_safeguarding') continue;
      expect(extraActionFor(cap), `${cap} should need no extra action`).toBeNull();
    }
  });

  it('refuses an operational administrator granting the safeguarding file', async () => {
    const { relationshipId } = await claim();
    await decideRelationship(db, ctx(), {
      relationshipId, decision: 'verified', reason: 'Seen',
    });
    // FEDERATION_ADMIN holds guardian:verify and attached the parent — and still
    // cannot open that door.
    await expect(grantGuardianCapability(db, ctx(operational), {
      relationshipId, capability: 'view_safeguarding',
    })).rejects.toThrow(ForbiddenError);
    await expect(grantGuardianCapability(db, ctx(operational), {
      relationshipId, capability: 'view_medical',
    })).rejects.toThrow(ForbiddenError);
  });

  it('allows the safeguarding officer the safeguarding capability', async () => {
    const { parent, child, relationshipId } = await claim();
    await decideRelationship(db, ctx(safeguarding), {
      relationshipId, decision: 'verified', reason: 'Seen',
    });
    await grantGuardianCapability(db, ctx(safeguarding), {
      relationshipId, capability: 'view_safeguarding',
    });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_safeguarding',
    })).toBe(true);
  });

  it('allows medical only to somebody holding medical:read', async () => {
    const { relationshipId } = await claim();
    await decideRelationship(db, ctx(root), {
      relationshipId, decision: 'verified', reason: 'Seen',
    });
    // The safeguarding officer holds safeguarding:write and NOT medical:read.
    await expect(grantGuardianCapability(db, ctx(safeguarding), {
      relationshipId, capability: 'view_medical',
    })).rejects.toThrow(ForbiddenError);
    // SUPER_ADMIN holds both.
    await grantGuardianCapability(db, ctx(root), {
      relationshipId, capability: 'view_medical',
    });
    expect(await capabilitiesOn(db, relationshipId)).toHaveLength(1);
  });
});

// ─── Revocation cascades ────────────────────────────────────────────────────

describe('revoking the relationship takes its capabilities with it', () => {
  it('leaves the guardian holding nothing', async () => {
    const { parent, child, relationshipId } = await claim();
    await decideRelationship(db, ctx(), { relationshipId, decision: 'verified', reason: 'Seen' });
    await grantGuardianCapability(db, ctx(), { relationshipId, capability: 'view_profile' });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(true);

    await revokeRelationship(db, ctx(), { relationshipId, reason: 'Court order' });

    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);
    expect(await capabilitiesOn(db, relationshipId)).toHaveLength(0);
  });
});

// ─── The page ───────────────────────────────────────────────────────────────

describe('the page', () => {
  it('exists and is offered in the admin menu, gated on guardian:verify', () => {
    expect(existsSync(PAGE)).toBe(true);
    const entry = ADMIN_GROUPS.flatMap((g) => g.modules)
      .find((m) => m.href === '/admin/guardianships');
    expect(entry, 'the guardianship screen is not in the admin menu').toBeTruthy();
    expect(entry!.action).toBe('guardian:verify');
  });

  it('gates itself on guardian:verify and re-checks on POST', () => {
    const src = read();
    expect(src).toMatch(/requires=["']guardian:verify["']/);
    expect(src).toMatch(/canAnywhere\(\s*identity!?\.principal,\s*'guardian:verify'\s*\)/);
    expect(src).toMatch(/mayVerify/);
  });

  it('states that verifying grants nothing', () => {
    // The sentence the whole design depends on a reviewer understanding.
    expect(read()).toMatch(/grants no access whatsoever/i);
  });

  it('reads the double gate from the module rather than a second copy', () => {
    // A page with its own list would offer a control the module then refuses —
    // or stop offering one it would allow, and nobody would notice which.
    const src = read();
    expect(src).toMatch(/extraActionFor\(/);
    expect(src).not.toMatch(/['"]medical:read['"]\s*:/);
  });

  it('SAYS a withheld control is withheld, rather than hiding it', () => {
    const src = read();
    expect(src).toMatch(/withheld from you/i);
    expect(src).toMatch(/on top of/i);
  });

  it('renders an unknown date of birth as unknown, never as adult', () => {
    // isMinor() returns null for a missing date of birth, and a screen that
    // rendered that as "an adult" would be the one place a child's status is
    // silently downgraded.
    const src = read();
    expect(src).toMatch(/subjectIsMinor === null/);
    expect(src).toMatch(/Date of birth not recorded/);
  });

  it('requires a reason on every act', () => {
    const src = read();
    // Both textareas and the inline revoke input.
    const requiredFields = src.match(/name="reason"[\s\S]{0,220}?required/g) ?? [];
    expect(requiredFields.length).toBeGreaterThanOrEqual(2);
  });

  it('works without JavaScript — plain forms posting to the page', () => {
    const src = read();
    expect(src).toMatch(/<form method="POST"/);
    expect(src).not.toMatch(/fetch\(/);
  });

  it('warns that revoking the relationship revokes the capabilities', () => {
    expect(read()).toMatch(/also revokes every capability/i);
  });

  it('calls the state components with the props they declare', () => {
    const src = read();
    for (const b of src.match(/<EmptyState[\s\S]*?\/>/g) ?? []) {
      expect(b).toMatch(/action=/);
      expect(b).not.toMatch(/description=/);
    }
    for (const b of src.match(/<ErrorState[\s\S]*?\/>/g) ?? []) {
      expect(b).toMatch(/safe=/);
      expect(b).not.toMatch(/description=/);
    }
  });
});
