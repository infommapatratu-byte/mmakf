// The approval queue (§76 — one approval engine, not one per form).
//
// Applications, event entries and unit submissions all arrived with a `status`
// field that was written once and read by nothing: there was no approve or
// reject anywhere in the product, and both operator tables were read-only. The
// office could see a queue it had no way to work.
//
// One generic engine covers all three, because the shape is identical: a record
// moves between states, each move needs authority and leaves a trail.

import { getList, set as storageSet, get as storageGet } from './storage';
import { can, type Action, type Principal } from './rbac';

/** Lists that carry an approvable status, and who may decide on each. */
export const QUEUES = {
  registrations: {
    label: 'Membership applications',
    action: 'membership:issue' as Action,
    states: ['Received', 'Under review', 'Verified by unit', 'Approved', 'Rejected', 'Withdrawn'],
    terminal: ['Approved', 'Rejected', 'Withdrawn'],
  },
  eventEntries: {
    label: 'Event entries',
    action: 'competition:write' as Action,
    states: ['Received', 'Under review', 'Accepted', 'Rejected', 'Withdrawn'],
    terminal: ['Accepted', 'Rejected', 'Withdrawn'],
  },
  submissions: {
    label: 'Unit submissions',
    action: 'content:write' as Action,
    states: ['Pending', 'Under review', 'Published', 'Returned', 'Rejected'],
    terminal: ['Published', 'Returned', 'Rejected'],
  },
} as const;

export type QueueName = keyof typeof QUEUES;

export function isQueue(name: string): name is QueueName {
  return Object.prototype.hasOwnProperty.call(QUEUES, name);
}

export class QueueError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

export interface Decision {
  queue: QueueName;
  /** The record's own id — never its array index, which shifts as rows arrive. */
  recordId: string;
  toStatus: string;
  /** Required for any rejection: a refusal without a reason cannot be explained. */
  reason?: string;
  /** Optional message the applicant is allowed to see. */
  applicantNote?: string;
}

export interface DecisionResult {
  ok: true;
  recordId: string;
  from: string;
  to: string;
}

/**
 * Record a decision on a queued item.
 *
 * Rules the federation depends on:
 *  · authority is checked against the queue's action, not assumed from being
 *    signed in;
 *  · a record that has already reached a terminal state cannot be silently
 *    re-decided — reopening is an explicit move back to "Under review";
 *  · a rejection requires a reason;
 *  · the decision is appended to the record's own history, never overwriting
 *    what came before (§78).
 */
export async function decide(
  principal: Principal,
  decision: Decision,
  now: Date = new Date()
): Promise<DecisionResult> {
  const queue = QUEUES[decision.queue];
  if (!queue) throw new QueueError('unknown_queue', 'Unknown queue');

  if (!can(principal, queue.action, {})) {
    throw new QueueError('forbidden', `You do not have authority to decide ${queue.label.toLowerCase()}`);
  }

  const toStatus = String(decision.toStatus || '').trim();
  if (!(queue.states as readonly string[]).includes(toStatus)) {
    throw new QueueError('bad_status', `"${toStatus}" is not a valid status for ${queue.label.toLowerCase()}`);
  }

  const isRejection = /reject|return/i.test(toStatus);
  const reason = String(decision.reason ?? '').trim();
  if (isRejection && !reason) {
    throw new QueueError('reason_required', 'A reason is required when rejecting or returning an item');
  }

  const rows = (await getList<any>(decision.queue, 5000)) || [];
  const index = rows.findIndex((r: any) => String(r?.id) === String(decision.recordId));
  if (index === -1) throw new QueueError('not_found', 'That item is no longer in the queue');

  const record = rows[index];
  const from = String(record.status ?? queue.states[0]);

  if (from === toStatus) {
    throw new QueueError('no_change', `This item is already marked "${toStatus}"`);
  }
  if ((queue.terminal as readonly string[]).includes(from) && toStatus !== 'Under review') {
    throw new QueueError(
      'already_decided',
      `This item was already ${from.toLowerCase()}. Move it back to "Under review" first if it needs reopening.`
    );
  }

  const entry = {
    at: now.toISOString(),
    by: principal.label,
    userId: principal.userId ?? null,
    from,
    to: toStatus,
    reason: reason || null,
  };

  rows[index] = {
    ...record,
    status: toStatus,
    decidedOn: now.toISOString(),
    decidedBy: principal.label,
    // Only this field is ever shown to the applicant.
    applicantNote: decision.applicantNote?.trim().slice(0, 500) || record.applicantNote || null,
    // Append-only: every previous decision stays readable.
    history: [...(Array.isArray(record.history) ? record.history : []), entry],
  };

  // The list is stored whole because these are Redis JSON lists, not rows. The
  // read-modify-write is why decisions are serialised through this one function
  // rather than being done ad hoc in each surface.
  await storageSet(decision.queue, rows);

  return { ok: true, recordId: String(decision.recordId), from, to: toStatus };
}

/** Counts per status, for the dashboard. */
export async function queueSummary(queue: QueueName): Promise<Record<string, number>> {
  const rows = (await getList<any>(queue, 5000)) || [];
  const counts: Record<string, number> = {};
  for (const state of QUEUES[queue].states) counts[state] = 0;
  for (const r of rows) {
    const status = String(r?.status ?? QUEUES[queue].states[0]);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Items still needing a decision — what the office actually has to work. */
export async function openItems(queue: QueueName, limit = 200): Promise<any[]> {
  const rows = (await getList<any>(queue, 5000)) || [];
  const terminal = QUEUES[queue].terminal as readonly string[];
  return rows
    .filter((r: any) => !terminal.includes(String(r?.status ?? '')))
    .slice(0, limit);
}
