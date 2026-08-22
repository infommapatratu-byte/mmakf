// Personal calendar feeds, and the secret that makes one safe.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PROBLEM THIS EXISTS TO SOLVE, IN ITS OWN WORDS
// ═══════════════════════════════════════════════════════════════════════════
//
// src/pages/calendar.ics.ts has said this since it was written:
//
//     "The mistake this file exists to avoid is the tempting one: reading the
//      session cookie so a signed-in official gets 'their' calendar. It would
//      work in a browser and then quietly do nothing in the calendar app that
//      actually subscribes — except on the day someone shares the URL, which for
//      a scoped feed would hand over another unit's draft fixtures. A per-user
//      feed needs a per-user secret in the URL and its own revocation story;
//      until the federation asks for that, this is the public calendar and says
//      so."
//
// This module is that secret and that revocation story.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FIVE DECISIONS
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE. THE SECRET IS NEVER STORED. `calendar_feed_tokens.token_hash` is a
// SHA-256 of it, exactly as `users.mfa_recovery_hashes` treats recovery codes.
// It is returned to its owner ONCE, at creation, and cannot be recovered
// afterwards. A feed URL is a bearer credential that travels through server
// logs, proxy logs, referrer headers and the address bar of whatever machine the
// member subscribed from; storing it in the clear would be storing a password.
//
// TWO. A URL THAT LEAKS IS A URL THAT CAN BE REVOKED, and revocation is
// immediate because resolution reads the row on every fetch. `status = revoked`
// rather than a DELETE (§78): a member who revokes a feed because they think it
// leaked needs the record that they did, and when.
//
// THREE. THE TOKEN IS THE ONLY AUTHORITY, SO IT MUST BE LONG. 32 bytes from
// `crypto.randomBytes`, base64url, 43 characters. Not a UUID: a v4 UUID carries
// 122 bits in a shape people recognise as an identifier and therefore paste into
// bug reports and screenshots, and 16 bytes is the floor rather than a margin.
//
// FOUR. COMPARISON IS BY HASH LOOKUP, NOT BY SCAN. The token is hashed and the
// hash is looked up on a unique index, so there is no row-by-row comparison and
// therefore no timing signal proportional to how many tokens exist. The database
// never sees the token.
//
// FIVE. A COACH'S FEED CARRIES BUSY, NOT DETAIL. `scope = 'coach_diary'` returns
// opaque blocks — "MMAKF (busy)" — with no class name, no venue, no student and
// no reason. An instructor's calendar is often shared with a family or an
// employer, and "Kids Program, Ramgarh hall, 18:00" published to whoever holds
// the URL is a movement pattern for a named adult who works with children. The
// federation's instruction asked for BUSY / AVAILABLE and that is what this is.

import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as sch from '@/db/scheduling.schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import type { Principal } from '@/lib/rbac';

type DB = any;

export class FeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

export function isFeedError(err: unknown): err is FeedError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'FeedError';
}

export type FeedScope = 'own_classes' | 'coach_diary';

/** 32 bytes, base64url. 43 characters, no padding, URL-safe by construction. */
export function mintSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * The stored form of a token.
 *
 * SHA-256 and not bcrypt/scrypt, deliberately, and the reason is the input: a
 * password is low-entropy and needs a slow hash to survive a dictionary attack,
 * whereas this is 256 bits of `randomBytes` and cannot be guessed at any speed.
 * A slow hash here would add a hundred milliseconds to every calendar poll and
 * defend against nothing.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export interface FeedToken {
  id: number;
  personId: number;
  scope: FeedScope;
  label: string | null;
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

function toToken(row: any): FeedToken {
  return {
    id: row.id, personId: row.personId, scope: row.scope, label: row.label ?? null,
    status: row.status,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    useCount: row.useCount,
    createdAt: new Date(row.createdAt).toISOString(),
    revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
    revokedReason: row.revokedReason ?? null,
  };
}

/**
 * The caller's OWN person id, from their own user row. Never from the request.
 *
 * Every function in this module takes the person from HERE. There is no
 * `personId` parameter anywhere, which is what makes it structurally impossible
 * to mint a feed token for somebody else's diary — the failure that would hand
 * an administrator a permanent, unauditable read of a member's calendar.
 */
async function ownPersonId(db: DB, principal: Principal | null | undefined): Promise<number | null> {
  if (!principal || principal.userId == null) return null;
  const row = (
    await db.select({ personId: s.users.personId }).from(s.users)
      .where(eq(s.users.id, principal.userId)).limit(1)
  )[0];
  return row?.personId ?? null;
}

const MAX_LIVE_TOKENS = 10;

export interface IssuedFeed {
  token: FeedToken;
  /**
   * THE ONLY TIME THIS VALUE EXISTS. It is not stored and cannot be recovered;
   * a member who loses it revokes the token and issues another.
   */
  secret: string;
  /** The path to subscribe to, without an origin. */
  path: string;
}

/**
 * Mint a feed for the CALLER'S OWN diary.
 *
 * A 'coach_diary' feed additionally requires that the caller actually teaches
 * something — checked against `class_sessions.coach_person_id`, not against a
 * role. A member with no classes to teach who asks for a busy feed would get an
 * empty calendar and a bearer token for it, which is a credential in circulation
 * protecting nothing.
 */
export async function issueFeed(
  db: DB, ctx: AuditContext,
  input: { scope?: FeedScope; label?: string | null } = {}
): Promise<IssuedFeed> {
  const personId = await ownPersonId(db, ctx.principal);
  if (personId == null) {
    throw new FeedError(
      'no_person',
      'This account is not linked to a person on the register, so it has no diary to publish. A shared credential is attributable to nobody and cannot hold a feed.'
    );
  }
  const scope: FeedScope = input.scope ?? 'own_classes';
  if (scope !== 'own_classes' && scope !== 'coach_diary') {
    throw new FeedError('bad_scope', `Unknown feed scope ${JSON.stringify(scope)}.`);
  }

  if (scope === 'coach_diary') {
    const teaches = await db.select({ id: sch.classSessions.id })
      .from(sch.classSessions)
      .where(eq(sch.classSessions.coachPersonId, personId))
      .limit(1);
    if (!teaches.length) {
      throw new FeedError(
        'not_a_coach',
        'A busy feed publishes the classes you teach, and the register shows none against your name. Nothing would be in it.'
      );
    }
  }

  const live = await db.select({ id: sch.calendarFeedTokens.id })
    .from(sch.calendarFeedTokens)
    .where(and(
      eq(sch.calendarFeedTokens.personId, personId),
      eq(sch.calendarFeedTokens.status, 'active')
    ));
  if (live.length >= MAX_LIVE_TOKENS) {
    // A cap, because every live token is a URL in circulation and a member with
    // forty of them cannot say which one leaked.
    throw new FeedError(
      'too_many',
      `You already have ${live.length} calendar subscriptions. Revoke one you no longer use before adding another — each is a URL that can read your diary.`
    );
  }

  const secret = mintSecret();
  const rows = await db.insert(sch.calendarFeedTokens).values({
    personId,
    tokenHash: hashSecret(secret),
    scope,
    label: input.label?.trim() || null,
    status: 'active',
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'calendar_feed_token', entityId: rows[0].id, action: 'create',
    // THE SECRET IS NOT IN THE AUDIT ROW EITHER. An audit trail is read by more
    // people than the member, and a bearer token written into it is a bearer
    // token published to the whole of operations.
    newValue: { personId, scope, label: input.label?.trim() || null },
  });

  return {
    token: toToken(rows[0]),
    secret,
    path: `/my/calendar/${secret}.ics`,
  };
}

/** The caller's own feeds. Never anybody else's — see ownPersonId(). */
export async function myFeeds(db: DB, principal: Principal): Promise<FeedToken[]> {
  const personId = await ownPersonId(db, principal);
  if (personId == null) return [];
  const rows = await db.select().from(sch.calendarFeedTokens)
    .where(eq(sch.calendarFeedTokens.personId, personId))
    .orderBy(sql`${sch.calendarFeedTokens.createdAt} desc`);
  return rows.map(toToken);
}

/**
 * Withdraw a feed.
 *
 * Takes a token ID and checks it belongs to the CALLER, so a substituted id is
 * refused rather than honoured. Revoking is immediate: `resolveFeed()` reads
 * `status` on every fetch, so the next poll from a leaked URL gets nothing.
 */
export async function revokeFeed(
  db: DB, ctx: AuditContext, tokenId: number, reason: string
): Promise<FeedToken> {
  const personId = await ownPersonId(db, ctx.principal);
  if (personId == null) throw new FeedError('no_person', 'This account has no diary.');

  const why = (reason ?? '').trim() || 'Revoked by the member';
  const rows = await db.select().from(sch.calendarFeedTokens)
    .where(and(
      eq(sch.calendarFeedTokens.id, tokenId),
      eq(sch.calendarFeedTokens.personId, personId)
    )).limit(1);
  if (!rows.length) {
    // The same message whether the token does not exist or belongs to somebody
    // else. A distinguishable refusal is a way to enumerate other people's
    // tokens.
    throw new FeedError('not_found', 'No calendar subscription of yours has that reference.');
  }
  if (rows[0].status === 'revoked') return toToken(rows[0]);

  const updated = await db.update(sch.calendarFeedTokens)
    .set({ status: 'revoked', revokedAt: new Date(), revokedReason: why })
    .where(eq(sch.calendarFeedTokens.id, tokenId))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'calendar_feed_token', entityId: tokenId, action: 'revoke',
    oldValue: { status: 'active' }, newValue: { status: 'revoked', reason: why },
  });
  return toToken(updated[0]);
}

export interface ResolvedFeed {
  tokenId: number;
  personId: number;
  scope: FeedScope;
}

/**
 * Turn a secret from a URL into a person, or into nothing.
 *
 * Returns null for an unknown token, a revoked token and a malformed one, WITH
 * THE SAME null — a caller holding a URL learns only that it does not work, and
 * cannot tell a revoked feed from a token that never existed.
 *
 * The use counter is bumped on success. Not for analytics: it is how a member
 * looking at their list can tell which subscription is actually being polled and
 * therefore which one is safe to revoke. `lastUsedAt` is the same answer in a
 * more readable form.
 */
export async function resolveFeed(db: DB, secret: string): Promise<ResolvedFeed | null> {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(secret)) return null;

  const rows = await db.select().from(sch.calendarFeedTokens)
    .where(eq(sch.calendarFeedTokens.tokenHash, hashSecret(secret)))
    .limit(1);
  if (!rows.length || rows[0].status !== 'active') return null;

  // Best effort. A calendar client polling every fifteen minutes must not have
  // its feed fail because a counter update lost a race with another poll.
  try {
    await db.update(sch.calendarFeedTokens)
      .set({ lastUsedAt: new Date(), useCount: sql`${sch.calendarFeedTokens.useCount} + 1` })
      .where(eq(sch.calendarFeedTokens.id, rows[0].id));
  } catch {
    // Deliberately silent: the feed is the product, the counter is a convenience.
  }

  return { tokenId: rows[0].id, personId: rows[0].personId, scope: rows[0].scope };
}
