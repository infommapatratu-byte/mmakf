// Two-person control, against real Postgres.
//
// The invariant these tests exist to protect: THE APPROVER MUST NOT BE THE
// REQUESTER. Every other test here guards a way that rule could be made
// meaningless in practice — a second person who lacks the authority, an act
// executed twice, a failure silently swallowed, or a queue that offers someone
// their own request to sign off.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, asc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  requestApproval, approve, reject, executeIfApproved, pendingApprovals,
  approvalState, ApprovalError, APPROVAL_ACTIONS,
} from '../src/lib/approvals';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, JH: number, OTHER: number, PEND: number;

const NOW = new Date('2026-08-12T09:00:00Z');

// ─── Principals. Distinct userIds are the whole point of this module. ───────

const superA: Principal = {
  userId: 1, label: 'super-admin-a',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const superB: Principal = {
  userId: 2, label: 'super-admin-b',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const fedAdmin: Principal = {
  userId: 3, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Holds finance:write. Holds no certificate:revoke — so not a second authorisation for one. */
const finance: Principal = {
  userId: 4, label: 'finance-officer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 5, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/** A shared/legacy login: authorised, but not an identifiable person. */
const legacy: Principal = {
  userId: null, label: 'legacy-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

// Scoped administrators, for proving the approver's authority is checked in the
// REQUEST'S scope and not merely somewhere.
const jhAdmin: Principal = {
  userId: 10, label: 'jh-admin', bindings: [],
};
const jhAdmin2: Principal = {
  userId: 11, label: 'jh-admin-2', bindings: [],
};
const otherAdmin: Principal = {
  userId: 12, label: 'other-state-admin', bindings: [],
};

// Annotated explicitly: without it TypeScript widens the inferred shape and the
// AuditContext parameter stops matching at every call site.
const ctxOf = (principal: Principal): AuditContext => ({ principal });

/** A certificate revocation request raised by `by`, national scope. */
async function raise(by: Principal, over: Record<string, any> = {}, policy = {}, now = NOW) {
  return requestApproval(db, ctxOf(by), {
    action: 'certificate_revocation',
    entityType: 'certificate',
    entityId: 4242,
    payload: { certificateNo: 'MMAKF-CERT-2026-000001' },
    reason: 'Grade found to rest on a falsified attendance record.',
    ...over,
  } as any, policy, now);
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
  const [ot] = await db.insert(s.stateUnits)
    .values({ code: 'ST-BR', state: 'Bihar', name: 'BR', status: 'active' })
    .returning({ id: s.stateUnits.id });
  OTHER = ot.id;
  const [pd] = await db.insert(s.stateUnits)
    .values({ code: 'ST-OD', state: 'Odisha', name: 'OD', status: 'active' })
    .returning({ id: s.stateUnits.id });
  PEND = pd.id;

  jhAdmin.bindings = [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: JH }];
  jhAdmin2.bindings = [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: JH }];
  otherAdmin.bindings = [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: OTHER }];
});

// ─── The central rule ───────────────────────────────────────────────────────

describe('THE APPROVER MUST NOT BE THE REQUESTER', () => {
  it('refuses self-approval by a SUPER_ADMIN — the role most likely to be given an exception', async () => {
    const id = await raise(superA);
    await expect(approve(db, ctxOf(superA), id, NOW)).rejects.toThrow(ApprovalError);
    await expect(approve(db, ctxOf(superA), id, NOW)).rejects.toMatchObject({ code: 'self_approval' });

    // And the refusal left no approval behind.
    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.status).toBe('pending');
    expect(state.approvals).toHaveLength(0);
  });

  it('accepts the identical approval from a different person', async () => {
    const id = await raise(superA);
    const state = await approve(db, ctxOf(superB), id, NOW);
    expect(state.status).toBe('approved');
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].by.userId).toBe(superB.userId);
    expect(state.requester.userId).toBe(superA.userId);
  });

  it('refuses a shared login on both halves — two people, not two calls', async () => {
    await expect(raise(legacy)).rejects.toMatchObject({ code: 'unidentified_principal' });

    const id = await raise(superA);
    await expect(approve(db, ctxOf(legacy), id, NOW))
      .rejects.toMatchObject({ code: 'unidentified_principal' });
  });
});

describe('the second person must independently hold the authority', () => {
  it('refuses an approver who lacks the permission the act requires', async () => {
    const id = await raise(superA);
    // The finance officer is a real, identified second person — and still not a
    // second authorisation for a certificate revocation.
    await expect(approve(db, ctxOf(finance), id, NOW)).rejects.toThrow(ForbiddenError);
    expect((await approvalState(db, ctxOf(superA), id, NOW)).status).toBe('pending');
  });

  it('refuses an approver whose authority is in a different scope', async () => {
    const id = await raise(jhAdmin, { scope: { stateUnitId: JH } });
    await expect(approve(db, ctxOf(otherAdmin), id, NOW)).rejects.toThrow(ForbiddenError);

    const state = await approve(db, ctxOf(jhAdmin2), id, NOW);
    expect(state.status).toBe('approved');
  });

  it('refuses a requester who lacks the authority — this is not a route to obtaining it', async () => {
    await expect(raise(athlete)).rejects.toThrow(ForbiddenError);
  });

  it('refuses an act that is not under two-person control at all', async () => {
    await expect(raise(superA, { action: 'delete_everything' }))
      .rejects.toMatchObject({ code: 'unknown_action' });
  });

  it('binds each named act to an authority nobody can hold by accident', async () => {
    // The seven acts the directive names, and nothing else.
    expect(Object.keys(APPROVAL_ACTIONS).sort()).toEqual([
      'certificate_revocation', 'dan_grade_approval', 'disciplinary_outcome',
      'financial_settlement', 'national_team_selection', 'policy_publication',
      'result_correction',
    ]);
    // A finance officer can second a settlement but not a Dan grade.
    const settlement = await requestApproval(db, ctxOf(fedAdmin), {
      action: 'financial_settlement', entityType: 'settlement', entityId: 7,
      payload: { amountPaise: 250000 },
      reason: 'Quarterly settlement to the state unit.',
    }, {}, NOW);
    const state = await approve(db, ctxOf(finance), settlement, NOW);
    expect(state.status).toBe('approved');

    const dan = await requestApproval(db, ctxOf(fedAdmin), {
      action: 'dan_grade_approval', entityType: 'grading_candidate', entityId: 9,
      payload: { grade: 'Godan' }, reason: 'Panel recommendation for 5th Dan.',
    }, {}, NOW);
    await expect(approve(db, ctxOf(finance), dan, NOW)).rejects.toThrow(ForbiddenError);
  });
});

// ─── Execution ──────────────────────────────────────────────────────────────

describe('execution happens once, and only once', () => {
  it('runs the handler on the first call and never again', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);

    let runs = 0;
    const handler = async () => { runs++; return { revokedCertificateId: 4242 }; };

    const first = await executeIfApproved(db, ctxOf(superA), id, handler, NOW);
    expect(first.ran).toBe(true);
    expect(runs).toBe(1);
    expect(first.outcome).toEqual({ revokedCertificateId: 4242 });

    const second = await executeIfApproved(db, ctxOf(superA), id, handler, NOW);
    expect(second.ran).toBe(false);
    expect(runs).toBe(1);                         // the handler did NOT run again
    expect(second.outcome).toEqual(first.outcome); // the recorded outcome is returned
    expect(second.executedAt).toBe(first.executedAt);
    expect(second.executedBy.userId).toBe(superA.userId);
  });

  it('refuses to execute a request that has not been approved', async () => {
    const id = await raise(superA);
    let runs = 0;
    await expect(
      executeIfApproved(db, ctxOf(superB), id, async () => { runs++; }, NOW)
    ).rejects.toMatchObject({ code: 'not_approved' });
    expect(runs).toBe(0);
  });

  it('refuses to execute for someone without the authority', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);
    await expect(
      executeIfApproved(db, ctxOf(finance), id, async () => 'done', NOW)
    ).rejects.toThrow(ForbiddenError);
  });

  it('leaves a failing handler recoverable: approved, unexecuted, error recorded, error rethrown', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);

    await expect(
      executeIfApproved(db, ctxOf(superA), id, async () => { throw new Error('payment gateway unreachable'); }, NOW)
    ).rejects.toThrow('payment gateway unreachable');   // never silently consumed

    const after = await approvalState(db, ctxOf(superA), id, NOW);
    expect(after.status).toBe('approved');              // still approved…
    expect(after.execution).toBeNull();                 // …and still unexecuted
    expect(after.failures).toHaveLength(1);
    expect(after.failures[0].error).toMatch(/payment gateway unreachable/);
    expect(after.failures[0].by.userId).toBe(superA.userId);

    // The operator fixes the cause and retries. No second approval is demanded.
    const retry = await executeIfApproved(db, ctxOf(superA), id, async () => 'ok', NOW);
    expect(retry.ran).toBe(true);
    expect(retry.outcome).toBe('ok');
    expect((await approvalState(db, ctxOf(superA), id, NOW)).failures).toHaveLength(1); // the failure is kept
  });

  it('records a handler that returns nothing as null, not as a missing execution', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);
    const r = await executeIfApproved(db, ctxOf(superA), id, async () => { /* side effect only */ }, NOW);
    expect(r.ran).toBe(true);
    expect(r.outcome).toBeNull();
    expect((await approvalState(db, ctxOf(superA), id, NOW)).status).toBe('executed');
  });
});

// ─── Expiry ─────────────────────────────────────────────────────────────────

describe('expiry applies ONLY when the federation has configured a window', () => {
  it('does not expire when no window is set, and says that is why', async () => {
    const id = await raise(superA);
    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.expiry.configured).toBe(false);
    expect(state.expiry.windowHours).toBeNull();
    expect(state.expiry.expiresAt).toBeNull();
    expect(state.expiry.note).toMatch(/No approval window has been configured/i);

    // A century later it is still pending. An unset rule is not applied.
    const later = await approvalState(db, ctxOf(superA), id, new Date('2126-08-12T09:00:00Z'));
    expect(later.status).toBe('pending');
  });

  it('lapses once the configured window has passed, and refuses approval after', async () => {
    const id = await raise(superA, {}, { windowHours: 24 });
    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.expiry.configured).toBe(true);
    expect(state.expiry.windowHours).toBe(24);
    expect(state.expiry.expiresAt).toBe('2026-08-13T09:00:00.000Z');

    const inWindow = new Date('2026-08-13T08:59:00Z');
    expect((await approvalState(db, ctxOf(superA), id, inWindow)).status).toBe('pending');

    const past = new Date('2026-08-13T10:00:00Z');
    expect((await approvalState(db, ctxOf(superA), id, past)).status).toBe('lapsed');
    await expect(approve(db, ctxOf(superB), id, past)).rejects.toMatchObject({ code: 'not_pending' });
  });

  it('does not lapse a request that was already approved inside its window', async () => {
    const id = await raise(superA, {}, { windowHours: 24 });
    await approve(db, ctxOf(superB), id, new Date('2026-08-12T10:00:00Z'));
    const past = await approvalState(db, ctxOf(superA), id, new Date('2026-09-01T00:00:00Z'));
    expect(past.status).toBe('approved');
  });

  it('refuses a window that is not a positive whole number of hours', async () => {
    await expect(raise(superA, {}, { windowHours: 0 })).rejects.toMatchObject({ code: 'bad_window' });
    await expect(raise(superA, {}, { windowHours: -4 })).rejects.toMatchObject({ code: 'bad_window' });
    await expect(raise(superA, {}, { windowHours: 1.5 })).rejects.toMatchObject({ code: 'bad_window' });
  });
});

// ─── Rejection ──────────────────────────────────────────────────────────────

describe('rejection', () => {
  it('requires a reason and is terminal', async () => {
    const id = await raise(superA);
    await expect(reject(db, ctxOf(superB), id, '  ', NOW)).rejects.toMatchObject({ code: 'reason_required' });

    const state = await reject(db, ctxOf(superB), id, 'The attendance record was verified as genuine.', NOW);
    expect(state.status).toBe('rejected');
    expect(state.rejection!.by.userId).toBe(superB.userId);
    expect(state.rejection!.reason).toMatch(/verified as genuine/);

    await expect(approve(db, ctxOf(fedAdmin), id, NOW)).rejects.toMatchObject({ code: 'not_pending' });
    await expect(reject(db, ctxOf(fedAdmin), id, 'again', NOW)).rejects.toMatchObject({ code: 'not_pending' });
  });

  it('lets the requester withdraw their own request, and records it as a withdrawal', async () => {
    const id = await raise(superA);
    const state = await reject(db, ctxOf(superA), id, 'Raised against the wrong certificate.', NOW);
    expect(state.status).toBe('rejected');
    expect(state.rejection!.selfWithdrawn).toBe(true);
  });
});

// ─── More than two people, when configured ──────────────────────────────────

describe('a higher approval count is configuration, and one person cannot supply it twice', () => {
  it('holds at pending until enough DISTINCT people have approved', async () => {
    const id = await raise(superA, {}, { approvalsRequired: 2 });

    const one = await approve(db, ctxOf(superB), id, NOW);
    expect(one.status).toBe('pending');
    expect(one.approvals).toHaveLength(1);

    await expect(approve(db, ctxOf(superB), id, NOW))
      .rejects.toMatchObject({ code: 'already_approved_by_you' });

    const two = await approve(db, ctxOf(fedAdmin), id, NOW);
    expect(two.status).toBe('approved');
    expect(two.approvals.map((a) => a.by.userId).sort()).toEqual([2, 3]);
  });

  it('refuses a configured count below one', async () => {
    await expect(raise(superA, {}, { approvalsRequired: 0 }))
      .rejects.toMatchObject({ code: 'bad_approvals_required' });
  });
});

// ─── The queue ──────────────────────────────────────────────────────────────

describe('the pending list shows only what this person may actually act on', () => {
  let alice: Principal, bob: Principal, carol: Principal;
  let aliceReq1: string, aliceReq2: string, bobReq: string, settlement: string;

  beforeAll(async () => {
    // Bound to their own state, so these requests cannot collide with any other
    // test's — a national principal would see everything ever raised.
    alice = { userId: 20, label: 'alice', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: PEND }] };
    bob = { userId: 21, label: 'bob', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: PEND }] };
    carol = { userId: 22, label: 'carol', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'state', scopeId: PEND }] };

    const scope = { stateUnitId: PEND };
    aliceReq1 = await raise(alice, { scope });
    aliceReq2 = await raise(alice, { scope });
    bobReq = await raise(bob, { scope });
    settlement = await requestApproval(db, ctxOf(alice), {
      action: 'financial_settlement', entityType: 'settlement', entityId: 99,
      payload: { amountPaise: 100000 }, reason: 'State unit grant.', scope,
    }, {}, NOW);
  });

  it('excludes the viewer’s own requests — they could not approve them anyway', async () => {
    const forAlice = await pendingApprovals(db, alice, { on: NOW });
    const ids = forAlice.items.map((r) => r.requestId);
    expect(ids).toContain(bobReq);
    expect(ids).not.toContain(aliceReq1);
    expect(ids).not.toContain(aliceReq2);
    expect(ids).not.toContain(settlement);
  });

  it('shows another person’s requests they hold the authority for', async () => {
    const forBob = await pendingApprovals(db, bob, { on: NOW });
    const ids = forBob.items.map((r) => r.requestId);
    expect(ids).toEqual(expect.arrayContaining([aliceReq1, aliceReq2, settlement]));
    expect(ids).not.toContain(bobReq);
  });

  it('hides requests whose authority the viewer does not hold', async () => {
    const forCarol = await pendingApprovals(db, carol, { on: NOW });
    expect(forCarol.items.map((r) => r.requestId)).toEqual([settlement]);
  });

  it('drops a request once it is approved, rejected or lapsed', async () => {
    await approve(db, ctxOf(bob), aliceReq1, NOW);
    await reject(db, ctxOf(bob), aliceReq2, 'Not supported by the record.', NOW);

    const forBob = await pendingApprovals(db, bob, { on: NOW });
    const ids = forBob.items.map((r) => r.requestId);
    expect(ids).not.toContain(aliceReq1);
    expect(ids).not.toContain(aliceReq2);

    const lapsing = await raise(alice, { scope: { stateUnitId: PEND } }, { windowHours: 1 });
    expect((await pendingApprovals(db, bob, { on: NOW })).items.map((r) => r.requestId)).toContain(lapsing);
    const past = new Date('2026-08-12T11:00:00Z');
    expect((await pendingApprovals(db, bob, { on: past })).items.map((r) => r.requestId)).not.toContain(lapsing);
  });

  it('returns nothing for an unidentified principal', async () => {
    const q = await pendingApprovals(db, legacy, { on: NOW });
    expect(q.items).toEqual([]);
    // …and it says WHY, rather than looking like an empty in-tray.
    expect(q.note).toMatch(/identified user account/i);
  });
});

// ─── Reconstruction ─────────────────────────────────────────────────────────

describe('the whole history is reconstructible from the event log alone', () => {
  it('records request, approval and execution as separate appended events, never an edit', async () => {
    const id = await requestApproval(db, ctxOf(superA), {
      action: 'result_correction', entityType: 'match_result', entityId: 555,
      payload: { from: { red: 5, blue: 3 }, to: { red: 3, blue: 5 } },
      reason: 'Scoreboard operator transposed the two totals.',
    }, { windowHours: 48 }, NOW);

    await approve(db, ctxOf(superB), id, new Date('2026-08-12T12:00:00Z'));
    await executeIfApproved(db, ctxOf(superA), id, async () => ({ corrected: true }),
      new Date('2026-08-12T13:00:00Z'));

    // Read the raw log. Nothing else.
    const rows = await db.select().from(s.domainEvents)
      .where(and(
        eq(s.domainEvents.entityType, 'approval_request'),
        eq(s.domainEvents.entityId, id)
      ))
      .orderBy(asc(s.domainEvents.id));

    expect(rows.map((r: any) => r.eventType)).toEqual([
      'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_EXECUTED',
    ]);

    // Who asked, why, who agreed, who ran it — all present in the rows themselves.
    expect(rows[0].payload.requester.userId).toBe(superA.userId);
    expect(rows[0].payload.reason).toMatch(/transposed/);
    expect(rows[0].payload.target).toEqual({ entityType: 'match_result', entityId: '555' });
    expect(rows[0].payload.windowHours).toBe(48);
    expect(rows[1].payload.by.userId).toBe(superB.userId);
    expect(rows[2].payload.by.userId).toBe(superA.userId);
    expect(rows[2].payload.outcome).toEqual({ corrected: true });

    // And the derived state is exactly that replay — it reads no other table.
    const state = await approvalState(db, ctxOf(superA), id, new Date('2026-08-20T00:00:00Z'));
    expect(state.status).toBe('executed');
    expect(state.history.map((h) => h.eventType)).toEqual(rows.map((r: any) => r.eventType));
    expect(state.requester.userId).toBe(superA.userId);
    expect(state.approvals[0].by.userId).toBe(superB.userId);
    expect(state.execution!.outcome).toEqual({ corrected: true });
  });

  it('never classifies an approval request as public or member data', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);
    const rows = await db.select().from(s.domainEvents)
      .where(and(
        eq(s.domainEvents.entityType, 'approval_request'),
        eq(s.domainEvents.entityId, id)
      ));
    for (const r of rows) expect(['official', 'confidential', 'restricted', 'highly_restricted']).toContain(r.classification);
  });

  it('writes an audit event for every step, with the reason attached', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);
    await executeIfApproved(db, ctxOf(superA), id, async () => 'done', NOW);

    const audits = await db.select().from(s.auditEvents)
      .where(and(
        eq(s.auditEvents.entityType, 'approval_request'),
        eq(s.auditEvents.entityId, id)
      ))
      .orderBy(asc(s.auditEvents.id));

    expect(audits.map((a: any) => a.action)).toEqual(['create', 'approve', 'finalize']);
    expect(audits[0].reason).toMatch(/falsified attendance record/);
    expect(audits[0].actorUserId).toBe(superA.userId);
    expect(audits[1].actorUserId).toBe(superB.userId);
    expect(audits[2].newValue.approvedBy).toEqual([superB.userId]);
  });

  it('refuses an unknown request id rather than inventing an empty one', async () => {
    await expect(approvalState(db, ctxOf(superA), 'MMAKF-APR-2026-999999', NOW))
      .rejects.toMatchObject({ code: 'unknown_request' });
  });
});

// ─── Reading a request is itself privileged ─────────────────────────────────

describe('a request cannot be read by someone who could not approve it', () => {
  it('refuses the reader who lacks the act’s authority', async () => {
    const id = await raise(superA);
    // The finance officer is a real administrator and still has no business
    // reading the reasoning behind a certificate revocation.
    await expect(approvalState(db, ctxOf(finance), id, NOW)).rejects.toThrow(ForbiddenError);
    await expect(approvalState(db, ctxOf(athlete), id, NOW)).rejects.toThrow(ForbiddenError);
  });

  it('refuses the reader whose authority is in a different state', async () => {
    const id = await raise(jhAdmin, { scope: { stateUnitId: JH } });
    await expect(approvalState(db, ctxOf(otherAdmin), id, NOW)).rejects.toThrow(ForbiddenError);
    expect((await approvalState(db, ctxOf(jhAdmin2), id, NOW)).requestId).toBe(id);
  });
});

// ─── Classification travels with the request ────────────────────────────────

describe('classification', () => {
  it('is inherited by every later event, so an outcome is never published wider than its request', async () => {
    const id = await raise(superA, { classification: 'restricted' });
    await approve(db, ctxOf(superB), id, NOW);
    await executeIfApproved(db, ctxOf(superA), id, async () => ({ memberName: 'a real person' }), NOW);

    const rows = await db.select().from(s.domainEvents)
      .where(and(eq(s.domainEvents.entityType, 'approval_request'), eq(s.domainEvents.entityId, id)))
      .orderBy(asc(s.domainEvents.id));

    expect(rows).toHaveLength(3);
    // The execution event carries the handler's outcome. It must not sit at a
    // lower classification than the request it came from.
    for (const r of rows) expect(r.classification).toBe('restricted');
  });

  it('records a failure at the request’s classification too — error text leaks as readily as outcomes', async () => {
    const id = await raise(superA, { classification: 'confidential' });
    await approve(db, ctxOf(superB), id, NOW);
    await expect(
      executeIfApproved(db, ctxOf(superA), id, async () => { throw new Error('member 1234 not found'); }, NOW)
    ).rejects.toThrow(/member 1234/);

    const rows = await db.select().from(s.domainEvents)
      .where(and(
        eq(s.domainEvents.entityType, 'approval_request'),
        eq(s.domainEvents.entityId, id),
        eq(s.domainEvents.eventType, 'APPROVAL_EXECUTION_FAILED')
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].classification).toBe('confidential');
  });

  it('cannot be lowered below the floor by the caller', async () => {
    const id = await raise(superA, { classification: 'public' });
    expect((await approvalState(db, ctxOf(superA), id, NOW)).classification).toBe('official');
  });
});

// ─── Who actually authorised this ───────────────────────────────────────────

describe('the recorded role is the one that granted the authority', () => {
  const mixed: Principal = {
    userId: 30, label: 'mixed-bindings',
    bindings: [
      // Listed first and grants nothing here. Recording this role would
      // misdescribe the authority the approval rested on.
      { role: 'ATHLETE', scopeType: 'national', scopeId: null },
      { role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null },
    ],
  };

  it('names the binding that granted the act, not the first one listed', async () => {
    const id = await raise(superA);
    const state = await approve(db, ctxOf(mixed), id, NOW);
    expect(state.approvals[0].by.userId).toBe(30);
    expect(state.approvals[0].by.role).toBe('SUPER_ADMIN');
  });

  it('refuses a second person whose binding has expired', async () => {
    const expired: Principal = {
      userId: 31, label: 'expired-admin',
      bindings: [{
        role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null,
        expiresAt: '2020-01-01T00:00:00Z',
      }],
    };
    const id = await raise(superA);
    await expect(approve(db, ctxOf(expired), id, NOW)).rejects.toThrow(ForbiddenError);
    expect((await approvalState(db, ctxOf(superA), id, NOW)).approvals).toHaveLength(0);
  });
});

// ─── Forging the log ────────────────────────────────────────────────────────

describe('a quorum cannot be forged from one person', () => {
  it('ignores a duplicate approval appended straight into the event log', async () => {
    const id = await raise(superA, {}, { approvalsRequired: 2 });
    await approve(db, ctxOf(superB), id, NOW);

    // Bypass the module entirely and append a second approval from the SAME
    // person — what an operator with database access would try.
    await db.insert(s.domainEvents).values({
      eventType: 'APPROVAL_GRANTED', entityType: 'approval_request', entityId: id,
      classification: 'official', actorUserId: 2, actorLabel: 'super-admin-b',
      correlationId: id, occurredAt: NOW,
      payload: {
        requestId: id, action: 'certificate_revocation',
        by: { userId: 2, label: 'super-admin-b', role: 'SUPER_ADMIN' },
      },
    });

    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.approvals).toHaveLength(1);      // still one PERSON
    expect(state.status).toBe('pending');
    // Nothing was deleted to achieve that — the forged row is still on the log.
    expect(state.history.filter((h) => h.eventType === 'APPROVAL_GRANTED')).toHaveLength(2);

    let runs = 0;
    await expect(executeIfApproved(db, ctxOf(superA), id, async () => { runs++; }, NOW))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect(runs).toBe(0);
  });
});

// ─── Execution against every non-approved state ─────────────────────────────

describe('only an approved request executes', () => {
  it('refuses a rejected one', async () => {
    const id = await raise(superA);
    await reject(db, ctxOf(superB), id, 'Not supported by the record.', NOW);
    let runs = 0;
    await expect(executeIfApproved(db, ctxOf(superA), id, async () => { runs++; }, NOW))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect(runs).toBe(0);
  });

  it('refuses a lapsed one', async () => {
    const id = await raise(superA, {}, { windowHours: 1 });
    const past = new Date('2026-08-13T09:00:00Z');
    let runs = 0;
    await expect(executeIfApproved(db, ctxOf(superA), id, async () => { runs++; }, past))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect(runs).toBe(0);
  });

  it('rolls back what the handler wrote through the transaction when it throws', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);

    await expect(executeIfApproved(db, ctxOf(superA), id, async (_state, tx) => {
      await tx.insert(s.domainEvents).values({
        eventType: 'SIDE_EFFECT_PROBE', entityType: 'probe', entityId: id,
        classification: 'official', payload: {}, occurredAt: NOW,
      });
      throw new Error('gateway refused');
    }, NOW)).rejects.toThrow('gateway refused');

    // The act left no trace: it did not half-happen.
    const probe = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'SIDE_EFFECT_PROBE'));
    expect(probe).toHaveLength(0);

    // But the record that it was attempted and failed survived the rollback.
    const after = await approvalState(db, ctxOf(superA), id, NOW);
    expect(after.status).toBe('approved');
    expect(after.failures).toHaveLength(1);
    expect(after.failures[0].error).toMatch(/gateway refused/);
  });

  it('does not record a refusal as an execution failure', async () => {
    const id = await raise(superA);
    await expect(executeIfApproved(db, ctxOf(superB), id, async () => 'x', NOW))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect((await approvalState(db, ctxOf(superA), id, NOW)).failures).toHaveLength(0);
  });
});

// ─── Concurrency: the read-then-append races ────────────────────────────────

// WHAT THESE TWO TESTS DO AND DO NOT ESTABLISH — read before trusting them.
//
// PGlite is a single connection and drizzle serialises transactions on it, so
// these overlapping calls never actually run at the same moment. They therefore
// PROVE that a second overlapping call adds neither an execution nor a second
// approval from the same person, and they would catch a regression that let one
// through — but they CANNOT demonstrate exclusion between two processes. That
// rests entirely on the `for update` row lock in `lockRequest`, and it is not
// covered by any test here. Verified by deleting the lock: both tests still
// pass. Proving it needs two real connections against a server Postgres.
describe('an overlapping second call cannot defeat the mechanism', () => {
  it('runs the act once when two executions overlap', async () => {
    const id = await raise(superA);
    await approve(db, ctxOf(superB), id, NOW);

    let runs = 0;
    const handler = async () => { runs++; return { n: runs }; };
    const settled = await Promise.allSettled([
      executeIfApproved(db, ctxOf(superA), id, handler, NOW),
      executeIfApproved(db, ctxOf(superB), id, handler, NOW),
    ]);

    expect(runs).toBe(1);
    const ok = settled.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok.filter((r) => r.value.ran)).toHaveLength(1);
    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.history.filter((h) => h.eventType === 'APPROVAL_EXECUTED')).toHaveLength(1);
  });

  it('counts one person once when two of their approvals overlap', async () => {
    const id = await raise(superA, {}, { approvalsRequired: 2 });
    await Promise.allSettled([
      approve(db, ctxOf(superB), id, NOW),
      approve(db, ctxOf(superB), id, NOW),
    ]);

    const state = await approvalState(db, ctxOf(superA), id, NOW);
    expect(state.approvals).toHaveLength(1);
    expect(state.status).toBe('pending');   // one person is not two
  });
});

// ─── The queue filters in SQL, and admits when it is incomplete ─────────────

describe('the queue', () => {
  let dan: Principal, erin: Principal;
  let A: number, B: number;

  beforeAll(async () => {
    const [a] = await db.insert(s.stateUnits)
      .values({ code: 'ST-WB', state: 'West Bengal', name: 'WB', status: 'active' })
      .returning({ id: s.stateUnits.id });
    const [b] = await db.insert(s.stateUnits)
      .values({ code: 'ST-AS', state: 'Assam', name: 'AS', status: 'active' })
      .returning({ id: s.stateUnits.id });
    A = a.id; B = b.id;

    dan = { userId: 40, label: 'dan', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: A }] };
    erin = { userId: 41, label: 'erin', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: A }] };
    const outsider: Principal = {
      userId: 42, label: 'outsider', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'state', scopeId: B }],
    };

    await raise(dan, { scope: { stateUnitId: A } });
    await raise(dan, { scope: { stateUnitId: A } });
    await raise(dan, { scope: { stateUnitId: A } });
    // Three more in a state erin has no authority over at all.
    await raise(outsider, { scope: { stateUnitId: B } });
    await raise(outsider, { scope: { stateUnitId: B } });
    await raise(outsider, { scope: { stateUnitId: B } });
  });

  it('never loads out-of-scope requests — the scope filter runs in the query', async () => {
    const q = await pendingApprovals(db, erin, { on: NOW });
    // `scanned` counts the rows the SQL returned. If the scope filter ran after
    // loading, the other state's three requests would be in this number and
    // their payloads would have been read into memory. They are not.
    expect(q.scanned).toBe(3);
    expect(q.items).toHaveLength(3);
    for (const r of q.items) expect(r.scope).toEqual({ stateUnitId: A });
  });

  it('excludes the viewer’s own requests in SQL, not after the fact', async () => {
    const q = await pendingApprovals(db, dan, { on: NOW });
    expect(q.scanned).toBe(0);
    expect(q.items).toEqual([]);
  });

  it('says so when it could not examine everything, rather than looking complete', async () => {
    const full = await pendingApprovals(db, erin, { on: NOW });
    expect(full.complete).toBe(true);
    expect(full.note).toMatch(/Every request this account could act on was examined/i);

    const capped = await pendingApprovals(db, erin, { on: NOW, scanLimit: 1 });
    expect(capped.complete).toBe(false);
    expect(capped.items).toHaveLength(1);
    expect(capped.note).toMatch(/only the most recent 1 were examined/i);
  });

  it('grants nothing to an account holding none of the seven authorities', async () => {
    const q = await pendingApprovals(db, athlete, { on: NOW });
    expect(q.items).toEqual([]);
    expect(q.scanned).toBe(0);
    expect(q.note).toMatch(/holds none of the authorities/i);
  });
});
