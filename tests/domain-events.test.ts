// The domain event spine, against real Postgres.
//
// The invariants these tests exist to protect:
//   · the feed is APPEND-ONLY — a republished fact never rewrites the first one;
//   · CLASSIFICATION IS ENFORCED ON READ — a restricted event is invisible to a
//     member and to a public reader, and the public projection carries none of
//     the private fields;
//   · a consumer's cursor advances only over events it actually handled, a
//     failing consumer stops at the failure, and it cannot stall another
//     consumer;
//   · order is the feed's order, always.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { allocateFederationId } from '../src/db/federation';
import {
  publish, readFeed, publicFeed, toPublicProjection, projectPayload, clearanceFor,
  consume, cursorFor, resetCursor, cursorReport,
  catalogueDefects, isDomainEventType, EVENT_TYPES, CLASSIFICATIONS,
  DomainEventError, type DomainEventRow,
} from '../src/lib/domain-events';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any;

const superAdmin: Principal = {
  userId: 1, label: 'super-admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const national: Principal = {
  userId: 2, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 3, label: 'finance-officer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const stateAdmin: Principal = {
  userId: 4, label: 'state-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 1 }],
};
const member: Principal = {
  userId: 5, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 6, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/**
 * Holds `audit:read`, but bound to ONE DOJO. The feed has no dojo column, so
 * there is no such thing as this principal's share of it — every operation on
 * the feed is national, and a gate that only asks "do you hold this action
 * anywhere?" hands a dojo the whole federation.
 */
const dojoAudit: Principal = {
  userId: 8, label: 'dojo-technical-director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'dojo', scopeId: 3 }],
};

const lapsed: Principal = {
  userId: 7, label: 'lapsed-admin',
  bindings: [{
    role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null,
    expiresAt: new Date('2020-01-01T00:00:00Z'),
  }],
};

/** A fixture reason, so `resetCursor` is not called without one. */
const fixture = { principal: national, reason: 'test fixture' };

/** The current head of the feed — every test measures from its own start. */
async function head(): Promise<number> {
  const rows = await db
    .select({ head: sql<number>`coalesce(max(${s.domainEvents.id}), 0)::int` })
    .from(s.domainEvents);
  return Number(rows[0]?.head ?? 0);
}

/** Every row currently on the feed for one entity, in feed order. */
async function rowsFor(entityId: string): Promise<any[]> {
  return db.select().from(s.domainEvents)
    .where(eq(s.domainEvents.entityId, entityId))
    .orderBy(asc(s.domainEvents.id));
}

let seq = 0;
/** A fresh entity id per case, so accumulated feed rows never cross tests. */
const uid = (tag: string) => `${tag}-${++seq}`;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
});

// ─── The catalogue ──────────────────────────────────────────────────────────

describe('event catalogue', () => {
  it('is internally consistent', () => {
    expect(catalogueDefects()).toEqual([]);
  });

  it('carries the event names the federation queue depends on', () => {
    for (const name of [
      'RESULT_FINALIZED', 'CERTIFICATE_ISSUED', 'RANKING_UPDATED', 'LIVE_STARTED',
      'MEMBERSHIP_CREATED', 'GRADING_APPROVED', 'ENTRY_CREATED', 'DRAW_PUBLISHED',
      'MATCH_COMPLETED',
    ]) {
      expect(isDomainEventType(name), name).toBe(true);
    }
  });

  it('rejects a name that is not in the catalogue', () => {
    expect(isDomainEventType('RESULT_FINALISED')).toBe(false);   // British spelling: a real typo
    expect(isDomainEventType('toString')).toBe(false);           // prototype keys are not event types
  });

  it('gives safeguarding, medical and money no public form at all', () => {
    for (const name of [
      'SAFEGUARDING_CASE_OPENED', 'SAFEGUARDING_CASE_UPDATED', 'MEDICAL_RECORD_UPDATED',
      'DISCIPLINARY_CASE_OPENED', 'ORDER_PAID', 'REFUND_ISSUED',
    ] as const) {
      expect(EVENT_TYPES[name].publicFields, name).toEqual([]);
    }
  });

  it('classifies no event type as raw-public', () => {
    // Deliberate. The raw feed carries whole payloads, and a producer may
    // legitimately attach private context to an otherwise public fact — an
    // injury note on a completed match. The public surface is the PROJECTION,
    // which names its fields in advance; the raw row stays internal.
    const rawPublic = Object.entries(EVENT_TYPES)
      // Cast: the catalogue is `as const`, so TypeScript already proves no floor is
      // 'public' and would reject the comparison. The runtime check stays, because it
      // is the one that still fires the day someone adds an entry.
      .filter(([, spec]) => (spec.floor as string) === 'public')
      .map(([name]) => name);
    expect(rawPublic).toEqual([]);
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe('publish', () => {
  it('appends an event at the catalogue floor when no classification is given', async () => {
    const { event, duplicate } = await publish(db, {
      eventType: 'MATCH_COMPLETED',
      entityType: 'match',
      entityId: uid('match'),
      payload: { matchId: 11, winnerEntryId: 4 },
      actor: national,
    });

    expect(duplicate).toBe(false);
    expect(event.id).toBeGreaterThan(0);
    expect(event.classification).toBe(EVENT_TYPES.MATCH_COMPLETED.floor);
    expect(event.actorUserId).toBe(2);
    expect(event.actorLabel).toBe('federation-admin');
    expect(event.publishedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish an event below its floor', async () => {
    await expect(publish(db, {
      eventType: 'SAFEGUARDING_CASE_OPENED',
      entityType: 'safeguarding_case',
      entityId: uid('case'),
      payload: { caseRef: 'SG-1' },
      classification: 'public',
    })).rejects.toMatchObject({ code: 'classification_too_low' });

    await expect(publish(db, {
      eventType: 'ORDER_PAID',
      entityType: 'order',
      entityId: uid('order'),
      payload: { amountPaise: 50000 },
      classification: 'member',
    })).rejects.toMatchObject({ code: 'classification_too_low' });
  });

  it('allows a producer to be MORE restrictive than the floor', async () => {
    const { event } = await publish(db, {
      eventType: 'MATCH_COMPLETED',
      entityType: 'match',
      entityId: uid('match'),
      payload: { matchId: 12 },
      classification: 'confidential',
    });
    expect(event.classification).toBe('confidential');
  });

  it('refuses an event type that is not in the catalogue', async () => {
    await expect(publish(db, {
      // Cast: at a real call site this is a compile error. The runtime guard is
      // here for data arriving from outside TypeScript.
      eventType: 'SOMETHING_INVENTED' as any,
      entityType: 'thing',
      entityId: uid('thing'),
      payload: {},
    })).rejects.toMatchObject({ code: 'unknown_event_type' });
  });

  it('refuses an event with no entity, or a payload that is not an object', async () => {
    await expect(publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: '  ', payload: {},
    })).rejects.toMatchObject({ code: 'bad_entity' });

    await expect(publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: uid('b'),
      payload: [1, 2, 3] as any,
    })).rejects.toMatchObject({ code: 'bad_payload' });
  });

  it('records when the fact happened separately from when it was appended', async () => {
    const happened = new Date('2026-08-01T14:03:00Z');
    const { event } = await publish(db, {
      eventType: 'RESULT_FINALIZED',
      entityType: 'competition_result',
      entityId: uid('res'),
      payload: { competitionId: 1 },
      occurredAt: happened,
    });
    expect(event.occurredAt.toISOString()).toBe(happened.toISOString());
    expect(event.publishedAt!.getTime()).toBeGreaterThan(happened.getTime());
  });
});

// ─── Idempotency and append-only ────────────────────────────────────────────

describe('idempotency and append-only', () => {
  it('detects the same logical event published twice', async () => {
    const id = uid('cert');
    const first = await publish(db, {
      eventType: 'CERTIFICATE_ISSUED',
      entityType: 'certificate',
      entityId: id,
      payload: { certificateNo: 'MMAKF-CERT-2026-000001' },
      correlationId: 'cert:1',
    });
    const second = await publish(db, {
      eventType: 'CERTIFICATE_ISSUED',
      entityType: 'certificate',
      entityId: id,
      payload: { certificateNo: 'MMAKF-CERT-2026-000001' },
      correlationId: 'cert:1',
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(await rowsFor(id)).toHaveLength(1);
  });

  it('refuses a republish that has drifted, rather than calling it a duplicate', async () => {
    const id = uid('cert');
    const first = await publish(db, {
      eventType: 'CERTIFICATE_ISSUED',
      entityType: 'certificate',
      entityId: id,
      payload: { certificateNo: 'A', grade: 'Shodan' },
      correlationId: 'cert:2',
      actor: national,
    });

    // Append-only means the ORIGINAL stands — a consumer that already acted must
    // still be able to see what it acted on. But the producer must be TOLD. If
    // this returned `duplicate: true`, the caller would walk away believing the
    // feed now says Nidan; it says Shodan, and nothing would ever say otherwise.
    await expect(publish(db, {
      eventType: 'CERTIFICATE_ISSUED',
      entityType: 'certificate',
      entityId: id,
      payload: { certificateNo: 'A', grade: 'Nidan — WRONG' },
      correlationId: 'cert:2',
      actor: superAdmin,
    })).rejects.toMatchObject({ code: 'correlation_conflict' });

    // The refusal has to name the event that stands, or the producer cannot act
    // on it: it must publish a CORRECTIVE event referring to that one.
    await expect(publish(db, {
      eventType: 'CERTIFICATE_ISSUED', entityType: 'certificate', entityId: id,
      payload: { certificateNo: 'A', grade: 'Nidan — WRONG' }, correlationId: 'cert:2',
    })).rejects.toThrow(new RegExp(`event ${first.event.id}\\b`));

    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.event.id);
    expect(rows[0].payload).toEqual({ certificateNo: 'A', grade: 'Shodan' });
    expect(rows[0].actorLabel).toBe('federation-admin');
  });

  it('refuses a republish that quietly relaxes the classification', async () => {
    const id = uid('match');
    await publish(db, {
      eventType: 'MATCH_COMPLETED', entityType: 'match', entityId: id,
      payload: { matchId: 77 }, classification: 'confidential', correlationId: 'match:77',
    });

    // Same payload, published again at the catalogue floor. The stored row
    // cannot be edited down, so answering "duplicate" would leave the feed
    // carrying 'confidential' while the producer believes it is 'member' — or,
    // read the other way, would let the second call silently fail to tighten a
    // row it has decided is under-protected.
    await expect(publish(db, {
      eventType: 'MATCH_COMPLETED', entityType: 'match', entityId: id,
      payload: { matchId: 77 }, correlationId: 'match:77',
    })).rejects.toMatchObject({ code: 'correlation_conflict' });

    expect(await rowsFor(id)).toHaveLength(1);
    expect((await rowsFor(id))[0].classification).toBe('confidential');
  });

  it('does not mistake key order or a round-tripped date for a drifted payload', async () => {
    const id = uid('rank');
    const at = new Date('2026-05-01T09:30:00.000Z');
    const a = await publish(db, {
      eventType: 'RANKING_UPDATED', entityType: 'ranking_period', entityId: id,
      payload: { rankingPeriodId: 3, publishedAt: at, rulesetId: 2 },
      correlationId: 'ranking:3',
    });
    // The same fact, assembled in a different order by a different code path.
    // A retry that has NOT drifted must not be turned into an incident.
    const b = await publish(db, {
      eventType: 'RANKING_UPDATED', entityType: 'ranking_period', entityId: id,
      payload: { rulesetId: 2, publishedAt: at, rankingPeriodId: 3 },
      correlationId: 'ranking:3',
    });
    expect(b.duplicate).toBe(true);
    expect(b.event.id).toBe(a.event.id);
    expect(await rowsFor(id)).toHaveLength(1);
  });

  it('treats the same correlationId on a different entity as a different event', async () => {
    const a = uid('cert'), b = uid('cert');
    const first = await publish(db, {
      eventType: 'CERTIFICATE_ISSUED', entityType: 'certificate', entityId: a,
      payload: {}, correlationId: 'shared-key',
    });
    const other = await publish(db, {
      eventType: 'CERTIFICATE_ISSUED', entityType: 'certificate', entityId: b,
      payload: {}, correlationId: 'shared-key',
    });
    expect(other.duplicate).toBe(false);
    expect(other.event.id).not.toBe(first.event.id);
  });

  it('publishes twice when no correlationId is offered — the producer opted out', async () => {
    const id = uid('live');
    await publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: id, payload: { channel: 'a' },
    });
    await publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: id, payload: { channel: 'a' },
    });
    // Not a bug: without a key there is nothing to deduplicate ON, and silently
    // collapsing two appends would lose a real repeat.
    expect(await rowsFor(id)).toHaveLength(2);
  });

  it('exposes no update or delete path for an event', async () => {
    const mod = await import('../src/lib/domain-events');
    const mutators = Object.keys(mod).filter((k) => /^(update|edit|delete|remove|amend)/i.test(k));
    expect(mutators).toEqual([]);
  });
});

// ─── Clearance ──────────────────────────────────────────────────────────────

describe('clearanceFor', () => {
  it('places each kind of principal on the ladder, denying by default', () => {
    expect(clearanceFor(null)).toBe('public');
    expect(clearanceFor(undefined)).toBe('public');
    expect(clearanceFor({ userId: 9, label: 'nobody', bindings: [] })).toBe('public');
    expect(clearanceFor(member)).toBe('member');
    expect(clearanceFor(athlete)).toBe('member');
    expect(clearanceFor(national)).toBe('restricted');
    expect(clearanceFor(finance)).toBe('restricted');
    expect(clearanceFor(superAdmin)).toBe('highly_restricted');
  });

  it('withholds a national officer\'s clearance from a scoped administrator', () => {
    // The feed has no state/district/dojo columns, so a state admin cannot be
    // scope-filtered on it. They get 'official' and no more.
    expect(clearanceFor(stateAdmin)).toBe('official');
  });

  it('gives an expired binding nothing', () => {
    expect(clearanceFor(lapsed)).toBe('public');
  });
});

// ─── Reading and classification enforcement ─────────────────────────────────

describe('readFeed', () => {
  let base = 0;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    base = await head();
    const draw = await publish(db, {
      eventType: 'DRAW_PUBLISHED', entityType: 'draw', entityId: uid('draw'),
      payload: { drawId: 1, randomSeed: 'seed-abc' },
    });
    const result = await publish(db, {
      eventType: 'RESULT_FINALIZED', entityType: 'competition_result', entityId: uid('res'),
      payload: { competitionId: 7, placings: [1, 2, 3] },
    });
    const protest = await publish(db, {
      eventType: 'PROTEST_LODGED', entityType: 'protest', entityId: uid('protest'),
      payload: { matchId: 3 },
    });
    const order = await publish(db, {
      eventType: 'ORDER_PAID', entityType: 'order', entityId: uid('order'),
      payload: { amountPaise: 250000, payerName: 'A Member' },
    });
    const disciplinary = await publish(db, {
      eventType: 'DISCIPLINARY_CASE_OPENED', entityType: 'disciplinary_case', entityId: uid('disc'),
      payload: { caseRef: 'D-1' },
    });
    const safeguarding = await publish(db, {
      eventType: 'SAFEGUARDING_CASE_OPENED', entityType: 'safeguarding_case', entityId: uid('sg'),
      payload: { caseRef: 'SG-1', childName: 'REDACT ME' },
    });
    Object.assign(ids, {
      draw: draw.event.id, result: result.event.id, protest: protest.event.id,
      order: order.event.id, disciplinary: disciplinary.event.id,
      safeguarding: safeguarding.event.id,
    });
  });

  const typesFor = (r: { events: DomainEventRow[] }) => r.events.map((e) => e.eventType);

  it('serves an anonymous caller no raw events at all', async () => {
    const r = await readFeed(db, null, { sinceId: base });
    expect(r.clearance).toBe('public');
    expect(r.events).toEqual([]);
  });

  it('keeps a restricted event invisible to a member and to a public reader', async () => {
    const asMember = await readFeed(db, { principal: member }, { sinceId: base });
    const memberIds = asMember.events.map((e) => e.id);
    expect(memberIds).not.toContain(ids.disciplinary);
    expect(memberIds).not.toContain(ids.safeguarding);
    expect(memberIds).not.toContain(ids.order);
    expect(JSON.stringify(asMember.events)).not.toContain('REDACT ME');

    const asPublic = await publicFeed(db, { sinceId: base });
    expect(JSON.stringify(asPublic)).not.toContain('REDACT ME');
    expect(asPublic.map((e) => e.eventType)).toEqual(['DRAW_PUBLISHED', 'RESULT_FINALIZED']);
  });

  it('gives a member the member level only', async () => {
    const r = await readFeed(db, { principal: member }, { sinceId: base });
    expect(r.clearance).toBe('member');
    expect(typesFor(r)).toEqual(['DRAW_PUBLISHED', 'RESULT_FINALIZED']);
  });

  it('gives a scoped administrator up to official, and no further', async () => {
    const r = await readFeed(db, { principal: stateAdmin }, { sinceId: base });
    expect(r.clearance).toBe('official');
    expect(typesFor(r)).toEqual(['DRAW_PUBLISHED', 'RESULT_FINALIZED', 'PROTEST_LODGED']);
  });

  it('gives a national administrator everything except safeguarding', async () => {
    const r = await readFeed(db, { principal: national }, { sinceId: base });
    expect(r.clearance).toBe('restricted');
    const seen = r.events.map((e) => e.id);
    expect(seen).toContain(ids.order);
    expect(seen).toContain(ids.disciplinary);
    expect(seen).not.toContain(ids.safeguarding);
  });

  it('gives the safeguarding role the whole feed', async () => {
    const r = await readFeed(db, { principal: superAdmin }, { sinceId: base });
    expect(r.clearance).toBe('highly_restricted');
    expect(r.events.map((e) => e.id)).toContain(ids.safeguarding);
  });

  it('lets a caller cap itself, and never raise itself', async () => {
    const capped = await readFeed(db, { principal: superAdmin }, { sinceId: base, upTo: 'member' });
    expect(capped.clearance).toBe('member');
    expect(typesFor(capped)).toEqual(['DRAW_PUBLISHED', 'RESULT_FINALIZED']);

    // A member asking for 'highly_restricted' is clamped to what they hold.
    const overreach = await readFeed(db, { principal: member }, {
      sinceId: base, upTo: 'highly_restricted',
    });
    expect(overreach.clearance).toBe('member');
    expect(typesFor(overreach)).toEqual(['DRAW_PUBLISHED', 'RESULT_FINALIZED']);
  });

  it('preserves feed order and pages by id', async () => {
    const all = await readFeed(db, { principal: superAdmin }, { sinceId: base });
    const seen = all.events.map((e) => e.id);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen).toEqual([
      ids.draw, ids.result, ids.protest, ids.order, ids.disciplinary, ids.safeguarding,
    ]);

    const firstTwo = await readFeed(db, { principal: superAdmin }, { sinceId: base, limit: 2 });
    expect(firstTwo.events.map((e) => e.id)).toEqual([ids.draw, ids.result]);

    const next = await readFeed(db, { principal: superAdmin }, { sinceId: ids.result, limit: 2 });
    expect(next.events.map((e) => e.id)).toEqual([ids.protest, ids.order]);
  });

  it('filters by event type without widening classification', async () => {
    const byType = await readFeed(db, { principal: member }, {
      sinceId: base, eventTypes: ['RESULT_FINALIZED', 'SAFEGUARDING_CASE_OPENED'],
    });
    // The safeguarding row was asked for by name and is still refused.
    expect(typesFor(byType)).toEqual(['RESULT_FINALIZED']);
  });

  it('takes the default limit when the bound is not a number, rather than dropping it', async () => {
    // THE ATTACK. `Number(searchParams.get('limit'))` on absent or junk input is
    // NaN, and NaN passes through Math.max/Math.min untouched: the clamp that
    // looks like it bounds the query does nothing at all. Proven by putting more
    // rows on the feed than the default page holds, so an unbounded read is
    // visible as a row count rather than merely "not an error".
    const base = await head();
    const rows = Array.from({ length: 105 }, (_, n) => ({
      eventType: 'LESSON_COMPLETED', entityType: 'lesson', entityId: uid('lesson'),
      payload: { n }, classification: 'member' as const,
      occurredAt: new Date(), publishedAt: new Date(),
    }));
    await db.insert(s.domainEvents).values(rows);

    const junk = await readFeed(db, { principal: national }, { sinceId: base, limit: Number('abc') });
    expect(junk.events).toHaveLength(100);                      // the default, not all 105
    const infinite = await readFeed(db, { principal: national }, {
      sinceId: base, limit: Number.POSITIVE_INFINITY,
    });
    expect(infinite.events).toHaveLength(100);

    // A bound below one is still a bound, and one above the ceiling is capped.
    for (const limit of [-5, 0]) {
      const r = await readFeed(db, { principal: national }, { sinceId: base, limit });
      expect(r.events, String(limit)).toHaveLength(1);
    }
    const huge = await readFeed(db, { principal: national }, { sinceId: base, limit: 1e9 });
    expect(huge.events).toHaveLength(105);                      // clamped to MAX_LIMIT, not refused

    // A junk batchSize must bound a consumer the same way.
    const consumer = 'test.junk-batch';
    await resetCursor(db, fixture, consumer, base);
    const seen: number[] = [];
    const run = await consume(db, consumer, (e) => { seen.push(e.id); }, {
      batchSize: Number('not a number'),
    });
    expect(run.delivered).toBe(100);
    expect(seen).toHaveLength(100);
    expect(run.more).toBe(true);
  });

  it('filters by entity', async () => {
    const r = await readFeed(db, { principal: superAdmin }, {
      sinceId: base, entityType: 'protest',
    });
    expect(r.events.map((e) => e.id)).toEqual([ids.protest]);
  });
});

// ─── Public projection ──────────────────────────────────────────────────────

describe('public projection', () => {
  it('carries only the allowlisted fields, and no actor or correlation key', async () => {
    const { event } = await publish(db, {
      eventType: 'MATCH_COMPLETED',
      entityType: 'match',
      entityId: uid('match'),
      payload: {
        matchId: 42, competitionId: 7, categoryId: 3, round: 'final',
        winnerEntryId: 9, scoreAka: 5, scoreAo: 3,
        // Private context a producer might reasonably attach for internal use.
        medicalNote: 'competitor withdrew, suspected concussion',
        judgeComments: 'disagreement on the second ippon',
        athleteDob: '2011-04-02',
      },
      actor: national,
      correlationId: 'match:42:complete',
    });

    const projection = toPublicProjection(event)!;
    expect(projection).not.toBeNull();
    expect(Object.keys(projection.payload).sort()).toEqual(
      ['categoryId', 'competitionId', 'matchId', 'round', 'scoreAka', 'scoreAo', 'winnerEntryId']
    );

    const serialised = JSON.stringify(projection);
    for (const secret of [
      'medicalNote', 'concussion', 'judgeComments', 'athleteDob', '2011-04-02',
      'federation-admin', 'match:42:complete', 'classification', 'actorUserId',
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });

  it('withholds a structure whose public shape the federation has not declared', async () => {
    // THE ATTACK. `placings` is on the allowlist, so a one-level allowlist
    // publishes whatever the producer put inside it — and the thing inside a
    // placing is a competitor. This is the payload the medal-ceremony screen
    // will want, written by someone who never looked at publicFields.
    const { event } = await publish(db, {
      eventType: 'RESULT_FINALIZED',
      entityType: 'competition_result',
      entityId: uid('res'),
      payload: {
        competitionId: 31, categoryId: 8, finalizedAt: '2026-03-01T10:00:00.000Z',
        placings: [
          { place: 1, entryId: 11, personId: 501, fullName: 'A Competitor',
            dateOfBirth: '2011-04-02', guardianPhone: '+91 99999 00000' },
          { place: 2, entryId: 12, personId: 502, fullName: 'B Competitor',
            dateOfBirth: '2010-08-19', guardianPhone: '+91 99999 00001' },
        ],
      },
    });

    const projection = toPublicProjection(event)!;
    const serialised = JSON.stringify(projection);
    for (const secret of [
      'dateOfBirth', '2011-04-02', '2010-08-19', 'guardianPhone', '99999 00000',
      'personId', 'fullName', 'A Competitor', 'B Competitor', 'entryId',
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
    expect(projection.payload).toEqual({
      competitionId: 31, categoryId: 8, finalizedAt: '2026-03-01T10:00:00.000Z',
    });
    // And the omission is STATED. A public surface must be able to render
    // "not published by the federation" rather than imply the result was empty.
    expect(projection.withheld).toEqual(['placings']);
  });

  it('carries the same withholding through the public feed, not only the projector', async () => {
    const base = await head();
    await publish(db, {
      eventType: 'RESULT_CORRECTED',
      entityType: 'competition_result',
      entityId: uid('res'),
      payload: {
        competitionId: 32, categoryId: 9, supersedesResultId: 4,
        correctedAt: '2026-03-02T10:00:00.000Z',
        placings: [{ place: 1, personId: 777, medicalNote: 'withdrew, concussion' }],
      },
    });

    const feed = await publicFeed(db, { sinceId: base });
    const serialised = JSON.stringify(feed);
    for (const secret of ['medicalNote', 'concussion', 'personId', '777']) {
      expect(serialised, secret).not.toContain(secret);
    }
    expect(feed[0].withheld).toEqual(['placings']);
    expect(feed[0].payload).not.toHaveProperty('placings');
  });

  it('withholds a declared scalar field that arrives as a structure', async () => {
    // `round` is allowlisted because a round is 'final' or 'repechage'. A
    // producer that enriches it into an object has not consulted the allowlist,
    // and the allowlist must not assume the enrichment is harmless.
    const { event } = await publish(db, {
      eventType: 'MATCH_COMPLETED',
      entityType: 'match',
      entityId: uid('match'),
      payload: {
        matchId: 91, round: { label: 'final', injuryNote: 'suspected concussion' },
        scoreAka: 4, scoreAo: 1,
      },
    });
    const projection = toPublicProjection(event)!;
    expect(JSON.stringify(projection)).not.toContain('concussion');
    expect(projection.payload).toEqual({ matchId: 91, scoreAka: 4, scoreAo: 1 });
    expect(projection.withheld).toEqual(['round']);
  });

  it('publishes inside a structure only along the paths the federation declared', () => {
    // The mechanism MMAKF uses when it decides what a placing publishes. Until
    // it does, nothing about a placing is public — which is the case above.
    const placings = [
      { place: 1, entryId: 11, personId: 501, dateOfBirth: '2011-04-02' },
      { place: 2, entryId: 12, personId: 502, dateOfBirth: '2010-08-19' },
    ];

    const declared = projectPayload({ competitionId: 1, placings }, [
      'competitionId', 'placings.place', 'placings.entryId',
    ]);
    expect(declared.withheld).toEqual([]);
    expect(declared.payload).toEqual({
      competitionId: 1,
      placings: [{ place: 1, entryId: 11 }, { place: 2, entryId: 12 }],
    });
    expect(JSON.stringify(declared)).not.toContain('dateOfBirth');
    expect(JSON.stringify(declared)).not.toContain('personId');
  });

  it('withholds a whole list when one element does not match the declared shape', () => {
    // A partial placings list is worse than none: it looks complete, and the
    // competitor missing from it is the one with a complaint.
    const out = projectPayload({
      placings: [
        { place: 1, entryId: 11 },
        { place: 2, entryId: { id: 12, holderPhone: '+91 99999 00002' } },
      ],
    }, ['placings.place', 'placings.entryId']);

    expect(out.withheld).toEqual(['placings']);
    expect(out.payload).toEqual({});
    expect(JSON.stringify(out)).not.toContain('holderPhone');
  });

  it('withholds a declared path when the value is not the shape it was declared as', () => {
    // Paths were declared INTO this value and it arrived as a scalar, or a null,
    // or an array of scalars. Producer and catalogue disagree, and publishing on
    // a disagreement is how the wrong field reaches the public.
    for (const placings of [null, 'first: A Competitor', 42, [1, 2, 3]]) {
      const out = projectPayload({ placings }, ['placings.place']);
      expect(out.payload, JSON.stringify(placings)).toEqual({});
      expect(out.withheld, JSON.stringify(placings)).toEqual(['placings']);
    }
  });

  it('lets a scalar list through, and a nested-object list never', () => {
    expect(projectPayload({ placings: [9, 8, 7] }, ['placings']))
      .toEqual({ payload: { placings: [9, 8, 7] }, withheld: [] });
    expect(projectPayload({ placings: [{ entryId: 9 }] }, ['placings']))
      .toEqual({ payload: {}, withheld: ['placings'] });
  });

  it('publishes the fact of a revocation and not the reason for it', async () => {
    // Whether MMAKF names WHY a credential was withdrawn is the federation's
    // editorial decision, and a revocation reason is free text an official
    // typed — it can name a disciplinary matter, a third party or a minor, and
    // no allowlist can bound what is inside it. The FACT is what protects the
    // person checking the credential, so the fact is what travels.
    const { event } = await publish(db, {
      eventType: 'CERTIFICATE_REVOKED',
      entityType: 'certificate',
      entityId: uid('cert'),
      payload: {
        certificateNo: 'MMAKF-CERT-2026-000009',
        revokedOn: '2026-04-01',
        revokedReason: 'issued in error following a safeguarding referral concerning the examiner',
      },
    });
    const projection = toPublicProjection(event)!;
    expect(projection.payload).toEqual({
      certificateNo: 'MMAKF-CERT-2026-000009', revokedOn: '2026-04-01',
    });
    expect(JSON.stringify(projection)).not.toContain('safeguarding');
    expect(EVENT_TYPES.CERTIFICATE_REVOKED.publicFields).not.toContain('revokedReason');
  });

  it('gives an event with no public form no projection at all', async () => {
    const { event } = await publish(db, {
      eventType: 'SAFEGUARDING_CASE_OPENED',
      entityType: 'safeguarding_case',
      entityId: uid('sg'),
      payload: { caseRef: 'SG-2', childName: 'A Child' },
    });
    expect(toPublicProjection(event)).toBeNull();
  });

  it('refuses a projection when the event itself was classified above the public ceiling', async () => {
    // MATCH_COMPLETED normally has a public form. This one was published as
    // confidential, and the event's own classification wins over the catalogue.
    const { event } = await publish(db, {
      eventType: 'MATCH_COMPLETED',
      entityType: 'match',
      entityId: uid('match'),
      payload: { matchId: 43, winnerEntryId: 1 },
      classification: 'confidential',
    });
    expect(toPublicProjection(event)).toBeNull();
  });

  it('gives an unrecognised event type no projection', () => {
    expect(toPublicProjection({
      id: 1, eventType: 'NOT_A_REAL_TYPE', entityType: 'x', entityId: '1',
      payload: { anything: 'at all' }, classification: 'public',
      actorUserId: null, actorLabel: null, correlationId: null,
      occurredAt: new Date(), publishedAt: new Date(),
    })).toBeNull();
  });

  it('feeds a public scoreboard from the same events as the internal feed', async () => {
    const base = await head();
    const { event } = await publish(db, {
      eventType: 'RESULT_FINALIZED', entityType: 'competition_result', entityId: uid('res'),
      payload: { competitionId: 21, categoryId: 4, placings: [9, 8, 7], enteredByUserId: 44 },
    });
    await publish(db, {
      eventType: 'ORDER_PAID', entityType: 'order', entityId: uid('order'),
      payload: { amountPaise: 100 },
    });

    // ONE publish, two audiences.
    const internal = await readFeed(db, { principal: national }, { sinceId: base });
    expect(internal.events.map((e) => e.id)).toContain(event.id);
    expect(internal.events.find((e) => e.id === event.id)!.payload).toHaveProperty('enteredByUserId');

    const feed = await publicFeed(db, { sinceId: base });
    expect(feed.map((e) => e.eventType)).toEqual(['RESULT_FINALIZED']);
    expect(feed[0].payload).toEqual({ competitionId: 21, categoryId: 4, placings: [9, 8, 7] });
    expect(feed[0].payload).not.toHaveProperty('enteredByUserId');
  });
});

// ─── Consumers ──────────────────────────────────────────────────────────────

describe('consume', () => {
  it('starts at zero, processes in order and advances its own cursor', async () => {
    const base = await head();
    const consumer = 'test.ordered';
    await resetCursor(db, fixture, consumer, base);

    const made: number[] = [];
    for (const n of [1, 2, 3]) {
      const { event } = await publish(db, {
        eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: uid('live'),
        payload: { channel: 'main', title: `Session ${n}` },
      });
      made.push(event.id);
    }

    const seen: number[] = [];
    const r = await consume(db, consumer, (e) => { seen.push(e.id); });

    expect(seen).toEqual(made);                       // order preserved
    expect(r.from).toBe(base);
    expect(r.to).toBe(made[2]);
    expect(r.delivered).toBe(3);
    expect(r.failedAtEventId).toBeNull();
    expect(await cursorFor(db, consumer)).toBe(made[2]);
  });

  it('is safe to re-run: a second pass delivers nothing already handled', async () => {
    const consumer = 'test.rerun';
    await resetCursor(db, fixture, consumer, await head());

    await publish(db, {
      eventType: 'RANKING_UPDATED', entityType: 'ranking_period', entityId: uid('rank'),
      payload: { rankingPeriodId: 1 },
    });

    const first = await consume(db, consumer, () => {});
    expect(first.delivered).toBe(1);

    const again = await consume(db, consumer, () => {
      throw new Error('a re-run must not deliver anything already handled');
    });
    expect(again.delivered).toBe(0);
    expect(again.from).toBe(again.to);
    expect(again.failedAtEventId).toBeNull();
  });

  it('honours batchSize and reports that more is waiting', async () => {
    const consumer = 'test.batched';
    await resetCursor(db, fixture, consumer, await head());

    for (let n = 0; n < 5; n++) {
      await publish(db, {
        eventType: 'ENTRY_CREATED', entityType: 'event_entry', entityId: uid('entry'),
        payload: { n },
      });
    }

    const r1 = await consume(db, consumer, () => {}, { batchSize: 2 });
    expect(r1.delivered).toBe(2);
    expect(r1.more).toBe(true);

    const r2 = await consume(db, consumer, () => {}, { batchSize: 10 });
    expect(r2.delivered).toBe(3);
    expect(r2.more).toBe(false);
  });

  it('does not advance past a failing event, and resumes from it once fixed', async () => {
    const base = await head();
    const consumer = 'test.failing';
    await resetCursor(db, fixture, consumer, base);

    const made: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      const { event } = await publish(db, {
        eventType: 'MATCH_COMPLETED', entityType: 'match', entityId: uid('match'),
        payload: { matchId: n },
      });
      made.push(event.id);
    }

    const poison = made[1];
    let broken = true;
    const seen: number[] = [];
    const handler = (e: DomainEventRow) => {
      if (broken && e.id === poison) throw new Error('handler exploded');
      seen.push(e.id);
    };

    const failed = await consume(db, consumer, handler);
    expect(failed.delivered).toBe(1);
    expect(failed.failedAtEventId).toBe(poison);
    expect(failed.failureMessage).toBe('handler exploded');
    expect(failed.more).toBe(true);
    // The cursor sits on the last SUCCESS, not on the failure.
    expect(await cursorFor(db, consumer)).toBe(made[0]);

    // Re-running while still broken re-delivers the failing event and no more.
    const stillFailing = await consume(db, consumer, handler);
    expect(stillFailing.delivered).toBe(0);
    expect(stillFailing.failedAtEventId).toBe(poison);
    expect(await cursorFor(db, consumer)).toBe(made[0]);

    broken = false;
    const recovered = await consume(db, consumer, handler);
    expect(recovered.delivered).toBe(3);
    expect(seen).toEqual(made);                       // nothing was skipped
    expect(await cursorFor(db, consumer)).toBe(made[3]);
  });

  it('a broken consumer does not block another consumer', async () => {
    const base = await head();
    await resetCursor(db, fixture, 'test.broken', base);
    await resetCursor(db, fixture, 'test.healthy', base);

    const made: number[] = [];
    for (const n of [1, 2, 3]) {
      const { event } = await publish(db, {
        eventType: 'CERTIFICATE_ISSUED', entityType: 'certificate', entityId: uid('cert'),
        payload: { certificateNo: `C-${n}` },
      });
      made.push(event.id);
    }

    const broken = await consume(db, 'test.broken', () => { throw new Error('down'); });
    expect(broken.delivered).toBe(0);
    expect(await cursorFor(db, 'test.broken')).toBe(base);

    const healthy: number[] = [];
    const ok = await consume(db, 'test.healthy', (e) => { healthy.push(e.id); });
    expect(ok.delivered).toBe(3);
    expect(healthy).toEqual(made);
    expect(await cursorFor(db, 'test.healthy')).toBe(made[2]);
    // And the broken one is still exactly where it was.
    expect(await cursorFor(db, 'test.broken')).toBe(base);
  });

  it('awaits an asynchronous handler and catches its rejection', async () => {
    const base = await head();
    const consumer = 'test.async';
    await resetCursor(db, fixture, consumer, base);

    const first = await publish(db, {
      eventType: 'LESSON_COMPLETED', entityType: 'lesson_progress', entityId: uid('lp'),
      payload: { n: 1 },
    });
    await publish(db, {
      eventType: 'LESSON_COMPLETED', entityType: 'lesson_progress', entityId: uid('lp'),
      payload: { n: 2 },
    });

    const r = await consume(db, consumer, async (e) => {
      await Promise.resolve();
      if (e.id !== first.event.id) throw new Error('async failure');
    });

    // A rejected promise must stop the batch exactly as a thrown error does —
    // not slip past because nobody awaited it.
    expect(r.delivered).toBe(1);
    expect(r.failureMessage).toBe('async failure');
    expect(await cursorFor(db, consumer)).toBe(first.event.id);
  });

  it('steps over events above a consumer\'s own classification cap', async () => {
    const base = await head();
    const consumer = 'test.capped';
    await resetCursor(db, fixture, consumer, base);

    const draw = await publish(db, {
      eventType: 'DRAW_PUBLISHED', entityType: 'draw', entityId: uid('draw'),
      payload: { drawId: 5 },
    });
    await publish(db, {
      eventType: 'SAFEGUARDING_CASE_OPENED', entityType: 'safeguarding_case', entityId: uid('sg'),
      payload: { caseRef: 'SG-3' },
    });
    const live = await publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: uid('live'),
      payload: { channel: 'main' },
    });

    const seen: string[] = [];
    const r = await consume(db, consumer, (e) => { seen.push(e.eventType); }, {
      maxClassification: 'member',
    });

    expect(seen).toEqual(['DRAW_PUBLISHED', 'LIVE_STARTED']);
    expect(r.delivered).toBe(2);
    expect(r.skipped).toBe(1);
    // A count is not an explanation. The cursor has moved past that event, so it
    // will never be offered to this consumer again; an operator asking why a
    // downstream surface is missing a fact has to be able to name which one.
    expect(r.skippedEventIds).toHaveLength(1);
    expect(r.skippedEventIds[0]).toBeGreaterThan(draw.event.id);
    expect(r.skippedEventIds[0]).toBeLessThan(live.event.id);
    const [skippedRow] = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.id, r.skippedEventIds[0]));
    expect(skippedRow.eventType).toBe('SAFEGUARDING_CASE_OPENED');
    // The cursor moves PAST the skipped event: this consumer will never be
    // entitled to it, so stopping there would wedge it for ever.
    expect(r.to).toBe(live.event.id);
    expect(draw.event.id).toBeLessThan(live.event.id);
  });

  it('re-delivers rather than rewinds when two runners of one consumer overlap', async () => {
    // Delivery is at-least-once, and this is the case that proves it: two
    // runners start from the same cursor, so the second re-delivers what the
    // first already handled. What must NOT happen is the slower runner writing
    // its lower position back and dragging the whole consumer backwards — that
    // turns an overlap into an unbounded re-delivery loop. advanceCursor() uses
    // greatest(), so the cursor can only ever move forward.
    const consumer = 'test.overlap';
    await resetCursor(db, fixture, consumer, await head());

    const made: number[] = [];
    for (let n = 0; n < 6; n++) {
      const { event } = await publish(db, {
        eventType: 'MATCH_COMPLETED', entityType: 'match', entityId: uid('match'),
        payload: { matchId: n, scoreAka: 3, scoreAo: 1 },
      });
      made.push(event.id);
    }
    const last = made[made.length - 1];

    const seen: number[] = [];
    // The short-batch runner is the one that would rewind the cursor: it stops
    // at event 2 while the other reaches event 6.
    const [full, short] = await Promise.all([
      consume(db, consumer, async (e) => { seen.push(e.id); }, { batchSize: 6 }),
      consume(db, consumer, async (e) => { seen.push(e.id); }, { batchSize: 2 }),
    ]);

    expect(full.to).toBe(last);
    expect(await cursorFor(db, consumer)).toBe(last);
    expect(short.to).toBeLessThanOrEqual(last);
    expect(seen.length).toBeGreaterThanOrEqual(full.delivered);

    // And the consumer is genuinely caught up afterwards: nothing is redelivered
    // on a clean re-run, which is what a rewind would have broken.
    const after = await consume(db, consumer, () => {
      throw new Error('the cursor was dragged backwards');
    });
    expect(after.delivered).toBe(0);
    expect(after.failedAtEventId).toBeNull();
  });

  it('cannot deliver an event that commits below a cursor it has already passed', async () => {
    // THE KNOWN GAP, made deterministic so it is a documented property rather
    // than a surprise. `domain_events.id` is a serial: the number is taken when
    // a publish BEGINS, not when it commits. A slow transaction holding id 41
    // can commit after a fast one holding 42; a consumer reading in between
    // advances to 42, and 41 then appears BELOW its cursor where `id > cursor`
    // will never select it again.
    //
    // Reproduced by taking a number from the sequence and inserting under it
    // late — which is exactly the state that race leaves behind.
    const consumer = 'test.commit-order';
    const base = await head();
    await resetCursor(db, fixture, consumer, base);

    const reserved = await db.execute(
      sql`select nextval(pg_get_serial_sequence('domain_events', 'id'))::int as id`
    );
    const slowId = Number((reserved.rows ?? reserved)[0].id);

    const fast = await publish(db, {
      eventType: 'LESSON_COMPLETED', entityType: 'lesson', entityId: uid('lesson'),
      payload: { publisher: 'fast' },
    });
    expect(fast.event.id).toBeGreaterThan(slowId);

    const firstPass: number[] = [];
    await consume(db, consumer, (e) => { firstPass.push(e.id); });
    expect(firstPass).toEqual([fast.event.id]);
    expect(await cursorFor(db, consumer)).toBe(fast.event.id);

    // The slow publisher commits now, under the number it reserved earlier.
    await db.insert(s.domainEvents).values({
      id: slowId,
      eventType: 'LESSON_COMPLETED', entityType: 'lesson', entityId: uid('lesson'),
      payload: { publisher: 'slow' }, classification: 'member',
      occurredAt: new Date(), publishedAt: new Date(),
    });

    // The event is unmistakably ON the feed...
    const onFeed = await readFeed(db, { principal: national }, { sinceId: base });
    expect(onFeed.events.map((e) => e.id)).toContain(slowId);

    // ...and this consumer will never see it. Not re-delivered — not delivered.
    const secondPass: number[] = [];
    const run = await consume(db, consumer, (e) => { secondPass.push(e.id); });
    expect(secondPass).toEqual([]);
    expect(run.delivered).toBe(0);

    // And the cursor reports it as perfectly caught up, which is precisely why
    // `consume()` states this in its docblock instead of leaving it to be found
    // in production. Closing it needs a commit-ordered column or a deliberate
    // safety lag — a federation decision about acceptable feed latency.
    const report = await cursorReport(db, fixture);
    expect(report.consumers.find((c) => c.consumer === consumer)!.cursor).toBe(fast.event.id);
  });

  it('refuses a consumer name that could collide with an ID sequence', async () => {
    await expect(consume(db, '', () => {})).rejects.toMatchObject({ code: 'bad_consumer_name' });
    await expect(consume(db, 'has space', () => {})).rejects.toMatchObject({ code: 'bad_consumer_name' });
  });

  it('keeps its cursors clear of the federation ID allocator', async () => {
    // Both live in id_sequences. The cursor key carries a ':' and year 0, and a
    // federation ID prefix can carry neither — this proves they never meet.
    await resetCursor(db, fixture, 'MEM', 4242);

    expect(await allocateFederationId(db, 'MEM', 2026)).toBe('MMAKF-MEM-2026-000001');
    expect(await cursorFor(db, 'MEM')).toBe(4242);

    expect(await allocateFederationId(db, 'MEM', 2026)).toBe('MMAKF-MEM-2026-000002');
    expect(await cursorFor(db, 'MEM')).toBe(4242);
  });
});

// ─── Cursor administration ──────────────────────────────────────────────────

describe('resetCursor', () => {
  it('refuses a principal without audit authority', async () => {
    await expect(
      resetCursor(db, { principal: athlete, reason: 'because' }, 'test.replay', 0)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses audit authority that is not national — a cursor is a national object', async () => {
    // THE ATTACK. `dojoAudit` holds `audit:read`, so a gate asking only "do you
    // hold this action anywhere?" lets one dojo replay every consumer in the
    // federation: re-send every notification, re-derive every analytic. The feed
    // has no dojo column, so there is no share of it this principal could own —
    // and the same principal cannot read a single event above 'public'. Reading
    // less than 'public' while being able to replay everything is the
    // contradiction this test exists to prevent coming back.
    const consumer = 'test.scope-attack';
    const base = await head();
    await resetCursor(db, fixture, consumer, base);

    await expect(
      resetCursor(db, { principal: dojoAudit, reason: 'replay please' }, consumer, 0)
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      resetCursor(db, { principal: stateAdmin, reason: 'replay please' }, consumer, 0)
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(clearanceFor(dojoAudit)).not.toBe('restricted');
    // Refused means UNCHANGED, not merely "threw".
    expect(await cursorFor(db, consumer)).toBe(base);
    // And nothing was recorded as though it had happened.
    const audits = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'domain_event_cursor'),
      eq(s.auditEvents.entityId, consumer)
    ));
    expect(audits.filter((a: any) => /replay please/.test(a.reason ?? ''))).toHaveLength(0);
  });

  it('demands a reason — a replay re-runs every downstream effect', async () => {
    await expect(
      resetCursor(db, { principal: national }, 'test.replay', 0)
    ).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('rejects a nonsensical position', async () => {
    await expect(
      resetCursor(db, { principal: national, reason: 'x' }, 'test.replay', -1)
    ).rejects.toBeInstanceOf(DomainEventError);
    await expect(
      resetCursor(db, { principal: national, reason: 'x' }, 'test.replay', 1.5)
    ).rejects.toMatchObject({ code: 'bad_cursor' });
  });

  it('moves a cursor backwards and records who ordered it and why', async () => {
    const consumer = 'test.replay';
    const base = await head();
    await resetCursor(db, fixture, consumer, base);

    const { event } = await publish(db, {
      eventType: 'RANKING_UPDATED', entityType: 'ranking_period', entityId: uid('rank'),
      payload: { rankingPeriodId: 9 },
    });
    await consume(db, consumer, () => {});
    expect(await cursorFor(db, consumer)).toBe(event.id);

    await resetCursor(
      db,
      { principal: national, reason: 'Ranking recalculation reissued after ruleset correction' },
      consumer,
      base
    );
    expect(await cursorFor(db, consumer)).toBe(base);

    // Replay: the event is delivered a second time, deliberately.
    const replayed: number[] = [];
    await consume(db, consumer, (e) => { replayed.push(e.id); });
    expect(replayed).toContain(event.id);

    const audits = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'domain_event_cursor'),
      eq(s.auditEvents.entityId, consumer)
    ));
    const withReason = audits.filter((a: any) => /ruleset correction/.test(a.reason ?? ''));
    expect(withReason).toHaveLength(1);
    expect(withReason[0].actorLabel).toBe('federation-admin');
    expect(withReason[0].oldValue).toMatchObject({ cursor: event.id });
    expect(withReason[0].newValue).toMatchObject({ cursor: base });
  });
});

describe('cursorReport', () => {
  it('refuses a caller with no national audit authority', async () => {
    // Every other read in the module is gated; this one names the federation's
    // consumers, the size of its feed and where each consumer is currently
    // blind — an operational map of what the federation runs.
    await expect(cursorReport(db, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cursorReport(db, { principal: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cursorReport(db, { principal: member })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cursorReport(db, { principal: stateAdmin })).rejects.toBeInstanceOf(ForbiddenError);
    // Holds audit:read, but only over one dojo.
    await expect(cursorReport(db, { principal: dojoAudit })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cursorReport(db, { principal: lapsed })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reports every consumer with its lag behind the head of the feed', async () => {
    const consumer = 'test.lagging';
    await resetCursor(db, fixture, consumer, await head());

    for (let n = 0; n < 3; n++) {
      await publish(db, {
        eventType: 'QUIZ_ATTEMPTED', entityType: 'quiz_attempt', entityId: uid('qa'),
        payload: { n },
      });
    }

    const report = await cursorReport(db, fixture);
    expect(report.head).toBe(await head());

    const row = report.consumers.find((c) => c.consumer === consumer)!;
    expect(row).toBeDefined();
    expect(row.lag).toBe(3);
    // The report lists consumers, never the ID allocator's own rows.
    expect(report.consumers.every((c) => !c.consumer.startsWith('MMAKF'))).toBe(true);
  });
});

// ─── The classification ladder ──────────────────────────────────────────────

describe('the classification ladder', () => {
  it('covers every data_class the schema defines', () => {
    // If the schema gains a level that the ladder does not rank, comparisons
    // against it become `undefined > n` — false — and the gate fails OPEN.
    expect([...CLASSIFICATIONS].sort()).toEqual([...s.dataClass.enumValues].sort());
  });

  it('refuses an unknown classification outright', async () => {
    await expect(publish(db, {
      eventType: 'LIVE_STARTED', entityType: 'broadcast', entityId: uid('live'),
      payload: {}, classification: 'sort_of_secret' as any,
    })).rejects.toMatchObject({ code: 'bad_classification' });

    await expect(
      consume(db, 'test.badcap', () => {}, { maxClassification: 'nonsense' as any })
    ).rejects.toMatchObject({ code: 'bad_classification' });
  });
});
