// The notification centre's reading side.
//
// tests/notifications.test.ts covers the ENGINE — the allow-list, the queue,
// the transports, the fan-out. These cover what the two new surfaces added:
//
//   · safeLink(), which decides whether a stored string may be redirected to.
//     It is an open-redirect control and it had no coverage, which is the
//     combination worth fixing first.
//   · ownLink(), which resolves a redirect target from the caller's own row
//     rather than from the request.
//   · the scope predicate on the operator's view, including the case that
//     returns NOTHING rather than everything.
//   · outcomeGroup(), because "a suppression is not a failure" is a claim the
//     page makes in prose and should not depend on somebody remembering it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import { queue } from '../src/lib/notifications';
import {
  safeLink, outcomeGroup, HELD_BY_DESIGN,
  inbox, unreadCount, ownLink, markAllRead, deliveryOverview, pushOutcomes,
} from '../src/db/notifications-inbox';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any, JH: number;
let ALICE: any, BOB: any;
let ALICE_USER: number, BOB_USER: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: national };

const asMember = (userId: number): Principal => ({
  userId, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
});

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

  ALICE = await createPerson(db, ctx, { fullName: 'Alice', stateUnitId: JH, email: 'alice@example.in' });
  BOB = await createPerson(db, ctx, { fullName: 'Bob', stateUnitId: JH, email: 'bob@example.in' });

  const [au] = await db.insert(s.users)
    .values({ email: 'alice@example.in', passwordHash: 'x', personId: ALICE.id, status: 'active' })
    .returning({ id: s.users.id });
  const [bu] = await db.insert(s.users)
    .values({ email: 'bob@example.in', passwordHash: 'x', personId: BOB.id, status: 'active' })
    .returning({ id: s.users.id });
  ALICE_USER = au.id;
  BOB_USER = bu.id;

  await queue(db, { personId: ALICE.id, title: 'Your grading result', body: 'Recorded.', linkUrl: '/my/passport' });
  await queue(db, { personId: ALICE.id, title: 'Rankings updated', body: 'Updated.', linkUrl: null });
  await queue(db, { personId: BOB.id, title: 'Your certificate', body: 'Issued.', linkUrl: '/my/passport' });
});

// ─── safeLink ───────────────────────────────────────────────────────────────

describe('a stored link is followed only if it is a path on this site', () => {
  it('accepts an ordinary internal path, including one with a query or a hyphen', () => {
    expect(safeLink('/my/passport')).toBe('/my/passport');
    expect(safeLink('/admin/fee-framework?id=4')).toBe('/admin/fee-framework?id=4');
    expect(safeLink('/competitions#results')).toBe('/competitions#results');
  });

  it('REFUSES an absolute URL, which is how an inbox becomes an open redirect', () => {
    expect(safeLink('https://evil.example/steal')).toBeNull();
    expect(safeLink('http://mmakf.in.evil.example/')).toBeNull();
  });

  it('REFUSES a protocol-relative link, which is another host wearing a path', () => {
    expect(safeLink('//evil.example/steal')).toBeNull();
  });

  it('REFUSES a scheme that is not http at all', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('mailto:someone@example.in')).toBeNull();
    expect(safeLink('data:text/html,<script>')).toBeNull();
  });

  it('REFUSES a backslash, which some parsers read as a slash', () => {
    expect(safeLink('/\\evil.example')).toBeNull();
    expect(safeLink('\\\\evil.example\\x')).toBeNull();
  });

  it('REFUSES whitespace and control characters used to smuggle past the checks', () => {
    expect(safeLink('/ /evil.example')).toBeNull();
    expect(safeLink('/\tx')).toBeNull();
    expect(safeLink('/' + String.fromCharCode(9) + 'x')).toBeNull();
    expect(safeLink('/' + String.fromCharCode(0) + 'x')).toBeNull();
    expect(safeLink('/' + String.fromCharCode(13) + 'x')).toBeNull();
  });

  it('treats nothing as nothing', () => {
    expect(safeLink(null)).toBeNull();
    expect(safeLink(undefined)).toBeNull();
    expect(safeLink('')).toBeNull();
  });
});

// ─── outcomeGroup ───────────────────────────────────────────────────────────

describe('a suppression is not a failure', () => {
  it('files every recorded suppression under "held", never under attention', () => {
    for (const o of HELD_BY_DESIGN) expect(outcomeGroup(o)).toBe('held');
  });

  it('files a suppression added LATER under held too, without anyone editing this', () => {
    expect(outcomeGroup('suppressed_something_nobody_has_written_yet')).toBe('held');
  });

  it('keeps delivery, waiting and churn apart from anything needing action', () => {
    expect(outcomeGroup('sent')).toBe('delivered');
    expect(outcomeGroup('queued')).toBe('waiting');
    expect(outcomeGroup('expired')).toBe('churn');
    expect(outcomeGroup('failed')).toBe('attention');
  });

  it('sends an UNRECOGNISED outcome to attention rather than quietly calling it fine', () => {
    expect(outcomeGroup('who_knows')).toBe('attention');
    expect(outcomeGroup(null)).toBe('attention');
  });
});

// ─── the inbox is the caller's own, by construction ─────────────────────────

describe('an inbox belongs to the person signed in', () => {
  it('returns only the caller\'s own notices', async () => {
    const mine = await inbox(db, asMember(ALICE_USER));
    expect(mine).toHaveLength(2);
    expect(mine.every((n) => n.title !== 'Your certificate')).toBe(true);
  });

  it('counts only the caller\'s own unread', async () => {
    expect(await unreadCount(db, asMember(ALICE_USER))).toBe(2);
    expect(await unreadCount(db, asMember(BOB_USER))).toBe(1);
  });

  it('returns nothing for a shared credential, which is attributable to nobody', async () => {
    const shared: Principal = {
      userId: null, label: 'office',
      bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
    };
    expect(await inbox(db, shared)).toEqual([]);
    expect(await unreadCount(db, shared)).toBe(0);
  });

  it('ATTACK: a redirect target cannot be fetched for somebody else\'s notice', async () => {
    const bobs = await inbox(db, asMember(BOB_USER));
    const bobsId = bobs[0].id;
    // Bob's own row resolves; the same id asked for by Alice does not.
    expect(await ownLink(db, asMember(BOB_USER), bobsId)).toBe('/my/passport');
    expect(await ownLink(db, asMember(ALICE_USER), bobsId)).toBeNull();
  });

  it('returns null rather than a link for a notice that records none', async () => {
    const mine = await inbox(db, asMember(ALICE_USER));
    const noLink = mine.find((n) => n.title === 'Rankings updated')!;
    expect(await ownLink(db, asMember(ALICE_USER), noLink.id)).toBeNull();
  });

  it('marking all read touches nobody else\'s rows', async () => {
    const moved = await markAllRead(db, asMember(ALICE_USER));
    expect(moved).toBe(2);
    expect(await unreadCount(db, asMember(ALICE_USER))).toBe(0);
    // Bob's is untouched, which is the whole point.
    expect(await unreadCount(db, asMember(BOB_USER))).toBe(1);
    // And it is idempotent.
    expect(await markAllRead(db, asMember(ALICE_USER))).toBe(0);
  });
});

// ─── the operator's view ────────────────────────────────────────────────────

describe('delivery is scoped by a SQL predicate, and sometimes to nothing', () => {
  it('refuses an account without notification:read', async () => {
    await expect(deliveryOverview(db, asMember(ALICE_USER))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('shows a national account the whole record', async () => {
    const o = await deliveryOverview(db, {
      userId: 9, label: 'ops',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    });
    expect(o.reach).toBe('all');
    const total = o.byStatus.reduce((n, r) => n + r.n, 0);
    expect(total).toBe(3);
  });

  it('shows NOTHING to an authority this table cannot be narrowed by', async () => {
    // A state-scoped programme manager holds notification:read, and
    // `notifications` carries no state column. The choice is the whole
    // federation's delivery record or none of it; it is none.
    const o = await deliveryOverview(db, {
      userId: 10, label: 'state programme manager',
      bindings: [{ role: 'SCHOOL_PROGRAM_MANAGER', scopeType: 'state', scopeId: JH }],
    });
    expect(o.reach).toBe('none');
    expect(o.byStatus).toEqual([]);
    expect(o.failures).toEqual([]);
  });

  it('narrows an institution-bound account to its own institutions', async () => {
    const o = await deliveryOverview(db, {
      userId: 11, label: 'school admin',
      bindings: [{ role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: 4242 }],
    });
    expect(o.reach).toBe('institutions');
    expect(o.institutionIds).toEqual([4242]);
    // The three seeded notices belong to no institution, so they are excluded
    // by the WHERE clause rather than filtered out afterwards.
    expect(o.byStatus.reduce((n, r) => n + r.n, 0)).toBe(0);
  });

  it('withholds push outcomes from anyone whose reach is not the whole federation', async () => {
    const scoped = await pushOutcomes(db, {
      userId: 11, label: 'school admin',
      bindings: [{ role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: 4242 }],
    });
    // notification_deliveries carries no institution, so there is no honest way
    // to narrow it — null, rather than an unnarrowed figure.
    expect(scoped).toBeNull();

    const nationalPush = await pushOutcomes(db, {
      userId: 9, label: 'ops',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    });
    expect(Array.isArray(nationalPush)).toBe(true);
  });
});
