// The write path on four surfaces that could only read.
//
// docs/IMPLEMENTATION-QUEUE.md item 3 named four screens that showed the
// federation its own state and could not change it. Verified against the source
// rather than the document, they were not the four the document said:
//
//   /admin/leads      — no POST handler at all, and src/db/engagement.ts had no
//                       function that could move a lead. Genuinely absent.
//   /admin/workflows  — a POST that could install the standard automations and
//                       nothing else. It could not retry a failed run and could
//                       not switch a definition off, though sweepRetries() and
//                       the `active` column both already existed.
//   /admin/audit      — the `audit-events` export kind was already registered
//                       and served; NOTHING LINKED TO IT. Not a missing
//                       capability, a missing door.
//   /admin/fees       — edit and delete were already implemented, INLINE, and
//                       the edit path skipped a guard the create path enforces.
//                       That one is a defect and not a gap, and it is the most
//                       consequential thing in this file.
//
// The last of those is the reason this suite exists in the form it does. A
// queue item that reads "add updateRule" turned out to mean "the rule the
// federation cares most about could be walked around in two steps".

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import {
  captureLead, leadDetail,
  setLeadStatus, assignLeadOwner, addLeadActivity,
  LEAD_TRANSITIONS, TERMINAL_LEAD_STATUSES, LEAD_ACTIVITY_KINDS,
  isEngagementError,
} from '../src/db/engagement';
import { requeueRun, setDefinitionActive, isWorkflowError } from '../src/lib/workflow';
import {
  createFramework, addRule, updateRule, deleteRule, publishFramework, isFeeError,
} from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';

let db: any;
let JH: number, BR: number;

const national: Principal = {
  userId: 1, label: 'admin', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const jhAdmin = (): Principal => ({
  userId: 2, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: 3, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});
const athlete: Principal = {
  userId: 4, label: 'athlete', bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/** Authors fee frameworks. Deliberately not the one that issues quotations. */
const finance: Principal = {
  userId: 5, label: 'finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};

const ctx = { principal: national };
const feeCtx = { principal: finance };

/** A lead in Jharkhand, fresh for each test that moves one. */
async function makeLead(fields: Record<string, unknown> = {}) {
  const [row] = await db.insert(s.leads).values({
    ref: `MMAKF-LEAD-T-${Math.floor(Math.random() * 1e9)}`,
    audience: 'school',
    status: 'new',
    contactName: 'A principal',
    stateUnitId: JH,
    ...fields,
  }).returning();
  return row;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'jh@mmakf.in', status: 'active' },
    { id: 3, email: 'br@mmakf.in', status: 'active' },
    { id: 4, email: 'athlete@mmakf.in', status: 'active' },
    { id: 5, email: 'finance@mmakf.in', status: 'active' },
    { id: 6, email: 'retired@mmakf.in', status: 'disabled' },
  ]);
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a lead can be moved along the pipeline', () => {
  it('moves, and records the reason in the trail and on the row', async () => {
    const lead = await makeLead();
    const out = await setLeadStatus(db, ctx, {
      leadId: lead.id, status: 'qualifying', reason: 'Principal confirmed a budget line',
    });
    expect(out).toMatchObject({ from: 'new', to: 'qualifying' });

    const detail = await leadDetail(db, national, lead.id);
    expect(detail.lead.status).toBe('qualifying');
    const change = detail.activities.find((a: any) => a.kind === 'status_change');
    expect(change.summary).toBe('new → qualifying');
    expect((change.detail as any).reason).toBe('Principal confirmed a budget line');
  });

  it('demands a reason for EVERY move, including a happy one', async () => {
    const lead = await makeLead();
    await expect(setLeadStatus(db, ctx, { leadId: lead.id, status: 'qualifying', reason: '   ' }))
      .rejects.toThrow(/requires a recorded reason/);
    // And nothing moved.
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, lead.id));
    expect(after.status).toBe('new');
  });

  it('refuses a transition the pipeline does not have', async () => {
    const lead = await makeLead();
    // new → won would let somebody book a sale that skipped every stage that
    // produces the evidence for it.
    await expect(setLeadStatus(db, ctx, { leadId: lead.id, status: 'won', reason: 'because' }))
      .rejects.toThrow(/can move to/);
  });

  it('refuses to reopen a terminal lead, and says why', async () => {
    const lead = await makeLead({ status: 'won' });
    await expect(setLeadStatus(db, ctx, { leadId: lead.id, status: 'qualifying', reason: 'they came back' }))
      .rejects.toThrow(/final/);
    for (const terminal of TERMINAL_LEAD_STATUSES) {
      expect(LEAD_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('writes the reason to lost_reason ONLY when the column means it', async () => {
    const lost = await makeLead({ status: 'quoted' });
    await setLeadStatus(db, ctx, { leadId: lost.id, status: 'lost', reason: 'Chose another provider' });
    const [lostRow] = await db.select().from(s.leads).where(eq(s.leads.id, lost.id));
    expect(lostRow.lostReason).toBe('Chose another provider');

    // A qualification reason must NOT land in a field every report reads as
    // "why we did not win".
    const won = await makeLead();
    await setLeadStatus(db, ctx, { leadId: won.id, status: 'qualifying', reason: 'Budget confirmed' });
    const [wonRow] = await db.select().from(s.leads).where(eq(s.leads.id, won.id));
    expect(wonRow.lostReason).toBeNull();
  });

  it('refuses a move to the status it is already at', async () => {
    const lead = await makeLead();
    await expect(setLeadStatus(db, ctx, { leadId: lead.id, status: 'new', reason: 'no-op' }))
      .rejects.toThrow(/already new/);
  });

  it('scopes on the lead itself, so an id in a form body buys nothing', async () => {
    const jhLead = await makeLead({ stateUnitId: JH });
    // Bihar's administrator holds engagement:write — in Bihar.
    await expect(setLeadStatus(db, { principal: brAdmin() }, {
      leadId: jhLead.id, status: 'qualifying', reason: 'not mine to move',
    })).rejects.toThrow();
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, jhLead.id));
    expect(after.status).toBe('new');

    // The state that owns it can.
    await setLeadStatus(db, { principal: jhAdmin() }, {
      leadId: jhLead.id, status: 'qualifying', reason: 'mine',
    });
    const [moved] = await db.select().from(s.leads).where(eq(s.leads.id, jhLead.id));
    expect(moved.status).toBe('qualifying');
  });

  it('refuses a principal with no engagement authority at all', async () => {
    const lead = await makeLead();
    await expect(setLeadStatus(db, { principal: athlete }, {
      leadId: lead.id, status: 'qualifying', reason: 'nope',
    })).rejects.toThrow();
  });
});

describe('a lead can be given an owner', () => {
  it('assigns, records it in the trail, and can unassign again', async () => {
    const lead = await makeLead();
    await assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: 2 });
    let [row] = await db.select().from(s.leads).where(eq(s.leads.id, lead.id));
    expect(row.ownerUserId).toBe(2);

    // Nobody is a legitimate destination: a lead whose owner has left must be
    // returnable to the pool rather than stuck with them.
    await assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: null });
    [row] = await db.select().from(s.leads).where(eq(s.leads.id, lead.id));
    expect(row.ownerUserId).toBeNull();

    const detail = await leadDetail(db, national, lead.id);
    expect(detail.activities.some((a: any) => a.summary === 'Owner removed')).toBe(true);
  });

  it('refuses an account that does not exist, as a sentence and not a driver error', async () => {
    const lead = await makeLead();
    await expect(assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: 999999 }))
      .rejects.toThrow(/No such user/);
  });

  it('refuses a disabled account, because nobody is looking at it', async () => {
    const lead = await makeLead();
    await expect(assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: 6 }))
      .rejects.toThrow(/disabled/);
  });

  it('refuses a re-assignment that changes nothing', async () => {
    const lead = await makeLead();
    await assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: 2 });
    await expect(assignLeadOwner(db, ctx, { leadId: lead.id, ownerUserId: 2 }))
      .rejects.toThrow(/already assigned/);
  });

  it('does NOT require the owner to have authority over the lead', async () => {
    // Deliberate: assignment is how work is handed to a newly appointed
    // officer. What they may actually open is decided by leadDetail() when they
    // open it.
    const jhLead = await makeLead({ stateUnitId: JH });
    await assignLeadOwner(db, ctx, { leadId: jhLead.id, ownerUserId: 3 }); // Bihar's admin
    const [row] = await db.select().from(s.leads).where(eq(s.leads.id, jhLead.id));
    expect(row.ownerUserId).toBe(3);
    // And they still cannot read it.
    await expect(leadDetail(db, brAdmin(), jhLead.id)).rejects.toThrow();
  });
});

describe('a contact can be recorded against a lead', () => {
  it('records a note and moves the lead to the top of the board', async () => {
    const lead = await makeLead();
    const before = (await db.select().from(s.leads).where(eq(s.leads.id, lead.id)))[0].updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await addLeadActivity(db, ctx, { leadId: lead.id, kind: 'call', summary: 'Spoke to the principal' });

    const detail = await leadDetail(db, national, lead.id);
    expect(detail.activities[0].summary).toBe('Spoke to the principal');
    expect(detail.activities[0].kind).toBe('call');
    expect(new Date(detail.lead.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('refuses a hand-written status_change, so the trail cannot claim a move that never happened', async () => {
    const lead = await makeLead();
    expect(LEAD_ACTIVITY_KINDS).not.toContain('status_change');
    await expect(addLeadActivity(db, ctx, {
      leadId: lead.id, kind: 'status_change', summary: 'new → won',
    })).rejects.toThrow(/written by the act that changes it/);
  });

  it('refuses an empty note', async () => {
    const lead = await makeLead();
    await expect(addLeadActivity(db, ctx, { leadId: lead.id, kind: 'note', summary: '  ' }))
      .rejects.toThrow(/needs something in it/);
  });

  it('writes NO audit row — a note is correspondence, not a change of record', async () => {
    const lead = await makeLead();
    const before = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityType, 'lead'));
    await addLeadActivity(db, ctx, { leadId: lead.id, kind: 'email', summary: 'Sent the brochure' });
    const after = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityType, 'lead'));
    expect(after.length).toBe(before.length);
  });

  it('scopes like every other act on a lead', async () => {
    const jhLead = await makeLead({ stateUnitId: JH });
    await expect(addLeadActivity(db, { principal: brAdmin() }, {
      leadId: jhLead.id, kind: 'note', summary: 'not mine',
    })).rejects.toThrow();
  });
});

describe('every lead act writes an audit row that names the change', () => {
  it('records the before and the after for a move', async () => {
    const lead = await makeLead();
    await setLeadStatus(db, { ...ctx, reason: 'Budget confirmed' } as any, {
      leadId: lead.id, status: 'qualifying', reason: 'Budget confirmed',
    });
    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityId, String(lead.id)));
    const move = rows.find((r: any) => r.entityType === 'lead' && r.action === 'update');
    expect(move).toBeTruthy();
    expect(move.oldValue).toMatchObject({ status: 'new' });
    expect(move.newValue).toMatchObject({ status: 'qualifying' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a failed workflow run can be put back in front of the sweep', () => {
  /** A definition and one run against it, in whatever state the test needs. */
  async function makeRun(status: string, attempt = 3, maxAttempts = 3) {
    const [def] = await db.insert(o.workflowDefinitions).values({
      code: `TEST_WF_${Math.floor(Math.random() * 1e9)}`,
      title: 'Test automation',
      trigger: 'TEST_TRIGGER',
      version: 1,
      active: true,
      definition: { steps: [], maxAttempts },
    }).returning();
    const [run] = await db.insert(o.workflowRuns).values({
      workflowCode: def.code,
      workflowVersion: 1,
      trigger: 'TEST_TRIGGER',
      idempotencyKey: `test:${Math.floor(Math.random() * 1e9)}`,
      status: status as any,
      attempt,
      maxAttempts,
    }).returning();
    return { def, run };
  }

  it('grants an exhausted run one more attempt and makes it due now', async () => {
    const { run } = await makeRun('failed', 3, 3);
    const out = await requeueRun(db, ctx, run.id);
    expect(out.maxAttempts).toBe(4);

    const [after] = await db.select().from(o.workflowRuns).where(eq(o.workflowRuns.id, run.id));
    expect(after.maxAttempts).toBe(4);
    expect(after.nextAttemptAt).not.toBeNull();
    // The count of how hard the system already tried is KEPT, not reset.
    expect(after.attempt).toBe(3);
  });

  it('refuses a run that succeeded', async () => {
    const { run } = await makeRun('succeeded', 1, 3);
    await expect(requeueRun(db, ctx, run.id)).rejects.toThrow(/nothing to retry/);
  });

  it('refuses a run that is still going', async () => {
    const { run } = await makeRun('running', 1, 3);
    await expect(requeueRun(db, ctx, run.id)).rejects.toThrow(/still in progress/);
  });

  it('refuses when the definition it ran under is gone', async () => {
    const { def, run } = await makeRun('failed', 3, 3);
    await db.delete(o.workflowDefinitions).where(eq(o.workflowDefinitions.id, def.id));
    await expect(requeueRun(db, ctx, run.id)).rejects.toThrow(/no longer exists/);
  });

  it('allows a retry when the automation is switched off, and says so', async () => {
    // Switching one off is exactly what an operator does BEFORE clearing up
    // after it, so refusing here would block the normal recovery.
    const { def, run } = await makeRun('partially_failed', 3, 3);
    await db.update(o.workflowDefinitions).set({ active: false })
      .where(eq(o.workflowDefinitions.id, def.id));
    const out = await requeueRun(db, ctx, run.id);
    expect(out.definitionInactive).toBe(true);
  });

  it('writes an audit row', async () => {
    const { run } = await makeRun('failed', 3, 3);
    await requeueRun(db, ctx, run.id);
    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'workflow_run'));
    expect(rows.some((r: any) => r.entityId === String(run.id))).toBe(true);
  });
});

describe('an automation can be switched off', () => {
  async function makeDef(version: number, active: boolean, code: string) {
    const [def] = await db.insert(o.workflowDefinitions).values({
      code, title: `Automation v${version}`, trigger: 'SW_TRIGGER',
      version, active, definition: { steps: [] },
    }).returning();
    return def;
  }

  it('flips active and records it as a governance act, not a generic update', async () => {
    const def = await makeDef(1, true, `SW_${Math.floor(Math.random() * 1e9)}`);
    await setDefinitionActive(db, ctx, { definitionId: def.id, active: false, reason: 'Sending duplicates' });
    const [after] = await db.select().from(o.workflowDefinitions).where(eq(o.workflowDefinitions.id, def.id));
    expect(after.active).toBe(false);

    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'workflow_definition'));
    const row = rows.find((r: any) => r.entityId === String(def.id));
    // 'suspend', not 'update' — the enum distinguishes a governance decision
    // from a clerk editing a row, and that is the whole reason it does.
    expect(row.action).toBe('suspend');
  });

  it('demands a reason', async () => {
    const def = await makeDef(1, true, `SW_${Math.floor(Math.random() * 1e9)}`);
    await expect(setDefinitionActive(db, ctx, { definitionId: def.id, active: false, reason: '' }))
      .rejects.toThrow(/requires a recorded reason/);
  });

  it('refuses a flip that changes nothing', async () => {
    const def = await makeDef(1, true, `SW_${Math.floor(Math.random() * 1e9)}`);
    await expect(setDefinitionActive(db, ctx, { definitionId: def.id, active: true, reason: 'again' }))
      .rejects.toThrow(/already active/);
  });

  it('refuses to reactivate a version a higher active one supersedes', async () => {
    // dispatch() runs only the HIGHEST active version, so switching v1 on while
    // v2 is active changes nothing while showing two active versions — the
    // operator would believe they had restored the old behaviour and be wrong.
    const code = `SW_${Math.floor(Math.random() * 1e9)}`;
    const v1 = await makeDef(1, false, code);
    await makeDef(2, true, code);
    await expect(setDefinitionActive(db, ctx, { definitionId: v1.id, active: true, reason: 'roll back' }))
      .rejects.toThrow(/only the highest active version/);
  });

  it('allows reactivating when nothing higher is active', async () => {
    const code = `SW_${Math.floor(Math.random() * 1e9)}`;
    const v1 = await makeDef(1, false, code);
    await makeDef(2, false, code);
    await setDefinitionActive(db, ctx, { definitionId: v1.id, active: true, reason: 'nothing else runs' });
    const [after] = await db.select().from(o.workflowDefinitions).where(eq(o.workflowDefinitions.id, v1.id));
    expect(after.active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a draft fee rule can be corrected — and cannot be corrected into a student charge', () => {
  /** A fresh draft framework with one legitimate rule on it. */
  async function draftWithRule() {
    const fw = await createFramework(db, feeCtx, {
      title: 'Editable framework', version: Math.floor(Math.random() * 1e6),
    });
    const rule = await addRule(db, feeCtx, fw.id, {
      code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 5_000_000, sortOrder: 10,
    });
    return { fw, rule };
  }

  it('corrects a mistyped amount without retyping the framework', async () => {
    const { rule } = await draftWithRule();
    const updated = await updateRule(db, feeCtx, rule.id, { amountMinor: 4_500_000 });
    expect(updated.amountMinor).toBe(4_500_000);
    // Untouched fields survive the patch.
    expect(updated.label).toBe('School programme base');
    expect(updated.audience).toBe('school');
  });

  // ── THE ONE THAT MATTERS ─────────────────────────────────────────────────
  //
  // addRule() refuses a rule that charges a student for being a student, and
  // the clone path was routed through addRule() so a clone could not smuggle
  // one across. The EDIT path wrote the row directly and classified nothing, so
  // the refusal could be walked around in two steps.
  //
  // NOTE ON THE KIND USED BELOW. 'membership' is NOT a value of the
  // `fee_rule_kind` enum — the kinds are base, per_participant, per_session,
  // per_batch, per_campus, per_instructor, per_km, multiplier, fixed_add,
  // discount, tax. An earlier draft of these two tests used it and they
  // "passed" against a driver enum error rather than against the refusal they
  // were written to prove: a false green of exactly the kind this project has
  // shipped before. What makes a rule a student charge is the WORDING —
  // 'membership' is a strong standing term and 'student' names somebody who
  // receives training — so the kind stays a legitimate one throughout.
  it('refuses an edit that turns a legitimate rule into a student charge', async () => {
    const { rule } = await draftWithRule();
    const err = await updateRule(db, feeCtx, rule.id, {
      label: 'Student membership (annual)',
      kind: 'fixed_add',
      audience: 'individual',
    }).catch((e) => e);

    // The specific refusal, not merely "it threw".
    expect(isFeeError(err)).toBe(true);
    expect(err.code).toBe('student_charge_refused');

    // And the stored row is untouched — a refused edit changes nothing.
    const [after] = await db.select().from(s.feeRules).where(eq(s.feeRules.id, rule.id));
    expect(after.label).toBe('School programme base');
    expect(after.audience).toBe('school');
  });

  it('refuses through the edit exactly what addRule refuses on creation', async () => {
    // Parity is the property that matters: the two doors into the table must
    // apply one rule. If addRule ever stopped refusing this, this assertion
    // fails too and the pair is re-examined together.
    const fw = await createFramework(db, feeCtx, {
      title: 'Parity', version: Math.floor(Math.random() * 1e6),
    });
    const onCreate = await addRule(db, feeCtx, fw.id, {
      code: 'STU-MEM', label: 'Student membership (annual)', kind: 'fixed_add',
      audience: 'individual', amountMinor: 50000,
    }).catch((e) => e);
    expect(isFeeError(onCreate)).toBe(true);
    expect(onCreate.code).toBe('student_charge_refused');
  });

  it('classifies the MERGED rule, so the combination cannot arrive in instalments', async () => {
    // THE SPLIT IS CHOSEN SO THAT THE PATCH ALONE IS CLEAN.
    //
    // This is the assertion the whole fix rests on, and it is easy to write a
    // version of it that proves nothing: if the patch itself carries the
    // offending wording, a classifier looking only at the patch would refuse it
    // too, and the test passes whether or not the merge happens.
    //
    // So the standing term lives in the rule's CODE — which updateRule refuses
    // to change — and the patch supplies only the student term and the
    // audience. Checked against classifyFeeRule() directly while writing this:
    //
    //   stored (code MEMBERSHIP-BASE, 'School programme base', school) → permitted
    //   the patch alone ('Junior cohort', individual)                  → permitted
    //   the two merged                                                 → REFUSED
    //
    // Only a classifier that sees the stored row and the patch together
    // refuses this, which is exactly what the inline edit path on /admin/fees
    // did not do.
    const fw = await createFramework(db, feeCtx, {
      title: 'Instalments', version: Math.floor(Math.random() * 1e6),
    });
    const rule = await addRule(db, feeCtx, fw.id, {
      code: 'MEMBERSHIP-BASE', label: 'School programme base', kind: 'fixed_add',
      audience: 'school', amountMinor: 500000, sortOrder: 10,
    });

    const err = await updateRule(db, feeCtx, rule.id, {
      label: 'Junior cohort',
      audience: 'individual',
    }).catch((e) => e);

    expect(isFeeError(err)).toBe(true);
    expect(err.code).toBe('student_charge_refused');

    // Nothing was written.
    const [after] = await db.select().from(s.feeRules).where(eq(s.feeRules.id, rule.id));
    expect(after.label).toBe('School programme base');
    expect(after.audience).toBe('school');
  });

  it('refuses to change the code, because a quote line records it beside the id', async () => {
    const { rule } = await draftWithRule();
    await expect(updateRule(db, feeCtx, rule.id, { code: 'RENAMED' } as any))
      .rejects.toThrow(/code cannot be changed/);
  });

  it('keeps the immutability rule: a published framework refuses both acts', async () => {
    const { fw, rule } = await draftWithRule();
    await publishFramework(db, feeCtx, fw.id);
    await expect(updateRule(db, feeCtx, rule.id, { amountMinor: 1 }))
      .rejects.toThrow(/cannot be changed/);
    await expect(deleteRule(db, feeCtx, rule.id))
      .rejects.toThrow(/cannot be changed/);
  });

  it('rejects a non-integer amount in the same words addRule does', async () => {
    const { rule } = await draftWithRule();
    await expect(updateRule(db, feeCtx, rule.id, { amountMinor: 450.5 }))
      .rejects.toThrow(/integer paise/);
  });

  it('deletes a draft rule and records the whole row, because there is nowhere else to read it', async () => {
    const { rule } = await draftWithRule();
    const out = await deleteRule(db, feeCtx, rule.id);
    expect(out.code).toBe('BASE-SCHOOL');

    const remaining = await db.select().from(s.feeRules).where(eq(s.feeRules.id, rule.id));
    expect(remaining.length).toBe(0);

    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'fee_rule'));
    const del = rows.find((r: any) => r.action === 'delete' && r.entityId === String(rule.id));
    expect((del.oldValue as any).code).toBe('BASE-SCHOOL');
    expect((del.oldValue as any).amountMinor).toBe(5_000_000);
  });

  it('refuses both acts to an account without feeframework:write', async () => {
    const { rule } = await draftWithRule();
    await expect(updateRule(db, { principal: athlete }, rule.id, { amountMinor: 1 })).rejects.toThrow();
    await expect(deleteRule(db, { principal: athlete }, rule.id)).rejects.toThrow();
  });

  it('names the rule rather than throwing a driver error when it does not exist', async () => {
    await expect(updateRule(db, feeCtx, 999999, { amountMinor: 1 })).rejects.toThrow(/No such fee rule/);
    await expect(deleteRule(db, feeCtx, 999999)).rejects.toThrow(/No such fee rule/);
  });
});

describe('the module errors are identified by shape, like every other module here', () => {
  it('an engagement refusal is an EngagementError', async () => {
    const lead = await makeLead();
    await setLeadStatus(db, ctx, { leadId: lead.id, status: 'qualifying', reason: 'ok' }).catch(() => {});
    const err = await setLeadStatus(db, ctx, { leadId: lead.id, status: 'qualifying', reason: 'again' })
      .catch((e) => e);
    expect(isEngagementError(err)).toBe(true);
  });

  it('a workflow refusal is a WorkflowError', async () => {
    const err = await requeueRun(db, ctx, 999999).catch((e) => e);
    expect(isWorkflowError(err)).toBe(true);
  });

  it('a fee refusal is a FeeError', async () => {
    const err = await deleteRule(db, feeCtx, 999999).catch((e) => e);
    expect(isFeeError(err)).toBe(true);
  });
});
