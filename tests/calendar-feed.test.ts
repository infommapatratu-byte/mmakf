// Personal calendar feeds, and the secret that makes one safe.
//
// src/pages/calendar.ics.ts refused to build this for a stated reason: "a
// per-user feed needs a per-user secret in the URL and its own revocation story;
// until the federation asks for that, this is the public calendar and says so."
//
// So the tests that matter here are the security ones, and there are four:
//
//   · the secret is NOT IN THE DATABASE — a leaked backup hands over nobody's
//     calendar, because only a SHA-256 of it was ever stored;
//   · it is not in the AUDIT TRAIL either, which more people read than the member;
//   · revocation is IMMEDIATE, because resolution reads the row every fetch;
//   · an unknown token, a revoked token and a malformed token are
//     INDISTINGUISHABLE, so a URL cannot be used to enumerate live ones.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as ops from '../src/db/operations.schema';
import * as sch from '../src/db/scheduling.schema';
import { createPerson } from '../src/db/federation';
import {
  issueFeed, myFeeds, revokeFeed, resolveFeed, mintSecret, hashSecret, isFeedError,
} from '../src/lib/calendar-feed';
import {
  createSchedule, draftVersion, publishVersion, createClass, generateSessions,
} from '../src/db/scheduling';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
let alice: Principal;
let coach: Principal;
let shared: Principal;

const ctx = (p: Principal = nat): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let db: any;
let JH: number, CLUB: number, VENUE: number;
let alicePerson: number, coachPerson: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [club] = await db.insert(s.dojos)
    .values({ code: 'D-1', name: 'Club', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  CLUB = club.id;
  const [venue] = await db.insert(ops.venues)
    .values({ code: 'V-1', name: 'Hall', kind: 'dojo', dojoId: CLUB, stateUnitId: JH })
    .returning({ id: ops.venues.id });
  VENUE = venue.id;

  const a = await createPerson(db, ctx(), { fullName: 'Alice', stateUnitId: JH });
  const c = await createPerson(db, ctx(), { fullName: 'Sensei', stateUnitId: JH });
  alicePerson = a.id; coachPerson = c.id;
  await db.update(s.persons).set({ dojoId: CLUB, status: 'active' }).where(eq(s.persons.id, alicePerson));
  await db.update(s.persons).set({ dojoId: CLUB, status: 'active' }).where(eq(s.persons.id, coachPerson));

  await db.insert(s.users).values([
    { id: 1, email: 'nat@x.test', status: 'active' },
    { id: 2, email: 'alice@x.test', status: 'active', personId: alicePerson },
    { id: 3, email: 'sensei@x.test', status: 'active', personId: coachPerson },
    // A user with NO person: the shared-credential case.
    { id: 4, email: 'desk@x.test', status: 'active' },
  ]);
  alice = { userId: 2, label: 'alice', bindings: [{ role: 'MEMBER', scopeType: 'dojo', scopeId: CLUB }] };
  coach = { userId: 3, label: 'sensei', bindings: [{ role: 'INSTRUCTOR', scopeType: 'dojo', scopeId: CLUB }] };
  shared = { userId: 4, label: 'front desk', bindings: [{ role: 'MEMBER', scopeType: 'dojo', scopeId: CLUB }] };

  // A class the coach actually teaches, so a 'coach_diary' feed has something
  // behind it — the module refuses one for somebody who teaches nothing.
  const hall = await createSchedule(db, ctx(), {
    name: 'hall', purpose: 'training', owner: { scope: 'dojo', id: CLUB }, venueId: VENUE,
  });
  const hv = await draftVersion(db, ctx(), hall.id, {
    effectiveFrom: '2019-01-01',
    rules: [{ dayOfWeek: 1, opensAt: '06:00', closesAt: '22:00' }],
  });
  await publishVersion(db, ctx(), hv.id, 'fixture');

  const klass = await createClass(db, ctx(), {
    name: 'Kihon', slug: 'kihon-feed', owner: { scope: 'dojo', id: CLUB },
    venueId: VENUE, defaultCoachPersonId: coachPerson, activate: true,
  });
  const cs = await createSchedule(db, ctx(), {
    name: 'kihon times', purpose: 'class', owner: { scope: 'dojo', id: CLUB }, classId: klass.id,
  });
  const cv = await draftVersion(db, ctx(), cs.id, {
    effectiveFrom: '2019-01-01', rules: [{ dayOfWeek: 1, opensAt: '18:00', closesAt: '19:30' }],
  });
  await publishVersion(db, ctx(), cv.id, 'fixture');
  await generateSessions(db, ctx(), klass.id, '2099-01-05', '2099-01-05');
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM audit_events');
  await db.execute?.('DELETE FROM calendar_feed_tokens');
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SECRET
// ═══════════════════════════════════════════════════════════════════════════

describe('the secret', () => {
  it('is long, URL-safe and never repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const secret = mintSecret();
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(secret)).toBe(false);
      seen.add(secret);
    }
  });

  it('is NOT stored — only a hash of it is', async () => {
    // The whole point. A leaked backup of this table hands over nobody's diary.
    const issued = await issueFeed(db, ctx(alice), { label: 'iPhone' });
    const rows = await db.select().from(sch.calendarFeedTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashSecret(issued.secret));
    expect(rows[0].tokenHash).not.toBe(issued.secret);
    expect(JSON.stringify(rows[0])).not.toContain(issued.secret);
  });

  it('is not in the audit trail either', async () => {
    // An audit trail is read by more people than the member. A bearer token
    // written into it is a bearer token published to the whole of operations.
    const issued = await issueFeed(db, ctx(alice), { label: 'iPhone' });
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'calendar_feed_token'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(issued.secret);
    expect(JSON.stringify(audit)).not.toContain(hashSecret(issued.secret));
  });

  it('is returned exactly once, in the path a member subscribes to', async () => {
    const issued = await issueFeed(db, ctx(alice));
    expect(issued.path).toBe(`/my/calendar/${issued.secret}.ics`);
    // And it is nowhere in the list afterwards, because it cannot be recovered.
    const listed = await myFeeds(db, alice);
    expect(JSON.stringify(listed)).not.toContain(issued.secret);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHOSE DIARY
// ═══════════════════════════════════════════════════════════════════════════

describe('whose diary it is', () => {
  it('takes no person id at all — it can only mint the caller’s own', async () => {
    // Structural, not a check: there is no personId parameter anywhere in the
    // module, so minting a feed for somebody else's diary is not expressible.
    const issued = await issueFeed(db, ctx(alice));
    expect(issued.token.personId).toBe(alicePerson);
  });

  it('refuses a credential attributable to nobody', async () => {
    await expect(issueFeed(db, ctx(shared))).rejects.toThrow(/not linked to a person/);
  });

  it('refuses a busy feed for somebody who teaches nothing', async () => {
    // Otherwise it is a bearer token in circulation protecting an empty calendar.
    await expect(issueFeed(db, ctx(alice), { scope: 'coach_diary' }))
      .rejects.toThrow(/register shows none against your name/);
  });

  it('issues a busy feed for somebody who does teach', async () => {
    const issued = await issueFeed(db, ctx(coach), { scope: 'coach_diary', label: 'work Outlook' });
    expect(issued.token.scope).toBe('coach_diary');
    expect(issued.token.personId).toBe(coachPerson);
  });

  it('lists only the caller’s own feeds', async () => {
    await issueFeed(db, ctx(alice), { label: 'phone' });
    await issueFeed(db, ctx(coach), { scope: 'coach_diary' });
    const hers = await myFeeds(db, alice);
    expect(hers).toHaveLength(1);
    expect(hers[0].personId).toBe(alicePerson);
  });

  it('caps how many URLs are in circulation at once', async () => {
    // A member with forty live tokens cannot say which one leaked.
    for (let i = 0; i < 10; i++) await issueFeed(db, ctx(alice), { label: `device ${i}` });
    await expect(issueFeed(db, ctx(alice))).rejects.toThrow(/Revoke one you no longer use/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION AND REVOCATION
// ═══════════════════════════════════════════════════════════════════════════

describe('resolving a feed', () => {
  it('turns a secret into the person it belongs to', async () => {
    const issued = await issueFeed(db, ctx(alice), { label: 'phone' });
    const resolved = await resolveFeed(db, issued.secret);
    expect(resolved).toMatchObject({ personId: alicePerson, scope: 'own_classes' });
  });

  it('counts uses, so a member can tell which subscription is live', async () => {
    const issued = await issueFeed(db, ctx(alice));
    await resolveFeed(db, issued.secret);
    await resolveFeed(db, issued.secret);
    const [row] = await db.select().from(sch.calendarFeedTokens);
    expect(row.useCount).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('stops working the moment it is revoked', async () => {
    const issued = await issueFeed(db, ctx(alice), { label: 'lost phone' });
    expect(await resolveFeed(db, issued.secret)).not.toBeNull();

    const revoked = await revokeFeed(db, ctx(alice), issued.token.id, 'Phone stolen');
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedReason).toBe('Phone stolen');
    expect(await resolveFeed(db, issued.secret)).toBeNull();
  });

  it('keeps the revoked row — nothing is deleted', async () => {
    const issued = await issueFeed(db, ctx(alice), { label: 'lost phone' });
    await revokeFeed(db, ctx(alice), issued.token.id, 'Phone stolen');
    const listed = await myFeeds(db, alice);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('revoked');
    expect(listed[0].revokedAt).not.toBeNull();
  });

  it('cannot tell an unknown token from a revoked or malformed one', async () => {
    // A distinguishable refusal is a way to enumerate live tokens.
    const issued = await issueFeed(db, ctx(alice));
    await revokeFeed(db, ctx(alice), issued.token.id, 'test');

    expect(await resolveFeed(db, issued.secret)).toBeNull();        // revoked
    expect(await resolveFeed(db, mintSecret())).toBeNull();          // never existed
    expect(await resolveFeed(db, 'short')).toBeNull();               // malformed
    expect(await resolveFeed(db, '../../etc/passwd')).toBeNull();    // hostile
    expect(await resolveFeed(db, '')).toBeNull();
    expect(await resolveFeed(db, null as any)).toBeNull();
  });

  it('does not let one member revoke another member’s feed', async () => {
    const hers = await issueFeed(db, ctx(alice), { label: 'phone' });
    // The same refusal whether it does not exist or belongs to somebody else.
    await expect(revokeFeed(db, ctx(coach), hers.token.id, 'mischief'))
      .rejects.toThrow(/No calendar subscription of yours/);
    expect(await resolveFeed(db, hers.secret)).not.toBeNull();
  });

  it('is idempotent when revoked twice', async () => {
    const issued = await issueFeed(db, ctx(alice));
    await revokeFeed(db, ctx(alice), issued.token.id, 'first');
    const again = await revokeFeed(db, ctx(alice), issued.token.id, 'second');
    expect(again.status).toBe('revoked');
    expect(again.revokedReason).toBe('first');   // the first reason stands
  });

  it('frees a slot when one is revoked', async () => {
    const tokens = [];
    for (let i = 0; i < 10; i++) tokens.push(await issueFeed(db, ctx(alice), { label: `d${i}` }));
    await expect(issueFeed(db, ctx(alice))).rejects.toThrow(/Revoke one/);
    await revokeFeed(db, ctx(alice), tokens[0].token.id, 'no longer used');
    const fresh = await issueFeed(db, ctx(alice), { label: 'new device' });
    expect(fresh.token.status).toBe('active');
  });
});
