// The fee register: the prices checkout actually charges, and the door to govern them.
//
// createOrder() prices every fee-coded line (a course, a training month, a
// grading, a membership…) from `fee_schedule`, taking the ACTIVE row whose
// effective window contains today. Before this module nothing in the
// application wrote that table, so nothing fee-coded could ever be paid for.
//
// THE GOVERNANCE THE OFFICE ASKED FOR, MAPPED ONTO THE COLUMNS:
//
//   approved  active = true,  approved_by set, effective_from <= today, no end
//   proposed  active = false, approved_by null, no end — createOrder() refuses it
//   archived  effective_to in the past (and active = false)
//
// "The payment system should never charge a proposed fee until an authorised
// administrator approves it": approval is approveFee(), gated on
// `feeframework:publish`, audited with the approver's name. Nothing else turns a
// proposed fee on.
//
// THE STUDENT RULE APPLIES HERE TOO. A fee that charges a student for standing
// (an admission, a student membership) is refused by classifyScheduledFee() —
// the same test createOrder() applies at payment time. Such a row is loaded
// inactive with the refusal in its notes, and approveFee() refuses it, so the
// office sees the conflict with its own charter rather than a price that
// appears approved and then fails at checkout.

import { and, asc, eq } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere } from '@/lib/rbac';
import { classifyScheduledFee } from '@/db/student-rule';
import { federationToday } from '@/db/orders';
import { FEE_MASTER, FEE_MASTER_SOURCE, type FeeMasterRow } from '@/data/fee-master-2026';

type DB = any;

export class FeeRegisterError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'FeeRegisterError';
  }
}

export function isFeeRegisterError(err: unknown): err is FeeRegisterError {
  return err instanceof FeeRegisterError;
}

export type FeeState = 'approved' | 'scheduled' | 'proposed' | 'refused' | 'archived';

export interface FeeRegisterRow {
  id: number;
  code: string;
  label: string;
  kind: string;
  amountPaise: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvedBy: string | null;
  notes: string | null;
  active: boolean;
  state: FeeState;
  /** The student-rule refusal, when there is one. Such a fee can never be approved here. */
  refusal: string | null;
  group: string | null;
}

const REFUSED_PREFIX = 'REFUSED BY THE STUDENT RULE: ';

function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** What the student rule says about a fee row; null when it may be charged. */
export function studentRefusal(row: { code: string; label: string; kind: string }): string | null {
  const verdict = classifyScheduledFee({ code: row.code, label: row.label, kind: row.kind });
  return verdict.refusal ?? null;
}

export function stateOf(
  row: { active: boolean; effectiveFrom: string; effectiveTo: string | null; notes: string | null },
  today: string,
): FeeState {
  if (row.effectiveTo && row.effectiveTo < today) return 'archived';
  if (row.active) return row.effectiveFrom > today ? 'scheduled' : 'approved';
  if (row.notes?.startsWith(REFUSED_PREFIX)) return 'refused';
  return 'proposed';
}

const GROUP_BY_CODE = new Map(FEE_MASTER.map((r) => [r.code, r.group]));

/** Every row of the register, newest first within each code. */
export async function feeRegister(db: DB, now: Date = new Date()): Promise<FeeRegisterRow[]> {
  const today = federationToday(now);
  const rows = await db.select().from(s.feeSchedule).orderBy(asc(s.feeSchedule.code), asc(s.feeSchedule.effectiveFrom));
  return rows.map((r: any) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    kind: r.kind,
    amountPaise: Number(r.amountPaise),
    effectiveFrom: String(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? String(r.effectiveTo) : null,
    approvedBy: r.approvedBy ?? null,
    notes: r.notes ?? null,
    active: Boolean(r.active),
    state: stateOf({ ...r, effectiveFrom: String(r.effectiveFrom), effectiveTo: r.effectiveTo ? String(r.effectiveTo) : null }, today),
    refusal: studentRefusal(r),
    group: GROUP_BY_CODE.get(r.code) ?? null,
  }));
}

export interface ImportReport {
  inserted: number;
  approved: number;
  proposed: number;
  refused: number;
  skippedExisting: number;
  refusedCodes: string[];
}

/**
 * Load the office's fee master into the register.
 *
 * IDEMPOTENT AND NON-DESTRUCTIVE: a code that already has ANY row is left
 * exactly as it is and counted as skipped. Re-running after an administrator has
 * approved or archived something must never revert their decision.
 *
 * Gated on `feeframework:write` (loading figures); turning a proposed fee on is
 * separately gated on `feeframework:publish`. The fee master's own confirmed
 * rows are loaded active because the office stated they are confirmed — the
 * approval is recorded against the person who loaded them and the source.
 */
export async function importFeeMaster(
  db: DB,
  ctx: AuditContext,
  rows: FeeMasterRow[] = FEE_MASTER,
  now: Date = new Date(),
): Promise<ImportReport> {
  assertCanAnywhere(ctx.principal, 'feeframework:write');
  const report: ImportReport = { inserted: 0, approved: 0, proposed: 0, refused: 0, skippedExisting: 0, refusedCodes: [] };
  const today = federationToday(now);
  const approver = `${(ctx.principal as any)?.label ?? 'administrator'} — ${FEE_MASTER_SOURCE}`;

  for (const row of rows) {
    if (!Number.isInteger(row.amountPaise) || row.amountPaise <= 0) {
      throw new FeeRegisterError('bad_amount', `${row.code}: an amount must be a positive number of paise.`);
    }
    const existing = (await db.select({ id: s.feeSchedule.id }).from(s.feeSchedule)
      .where(eq(s.feeSchedule.code, row.code)).limit(1))[0];
    if (existing) { report.skippedExisting++; continue; }

    const refusal = studentRefusal(row);
    const active = row.status === 'approved' && !refusal;
    const notes = refusal
      ? `${REFUSED_PREFIX}${refusal} | ${row.notes}`
      : row.status === 'proposed'
        ? `PROPOSED — not chargeable until approved. ${row.notes}`
        : row.notes;

    const [inserted] = await db.insert(s.feeSchedule).values({
      code: row.code,
      label: row.label,
      kind: row.kind,
      amountPaise: row.amountPaise,
      scopeType: 'national',
      effectiveFrom: today,
      approvedBy: active ? approver : null,
      notes,
      active,
    }).returning();
    report.inserted++;
    if (refusal) { report.refused++; report.refusedCodes.push(row.code); }
    else if (active) report.approved++;
    else report.proposed++;

    await writeAudit(db, ctx, {
      entityType: 'fee_schedule', entityId: inserted.id, action: 'create',
      newValue: { code: row.code, amountPaise: row.amountPaise, kind: row.kind, active, governance: refusal ? 'refused' : row.status, source: FEE_MASTER_SOURCE },
    });
  }
  return report;
}

async function loadRow(db: DB, id: number) {
  const row = (await db.select().from(s.feeSchedule).where(eq(s.feeSchedule.id, id)).limit(1))[0];
  if (!row) throw new FeeRegisterError('not_found', 'No such fee.');
  return row;
}

/**
 * Approve a proposed fee: it becomes chargeable from today (or from its own
 * later start date). The approver is recorded on the row and in the audit trail.
 */
export async function approveFee(db: DB, ctx: AuditContext, id: number, now: Date = new Date()) {
  assertCanAnywhere(ctx.principal, 'feeframework:publish');
  const today = federationToday(now);
  const row = await loadRow(db, id);
  const state = stateOf({ ...row, effectiveFrom: String(row.effectiveFrom), effectiveTo: row.effectiveTo ? String(row.effectiveTo) : null }, today);
  if (state === 'archived') throw new FeeRegisterError('archived', 'An archived fee cannot be approved. Enter a new fee instead.');
  if (row.active) throw new FeeRegisterError('already_approved', 'This fee is already approved.');
  const refusal = studentRefusal(row);
  if (refusal) {
    throw new FeeRegisterError('student_rule', `This fee cannot be charged: ${refusal}`);
  }
  const effectiveFrom = String(row.effectiveFrom) < today ? today : String(row.effectiveFrom);
  const approvedBy = `${(ctx.principal as any)?.label ?? 'administrator'} on ${today}`;
  const notes = (row.notes ?? '').replace(/^PROPOSED — not chargeable until approved\. ?/, '') || null;
  const [updated] = await db.update(s.feeSchedule)
    .set({ active: true, approvedBy, effectiveFrom, notes })
    .where(and(eq(s.feeSchedule.id, id), eq(s.feeSchedule.active, false)))
    .returning();
  if (!updated) throw new FeeRegisterError('already_approved', 'This fee was approved by someone else just now.');
  await writeAudit(db, ctx, {
    entityType: 'fee_schedule', entityId: id, action: 'approve',
    oldValue: { active: false }, newValue: { active: true, approvedBy, effectiveFrom, amountPaise: row.amountPaise },
  });
  return updated;
}

/**
 * Archive a fee: it stops being chargeable from today and stays on record as
 * history. A new price is entered as a new row; an old one is never edited.
 */
export async function archiveFee(db: DB, ctx: AuditContext, id: number, now: Date = new Date()) {
  assertCanAnywhere(ctx.principal, 'feeframework:publish');
  const today = federationToday(now);
  const row = await loadRow(db, id);
  if (row.effectiveTo && String(row.effectiveTo) < today) {
    throw new FeeRegisterError('archived', 'This fee is already archived.');
  }
  const effectiveTo = dayBefore(today);
  const [updated] = await db.update(s.feeSchedule)
    .set({ active: false, effectiveTo })
    .where(eq(s.feeSchedule.id, id))
    .returning();
  await writeAudit(db, ctx, {
    // 'revoke': the audit_action enum has no 'archive', and an unknown value
    // would make the audit insert fail. Withdrawing a price is a revocation.
    entityType: 'fee_schedule', entityId: id, action: 'revoke',
    oldValue: { active: row.active, effectiveTo: row.effectiveTo }, newValue: { active: false, effectiveTo },
  });
  return updated;
}
