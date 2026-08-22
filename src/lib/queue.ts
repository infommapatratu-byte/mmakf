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
    // Named for what it now is. The live entry register is the Postgres table
    // `event_entries`, worked from the entry-register panel on /admin/queue;
    // this queue is the Redis list the retired public form wrote to.
    label: 'Event entries — legacy intake',
    action: 'competition:write' as Action,
    // THE NAME MISMATCH, FIXED. The retired public form appended to a list
    // called `eventRegs` while this engine read one called `eventEntries`, so
    // every entry ever submitted from /events was unreachable by the only
    // screen that could decide it. Pointing the queue at the list the intake
    // actually wrote is the safe direction: the other — rewriting the intake to
    // a new key — would have stranded everything already stored.
    storageKey: 'eventRegs',
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

/**
 * The storage key a queue's rows actually live under.
 *
 * Defaults to the queue's own name, which is what every queue but one wants.
 * The exception is declared on the queue rather than special-cased at each read
 * site, because a key that only two of the three readers know about is how the
 * original mismatch survived for as long as it did.
 */
export function storageKeyFor(queue: QueueName): string {
  return (QUEUES[queue] as { storageKey?: string }).storageKey ?? queue;
}

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
  /**
   * The record as it now stands, for a caller that has to ACT on the decision.
   *
   * WHY IT IS HERE AT ALL. src/pages/api/queue/decide.ts has always read
   * `(result as any).record` to find the person a membership should be issued
   * to — and this interface never carried one, so that read was `undefined`
   * every single time. The approval path therefore always took its "this
   * application carries no linked person record" branch and no membership was
   * ever issued by it. A field the caller invented and this type never promised.
   *
   * IT IS PII AND MUST NOT BE SERIALISED TO A CLIENT. It holds the applicant's
   * name, date of birth, email, telephone and address. Every caller is
   * responsible for stripping it before it reaches a response body; decide.ts
   * destructures it out for exactly that reason and says so.
   */
  record: Record<string, any>;
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

  // storageKeyFor(), not the queue name. eventEntries reads the list the
  // retired intake actually wrote (`eventRegs`); using the queue name here was
  // the original bug wearing a fix.
  const rows = (await getList<any>(storageKeyFor(decision.queue), 5000)) || [];
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
  // AND THE WRITE MUST USE THE SAME KEY AS THE READ. It did not: the read was
  // corrected to storageKeyFor() and this line was left on the queue name, so a
  // decision on a legacy event entry was read from `eventRegs` and written to
  // `eventEntries` — the decision vanished and the original row kept its old
  // status for ever. A half-applied fix is worse than none, because the comment
  // above says it is handled.
  await storageSet(storageKeyFor(decision.queue), rows);

  // `record` is the DECIDED row, not the one read at the top — a caller
  // provisioning from it must see the status the decision just set.
  return {
    ok: true,
    recordId: String(decision.recordId),
    from,
    to: toStatus,
    record: rows[index],
  };
}

/** Counts per status, for the dashboard. */
export async function queueSummary(queue: QueueName): Promise<Record<string, number>> {
  const rows = (await getList<any>(storageKeyFor(queue), 5000)) || [];
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
  const rows = (await getList<any>(storageKeyFor(queue), 5000)) || [];
  const terminal = QUEUES[queue].terminal as readonly string[];
  return rows
    .filter((r: any) => !terminal.includes(String(r?.status ?? '')))
    .slice(0, limit);
}
