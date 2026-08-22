// The approval queue engine.
//
// Before this existed, `status` was written once and read by nothing: no
// approve, no reject, no way to work the queue at all. These tests pin the
// rules that make a decision trustworthy — authority, a reason for refusals,
// no silent re-deciding, and an append-only history.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Principal } from '../src/lib/rbac';

// The queue reads and writes through the storage layer. Stub it with an
// in-memory store so the rules are tested rather than Redis.
const store: Record<string, any[]> = {};

vi.mock('../src/lib/storage', () => ({
  getList: async (key: string) => store[key] ?? [],
  set: async (key: string, value: any) => { store[key] = value; },
  get: async (key: string) => store[key] ?? null,
}));

const { decide, queueSummary, openItems, QueueError, QUEUES, isQueue } = await import('../src/lib/queue');

const NOW = new Date('2026-08-12T10:00:00Z');

const registrar: Principal = {
  userId: 1, label: 'secretary@mmakf.in',
  bindings: [{ role: 'GENERAL_SECRETARY', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'athlete@mmakf.in',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const examiner: Principal = {
  userId: 3, label: 'examiner@mmakf.in',
  bindings: [{ role: 'EXAMINER', scopeType: 'national', scopeId: null }],
};

beforeEach(() => {
  store.registrations = [
    { id: 'rec-1', appNo: 'MMAKF-R-2026-AAAA1111', name: 'Ravi Kumar', status: 'Received', history: [] },
    { id: 'rec-2', appNo: 'MMAKF-R-2026-BBBB2222', name: 'Sita Devi', status: 'Under review', history: [] },
    { id: 'rec-3', appNo: 'MMAKF-R-2026-CCCC3333', name: 'Old Case', status: 'Approved', history: [] },
  ];
  store.submissions = [{ id: 'sub-1', title: 'District results', status: 'Pending', history: [] }];
  store.eventEntries = [{ id: 'ent-1', name: 'Entry', status: 'Received', history: [] }];
});

describe('queue definitions', () => {
  it('covers exactly the three approvable lists', () => {
    expect(Object.keys(QUEUES).sort()).toEqual(['eventEntries', 'registrations', 'submissions']);
  });

  it('recognises only real queue names', () => {
    expect(isQueue('registrations')).toBe(true);
    expect(isQueue('members')).toBe(false);
    expect(isQueue('__proto__')).toBe(false);   // not a queue via prototype chain
  });

  it('marks terminal states as a subset of its states', () => {
    for (const q of Object.values(QUEUES)) {
      for (const t of q.terminal) expect(q.states).toContain(t);
    }
  });
});

describe('authority', () => {
  it('lets the authorised officer decide', async () => {
    const r = await decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Under review' }, NOW);
    expect(r.ok).toBe(true);
    expect(r.recordId).toBe('rec-1');
    expect(r.from).toBe('Received');
    expect(r.to).toBe('Under review');
  });

  it('returns the DECIDED record, so an approval can provision from it', async () => {
    // Added when `record` joined DecisionResult. src/pages/api/queue/decide.ts
    // had been reading `result.record` since before the field existed, so it was
    // undefined on every request and the membership path always fell into its
    // "this application carries no linked person record" branch — an instruction
    // that could not be followed, because nothing linked an application to a
    // person. It is the decided row, not the row as it was read.
    const r = await decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved' }, NOW);
    expect(r.record).toBeTruthy();
    expect(String(r.record.id)).toBe('rec-1');
    expect(r.record.status).toBe('Approved');
  });

  it('ATTACK: an athlete cannot approve their own application', async () => {
    await expect(
      decide(athlete, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved' }, NOW)
    ).rejects.toThrow(/authority/i);
    expect(store.registrations[0].status).toBe('Received');   // unchanged
  });

  it('ATTACK: an examiner may score gradings but cannot issue memberships', async () => {
    await expect(
      decide(examiner, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved' }, NOW)
    ).rejects.toThrow(/authority/i);
  });

  it('checks authority per queue, not once for everything', async () => {
    // A technical director holds content authority but not membership issuance.
    const technical: Principal = {
      userId: 4, label: 'technical@mmakf.in',
      bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
    };
    await expect(
      decide(technical, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved' }, NOW)
    ).rejects.toThrow(/authority/i);
    await expect(
      decide(technical, { queue: 'submissions', recordId: 'sub-1', toStatus: 'Published' }, NOW)
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('the rules that make a decision trustworthy', () => {
  it('REFUSES a rejection with no reason', async () => {
    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Rejected' }, NOW)
    ).rejects.toThrow(/reason is required/i);

    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Rejected', reason: '   ' }, NOW)
    ).rejects.toThrow(/reason is required/i);

    expect(store.registrations[0].status).toBe('Received');
  });

  it('accepts a rejection that carries a reason', async () => {
    await decide(registrar, {
      queue: 'registrations', recordId: 'rec-1', toStatus: 'Rejected',
      reason: 'Applicant is already registered under MMAKF-A-2015-00891',
    }, NOW);
    expect(store.registrations[0].status).toBe('Rejected');
    expect(store.registrations[0].history[0].reason).toMatch(/already registered/);
  });

  it('requires a reason to return a unit submission too', async () => {
    await expect(
      decide(registrar, { queue: 'submissions', recordId: 'sub-1', toStatus: 'Returned' }, NOW)
    ).rejects.toThrow(/reason is required/i);
  });

  it('ATTACK: an already-decided item cannot be silently re-decided', async () => {
    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'rec-3', toStatus: 'Rejected', reason: 'Changed my mind' }, NOW)
    ).rejects.toThrow(/already approved/i);
    expect(store.registrations[2].status).toBe('Approved');
  });

  it('but CAN be reopened explicitly, which is an auditable act', async () => {
    await decide(registrar, { queue: 'registrations', recordId: 'rec-3', toStatus: 'Under review' }, NOW);
    expect(store.registrations[2].status).toBe('Under review');
    expect(store.registrations[2].history[0]).toMatchObject({ from: 'Approved', to: 'Under review' });
  });

  it('refuses a status that is not in the queue vocabulary', async () => {
    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Blessed' }, NOW)
    ).rejects.toThrow(/not a valid status/i);
  });

  it('refuses a no-op, so the history is not padded with meaningless entries', async () => {
    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'rec-2', toStatus: 'Under review' }, NOW)
    ).rejects.toThrow(/already marked/i);
  });

  it('refuses an unknown record rather than creating one', async () => {
    await expect(
      decide(registrar, { queue: 'registrations', recordId: 'does-not-exist', toStatus: 'Approved' }, NOW)
    ).rejects.toThrow(/no longer in the queue/i);
    expect(store.registrations.length).toBe(3);
  });

  it('matches on the record id, not on a position that shifts as rows arrive', async () => {
    store.registrations.unshift({ id: 'rec-new', name: 'Newest', status: 'Received', history: [] });
    await decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Under review' }, NOW);
    expect(store.registrations.find((r: any) => r.id === 'rec-1').status).toBe('Under review');
    expect(store.registrations.find((r: any) => r.id === 'rec-new').status).toBe('Received');
  });
});

describe('history is append-only', () => {
  it('records who, when, from, to and why — and never overwrites', async () => {
    await decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Under review' }, NOW);
    await decide(registrar, {
      queue: 'registrations', recordId: 'rec-1', toStatus: 'Verified by unit',
    }, new Date('2026-08-13T10:00:00Z'));
    await decide(registrar, {
      queue: 'registrations', recordId: 'rec-1', toStatus: 'Rejected', reason: 'Grade could not be evidenced',
    }, new Date('2026-08-14T10:00:00Z'));

    const history = store.registrations[0].history;
    expect(history.length).toBe(3);
    expect(history.map((h: any) => h.to)).toEqual(['Under review', 'Verified by unit', 'Rejected']);
    expect(history[0].by).toBe('secretary@mmakf.in');
    expect(history[0].at).toBe(NOW.toISOString());
    expect(history[2].reason).toBe('Grade could not be evidenced');
    // The first entry survives the third decision.
    expect(history[0].from).toBe('Received');
  });

  it('tolerates a record whose history field is missing or malformed', async () => {
    store.registrations.push({ id: 'rec-legacy', status: 'Received' });               // no history
    store.registrations.push({ id: 'rec-broken', status: 'Received', history: 'x' }); // wrong type

    await decide(registrar, { queue: 'registrations', recordId: 'rec-legacy', toStatus: 'Under review' }, NOW);
    await decide(registrar, { queue: 'registrations', recordId: 'rec-broken', toStatus: 'Under review' }, NOW);

    expect(store.registrations.find((r: any) => r.id === 'rec-legacy').history.length).toBe(1);
    expect(store.registrations.find((r: any) => r.id === 'rec-broken').history.length).toBe(1);
  });

  it('keeps the applicant-facing note separate from the internal reason', async () => {
    await decide(registrar, {
      queue: 'registrations', recordId: 'rec-1', toStatus: 'Rejected',
      reason: 'Suspected duplicate of an existing member; flagged internally',
      applicantNote: 'Please contact the office to confirm your existing membership.',
    }, NOW);

    const record = store.registrations[0];
    expect(record.applicantNote).toMatch(/contact the office/);
    expect(record.applicantNote).not.toMatch(/flagged internally/);
    // The internal reason lives in the history, which the applicant never sees.
    expect(record.history[0].reason).toMatch(/flagged internally/);
  });

  it('truncates an over-long applicant note rather than storing it unbounded', async () => {
    await decide(registrar, {
      queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved',
      applicantNote: 'x'.repeat(900),
    }, NOW);
    expect(store.registrations[0].applicantNote.length).toBe(500);
  });
});

describe('reads', () => {
  it('summarises counts across every status the queue defines', async () => {
    const summary = await queueSummary('registrations');
    expect(summary.Received).toBe(1);
    expect(summary['Under review']).toBe(1);
    expect(summary.Approved).toBe(1);
    expect(summary.Rejected).toBe(0);      // present, not missing
    for (const state of QUEUES.registrations.states) expect(summary).toHaveProperty(state);
  });

  it('lists only what still needs a decision', async () => {
    const open = await openItems('registrations');
    expect(open.map((r: any) => r.id)).toEqual(['rec-1', 'rec-2']);
    expect(open.map((r: any) => r.id)).not.toContain('rec-3');   // already approved
  });

  it('drops an item off the open list once it is decided', async () => {
    await decide(registrar, { queue: 'registrations', recordId: 'rec-1', toStatus: 'Approved' }, NOW);
    const open = await openItems('registrations');
    expect(open.map((r: any) => r.id)).toEqual(['rec-2']);
  });
});
