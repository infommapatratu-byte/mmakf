// Registration, and the queue that turns a request into authority.
//
// The federation's instruction was: "make sure all should be able to create and
// access their authorised section only — like coach, referee, seller. If
// onboarded they can list their items after approval by our people in admin."
//
// Most of this file is the first half of that sentence attacked from the angles
// that actually break it: an account that thinks registering made it somebody,
// an applicant who also happens to hold the reviewing authority, a reviewer
// reaching for a role more powerful than their own, and an administrator in one
// state quietly binding a coach to the whole country.
//
// Every test here is written against a real Postgres (PGlite) with every
// migration applied, because the rules being proved are half enforced by
// partial unique indexes and half by SQL predicates, and neither exists in a
// mock.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  registerAccount, applyForRole, reviewApplication, withdrawApplication,
  myApplications, applicationQueue, applicationDetail, canReviewApplications,
  APPLICABLE_ROLES, APPLICATION_MUST_NOT_CONFER, isApplicableRole,
  EVIDENCE_REQUIREMENTS_NOT_SET, REVIEW_TURNAROUND_NOT_SET,
  isOnboardingError,
} from '../src/db/onboarding';
import { resolvePrincipal } from '../src/db/users';
import { can, canAnywhere, actionsForRole, type Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number;
let ADMIN: number, JH_ADMIN: number, JH_STATE: number;

const PW = 'a-perfectly-ordinary-passphrase';

/**
 * A national administrator who can confer roles.
 *
 * Built as a getter over an id captured from the INSERT rather than a literal
 * 1, because seeding `{ id: 1 }` by hand does not advance the serial sequence —
 * and the next real registration then collides on the primary key. That
 * collision surfaced as "an account already exists for…", which is the wrong
 * diagnosis for the right symptom and cost a debugging cycle.
 */
const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});

/**
 * An administrator with granting authority bound to ONE state.
 *
 * This is the Jharkhand administrator of rule 4, built without touching
 * src/lib/rbac.ts: a role binding is (role, scope), and nothing says
 * FEDERATION_ADMIN must be national. canGrantRole() then covers state JH and
 * nothing else, which is exactly the containment being tested.
 */
const jhGranter = (): Principal => ({
  userId: JH_ADMIN, label: 'jh-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: JH }],
});

/** A state administrator, who under the current model holds NO role:grant. */
const jhStateAdmin = (): Principal => ({
  userId: JH_STATE, label: 'jh-state',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});

const ctxOf = (principal: Principal) => ({ principal });

async function register(email: string) {
  const r = await registerAccount(db, { email, password: PW });
  return {
    ...r,
    principal: { userId: r.userId, label: r.email, bindings: [] } as Principal,
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
  const seeded = await db.insert(s.users).values([
    { email: 'admin@mmakf.in', status: 'active' },
    { email: 'jh-admin@mmakf.in', status: 'active' },
    { email: 'jh-state@mmakf.in', status: 'active' },
  ]).returning({ id: s.users.id });
  [ADMIN, JH_ADMIN, JH_STATE] = seeded.map((u: any) => u.id);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
});

// ─── RULE 1 ─────────────────────────────────────────────────────────────────

describe('RULE 1: REGISTRATION GRANTS NOTHING', () => {
  it('creates an account with zero role bindings', async () => {
    const me = await register('nobody@example.in');
    expect(me.roleBindingCount).toBe(0);

    const rows = await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId));
    expect(rows).toEqual([]);

    // Not merely "no rows" — the principal the rest of the system will actually
    // build for this account carries nothing.
    const principal = await resolvePrincipal(db, me.userId, 0);
    expect(principal!.bindings).toEqual([]);
  });

  it('the new account is refused by the authorisation engine for everything', async () => {
    const me = await register('nothing@example.in');
    const p = (await resolvePrincipal(db, me.userId, 0))!;

    for (const action of [
      'person:read', 'person:read_pii', 'membership:read', 'user:read', 'user:write',
      'role:grant', 'audit:read', 'finance:read', 'content:write',
      'marketplace:read', 'marketplace:review', 'marketplace:suspend',
    ] as const) {
      expect(can(p, action, {}), action).toBe(false);
      expect(can(p, action, { stateUnitId: JH }), action).toBe(false);
      expect(canAnywhere(p, action), action).toBe(false);
    }
  });

  it('cannot reach the application review queue', async () => {
    const me = await register('queue-peeker@example.in');
    expect(canReviewApplications(me.principal)).toBe(false);
    await expect(applicationQueue(db, me.principal)).rejects.toThrow(/role:grant/);
    await expect(applicationDetail(db, me.principal, 1)).rejects.toThrow(/role:grant/);
  });

  it('sees only its own applications, and a fresh account has none', async () => {
    const me = await register('own-only@example.in');
    expect(await myApplications(db, me.principal)).toEqual([]);

    // Somebody else's application exists and is invisible.
    const other = await register('somebody-else@example.in');
    await applyForRole(db, ctxOf(other.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: JH });
    expect(await myApplications(db, me.principal)).toEqual([]);
    expect((await myApplications(db, other.principal)).length).toBe(1);
  });

  it('DOES NOT CLAIM A VERIFICATION EMAIL WAS SENT', async () => {
    const me = await register('honest@example.in');
    // No email transport is configured in this project. Telling somebody to
    // check an inbox would send them to wait for something never coming, and
    // src/lib/notifications.ts already refuses to lie in exactly this way.
    expect(me.verification.emailSent).toBe(false);
    expect(me.verification.note).toMatch(/no verification|not sent|no email transport/i);
    expect(me.verification.note).not.toMatch(/check your (inbox|email)/i);

    const queued = await db.select().from(s.notifications);
    expect(queued.length).toBe(0);
  });

  it('records the registration in the audit trail as conferring nothing', async () => {
    const me = await register('audited@example.in');
    const rows = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'user'), eq(s.auditEvents.entityId, String(me.userId))));
    expect(rows.length).toBe(1);
    expect(rows[0].newValue.selfRegistered).toBe(true);
    expect(rows[0].newValue.roleBindingsGranted).toBe(0);
  });

  it('refuses a duplicate email and a password below policy', async () => {
    await register('taken@example.in');
    await expect(register('taken@example.in')).rejects.toThrow(/already exists/i);
    await expect(registerAccount(db, { email: 'weak@example.in', password: 'short' }))
      .rejects.toThrow(/12 characters/);
  });
});

// ─── RULE 2 ─────────────────────────────────────────────────────────────────

describe('RULE 2: NOBODY DECIDES THEIR OWN APPLICATION', () => {
  it('refuses self-approval even for a SUPER_ADMIN', async () => {
    const me = await register('super-applicant@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'INSTRUCTOR', scopeType: 'state', scopeId: JH,
    });

    // The applicant holds the highest authority in the system and applies to
    // themselves anyway. src/lib/approvals.ts refuses self-approval for every
    // role without exception, and this matches it.
    const selfSuper: Principal = {
      userId: me.userId, label: 'super-applicant',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };

    await expect(
      reviewApplication(db, ctxOf(selfSuper), app.applicationId, { decision: 'approve', reason: 'I know myself.' })
    ).rejects.toThrow(/cannot decide their own/i);

    // And no binding leaked out of the attempt.
    const bindings = await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId));
    expect(bindings).toEqual([]);
  });

  it('refuses self-REJECTION too, and points at the function that exists for it', async () => {
    const me = await register('self-rejecter@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'JUDGE', scopeType: 'state', scopeId: JH,
    });
    const selfSuper: Principal = {
      userId: me.userId, label: 'self',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    await expect(
      reviewApplication(db, ctxOf(selfSuper), app.applicationId, { decision: 'reject', reason: 'Changed my mind.' })
    ).rejects.toThrow(/withdrawApplication/);

    // Withdrawing is the supported path, and it works.
    const done = await withdrawApplication(db, ctxOf(me.principal), app.applicationId, 'Reapplying later.');
    expect(done.status).toBe('withdrawn');
  });

  it('refuses a decision that cannot be attributed to anybody', async () => {
    const me = await register('anon-target@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'ATHLETE', scopeType: 'state', scopeId: JH,
    });
    // A principal with no userId cannot be compared against the applicant, so
    // the self-review rule could not have fired. Refusing is the only safe read.
    const ghost: Principal = {
      userId: null, label: 'legacy-admin',
      bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
    };
    await expect(
      reviewApplication(db, ctxOf(ghost), app.applicationId, { decision: 'approve', reason: 'ok' })
    ).rejects.toThrow(/attributable/i);
  });
});

// ─── RULE 3 ─────────────────────────────────────────────────────────────────

describe('RULE 3: NO PRIVILEGE AMPLIFICATION', () => {
  it('no role that may be applied for holds an escalating action', () => {
    // Structural, not a spot-check: if somebody widens INSTRUCTOR in rbac.ts to
    // include user:write, this fails before the application queue quietly
    // becomes a way to request it.
    for (const role of APPLICABLE_ROLES) {
      const held = actionsForRole(role);
      for (const forbidden of APPLICATION_MUST_NOT_CONFER) {
        expect(held, `${role} must not confer ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('administrative authority cannot even be requested', async () => {
    const me = await register('ambitious@example.in');
    for (const role of ['SUPER_ADMIN', 'FEDERATION_ADMIN', 'SAFEGUARDING_OFFICER', 'FINANCE_OFFICER', 'STATE_ADMIN'] as const) {
      expect(isApplicableRole(role)).toBe(false);
      await expect(
        applyForRole(db, ctxOf(me.principal), { requestedRole: role, scopeType: 'national', scopeId: null })
      ).rejects.toThrow(/conferred by the federation, not requested/);
    }
  });

  it('a row that names a restricted role is REFUSED AT DECISION TIME as well', async () => {
    // Rows outlive code. This one is written straight into the table, as an
    // earlier version of the endpoint or a compromised path might have, and the
    // reviewer is a national administrator who would otherwise sail through.
    const me = await register('smuggler@example.in');
    const [row] = await db.insert(s.roleApplications).values({
      ref: 'MMAKF-APP-2026-999001',
      applicantUserId: me.userId,
      requestedRole: 'SUPER_ADMIN',
      scopeType: 'national', scopeId: null,
      status: 'submitted',
    }).returning({ id: s.roleApplications.id });

    await expect(
      reviewApplication(db, ctxOf(national()), row.id, { decision: 'approve', reason: 'Looks fine to me.' })
    ).rejects.toThrow(/not a role that may be conferred/);

    const bindings = await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId));
    expect(bindings).toEqual([]);
  });

  it('a SAFEGUARDING_OFFICER application cannot be approved by a federation admin', async () => {
    const me = await register('safeguard-seeker@example.in');
    const [row] = await db.insert(s.roleApplications).values({
      ref: 'MMAKF-APP-2026-999002',
      applicantUserId: me.userId,
      requestedRole: 'SAFEGUARDING_OFFICER',
      scopeType: 'national', scopeId: null,
      status: 'submitted',
    }).returning({ id: s.roleApplications.id });

    await expect(
      reviewApplication(db, ctxOf(national()), row.id, { decision: 'approve', reason: 'Approved.' })
    ).rejects.toThrow();
    expect((await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId)))).toEqual([]);
  });

  it('APPROVAL GOES THROUGH canGrantRole: a state admin holds no granting power and is refused', async () => {
    const me = await register('coach-in-jh@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'INSTRUCTOR', scopeType: 'state', scopeId: JH,
    });

    // The applicant is in the state administrator's own state, and the role is
    // one they could never abuse. It is still refused, because canGrantRole()
    // requires role:grant and STATE_ADMIN does not hold it. The queue is not a
    // softer path to a binding than the admin console.
    const st = jhStateAdmin();
    expect(canReviewApplications(st)).toBe(false);
    await expect(
      reviewApplication(db, ctxOf(st), app.applicationId, { decision: 'approve', reason: 'Known to me.' })
    ).rejects.toThrow(/cannot confer INSTRUCTOR/);

    expect((await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId)))).toEqual([]);

    // The application survives the refused attempt, still open for somebody
    // who does hold the authority.
    const [after] = await db.select().from(s.roleApplications).where(eq(s.roleApplications.id, app.applicationId));
    expect(after.status).toBe('submitted');
  });
});

// ─── RULE 4 ─────────────────────────────────────────────────────────────────

describe('RULE 4: SCOPE CONTAINMENT', () => {
  it('a Jharkhand granter binds a Jharkhand coach — at the APPLICATION\'S scope', async () => {
    const me = await register('jh-coach@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'INSTRUCTOR', scopeType: 'state', scopeId: JH,
      evidence: { grade: 'as stated by the applicant', years: 6 },
    });

    const result = await reviewApplication(db, ctxOf(jhGranter()), app.applicationId, {
      decision: 'approve', reason: 'Evidence seen at the state office.',
    });

    expect(result.status).toBe('approved');
    expect(result.boundAt).toEqual({ role: 'INSTRUCTOR', scopeType: 'state', scopeId: JH });

    const [binding] = await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId));
    // THE BINDING IS NOT NATIONAL. There is no parameter on reviewApplication()
    // that could have made it national, which is the point of the design.
    expect(binding.scopeType).toBe('state');
    expect(binding.scopeId).toBe(JH);
    expect(binding.role).toBe('INSTRUCTOR');

    // And the authority is real, but only there.
    const p = (await resolvePrincipal(db, me.userId, 0))!;
    expect(can(p, 'grading:read', { stateUnitId: JH })).toBe(true);
    expect(can(p, 'grading:read', { stateUnitId: BR })).toBe(false);
    expect(can(p, 'grading:read', {})).toBe(false);
  });

  it('a Jharkhand granter cannot approve a NATIONAL application', async () => {
    const me = await register('wants-national@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'REFEREE', scopeType: 'national', scopeId: null,
    });

    await expect(
      reviewApplication(db, ctxOf(jhGranter()), app.applicationId, { decision: 'approve', reason: 'Good referee.' })
    ).rejects.toThrow(/cannot confer REFEREE at national/);

    expect((await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId)))).toEqual([]);
  });

  it('a Jharkhand granter cannot approve a Bihar application', async () => {
    const me = await register('bihar-referee@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'REFEREE', scopeType: 'state', scopeId: BR,
    });
    await expect(
      reviewApplication(db, ctxOf(jhGranter()), app.applicationId, { decision: 'approve', reason: 'Fine.' })
    ).rejects.toThrow(/cannot confer REFEREE at state/);
  });

  it('THE QUEUE ITSELF IS SCOPED IN SQL, not filtered afterwards', async () => {
    const jhApplicant = await register('queue-jh@example.in');
    const brApplicant = await register('queue-br@example.in');
    await applyForRole(db, ctxOf(jhApplicant.principal), { requestedRole: 'JUDGE', scopeType: 'state', scopeId: JH });
    await applyForRole(db, ctxOf(brApplicant.principal), { requestedRole: 'JUDGE', scopeType: 'state', scopeId: BR });

    const jhQueue = await applicationQueue(db, jhGranter(), { limit: 200 });
    expect(jhQueue.rows.length).toBeGreaterThan(0);
    expect(jhQueue.rows.every((r: any) => r.scopeType === 'state' && r.scopeId === JH)).toBe(true);

    const natQueue = await applicationQueue(db, national(), { limit: 200 });
    const scopes = new Set(natQueue.rows.map((r: any) => `${r.scopeType}:${r.scopeId}`));
    expect(scopes.size).toBeGreaterThan(1);
  });

  it('a Bihar application is not merely un-approvable, it is INVISIBLE to Jharkhand', async () => {
    const me = await register('invisible-br@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'ATHLETE', scopeType: 'state', scopeId: BR });
    await expect(applicationDetail(db, jhGranter(), app.applicationId)).rejects.toThrow(/within your scope/);
    // The same row is perfectly visible to somebody with national reach.
    expect((await applicationDetail(db, national(), app.applicationId)).id).toBe(app.applicationId);
  });
});

// ─── RULE 9 ─────────────────────────────────────────────────────────────────

describe('RULE 9: A DECISION REQUIRES A RECORDED REASON', () => {
  it('refuses an approval and a rejection with no reason', async () => {
    const me = await register('reasonless@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'MEMBER', scopeType: 'state', scopeId: JH });

    for (const decision of ['approve', 'reject'] as const) {
      await expect(
        reviewApplication(db, ctxOf(national()), app.applicationId, { decision, reason: '   ' } as any)
      ).rejects.toThrow(/requires a recorded reason/);
    }
  });

  it('stores the reason on the row AND on the audit trail', async () => {
    const me = await register('rejected-with-reason@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'EXAMINER', scopeType: 'state', scopeId: JH });

    const reason = 'The federation has not yet published examiner requirements; deferred pending that decision.';
    await reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'reject', reason });

    const [row] = await db.select().from(s.roleApplications).where(eq(s.roleApplications.id, app.applicationId));
    expect(row.status).toBe('rejected');
    expect(row.decisionReason).toBe(reason);
    expect(row.reviewedByUserId).toBe(ADMIN);
    expect(row.reviewedAt).toBeTruthy();

    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'role_application'), eq(s.auditEvents.entityId, String(app.applicationId))));
    const decision = audit.find((a: any) => a.action === 'reject');
    expect(decision.reason).toBe(reason);

    // A rejection creates nothing.
    expect((await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId)))).toEqual([]);
  });
});

// ─── The ordinary paths ─────────────────────────────────────────────────────

describe('applying, and the ordinary paths through the queue', () => {
  it('captures whatever evidence the applicant supplies, and judges none of it', async () => {
    const me = await register('evidence@example.in');
    const evidence = {
      grade: 'Shodan, as stated by the applicant',
      licence: 'not held',
      years: 11,
      references: ['Sensei A', 'Sensei B'],
      note: 'Trained abroad 2019-2021.',
    };
    const app = await applyForRole(db, ctxOf(me.principal), {
      requestedRole: 'INSTRUCTOR', scopeType: 'state', scopeId: BR, evidence,
    });
    const [row] = await db.select().from(s.roleApplications).where(eq(s.roleApplications.id, app.applicationId));
    // Verbatim. No field was required, none was rejected, and nothing about
    // 'licence: not held' stopped the application being filed — because what
    // qualifies an instructor is a federation decision nobody has published.
    expect(row.evidence).toEqual(evidence);
  });

  it('an application with no evidence at all is still accepted', async () => {
    const me = await register('no-evidence@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'ATHLETE', scopeType: 'state', scopeId: JH });
    expect(app.status).toBe('submitted');
  });

  it('says the federation has not published a requirement, rather than inventing one', async () => {
    expect(EVIDENCE_REQUIREMENTS_NOT_SET).toMatch(/has not published/);
    expect(REVIEW_TURNAROUND_NOT_SET).toMatch(/has not set/);
    const queue = await applicationQueue(db, national(), { limit: 1 });
    expect(queue.turnaround).toBe(REVIEW_TURNAROUND_NOT_SET);
    // No promise of a turnaround anywhere in the payload.
    expect(JSON.stringify(queue)).not.toMatch(/48 hours|two working days|within \d+ days/i);
  });

  it('refuses a second open application for the same role and scope', async () => {
    const me = await register('impatient@example.in');
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: JH });
    await expect(
      applyForRole(db, ctxOf(me.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: JH })
    ).rejects.toThrow(/already open/);
  });

  it('refuses a second open NATIONAL application, where NULL scope ids would otherwise slip through', async () => {
    // The case a single unique index misses: Postgres treats NULLs as distinct,
    // so without the second partial index this user could file unlimited
    // national applications — the widest scope, and the one an attacker picks.
    const me = await register('national-spammer@example.in');
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'JUDGE', scopeType: 'national', scopeId: null });
    await expect(
      applyForRole(db, ctxOf(me.principal), { requestedRole: 'JUDGE', scopeType: 'national', scopeId: null })
    ).rejects.toThrow(/already open/);
  });

  it('allows the same role in a DIFFERENT scope, and a different role in the same scope', async () => {
    const me = await register('legitimately-busy@example.in');
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: JH });
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: BR });
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'JUDGE', scopeType: 'state', scopeId: JH });
    expect((await myApplications(db, me.principal)).length).toBe(3);
  });

  it('refuses an application for a role the account already holds', async () => {
    const me = await register('already-a-judge@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'JUDGE', scopeType: 'state', scopeId: JH });
    await reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'approve', reason: 'Licensed.' });
    await expect(
      applyForRole(db, ctxOf(me.principal), { requestedRole: 'JUDGE', scopeType: 'state', scopeId: JH })
    ).rejects.toThrow(/already holds/);
  });

  it('refuses a scope that does not exist, rather than filing into a queue nobody reads', async () => {
    const me = await register('bad-scope@example.in');
    await expect(
      applyForRole(db, ctxOf(me.principal), { requestedRole: 'ATHLETE', scopeType: 'state', scopeId: 99999 })
    ).rejects.toThrow(/No such state unit/);
    await expect(
      applyForRole(db, ctxOf(me.principal), { requestedRole: 'ATHLETE', scopeType: 'state', scopeId: null })
    ).rejects.toThrow(/must name the unit/);
  });

  it('refuses evidence too large to belong in a jsonb column', async () => {
    const me = await register('bulk-evidence@example.in');
    await expect(
      applyForRole(db, ctxOf(me.principal), {
        requestedRole: 'MEMBER', scopeType: 'state', scopeId: JH,
        evidence: { blob: 'x'.repeat(20_000) },
      })
    ).rejects.toThrow(/16384 characters/);
  });

  it('cannot withdraw somebody else\'s application', async () => {
    const mine = await register('withdraw-mine@example.in');
    const theirs = await register('withdraw-theirs@example.in');
    const app = await applyForRole(db, ctxOf(theirs.principal), { requestedRole: 'MEMBER', scopeType: 'state', scopeId: BR });

    await expect(withdrawApplication(db, ctxOf(mine.principal), app.applicationId)).rejects.toThrow(/No open application of yours/);
    const [row] = await db.select().from(s.roleApplications).where(eq(s.roleApplications.id, app.applicationId));
    expect(row.status).toBe('submitted');
  });

  it('an approval creates the binding and the account can immediately use it', async () => {
    const me = await register('promoted@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'REFEREE', scopeType: 'state', scopeId: BR });

    const before = (await resolvePrincipal(db, me.userId, 0))!;
    expect(can(before, 'result:enter', { stateUnitId: BR })).toBe(false);

    await reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'approve', reason: 'Licence verified.' });

    // Bindings are resolved per request, never cached in a cookie, so the new
    // authority is live on the next call without any session change.
    const after = (await resolvePrincipal(db, me.userId, 0))!;
    expect(can(after, 'result:enter', { stateUnitId: BR })).toBe(true);
    expect(can(after, 'result:enter', { stateUnitId: JH })).toBe(false);
  });

  it('a decided application cannot be decided again', async () => {
    const me = await register('decided-once@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'ATHLETE', scopeType: 'state', scopeId: BR });
    await reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'approve', reason: 'Registered athlete.' });

    await expect(
      reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'reject', reason: 'Actually, no.' })
    ).rejects.toThrow(/already approved/);

    // Exactly one binding, not two.
    const bindings = await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId));
    expect(bindings.length).toBe(1);
  });

  it('a withdrawn application cannot then be approved', async () => {
    const me = await register('withdrawn-then@example.in');
    const app = await applyForRole(db, ctxOf(me.principal), { requestedRole: 'MEMBER', scopeType: 'state', scopeId: BR });
    await withdrawApplication(db, ctxOf(me.principal), app.applicationId, 'Not ready.');
    await expect(
      reviewApplication(db, ctxOf(national()), app.applicationId, { decision: 'approve', reason: 'Anyway.' })
    ).rejects.toThrow(/already withdrawn/);
    expect((await db.select().from(s.roleBindings).where(eq(s.roleBindings.userId, me.userId)))).toEqual([]);
  });

  it('the queue tells a reviewer, per row, whether they may actually decide it', async () => {
    const me = await register('per-row@example.in');
    await applyForRole(db, ctxOf(me.principal), { requestedRole: 'INSTRUCTOR', scopeType: 'state', scopeId: JH });
    const queue = await applicationQueue(db, jhGranter(), { limit: 200 });
    expect(queue.rows.every((r: any) => r.canDecide === true)).toBe(true);
    // A screen that offered a button it would then refuse teaches people to
    // distrust the system, so the answer travels with the row.
    expect(queue.rows.every((r: any) => r.evidenceRequirement === EVIDENCE_REQUIREMENTS_NOT_SET)).toBe(true);
  });

  it('errors are identifiable by code without instanceof across module boundaries', async () => {
    const me = await register('error-shape@example.in');
    try {
      await applyForRole(db, ctxOf(me.principal), { requestedRole: 'SUPER_ADMIN' as any, scopeType: 'national', scopeId: null });
      expect.unreachable();
    } catch (err) {
      expect(isOnboardingError(err)).toBe(true);
      expect((err as any).code).toBe('role_not_applicable');
    }
  });
});
