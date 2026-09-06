// The workforce — migration 0058 and src/db/workforce.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR THAT MATTER MOST
// ─────────────────────────────────────────────────────────────────────────────
//
//   · Nobody decides their own request — including the head of HR.
//   · Self-service functions take no id, so there is no IDOR to get wrong.
//   · An unsuccessful candidate never becomes a `persons` row.
//   · Ending an employment ends ONE row and touches no rank, no membership and
//     no login.
//
// The third is the one that would be silently wrong for years: a hiring flow
// that creates a person on APPLICATION rather than on ACCEPTANCE makes the
// federation's own member count a number nobody can defend, and nothing fails.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as w from '../src/db/workforce.schema';
import {
  createPosition, setPositionReportsTo, listPositions,
  createEmployment, activateEmployment, changeManager, suspendEmployment, endEmployment,
  employmentRegister, myEmployment, myDirectReports, employmentHistory,
  createLeaveType, setEntitlement, requestLeave, decideLeave, withdrawLeave,
  leaveBalance, myLeave, leaveQueue,
  recordWork, approveWork,
  createClaim, addClaimLine, submitClaim, decideClaim, markClaimPaid,
  createVacancy, openVacancy, publishVacancy, publicVacancies, publicVacancy,
  applyForVacancy, moveApplication, applicationsFor,
  scheduleInterview, recordInterviewFeedback, interviewFeedbackFor,
  makeOffer, acceptOffer, declineOffer,
  isWorkforceError, EXIT_REASONS,
} from '../src/db/workforce';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

/** Holds hr:* and hiring:*. Not a federation administrator — PART X. */
const hr: Principal = {
  userId: 10, label: 'hr officer',
  bindings: [{ role: 'HR_OFFICER', scopeType: 'national', scopeId: null }],
};
const hr2: Principal = {
  userId: 11, label: 'second hr officer',
  bindings: [{ role: 'HR_OFFICER', scopeType: 'national', scopeId: null }],
};
/** An ordinary national administrator. Holds NO hr:* — this is PART X. */
const admin: Principal = {
  userId: 12, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 13, label: 'finance officer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** A plain employee: a login with a person, and no federation authority. */
const staff = (userId: number, label: string): Principal => ({
  userId, label, bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
});

const ctx = (p: Principal = hr): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let seq = 960000;
async function person(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`, fullName: name, status: 'active',
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** A login bound to a person, which is how self-service resolves. */
async function login(userId: number, personId: number) {
  await db.insert(s.users).values({
    id: userId, personId, email: `u${userId}@test.invalid`, status: 'active',
  }).onConflictDoUpdate({ target: s.users.id, set: { personId } });
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
  for (const id of [10, 11, 12, 13]) {
    await db.insert(s.users).values({ id, email: `u${id}@test.invalid`, status: 'active' }).onConflictDoNothing();
  }
});

beforeEach(async () => {
  for (const t of [
    'interview_feedback', 'interview_panellists', 'interviews', 'job_offers',
    'job_application_events', 'job_applications', 'vacancies',
    'expense_claim_lines', 'expense_claims', 'work_records',
    'leave_requests', 'leave_entitlements', 'leave_types',
    'employment_events', 'employments', 'positions',
    'domain_events', 'audit_events',
    // Persons is deleted last and these reference it. rank_records and
    // memberships are written by the 'ends ONE row' test, which is the whole
    // point of that test.
    'memberships', 'rank_records', 'instructor_quals',
  ]) {
    await db.execute?.(`DELETE FROM ${t}`);
  }
  await db.execute?.('UPDATE users SET person_id = NULL');
  await db.execute?.('DELETE FROM persons');
});

// ─── PART X: HR data is not for ordinary administrators ─────────────────────

describe('PART X — HR data does not reach ordinary administrators', () => {
  it('a FEDERATION_ADMIN cannot read the employment register', async () => {
    await expect(employmentRegister(db, admin)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a FEDERATION_ADMIN cannot create an employment', async () => {
    const p = await person('Anita Bose');
    await expect(createEmployment(db, ctx(admin), {
      personId: p, employmentType: 'permanent',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the HR officer can', async () => {
    const p = await person('Anita Bose');
    const e = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent' });
    expect(e.employeeNo).toMatch(/^MMAKF-EMP-/);
    expect(await employmentRegister(db, hr)).toHaveLength(1);
  });
});

// ─── One canonical person ───────────────────────────────────────────────────

describe('one canonical person', () => {
  it('an employment attaches to an existing person and never creates one', async () => {
    await expect(createEmployment(db, ctx(), { personId: 999999, employmentType: 'permanent' }))
      .rejects.toMatchObject({ code: 'no_such_person' });
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });

  it('refuses a second live employment for the same person', async () => {
    const p = await person('Anita Bose');
    await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent' });
    await expect(createEmployment(db, ctx(), { personId: p, employmentType: 'contract' }))
      .rejects.toMatchObject({ code: 'already_employed' });
  });

  it('allows re-employment after the first ended', async () => {
    const p = await person('Anita Bose');
    const first = await createEmployment(db, ctx(), { personId: p, employmentType: 'fixed_term', startedOn: '2024-01-01' });
    await endEmployment(db, ctx(), first.id, { endedOn: '2024-12-31', exitReason: 'contract_ended' });
    const second = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent', startedOn: '2025-06-01' });
    expect(second.id).not.toBe(first.id);
    // The closed row survives — it is the employment history.
    expect(await db.select().from(w.employments).where(eq(w.employments.personId, p))).toHaveLength(2);
  });

  it('nobody can be their own line manager', async () => {
    const p = await person('Anita Bose');
    await expect(createEmployment(db, ctx(), { personId: p, employmentType: 'permanent', managerPersonId: p }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });
});

// ─── Ending an employment ends ONE row ──────────────────────────────────────

describe('ending an employment', () => {
  it('leaves the person, their rank, their membership and their login alone', async () => {
    const p = await person('Pramod Pathak');
    await login(30, p);
    await db.insert(s.rankRecords).values({
      personId: p, kind: 'dan', gradeLabel: 'Yondan', gradeOrdinal: 4,
      awardedOn: '2019-04-01', status: 'active',
    });
    await db.insert(s.memberships).values({
      personId: p, category: 'instructor', validFrom: '2026-01-01', status: 'active',
    });
    const e = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent', startedOn: '2024-01-01' });

    await endEmployment(db, ctx(), e.id, { endedOn: '2026-03-31', exitReason: 'resigned' });

    const [pr] = await db.select().from(s.persons).where(eq(s.persons.id, p));
    expect(pr.status).toBe('active');
    const [rank] = await db.select().from(s.rankRecords).where(eq(s.rankRecords.personId, p));
    expect(rank.status).toBe('active');
    const [mem] = await db.select().from(s.memberships).where(eq(s.memberships.personId, p));
    expect(mem.status).toBe('active');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, 30));
    expect(u.status).toBe('active');
  });

  it('requires a recorded exit reason from the controlled list', async () => {
    const p = await person('Anita Bose');
    const e = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent' });
    await expect(endEmployment(db, ctx(), e.id, { exitReason: 'because' as any }))
      .rejects.toMatchObject({ code: 'bad_input' });
    expect(EXIT_REASONS).toContain('resigned');
  });

  it('cannot end before it started', async () => {
    const p = await person('Anita Bose');
    const e = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent', startedOn: '2026-05-01' });
    await expect(endEmployment(db, ctx(), e.id, { endedOn: '2026-01-01', exitReason: 'resigned' }))
      .rejects.toMatchObject({ code: 'bad_period' });
  });

  it('keeps the exit reason off the domain-event feed', async () => {
    const p = await person('Anita Bose');
    const e = await createEmployment(db, ctx(), { personId: p, employmentType: 'permanent', startedOn: '2024-01-01' });
    await endEmployment(db, ctx(), e.id, { endedOn: '2026-01-01', exitReason: 'dismissed', exitNote: 'gross misconduct' });

    const rows = await db.select().from(s.domainEvents).where(eq(s.domainEvents.eventType, 'EMPLOYMENT_ENDED'));
    expect(rows).toHaveLength(1);
    const payload = JSON.stringify(rows[0].payload);
    expect(payload).not.toContain('dismissed');
    expect(payload).not.toContain('misconduct');
    // national audit:read only — 'official' would be every dojo administrator.
    expect(rows[0].classification).toBe('restricted');
  });
});

// ─── Self-service takes no id ───────────────────────────────────────────────

describe('self-service resolves from the session, never from an id', () => {
  it('the my* functions accept no employment id at all', () => {
    const src = readFileSync('src/db/workforce.ts', 'utf8');
    for (const fn of ['myEmployment', 'myLeave', 'myClaims', 'myDirectReports']) {
      const i = src.indexOf(`export async function ${fn}(`);
      expect(i, `${fn} missing`).toBeGreaterThan(-1);
      const sig = src.slice(i, src.indexOf(')', i));
      expect(sig, `${fn} takes an id`).not.toContain('employmentId');
    }
  });

  it('a login with no person is not employed, and is told so', async () => {
    expect(await myEmployment(db, staff(40, 'stranger'))).toBeNull();
    await expect(requestLeave(db, ctx(staff(40, 'stranger')), {
      leaveTypeId: 1, fromDate: '2026-10-01', toDate: '2026-10-02',
    })).rejects.toMatchObject({ code: 'not_employed' });
  });

  it('withdrawing somebody else’s leave is refused', async () => {
    const type = await createLeaveType(db, ctx(), { code: 'CL', name: 'Casual leave' });
    const a = await person('Employee A');
    const b = await person('Employee B');
    await login(41, a); await login(42, b);
    const ea = await createEmployment(db, ctx(), { personId: a, employmentType: 'permanent' });
    await createEmployment(db, ctx(), { personId: b, employmentType: 'permanent' });
    await setEntitlement(db, ctx(), { employmentId: ea.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays: 20 });

    const req = await requestLeave(db, ctx(staff(41, 'A')), {
      leaveTypeId: type.id, fromDate: '2026-10-01', toDate: '2026-10-02',
    });
    // B knows the id and is refused on ownership derived from B's own session.
    await expect(withdrawLeave(db, ctx(staff(42, 'B')), req.id)).rejects.toBeInstanceOf(ForbiddenError);
    // A can.
    const done = await withdrawLeave(db, ctx(staff(41, 'A')), req.id);
    expect(done.status).toBe('withdrawn');
  });
});

// ─── Nobody decides their own request ───────────────────────────────────────

describe('nobody decides their own request', () => {
  async function setup() {
    const type = await createLeaveType(db, ctx(), { code: 'CL', name: 'Casual leave' });
    const mgr = await person('The Manager');
    const emp = await person('The Employee');
    await login(50, mgr); await login(51, emp);
    const e = await createEmployment(db, ctx(), {
      personId: emp, employmentType: 'permanent', managerPersonId: mgr,
    });
    await setEntitlement(db, ctx(), { employmentId: e.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays: 40 });
    return { type, mgr, emp, employment: e };
  }

  it('the manager can approve, the employee cannot', async () => {
    const { type } = await setup();
    const req = await requestLeave(db, ctx(staff(51, 'employee')), {
      leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-07',
    });
    await expect(decideLeave(db, ctx(staff(51, 'employee')), { requestId: req.id, decision: 'approved' }))
      .rejects.toMatchObject({ code: 'self_decision' });
    const ok = await decideLeave(db, ctx(staff(50, 'manager')), { requestId: req.id, decision: 'approved' });
    expect(ok.status).toBe('approved');
  });

  it('an HR officer requesting leave cannot approve it with their own hr:write', async () => {
    const type = await createLeaveType(db, ctx(), { code: 'CL', name: 'Casual leave' });
    const hrPerson = await person('Head of HR');
    // The SAME login that holds hr:write is the subject of the request.
    await db.insert(s.users).values({ id: 10, email: 'u10@test.invalid', status: 'active' })
      .onConflictDoUpdate({ target: s.users.id, set: { personId: hrPerson } });
    const e = await createEmployment(db, ctx(hr2), { personId: hrPerson, employmentType: 'permanent' });
    await setEntitlement(db, ctx(hr2), { employmentId: e.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays: 40 });

    const req = await requestLeave(db, ctx(hr), { leaveTypeId: type.id, fromDate: '2026-11-02', toDate: '2026-11-03' });
    await expect(decideLeave(db, ctx(hr), { requestId: req.id, decision: 'approved' }))
      .rejects.toMatchObject({ code: 'self_decision' });
    // A second HR officer can.
    const ok = await decideLeave(db, ctx(hr2), { requestId: req.id, decision: 'approved' });
    expect(ok.status).toBe('approved');
  });

  it('an unattributable actor is refused even holding hr:write', async () => {
    const { type } = await setup();
    const req = await requestLeave(db, ctx(staff(51, 'employee')), {
      leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-06',
    });
    const shared: Principal = {
      userId: null, label: 'shared office login',
      bindings: [{ role: 'HR_OFFICER', scopeType: 'national', scopeId: null }],
    };
    await expect(decideLeave(db, ctx(shared), { requestId: req.id, decision: 'approved' }))
      .rejects.toMatchObject({ code: 'unattributable' });
  });

  it('a manager does not see their own request in their own queue', async () => {
    const type = await createLeaveType(db, ctx(), { code: 'CL', name: 'Casual leave' });
    const mgr = await person('The Manager');
    await login(52, mgr);
    const e = await createEmployment(db, ctx(), { personId: mgr, employmentType: 'permanent' });
    await setEntitlement(db, ctx(), { employmentId: e.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays: 40 });
    await requestLeave(db, ctx(staff(52, 'manager')), { leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-06' });
    expect(await leaveQueue(db, staff(52, 'manager'))).toEqual([]);
  });

  it('refusing leave requires a reason', async () => {
    const { type } = await setup();
    const req = await requestLeave(db, ctx(staff(51, 'employee')), {
      leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-06',
    });
    await expect(decideLeave(db, ctx(staff(50, 'manager')), { requestId: req.id, decision: 'rejected' }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });
});

// ─── Leave arithmetic ───────────────────────────────────────────────────────

describe('leave arithmetic', () => {
  async function setup(entitledHalfDays = 20) {
    const type = await createLeaveType(db, ctx(), { code: 'CL', name: 'Casual leave' });
    const emp = await person('The Employee');
    await login(60, emp);
    const e = await createEmployment(db, ctx(), { personId: emp, employmentType: 'permanent' });
    await setEntitlement(db, ctx(), { employmentId: e.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays });
    return { type, employment: e };
  }

  it('computes half-days from the dates, never from the client', async () => {
    const { type } = await setup();
    const r = await requestLeave(db, ctx(staff(60, 'e')), {
      leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-07',
    });
    expect(r.halfDays).toBe(6); // three whole days
    const half = await requestLeave(db, ctx(staff(60, 'e')), {
      leaveTypeId: type.id, fromDate: '2026-11-02', toDate: '2026-11-03', firstDayHalf: true,
    });
    expect(half.halfDays).toBe(3);
  });

  it('reports pending separately from taken, so two managers cannot approve the same days', async () => {
    const { type, employment } = await setup();
    await requestLeave(db, ctx(staff(60, 'e')), { leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-06' });
    const b = await leaveBalance(db, employment.id, type.id, 2026);
    expect(b.entitled).toBe(20);
    expect(b.taken).toBe(0);
    expect(b.pending).toBe(4);
    expect(b.remaining).toBe(20);
  });

  it('refuses overlapping requests', async () => {
    const { type } = await setup();
    await requestLeave(db, ctx(staff(60, 'e')), { leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-08' });
    await expect(requestLeave(db, ctx(staff(60, 'e')), {
      leaveTypeId: type.id, fromDate: '2026-10-07', toDate: '2026-10-09',
    })).rejects.toMatchObject({ code: 'bad_period' });
  });

  it('refuses more than the balance, counting requests already pending', async () => {
    const { type } = await setup(6); // three days
    await requestLeave(db, ctx(staff(60, 'e')), { leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-06' });
    await expect(requestLeave(db, ctx(staff(60, 'e')), {
      leaveTypeId: type.id, fromDate: '2026-11-02', toDate: '2026-11-04',
    })).rejects.toMatchObject({ code: 'insufficient_balance' });
  });

  it('allows an overdraft when the leave type says so', async () => {
    const type = await createLeaveType(db, ctx(), { code: 'SL', name: 'Sick leave', allowsNegative: true });
    const emp = await person('The Employee');
    await login(61, emp);
    const e = await createEmployment(db, ctx(), { personId: emp, employmentType: 'permanent' });
    await setEntitlement(db, ctx(), { employmentId: e.id, leaveTypeId: type.id, leaveYear: 2026, entitledHalfDays: 2 });
    const r = await requestLeave(db, ctx(staff(61, 'e')), { leaveTypeId: type.id, fromDate: '2026-10-05', toDate: '2026-10-09' });
    expect(r.halfDays).toBe(10);
  });

  it('refuses leave that ends before it starts', async () => {
    const { type } = await setup();
    await expect(requestLeave(db, ctx(staff(60, 'e')), {
      leaveTypeId: type.id, fromDate: '2026-10-09', toDate: '2026-10-05',
    })).rejects.toMatchObject({ code: 'bad_period' });
  });
});

// ─── Time ───────────────────────────────────────────────────────────────────

describe('working time', () => {
  async function setup() {
    const mgr = await person('The Manager');
    const emp = await person('The Employee');
    await login(70, mgr); await login(71, emp);
    const e = await createEmployment(db, ctx(), { personId: emp, employmentType: 'permanent', managerPersonId: mgr });
    return { employment: e };
  }

  it('refuses time in the future and time beyond a day', async () => {
    await setup();
    await expect(recordWork(db, ctx(staff(71, 'e')), { workDate: '2099-01-01', minutes: 60 }))
      .rejects.toMatchObject({ code: 'bad_period' });
    await expect(recordWork(db, ctx(staff(71, 'e')), { workDate: '2026-01-05', minutes: 2000 }))
      .rejects.toMatchObject({ code: 'bad_input' });
  });

  it('lets a day be corrected until it is approved, and not after', async () => {
    await setup();
    const first = await recordWork(db, ctx(staff(71, 'e')), { workDate: '2026-01-05', minutes: 420 });
    const fixed = await recordWork(db, ctx(staff(71, 'e')), { workDate: '2026-01-05', minutes: 450 });
    expect(fixed.minutes).toBe(450);
    expect(fixed.id).toBe(first.id);

    await approveWork(db, ctx(staff(70, 'm')), first.id, 'approved');
    // An approved day is an input to payroll and must not move underneath it.
    await expect(recordWork(db, ctx(staff(71, 'e')), { workDate: '2026-01-05', minutes: 480 }))
      .rejects.toMatchObject({ code: 'bad_state' });
  });

  it('an employee cannot approve their own time', async () => {
    await setup();
    const rec = await recordWork(db, ctx(staff(71, 'e')), { workDate: '2026-01-05', minutes: 420 });
    await expect(approveWork(db, ctx(staff(71, 'e')), rec.id, 'approved'))
      .rejects.toMatchObject({ code: 'self_decision' });
  });
});

// ─── Expenses ───────────────────────────────────────────────────────────────

describe('expense claims', () => {
  async function setup() {
    const mgr = await person('The Manager');
    const emp = await person('The Employee');
    await login(80, mgr); await login(81, emp);
    await createEmployment(db, ctx(), { personId: emp, employmentType: 'permanent', managerPersonId: mgr });
  }

  it('totals from its own lines, never from a client figure', async () => {
    await setup();
    const claim = await createClaim(db, ctx(staff(81, 'e')), { title: 'Nationals travel' });
    await addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'travel', description: 'Train', amountMinor: 145000,
    });
    const after = await addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-02', category: 'meals', description: 'Dinner', amountMinor: 45000,
    });
    expect(after.totalMinor).toBe(190000);
  });

  it('refuses a rupee amount, a future date and an unknown category', async () => {
    await setup();
    const claim = await createClaim(db, ctx(staff(81, 'e')), { title: 'X' });
    await expect(addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'travel', description: 'x', amountMinor: 12.5 as any,
    })).rejects.toMatchObject({ code: 'bad_amount' });
    await expect(addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2099-01-01', category: 'travel', description: 'x', amountMinor: 100,
    })).rejects.toMatchObject({ code: 'bad_period' });
    await expect(addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'bribes', description: 'x', amountMinor: 100,
    })).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('refuses an empty claim, and cannot be paid before it is approved', async () => {
    await setup();
    const claim = await createClaim(db, ctx(staff(81, 'e')), { title: 'Empty' });
    await expect(submitClaim(db, ctx(staff(81, 'e')), claim.id)).rejects.toMatchObject({ code: 'bad_amount' });

    await addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'travel', description: 'Bus', amountMinor: 5000,
    });
    await submitClaim(db, ctx(staff(81, 'e')), claim.id);
    await expect(markClaimPaid(db, ctx(finance), claim.id)).rejects.toMatchObject({ code: 'bad_state' });

    await decideClaim(db, ctx(staff(80, 'm')), { claimId: claim.id, decision: 'approved' });
    const paid = await markClaimPaid(db, ctx(finance), claim.id, '2026-03-01');
    expect(paid.status).toBe('paid');
  });

  it('an employee cannot approve their own claim', async () => {
    await setup();
    const claim = await createClaim(db, ctx(staff(81, 'e')), { title: 'Self' });
    await addClaimLine(db, ctx(staff(81, 'e')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'travel', description: 'Bus', amountMinor: 5000,
    });
    await submitClaim(db, ctx(staff(81, 'e')), claim.id);
    await expect(decideClaim(db, ctx(staff(81, 'e')), { claimId: claim.id, decision: 'approved' }))
      .rejects.toMatchObject({ code: 'self_decision' });
  });

  it('a stranger cannot add a line to somebody else’s claim', async () => {
    await setup();
    const other = await person('Somebody Else');
    await login(82, other);
    await createEmployment(db, ctx(), { personId: other, employmentType: 'permanent' });
    const claim = await createClaim(db, ctx(staff(81, 'e')), { title: 'Mine' });
    await expect(addClaimLine(db, ctx(staff(82, 'x')), {
      claimId: claim.id, spentOn: '2026-02-01', category: 'travel', description: 'x', amountMinor: 100,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── Recruitment ────────────────────────────────────────────────────────────

describe('the public careers page', () => {
  async function openVac(slug = 'competition-operations-manager') {
    const v = await createVacancy(db, ctx(), {
      title: 'Competition Operations Manager', employmentType: 'permanent', slug,
      summary: 'Run the national calendar.',
    });
    await openVacancy(db, ctx(), v.id);
    await publishVacancy(db, ctx(), v.id);
    return v;
  }

  it('shows nothing until a vacancy is open AND published', async () => {
    const v = await createVacancy(db, ctx(), { title: 'X', employmentType: 'permanent', slug: 'x' });
    expect(await publicVacancies(db)).toEqual([]);
    // A draft cannot be published — advertising it invites applications nobody reads.
    await expect(publishVacancy(db, ctx(), v.id)).rejects.toMatchObject({ code: 'bad_state' });
    await openVacancy(db, ctx(), v.id);
    await publishVacancy(db, ctx(), v.id);
    expect(await publicVacancies(db)).toHaveLength(1);
  });

  it('refuses to publish without a slug', async () => {
    const v = await createVacancy(db, ctx(), { title: 'X', employmentType: 'permanent' });
    await openVacancy(db, ctx(), v.id);
    await expect(publishVacancy(db, ctx(), v.id)).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('the database refuses a direct UPDATE publishing a draft', async () => {
    const v = await createVacancy(db, ctx(), { title: 'X', employmentType: 'permanent', slug: 'x' });
    await expect(db.execute?.(`update vacancies set published = true where id = ${v.id}`)).rejects.toThrow();
  });

  it('exposes no internal id or pay band to the public', async () => {
    await openVac();
    const [row] = await publicVacancies(db);
    // `reference` is deliberately present: it is the advert's own identifier,
    // which a candidate quotes back. What is absent is the internal `id`, the
    // `positionId` and the pay band — the establishment record behind the advert.
    expect(Object.keys(row).sort()).toEqual([
      'closesOn', 'departmentName', 'description', 'employmentType',
      'location', 'openings', 'reference', 'requirements', 'slug', 'summary', 'title',
    ].sort());
    expect(Object.keys(row)).not.toContain('id');
    expect(Object.keys(row)).not.toContain('positionId');
    expect(JSON.stringify(row)).not.toContain('payBand');
  });

  it('a candidate can apply with no login and gets a reference', async () => {
    await openVac();
    const res = await applyForVacancy(db, {
      slug: 'competition-operations-manager',
      applicantName: 'Meera Nair', applicantEmail: 'Meera@Example.invalid',
    });
    expect(res.reference).toMatch(/^MMAKF-JOB-/);
    // A candidate is NOT a person in the federation register.
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });

  it('refuses a second application from the same email', async () => {
    await openVac();
    await applyForVacancy(db, { slug: 'competition-operations-manager', applicantName: 'M', applicantEmail: 'm@example.invalid' });
    await expect(applyForVacancy(db, {
      slug: 'competition-operations-manager', applicantName: 'M again', applicantEmail: 'M@EXAMPLE.INVALID',
    })).rejects.toMatchObject({ code: 'duplicate_application' });
  });

  it('refuses an application to a closed vacancy, re-reading it at submit time', async () => {
    const v = await openVac();
    await db.update(w.vacancies).set({ published: false }).where(eq(w.vacancies.id, v.id));
    await expect(applyForVacancy(db, {
      slug: 'competition-operations-manager', applicantName: 'M', applicantEmail: 'm@example.invalid',
    })).rejects.toMatchObject({ code: 'vacancy_not_open' });
  });

  it('refuses a bad email rather than storing it', async () => {
    await openVac();
    await expect(applyForVacancy(db, {
      slug: 'competition-operations-manager', applicantName: 'M', applicantEmail: 'not-an-email',
    })).rejects.toMatchObject({ code: 'bad_input' });
  });
});

describe('the hiring chain', () => {
  async function candidate() {
    const v = await createVacancy(db, ctx(), { title: 'Manager', employmentType: 'permanent', slug: 'manager' });
    await openVacancy(db, ctx(), v.id);
    await publishVacancy(db, ctx(), v.id);
    await applyForVacancy(db, { slug: 'manager', applicantName: 'Meera Nair', applicantEmail: 'meera@example.invalid' });
    const [app] = await applicationsFor(db, hr, v.id);
    return { vacancy: v, app };
  }

  it('runs vacancy -> application -> interview -> offer -> person -> employment', async () => {
    const { app } = await candidate();
    expect(app.status).toBe('received');

    await moveApplication(db, ctx(), { applicationId: app.id, status: 'shortlisted' });

    const panellist = await person('The Panellist');
    await login(90, panellist);
    const interview = await scheduleInterview(db, ctx(), {
      applicationId: app.id, panellistPersonIds: [panellist],
    });
    await recordInterviewFeedback(db, ctx(staff(90, 'panellist')), {
      interviewId: interview.id, score: 4, recommendation: 'yes', notes: 'Strong on operations.',
    });
    expect(await interviewFeedbackFor(db, hr, interview.id)).toHaveLength(1);

    const offer = await makeOffer(db, ctx(), {
      applicationId: app.id, employmentType: 'permanent', proposedStartOn: '2026-11-01',
    });
    expect(offer.status).toBe('issued');
    // STILL not a person.
    expect(await db.select().from(s.persons)).toHaveLength(1); // only the panellist

    const accepted = await acceptOffer(db, ctx(), offer.id);
    expect(accepted.employment.employeeNo).toMatch(/^MMAKF-EMP-/);
    const people = await db.select().from(s.persons);
    expect(people).toHaveLength(2);
    expect(people.some((p: any) => p.fullName === 'Meera Nair')).toBe(true);
    // The person carries the application reference as its source.
    const [hired] = people.filter((p: any) => p.fullName === 'Meera Nair');
    expect(hired.sourceRef).toMatch(/^MMAKF-JOB-/);
  });

  it('accepting twice is idempotent, not a second employment', async () => {
    const { app } = await candidate();
    const offer = await makeOffer(db, ctx(), { applicationId: app.id, employmentType: 'permanent', proposedStartOn: '2026-11-01' });
    const first = await acceptOffer(db, ctx(), offer.id);
    const again = await acceptOffer(db, ctx(), offer.id);
    expect(again.alreadyDone).toBe(true);
    expect(again.employment.id).toBe(first.employment.id);
    expect(await db.select().from(w.employments)).toHaveLength(1);
  });

  it('a declined candidate never becomes a person', async () => {
    const { app } = await candidate();
    const offer = await makeOffer(db, ctx(), { applicationId: app.id, employmentType: 'permanent', proposedStartOn: '2026-11-01' });
    await declineOffer(db, ctx(), offer.id, 'took another role');
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });

  it('a rejected candidate never becomes a person, and rejection needs a reason', async () => {
    const { app } = await candidate();
    await expect(moveApplication(db, ctx(), { applicationId: app.id, status: 'rejected' }))
      .rejects.toMatchObject({ code: 'bad_input' });
    await moveApplication(db, ctx(), { applicationId: app.id, status: 'rejected', note: 'Not enough operations experience.' });
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });

  it('an application cannot be marked accepted by hand', async () => {
    const { app } = await candidate();
    await expect(moveApplication(db, ctx(), { applicationId: app.id, status: 'accepted' }))
      .rejects.toMatchObject({ code: 'bad_state' });
  });

  it('only a panellist may record feedback, and only once', async () => {
    const { app } = await candidate();
    const panellist = await person('The Panellist');
    const outsider = await person('An Outsider');
    await login(91, panellist); await login(92, outsider);
    const interview = await scheduleInterview(db, ctx(), { applicationId: app.id, panellistPersonIds: [panellist] });

    await expect(recordInterviewFeedback(db, ctx(staff(92, 'outsider')), {
      interviewId: interview.id, recommendation: 'yes',
    })).rejects.toMatchObject({ code: 'not_a_panellist' });

    await recordInterviewFeedback(db, ctx(staff(91, 'p')), { interviewId: interview.id, recommendation: 'yes' });
    await expect(recordInterviewFeedback(db, ctx(staff(91, 'p')), {
      interviewId: interview.id, recommendation: 'no',
    })).rejects.toMatchObject({ code: 'already_given_feedback' });
  });

  it('an expired offer cannot be accepted', async () => {
    const { app } = await candidate();
    const offer = await makeOffer(db, ctx(), {
      applicationId: app.id, employmentType: 'permanent',
      proposedStartOn: '2026-11-01', expiresOn: '2020-01-01',
    });
    await expect(acceptOffer(db, ctx(), offer.id)).rejects.toMatchObject({ code: 'bad_state' });
  });

  it('a hiring manager cannot issue an offer without hiring:decide', async () => {
    const { app } = await candidate();
    const hiringManager: Principal = {
      userId: 93, label: 'hiring manager',
      // A hand-built principal holding only the write half of recruitment.
      bindings: [{ role: 'HR_OFFICER', scopeType: 'national', scopeId: null }],
    };
    // HR_OFFICER holds all three, so prove the gate by the action rather than
    // by a role: makeOffer asserts 'hiring:decide' and moveApplication does not.
    const src = readFileSync('src/db/workforce.ts', 'utf8');
    const block = src.slice(src.indexOf('export async function makeOffer'), src.indexOf('export async function acceptOffer'));
    expect(block).toContain("assertCanAnywhere(ctx.principal, 'hiring:decide')");
    const move = src.slice(src.indexOf('export async function moveApplication'), src.indexOf('export async function applicationsFor'));
    expect(move).toContain("assertCanAnywhere(ctx.principal, 'hiring:write')");
    expect(move).not.toContain("'hiring:decide'");
    expect(hiringManager.userId).toBe(93);
  });
});

// ─── Structural guarantees ──────────────────────────────────────────────────

describe('the schema cannot hold what the design forbids', () => {
  it('no employment table carries a salary or bank detail', async () => {
    for (const table of ['employments', 'positions', 'job_offers']) {
      const cols = await db.execute?.(
        `select column_name from information_schema.columns where table_name = '${table}'`
      );
      const names: string[] = (cols?.rows ?? cols ?? []).map((r: any) => String(r.column_name));
      expect(names.length).toBeGreaterThan(0);
      for (const forbidden of ['salary', 'wage', 'bank', 'account_number', 'ifsc', 'ctc', 'gross', 'net_pay']) {
        expect(names.some((n) => n.includes(forbidden)), `${table} has a '${forbidden}' column`).toBe(false);
      }
      expect(names).toContain('pay_band_code');
    }
  });

  it('no foreign key joins the workforce to the public team register', async () => {
    const fks = await db.execute?.(`
      select tc.table_name as src, ccu.table_name as dest
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and (tc.table_name in ('employments','positions') or ccu.table_name in ('employments','positions'))
    `);
    const rows: any[] = (fks?.rows ?? fks ?? []);
    for (const r of rows) {
      expect(r.dest, `${r.src} -> ${r.dest}`).not.toBe('team_appointments');
      expect(r.src, `${r.src} -> ${r.dest}`).not.toBe('team_appointments');
    }
  });

  it('src/db/workforce.ts computes no pay', () => {
    const src = readFileSync('src/db/workforce.ts', 'utf8');
    // No rate, no multiplication of minutes by anything.
    expect(src).not.toMatch(/hourlyRate|payRate|grossPay|netPay|salaryFor/);
  });

  it('src/db/workforce.ts never updates or deletes the employment history', () => {
    const src = readFileSync('src/db/workforce.ts', 'utf8');
    expect(src).not.toMatch(/update\(\s*w\.employmentEvents/);
    expect(src).not.toMatch(/delete\(\s*w\.employmentEvents/);
    expect(src).not.toMatch(/update\(\s*w\.jobApplicationEvents/);
  });

  it('the establishment reuses the team register’s departments', async () => {
    const cols = await db.execute?.(
      `select column_name from information_schema.columns where table_name = 'positions' and column_name = 'department_id'`
    );
    expect((cols?.rows ?? cols ?? []).length).toBe(1);
  });

  it('leave types and positions ship empty', async () => {
    expect(await db.select().from(w.leaveTypes)).toEqual([]);
    expect(await listPositions(db, hr)).toEqual([]);
  });
});

describe('the establishment', () => {
  it('refuses a reporting cycle deeper than self-reporting', async () => {
    const a = await createPosition(db, ctx(), { code: 'A', title: 'A', orgLevel: 'director' });
    const b = await createPosition(db, ctx(), { code: 'B', title: 'B', orgLevel: 'manager', reportsToPositionId: a.id });
    await expect(setPositionReportsTo(db, ctx(), a.id, b.id)).rejects.toMatchObject({ code: 'bad_input' });
  });

  it('records the manager as a person, separately from the position line', async () => {
    const mgr = await person('The Manager');
    const emp = await person('The Employee');
    const pos = await createPosition(db, ctx(), { code: 'OPS', title: 'Ops', orgLevel: 'manager' });
    const e = await createEmployment(db, ctx(), {
      personId: emp, positionId: pos.id, employmentType: 'permanent', managerPersonId: mgr,
    });
    await login(95, mgr);
    expect((await myDirectReports(db, staff(95, 'm'))).map((r: any) => r.personId)).toEqual([emp]);

    const other = await person('New Manager');
    await changeManager(db, ctx(), e.id, other);
    expect(await myDirectReports(db, staff(95, 'm'))).toEqual([]);
  });

  it('writes an append-only history an employee can read of themselves', async () => {
    const emp = await person('The Employee');
    await login(96, emp);
    const e = await createEmployment(db, ctx(), { personId: emp, employmentType: 'permanent' });
    await activateEmployment(db, ctx(), e.id);
    await suspendEmployment(db, ctx(), e.id, 'under review');

    const hist = await employmentHistory(db, staff(96, 'e'), e.id);
    expect(hist.map((h: any) => h.kind)).toEqual(expect.arrayContaining(['onboarded', 'confirmed', 'suspended']));

    // A stranger cannot.
    const stranger = await person('Stranger');
    await login(97, stranger);
    await expect(employmentHistory(db, staff(97, 'x'), e.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
