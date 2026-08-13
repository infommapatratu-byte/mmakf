// The realtime transport, against real Postgres.
//
// What these tests exist to protect, in the order the damage would be worst:
//
//   · A CHANNEL IS AUTHORISED ON SUBSCRIBE, and a wrong answer here is not a
//     one-off leak — the connection stays open. So the admin channels are tested
//     against a principal who holds the action but only in a DOJO, which is the
//     mistake `canAnywhere()` would make, and against a competition the
//     federation has not published.
//   · THE PUBLIC PROJECTION IS THE ONLY THING A PUBLIC CHANNEL CARRIES. A
//     payload is published with private fields deliberately attached, and the
//     frames must not contain them.
//   · RESUMPTION IS EXACT. A subscriber that reconnects with Last-Event-ID gets
//     what it missed and nothing it already had.
//   · THE LIMITS ARE REAL, not documented. The batch cap, the per-client
//     concurrency cap and the duration cap are each exercised.
//   · WITHOUT A DATABASE THE ENDPOINT SAYS SO. 503, in words, with the fallback
//     named — never an empty stream that looks live.
//
// Where a rule is DUPLICATED from another module (the competition visibility
// statuses), the duplicate is checked against that module's own behaviour rather
// than against a second copy of the list.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';
import { publish } from '../src/lib/domain-events';
import type { Principal } from '../src/lib/rbac';
import {
  parseChannel, authoriseChannel, pollChannel, openStream, resolveCursor, currentHead,
  acquireStreamSlot, __resetStreamSlots, streamCatalogueDefects,
  frame, comment, ADMIN_SCOPES, ADMIN_SCOPE_NAMES, STREAM_LIMITS, LIVE_CLASS_ENTITY_TYPE,
  type ChannelGrant,
} from '../src/lib/realtime';
import { publicEventDetail } from '../src/pages/api/competition/[...action]';
import { GET as streamRoute } from '../src/pages/api/stream/[channel]';

let db: any;

// ─── Principals ─────────────────────────────────────────────────────────────

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 2, label: 'finance-officer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const stateAdmin: Principal = {
  userId: 3, label: 'state-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 1 }],
};
/**
 * Holds `audit:read` — but bound to ONE DOJO. The feed has no dojo column, so
 * there is no such thing as this principal's share of it. A gate that asked
 * "do you hold this anywhere?" would hand a single dojo the federation's entire
 * feed, over a connection that stays open.
 */
const dojoAudit: Principal = {
  userId: 4, label: 'dojo-technical-director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'dojo', scopeId: 3 }],
};
const member: Principal = {
  userId: 5, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 6, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Every status in the event lifecycle, so visibility is tested at all of them. */
const ALL_EVENT_STATUSES = [
  'draft', 'technical_review', 'sanction_review', 'approved', 'published',
  'registration_open', 'registration_closed', 'check_in', 'live',
  'results_pending', 'results_final', 'archived', 'cancelled', 'postponed',
] as const;

const competitionByStatus = new Map<string, number>();
/** The competition every scoreboard test streams. Published, so it is public. */
let publicCompetitionId = 0;

const liveClass: Record<'open' | 'membersOnly' | 'unpublished', number> = {
  open: 0, membersOnly: 0, unpublished: 0,
};

let seq = 0;
const uid = () => ++seq;

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // publicEventDetail() reads through the app's own db() accessor. Injecting the
  // test client and a placeholder URL is what lets the visibility rule be
  // cross-checked against the module that owns it rather than against a copy.
  process.env.DATABASE_URL = 'postgresql://test/test';
  __setTestClient(db);

  for (const status of ALL_EVENT_STATUSES) {
    const [row] = await db.insert(s.competitionEvents).values({
      code: `MMAKF-EVT-2026-${String(uid()).padStart(6, '0')}`,
      title: `Fixture ${status}`,
      kind: 'national_championship',
      status,
    }).returning();
    competitionByStatus.set(status, row.id);
  }
  publicCompetitionId = competitionByStatus.get('published')!;

  const classes: Array<[keyof typeof liveClass, string, boolean]> = [
    ['open', 'public', true],
    ['membersOnly', 'members', true],
    ['unpublished', 'public', false],
  ];
  for (const [key, visibility, published] of classes) {
    const [row] = await db.insert(s.liveClasses).values({
      code: `MMAKF-LIVE-2026-${String(uid()).padStart(6, '0')}`,
      title: `Fixture ${key}`,
      visibility,
      published,
      status: 'live',
    }).returning();
    liveClass[key] = row.id;
  }
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Frame {
  id: number | null;
  event: string | null;
  data: any;
  comment: string | null;
  retry: number | null;
}

/** Parse an SSE body into frames, the way a browser would. */
function parseFrames(text: string): Frame[] {
  return text.split('\n\n').filter((b) => b.trim().length).map((block) => {
    const f: Frame = { id: null, event: null, data: null, comment: null, retry: null };
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) f.comment = line.slice(2);
      else if (line.startsWith('id: ')) f.id = Number(line.slice(4));
      else if (line.startsWith('event: ')) f.event = line.slice(7);
      else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
      else if (line.startsWith('retry: ')) f.retry = Number(line.slice(7));
    }
    return f;
  });
}

/** Read a streaming response to completion. Streams here close themselves. */
async function drain(res: Response): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return parseFrames(out);
}

/** Short, deterministic timings so a stream test finishes in a fraction of a second. */
const FAST = { pollMs: 4, heartbeatMs: 20, maxDurationMs: 250 };

async function grantFor(channel: string, principal: Principal | null = null): Promise<ChannelGrant> {
  const auth = await authoriseChannel(db, channel, principal ? { principal } : null);
  if (!auth.ok) throw new Error(`expected ${channel} to be authorised, got ${auth.code}: ${auth.message}`);
  return auth.grant;
}

async function refusalFor(channel: string, principal: Principal | null = null) {
  const auth = await authoriseChannel(db, channel, principal ? { principal } : null);
  if (auth.ok) throw new Error(`expected ${channel} to be refused, but it was granted`);
  return auth;
}

/** Publish a match result for a competition, with whatever payload is given. */
async function publishMatch(competitionId: number, payload: Record<string, unknown> = {}) {
  const { event } = await publish(db, {
    eventType: 'MATCH_COMPLETED',
    entityType: 'match',
    entityId: uid(),
    payload: { competitionId, categoryId: 1, round: 'final', ...payload },
  });
  return event.id;
}

// ─── The module's own tables ────────────────────────────────────────────────

describe('stream catalogue', () => {
  it('is internally consistent, and its ladder still matches domain-events.ts', () => {
    expect(streamCatalogueDefects()).toEqual([]);
  });

  it('offers no channel that reaches safeguarding, medical or disciplinary material', () => {
    for (const name of ADMIN_SCOPE_NAMES) {
      expect(['public', 'member', 'official', 'confidential'], name)
        .toContain(ADMIN_SCOPES[name].upTo);
    }
  });

  it('has no safeguarding channel to subscribe to at all', async () => {
    const refusal = await refusalFor('admin:safeguarding', national);
    expect(refusal.status).toBe(404);
  });
});

// ─── Channel names ──────────────────────────────────────────────────────────

describe('channel names', () => {
  it('accepts the three documented forms', () => {
    expect(parseChannel('scoreboard:12')).toMatchObject({ kind: 'scoreboard', subject: '12' });
    expect(parseChannel('live-class:7')).toMatchObject({ kind: 'live-class', subject: '7' });
    expect(parseChannel('admin:operations')).toMatchObject({ kind: 'admin', subject: 'operations' });
  });

  it('refuses anything else, including the shapes an attacker would try', () => {
    for (const bad of [
      '', '   ', 'scoreboard', 'scoreboard:', 'scoreboard:0', 'scoreboard:-1',
      'scoreboard:abc', 'scoreboard:1;drop', 'scoreboard:1\nid: 9',
      'admin:../../etc', 'admin:', 'unknown:1', 'SCOREBOARD:1',
      'live-class:9999999999',                        // beyond the id bound
      `admin:${'x'.repeat(80)}`,
    ]) {
      expect(parseChannel(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

// ─── Authorisation: the public scoreboard ───────────────────────────────────

describe('scoreboard channel authorisation', () => {
  /**
   * The visibility rule is defined in src/pages/api/competition/[...action].ts
   * and mirrored in realtime.ts. This is the guard against those two drifting:
   * at EVERY status in the lifecycle, subscribing must be possible exactly when
   * that file's own public read returns something.
   */
  it('agrees with publicEventDetail() at every status in the lifecycle', async () => {
    const outcomes = new Set<boolean>();
    for (const status of ALL_EVENT_STATUSES) {
      const id = competitionByStatus.get(status)!;
      const auth = await authoriseChannel(db, `scoreboard:${id}`, null);
      const publiclyReadable = (await publicEventDetail(id)) !== null;
      expect(auth.ok, `${status}: channel ${auth.ok} but page ${publiclyReadable}`).toBe(publiclyReadable);
      outcomes.add(auth.ok);
    }
    // Not vacuous: the lifecycle really does contain both answers, so a rule
    // that had collapsed to "always yes" or "always no" would fail here.
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('refuses a competition that does not exist, without saying which it was', async () => {
    const refusal = await refusalFor('scoreboard:987654');
    expect(refusal.status).toBe(404);
    expect(refusal.message).not.toMatch(/987654/);
  });

  it('is open to an anonymous subscriber and projects rather than reads raw', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    expect(grant.mode).toBe('projection');
    expect(grant.audience).toBe('public');
    expect(grant.principal).toBeNull();
  });
});

// ─── Authorisation: live classes ────────────────────────────────────────────

describe('live-class channel authorisation', () => {
  it('opens a public, published class to anyone', async () => {
    const grant = await grantFor(`live-class:${liveClass.open}`);
    expect(grant.mode).toBe('projection');
  });

  it('refuses a members-only class to the public and allows it to a member', async () => {
    const refusal = await refusalFor(`live-class:${liveClass.membersOnly}`);
    expect(refusal.status).toBe(401);
    // Not an authorisation term leaked onto a page.
    expect(refusal.message).not.toMatch(/^Forbidden:/);

    const grant = await grantFor(`live-class:${liveClass.membersOnly}`, member);
    expect(grant.audience).toBe('member');
  });

  it('refuses an unpublished class even though it is marked public', async () => {
    const refusal = await refusalFor(`live-class:${liveClass.unpublished}`, member);
    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe('class_not_published');
  });

  /**
   * The rule is borrowed by RUNNING a query, so a database that is merely
   * unreachable arrives at the same `catch` as a refusal. Answering 403 there
   * sends an operator to the role bindings for a database that was down, and
   * `err.message` on an infrastructure failure is a Postgres sentence naming
   * tables — sent to whoever asked, who on this channel may be anonymous.
   */
  it('does not report a database failure as a refusal, and leaks no error text', async () => {
    const broken = {
      select() { throw new Error('connect ECONNREFUSED 127.0.0.1:5433 relation "live_classes"'); },
    } as any;

    await expect(authoriseChannel(broken, `live-class:${liveClass.open}`, null)).rejects.toThrow(/ECONNREFUSED/);

    // End to end: the endpoint turns it into 503, and the body says nothing
    // about the database internals.
    __setTestClient(broken);
    try {
      const res = await streamRoute(request(`live-class:${liveClass.open}`));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('unavailable');
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|live_classes|127\.0\.0\.1/);
    } finally {
      __setTestClient(db);
    }
  });

  it('refuses a class that does not exist', async () => {
    const refusal = await refusalFor('live-class:987654', member);
    expect(refusal.status).toBe(404);
  });
});

// ─── Authorisation: admin channels ──────────────────────────────────────────

describe('admin channel authorisation', () => {
  it('grants a national administrator the operations channel', async () => {
    const grant = await grantFor('admin:operations', national);
    expect(grant.mode).toBe('raw');
    expect(grant.upTo).toBe('official');
  });

  it('REFUSES an administrator who holds audit:read only in one dojo', async () => {
    const refusal = await refusalFor('admin:operations', dojoAudit);
    expect(refusal.status).toBe(403);
    expect(refusal.message).toMatch(/national/i);
  });

  it('refuses a state administrator, and an athlete, and the unauthenticated', async () => {
    expect((await refusalFor('admin:operations', stateAdmin)).status).toBe(403);
    expect((await refusalFor('admin:finance', athlete)).status).toBe(403);
    const anonymous = await refusalFor('admin:operations', null);
    expect(anonymous.status).toBe(401);
  });

  it('grants the finance channel to a finance officer only', async () => {
    const grant = await grantFor('admin:finance', finance);
    expect(grant.upTo).toBe('confidential');
    expect((await refusalFor('admin:finance', member)).status).toBe(403);
  });

  it('refuses an administrative scope that does not exist', async () => {
    const refusal = await refusalFor('admin:everything', national);
    expect(refusal.status).toBe(404);
    expect(refusal.message).toMatch(/operations/);
  });
});

// ─── The public projection ──────────────────────────────────────────────────

describe('what a public channel carries', () => {
  it('carries only the fields the federation declared public', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);

    await publishMatch(publicCompetitionId, {
      matchId: 4001,
      scoreAka: 5,
      scoreAo: 3,
      winnerEntryId: 77,
      // Everything below is the reason this test exists. A producer may attach
      // private context to a public fact; none of it is on the allowlist.
      injuryNote: 'suspected concussion, referred to the event doctor',
      competitorName: 'a real person',
      competitorDateOfBirth: '2011-04-02',
      guardianPhone: '+91 00000 00000',
      internalEntryRef: 'ENT-99',
    });

    const poll = await pollChannel(db, grant, from);
    expect(poll.frames).toHaveLength(1);
    const payload = parseFrames(poll.frames.join(''))[0].data.payload;

    expect(Object.keys(payload).sort()).toEqual(
      ['categoryId', 'competitionId', 'matchId', 'round', 'scoreAka', 'scoreAo', 'winnerEntryId'].sort()
    );
    for (const leaked of ['injuryNote', 'competitorName', 'competitorDateOfBirth', 'guardianPhone', 'internalEntryRef']) {
      expect(payload, leaked).not.toHaveProperty(leaked);
    }
    // Nor anywhere else in the frame — the whole serialisation is checked, not
    // just the payload object, because a leak added to a wrapper is still a leak.
    expect(poll.frames.join('')).not.toMatch(/concussion|guardianPhone|2011-04-02/);
  });

  it('never carries an event classified above the public ceiling', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);

    await publish(db, {
      eventType: 'SAFEGUARDING_CASE_OPENED',
      entityType: 'safeguarding_case',
      entityId: uid(),
      payload: { competitionId: publicCompetitionId, detail: 'must never leave the case file' },
    });
    await publish(db, {
      eventType: 'ORDER_PAID',
      entityType: 'order',
      entityId: uid(),
      payload: { competitionId: publicCompetitionId, amountPaise: 250000 },
    });

    const poll = await pollChannel(db, grant, from);
    expect(poll.frames).toEqual([]);
  });

  it('carries only the named competition, and steps its cursor past the rest', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);

    const otherCompetition = competitionByStatus.get('results_final')!;
    await publishMatch(otherCompetition, { matchId: 5001 });
    const mine = await publishMatch(publicCompetitionId, { matchId: 5002 });
    const lastOther = await publishMatch(otherCompetition, { matchId: 5003 });

    const poll = await pollChannel(db, grant, from);
    const frames = parseFrames(poll.frames.join(''));
    expect(frames.map((f) => f.id)).toEqual([mine]);
    // The cursor passed the other competition's events. If it did not, every
    // poll would re-read the same window forever on a busy feed.
    expect(poll.cursor).toBe(lastOther);
  });
});

// ─── What an admin channel carries ──────────────────────────────────────────

describe('what an admin channel carries', () => {
  it('clamps to the channel ceiling: finance sees a payment, operations does not', async () => {
    const from = await currentHead(db);
    await publish(db, {
      eventType: 'ORDER_PAID',
      entityType: 'order',
      entityId: uid(),
      payload: { orderId: 'ORD-1', amountPaise: 150000 },
    });

    const financePoll = await pollChannel(db, await grantFor('admin:finance', finance), from);
    expect(financePoll.frames).toHaveLength(1);
    expect(financePoll.clearance).toBe('confidential');

    const opsPoll = await pollChannel(db, await grantFor('admin:operations', national), from);
    expect(opsPoll.frames).toEqual([]);
    expect(opsPoll.clearance).toBe('official');
  });

  it('withholds the actor user id while keeping the actor label', async () => {
    const from = await currentHead(db);
    await publish(db, {
      eventType: 'GRADING_APPROVED',
      entityType: 'grading',
      entityId: uid(),
      payload: { candidate: 'internal' },
      actor: national,
    });

    const poll = await pollChannel(db, await grantFor('admin:grading', national), from);
    const [f] = parseFrames(poll.frames.join(''));
    expect(f.data.actorLabel).toBe('federation-admin');
    expect(f.data).not.toHaveProperty('actorUserId');
    expect(f.data).not.toHaveProperty('publishedAt');
  });
});

// ─── Resumption ─────────────────────────────────────────────────────────────

describe('cursor resumption', () => {
  it('resumes exactly where the subscriber stopped', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);

    const first = await publishMatch(publicCompetitionId, { matchId: 6001 });
    const second = await publishMatch(publicCompetitionId, { matchId: 6002 });
    const third = await publishMatch(publicCompetitionId, { matchId: 6003 });

    // The first connection reads everything and ends at `third`.
    const initial = await pollChannel(db, grant, from);
    expect(parseFrames(initial.frames.join('')).map((f) => f.id)).toEqual([first, second, third]);

    // A connection that died after the first event reconnects with its id.
    const resumed = await pollChannel(db, grant, first);
    expect(parseFrames(resumed.frames.join('')).map((f) => f.id)).toEqual([second, third]);

    // And one that had caught up gets nothing rather than a replay.
    expect((await pollChannel(db, grant, third)).frames).toEqual([]);
  });

  it('takes Last-Event-ID from the header, then the query, then the head', async () => {
    const head = await currentHead(db);
    expect(head).toBeGreaterThan(2);                       // the assertions below need room
    expect(await resolveCursor(db, String(head - 1), String(head - 2))).toBe(head - 1);
    expect(await resolveCursor(db, null, String(head - 2))).toBe(head - 2);
    expect(await resolveCursor(db, null, null)).toBe(head);
    // A junk resume point starts from NOW, never from 0 — replaying the
    // federation's whole history to a scoreboard that just opened is the one
    // answer that must not happen.
    for (const junk of ['', '  ', 'abc', '-3', '1e9999', 'NaN', '3.7']) {
      expect(await resolveCursor(db, junk, null), junk).toBe(head);
    }
  });

  it('clamps a resume point above the head instead of putting it into SQL', async () => {
    const head = await currentHead(db);
    // `domain_events.id` is an integer column and Last-Event-ID is a header
    // anyone can set. Unclamped, this number reaches `where id > …` on EVERY
    // poll and Postgres answers "value out of range for type integer" — inside
    // a response that already returned 200 and can no longer report a 400.
    const hostile = '99999999999999999999';
    expect(await resolveCursor(db, hostile, null)).toBe(head);
    expect(await resolveCursor(db, String(head + 5_000), null)).toBe(head);

    // And the proof that the clamp is what stands between the header and the
    // database: the unclamped value still breaks the poll.
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    await expect(pollChannel(db, grant, Number(hostile))).rejects.toThrow();
    await expect(pollChannel(db, grant, await resolveCursor(db, hostile, null))).resolves.toBeTruthy();
  });

  it('streams the missed events and nothing already delivered', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const first = await publishMatch(publicCompetitionId, { matchId: 7001 });
    const second = await publishMatch(publicCompetitionId, { matchId: 7002 });

    const frames = await drain(openStream(db, grant, { cursor: first, options: FAST }));
    const delivered = frames.filter((f) => f.event === 'MATCH_COMPLETED');
    expect(delivered.map((f) => f.id)).toEqual([second]);

    // The opening frame tells the client where it resumed from, and the browser
    // is told how long to wait before reconnecting.
    const ready = frames.find((f) => f.event === 'ready')!;
    expect(ready.data.cursor).toBe(first);
    expect(frames.some((f) => f.retry != null)).toBe(true);
  });
});

// ─── Heartbeat ──────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  it('sends a comment frame when there is nothing to say', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const head = await currentHead(db);

    const frames = await drain(openStream(db, grant, {
      cursor: head,
      options: { pollMs: 4, heartbeatMs: 15, maxDurationMs: 200 },
    }));

    const beats = frames.filter((f) => f.comment != null);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0].comment).toMatch(/keep-alive/);
    // A heartbeat must not carry an id: it would move the resume position
    // without delivering anything, and the client would skip an event.
    for (const b of beats) expect(b.id).toBeNull();
  });
});

// ─── Limits ─────────────────────────────────────────────────────────────────

describe('limits', () => {
  it('caps the batch per poll and reports that more is waiting', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);
    for (let i = 0; i < 5; i++) await publishMatch(publicCompetitionId, { matchId: 8000 + i });

    const first = await pollChannel(db, grant, from, 2);
    expect(first.frames).toHaveLength(2);
    expect(first.full).toBe(true);

    const second = await pollChannel(db, grant, first.cursor, 2);
    expect(second.frames).toHaveLength(2);

    const third = await pollChannel(db, grant, second.cursor, 2);
    expect(third.frames).toHaveLength(1);
    expect(third.full).toBe(false);
  });

  it('never exceeds the module cap however large a batch is requested', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const poll = await pollChannel(db, grant, 0, 10_000);
    expect(poll.frames.length).toBeLessThanOrEqual(STREAM_LIMITS.maxBatch);
  });

  it('caps concurrent streams per client and returns the slot on release', () => {
    __resetStreamSlots();
    const held = [];
    for (let i = 0; i < STREAM_LIMITS.maxStreamsPerClient; i++) {
      const release = acquireStreamSlot('client-a');
      expect(release).not.toBeNull();
      held.push(release!);
    }
    expect(acquireStreamSlot('client-a')).toBeNull();

    // Another client is unaffected — the cap is per client, not global.
    const other = acquireStreamSlot('client-b');
    expect(other).not.toBeNull();

    held[0]();
    held[0]();                                  // idempotent: no free slot minted
    expect(acquireStreamSlot('client-a')).not.toBeNull();
    expect(acquireStreamSlot('client-a')).toBeNull();

    __resetStreamSlots();
  });

  it('closes a connection at the duration cap and tells the client to reconnect', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const head = await currentHead(db);

    const started = Date.now();
    const frames = await drain(openStream(db, grant, {
      cursor: head,
      options: { pollMs: 4, heartbeatMs: 1_000, maxDurationMs: 120 },
    }));
    const elapsed = Date.now() - started;

    const closing = frames.find((f) => f.event === 'closing');
    expect(closing).toBeTruthy();
    expect(closing!.data.reason).toBe('duration_cap');
    expect(closing!.data.reconnect).toBe(true);
    // It actually ended, rather than merely announcing that it would.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('paces catch-up polls instead of looping on the database with no pause', async () => {
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const from = await currentHead(db);
    for (let i = 0; i < 3; i++) await publishMatch(publicCompetitionId, { matchId: 8500 + i });

    // The clock is INJECTED, and it is the injected sleep that advances it.
    // maxDurationMs is a deadline the stream reads off now(), so with the real
    // clock this test was really asserting that three database round trips fit
    // inside 200 wall-clock milliseconds on the machine running it. They do on
    // an idle machine and they do not when the whole suite is running, which is
    // how this failed once in a full run and passed on its own. Nothing about
    // the pacing rule is a fact about wall-clock time, so nothing here should
    // depend on one.
    const waits: number[] = [];
    let clock = 0;
    const frames = await drain(openStream(db, grant, {
      cursor: from,
      options: {
        maxBatch: 1, catchupMs: 5, pollMs: 60, heartbeatMs: 10_000, maxDurationMs: 200,
        now: () => clock,
        sleep: async (ms: number) => { waits.push(ms); clock += ms; await new Promise((r) => setTimeout(r, ms)); },
      },
    }));

    expect(frames.filter((f) => f.event === 'MATCH_COMPLETED')).toHaveLength(3);
    // A full batch is drained at the catch-up interval, not the idle one...
    expect(waits.filter((ms) => ms === 5).length).toBeGreaterThanOrEqual(3);
    // ...and NEVER with no wait at all. A scoreboard channel filters by
    // competition in JavaScript, so an unauthenticated subscriber resuming from
    // a low Last-Event-ID otherwise reads the whole feed as fast as the
    // database will serve it while emitting almost none of it.
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  it('releases the concurrency slot when the stream ends', async () => {
    __resetStreamSlots();
    const grant = await grantFor(`scoreboard:${publicCompetitionId}`);
    const release = acquireStreamSlot('client-c')!;
    await drain(openStream(db, grant, {
      cursor: await currentHead(db),
      release,
      options: { pollMs: 4, heartbeatMs: 1_000, maxDurationMs: 60 },
    }));
    // The slot is back: a client whose streams expire must not be locked out.
    for (let i = 0; i < STREAM_LIMITS.maxStreamsPerClient; i++) {
      expect(acquireStreamSlot('client-c')).not.toBeNull();
    }
    __resetStreamSlots();
  });
});

// ─── Framing ────────────────────────────────────────────────────────────────

describe('framing', () => {
  it('cannot be split by a value that contains a newline', () => {
    // A raw event type is not this module's to trust: other modules write rows
    // to domain_events directly. A newline in an event name would split one
    // frame into two and desynchronise everything after it.
    const f = frame({ id: 5, event: 'EVIL\nid: 999\nevent: other', data: { text: 'line one\nline two' } });
    expect(f.split('\n\n').filter(Boolean)).toHaveLength(1);
    const parsed = parseFrames(f)[0];
    expect(parsed.id).toBe(5);
    expect(parsed.data.text).toBe('line one\nline two');
    expect(parsed.event).not.toMatch(/\n/);
  });

  it('keeps a comment on one line', () => {
    expect(comment('a\nb\nc')).toBe(': a b c\n\n');
  });
});

// ─── The endpoint ───────────────────────────────────────────────────────────

function request(channel: string, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/stream/${channel}`);
  return {
    params: { channel },
    request: new Request(url, { headers }),
    url,
  } as any;
}

describe('GET /api/stream/[channel]', () => {
  it('returns 503 and names the fallback when no database is configured', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await streamRoute(request(`scoreboard:${publicCompetitionId}`));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('database_not_configured');
      expect(body.fallback).toBe('polling');
      // The message has to be usable by whoever reads it, not a status code.
      expect(body.error).toMatch(/not configured/i);
      expect(body.error).toMatch(/live/i);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it('refuses an administrative channel to an unauthenticated caller', async () => {
    const res = await streamRoute(request('admin:operations'));
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
  });

  it('opens a public scoreboard channel with the SSE headers a proxy needs', async () => {
    const res = await streamRoute(request(`scoreboard:${publicCompetitionId}`, {
      'last-event-id': String(await currentHead(db)),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(res.headers.get('Cache-Control')).toMatch(/no-transform/);
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    // No CORS header: EventSource sends cookies, and a permissive one would let
    // any page on the internet open a channel in a signed-in official's browser.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();

    // Cancel rather than drain: this one runs on the real four-minute cap.
    await res.body!.cancel();
    __resetStreamSlots();
  });

  it('refuses a channel name it does not recognise', async () => {
    const res = await streamRoute(request('nonsense'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_channel');
  });
});

// ─── The convention producers must follow ───────────────────────────────────

describe('the live-class subject convention', () => {
  it('delivers an event published against the class, and no other class', async () => {
    const grant = await grantFor(`live-class:${liveClass.open}`);
    const from = await currentHead(db);

    await publish(db, {
      eventType: 'LIVE_STARTED',
      entityType: LIVE_CLASS_ENTITY_TYPE,
      entityId: liveClass.open,
      payload: { channel: 'MMAKF', title: 'Fixture open', startedAt: '2026-08-12T10:00:00.000Z' },
    });
    await publish(db, {
      eventType: 'LIVE_STARTED',
      entityType: LIVE_CLASS_ENTITY_TYPE,
      entityId: liveClass.membersOnly,
      payload: { channel: 'MMAKF', title: 'Fixture members', startedAt: '2026-08-12T10:00:00.000Z' },
    });

    const poll = await pollChannel(db, grant, from);
    const frames = parseFrames(poll.frames.join(''));
    expect(frames).toHaveLength(1);
    expect(frames[0].data.payload.title).toBe('Fixture open');
  });
});

// ─── A sanity check on the fixture database ─────────────────────────────────

describe('the feed itself', () => {
  it('is the only place these tests read from', async () => {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(s.domainEvents);
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
