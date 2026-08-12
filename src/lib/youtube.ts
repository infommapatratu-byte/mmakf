// YouTube integration — authorised channels, broadcast detection, media sync.
//
// Q-13. The problem this solves: when an authorised Master Teacher goes live on
// their own channel, the class must appear inside MMAKF BY ITSELF. Requiring an
// administrator to paste a URL every time is what makes live classes quietly
// stop happening — the workflow survives exactly as long as someone remembers.
//
// YouTube is the streaming TRANSPORT. MMAKF is the authoritative learning
// environment: attendance, questions, curriculum links and progress live here.
//
// SECURITY POSTURE, stated plainly because it is the part most often got wrong:
//  · Refresh tokens are encrypted at rest with AES-256-GCM and NEVER leave the
//    server. No token, and no access token, is ever sent to a browser.
//  · Every API call happens server-side.
//  · A channel owner can revoke consent at Google's end at any time. The system
//    must NOTICE and say so rather than failing silently, which is what
//    `tokenStatus` is for.
//
// CONTENT POSTURE, equally important:
//  · A teacher's channel carries personal and family material alongside
//    teaching material. NOTHING discovered here is published automatically.
//    Everything lands `pending_review` and a human classifies it.
//  · Classification and RIGHTS are independent. A video can be entirely
//    federation-relevant and still not be MMAKF's to publish.

import crypto from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere } from '@/lib/rbac';
import { isUniqueViolation } from '@/db/pgerror';

type DB = any;

export class YouTubeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'YouTubeError';
    this.code = code;
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Optional: read-only public data works with an API key and no OAuth. */
  apiKey?: string;
}

export function youtubeConfig(): YouTubeConfig | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, apiKey: process.env.YOUTUBE_API_KEY };
}

/**
 * Is the integration usable, and if not, exactly what is missing?
 *
 * Surfaces call this so they can state the real reason rather than rendering a
 * Connect button that cannot work (§70).
 */
export function integrationStatus(): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.YOUTUBE_CLIENT_ID) missing.push('YOUTUBE_CLIENT_ID');
  if (!process.env.YOUTUBE_CLIENT_SECRET) missing.push('YOUTUBE_CLIENT_SECRET');
  if (!process.env.YOUTUBE_REDIRECT_URI) missing.push('YOUTUBE_REDIRECT_URI');
  if (!process.env.MEDIA_TOKEN_KEY) missing.push('MEDIA_TOKEN_KEY');
  return { ready: missing.length === 0, missing };
}

// ─── Token encryption ───────────────────────────────────────────────────────

/**
 * AES-256-GCM with a random IV per token.
 *
 * GCM rather than CBC because it is authenticated: a tampered ciphertext fails
 * to decrypt instead of yielding plausible garbage that later gets sent to
 * Google as a credential.
 *
 * The key comes from MEDIA_TOKEN_KEY. If it is absent, storing a token is
 * REFUSED — writing a long-lived Google credential in plaintext because a
 * variable was unset is exactly the failure this guards.
 */
function tokenKey(): Buffer {
  const raw = process.env.MEDIA_TOKEN_KEY;
  if (!raw) {
    throw new YouTubeError(
      'no_token_key',
      'MEDIA_TOKEN_KEY is not set. Refusing to store an OAuth refresh token unencrypted.'
    );
  }
  // Any length of secret is accepted and stretched to 32 bytes, so operators are
  // not forced to generate an exactly-sized key by hand.
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptToken(stored: string): string {
  const parts = String(stored ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new YouTubeError('bad_token', 'Stored token is not in the expected encrypted format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

/** Read-only. The federation never needs to post, edit or delete on a channel. */
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

export function authorisationUrl(state: string): string {
  const cfg = youtubeConfig();
  if (!cfg) throw new YouTubeError('not_configured', 'YouTube integration is not configured.');

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent are both required to be issued a refresh token at all;
    // without them the grant expires in an hour and the poller stops working
    // silently a day later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const cfg = youtubeConfig();
  if (!cfg) throw new YouTubeError('not_configured', 'YouTube integration is not configured.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    throw new YouTubeError(
      'oauth_failed',
      `Token exchange failed: ${body.error_description || body.error || res.status}. ` +
      'A missing refresh_token usually means the account has already granted access — revoke it in the Google account and retry.'
    );
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

/** Access tokens are short-lived and are never stored — only held in memory. */
async function accessTokenFor(db: DB, channel: any): Promise<string> {
  const cfg = youtubeConfig();
  if (!cfg) throw new YouTubeError('not_configured', 'YouTube integration is not configured.');
  if (!channel.refreshTokenEncrypted) {
    throw new YouTubeError('no_token', `Channel ${channel.title} has no stored authorisation.`);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: decryptToken(channel.refreshTokenEncrypted),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The owner revoked consent at Google's end. Record it so the office sees
    // WHY syncing stopped, instead of watching it silently do nothing.
    const revoked = body.error === 'invalid_grant';
    await db.update(s.mediaChannels)
      .set({
        tokenStatus: revoked ? 'revoked' : 'expired',
        lastSyncError: `Token refresh failed: ${body.error_description || body.error || res.status}`,
      })
      .where(eq(s.mediaChannels.id, channel.id));

    throw new YouTubeError(
      revoked ? 'consent_revoked' : 'token_refresh_failed',
      revoked
        ? `The channel owner has revoked MMAKF's access to ${channel.title}. They must reconnect it.`
        : `Could not refresh the access token for ${channel.title}.`
    );
  }
  return body.access_token;
}

// ─── API ────────────────────────────────────────────────────────────────────

async function api(path: string, params: Record<string, string>, auth: { accessToken?: string; apiKey?: string }) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (auth.apiKey && !auth.accessToken) url.searchParams.set('key', auth.apiKey);

  const res = await fetch(url, {
    headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') {
      throw new YouTubeError('quota_exceeded', 'YouTube API quota exhausted for today. Sync will resume tomorrow.');
    }
    throw new YouTubeError('api_error', `YouTube ${path} failed: ${body?.error?.message || res.status}`);
  }
  return body;
}

// ─── Channel registration ───────────────────────────────────────────────────

/**
 * Register a channel as an authorised federation media source.
 *
 * `authorised` defaults to FALSE. Connecting a channel and authorising it as a
 * federation source are two decisions, and collapsing them would mean a
 * teacher's whole upload history becoming federation content the moment they
 * clicked Connect.
 */
export async function registerChannel(
  db: DB,
  ctx: AuditContext,
  input: {
    externalId: string;
    handle?: string;
    title: string;
    ownerPersonId?: number | null;
    ownerKind?: 'federation' | 'person' | 'unit' | 'dojo';
    refreshToken?: string;
  }
) {
  assertCanAnywhere(ctx.principal, 'content:write');

  let encrypted: string | null = null;
  if (input.refreshToken) encrypted = encryptToken(input.refreshToken);   // throws if no key

  let row;
  try {
    [row] = await db.insert(s.mediaChannels).values({
      platform: 'youtube',
      externalId: input.externalId,
      handle: input.handle ?? null,
      title: input.title,
      url: input.handle
        ? `https://www.youtube.com/${input.handle}`
        : `https://www.youtube.com/channel/${input.externalId}`,
      ownerPersonId: input.ownerPersonId ?? null,
      ownerKind: input.ownerKind ?? 'person',
      authorised: false,
      refreshTokenEncrypted: encrypted,
      tokenStatus: encrypted ? 'valid' : 'none',
      scopes: SCOPES,
      defaultLiveClass: 'pending_review',
      autoPublishLive: false,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new YouTubeError('already_registered', 'That channel is already registered.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'media_channel',
    entityId: row.id,
    action: 'create',
    newValue: { externalId: input.externalId, title: input.title, authorised: false, hasToken: Boolean(encrypted) },
  });
  return row;
}

/** Authorise or withdraw a channel as a federation media source. */
export async function setChannelAuthorisation(
  db: DB,
  ctx: AuditContext,
  channelId: number,
  authorised: boolean,
  reason?: string
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  if (!authorised && !reason?.trim()) {
    throw new YouTubeError('reason_required', 'Withdrawing a channel requires a reason.');
  }

  const before = (await db.select().from(s.mediaChannels).where(eq(s.mediaChannels.id, channelId)).limit(1))[0];
  if (!before) throw new YouTubeError('unknown_channel', 'Unknown channel');

  await db.update(s.mediaChannels).set({
    authorised,
    authorisedByUserId: authorised ? ctx.principal.userId ?? null : before.authorisedByUserId,
    authorisedAt: authorised ? new Date() : before.authorisedAt,
    revokedAt: authorised ? null : new Date(),
    revokedReason: authorised ? null : reason!.trim(),
  }).where(eq(s.mediaChannels.id, channelId));

  await writeAudit(db, { ...ctx, reason: reason ?? null }, {
    entityType: 'media_channel',
    entityId: channelId,
    action: authorised ? 'approve' : 'revoke',
    oldValue: { authorised: before.authorised },
    newValue: { authorised },
  });
}

// ─── Broadcast detection ────────────────────────────────────────────────────

export interface SyncReport {
  channelsPolled: number;
  broadcastsFound: number;
  broadcastsStarted: number;
  broadcastsEnded: number;
  recordingsLinked: number;
  liveClassesCreated: number;
  errors: string[];
}

/**
 * Poll every authorised channel for live and upcoming broadcasts.
 *
 * IDEMPOTENT BY CONSTRUCTION: broadcasts are keyed on (channelId, externalId)
 * with a unique index, so the same broadcast can never be recorded twice however
 * often this runs. That matters because it runs on a schedule and will overlap
 * itself the moment one run is slow.
 *
 * Never throws for one channel's failure — a revoked token on one teacher's
 * channel must not stop every other channel from syncing.
 */
export async function syncBroadcasts(db: DB, ctx: AuditContext, now: Date = new Date()): Promise<SyncReport> {
  const report: SyncReport = {
    channelsPolled: 0, broadcastsFound: 0, broadcastsStarted: 0,
    broadcastsEnded: 0, recordingsLinked: 0, liveClassesCreated: 0, errors: [],
  };

  const status = integrationStatus();
  if (!status.ready) {
    report.errors.push(`YouTube integration not configured: ${status.missing.join(', ')} unset.`);
    return report;
  }

  const channels = await db.select().from(s.mediaChannels).where(and(
    eq(s.mediaChannels.platform, 'youtube'),
    eq(s.mediaChannels.authorised, true)
  ));

  for (const channel of channels) {
    report.channelsPolled++;
    try {
      const accessToken = await accessTokenFor(db, channel);

      // Currently live, then scheduled. Two calls because the API treats them as
      // different event types.
      const live = await api('search', {
        part: 'snippet', channelId: channel.externalId, eventType: 'live',
        type: 'video', maxResults: '10',
      }, { accessToken });

      const upcoming = await api('search', {
        part: 'snippet', channelId: channel.externalId, eventType: 'upcoming',
        type: 'video', maxResults: '10',
      }, { accessToken });

      const items = [
        ...(live.items ?? []).map((i: any) => ({ item: i, state: 'live' as const })),
        ...(upcoming.items ?? []).map((i: any) => ({ item: i, state: 'upcoming' as const })),
      ];

      for (const { item, state } of items) {
        const videoId = item?.id?.videoId;
        if (!videoId) continue;
        report.broadcastsFound++;

        // Authoritative timing comes from liveStreamingDetails, not from search.
        const details = await api('videos', {
          part: 'liveStreamingDetails,snippet', id: videoId,
        }, { accessToken });
        const v = details.items?.[0];
        const lsd = v?.liveStreamingDetails ?? {};

        const existing = (await db.select().from(s.broadcasts).where(and(
          eq(s.broadcasts.channelId, channel.id),
          eq(s.broadcasts.externalId, videoId)
        )).limit(1))[0];

        const values = {
          channelId: channel.id,
          externalId: videoId,
          status: state,
          title: v?.snippet?.title ?? item.snippet?.title ?? 'Untitled broadcast',
          description: v?.snippet?.description ?? null,
          thumbnailUrl: v?.snippet?.thumbnails?.high?.url ?? null,
          scheduledStartAt: lsd.scheduledStartTime ? new Date(lsd.scheduledStartTime) : null,
          actualStartAt: lsd.actualStartTime ? new Date(lsd.actualStartTime) : null,
          actualEndAt: lsd.actualEndTime ? new Date(lsd.actualEndTime) : null,
          concurrentViewers: lsd.concurrentViewers ? Number(lsd.concurrentViewers) : null,
          lastPolledAt: now,
        };

        if (existing) {
          await db.update(s.broadcasts).set(values).where(eq(s.broadcasts.id, existing.id));
          if (existing.status !== 'live' && state === 'live') report.broadcastsStarted++;
        } else {
          const [created] = await db.insert(s.broadcasts).values(values).returning();
          if (state === 'live') report.broadcastsStarted++;

          // A live class is created for every detected broadcast, but published
          // only when the channel is explicitly configured to auto-publish.
          // Otherwise it waits for review — a teacher's channel is not a
          // federation curriculum.
          const [liveClass] = await db.insert(s.liveClasses).values({
            code: `MMAKF-LIVE-${now.getFullYear()}-${created.id.toString().padStart(6, '0')}`,
            broadcastId: created.id,
            title: values.title,
            teacherPersonId: channel.ownerPersonId ?? null,
            status: state,
            scheduledStartAt: values.scheduledStartAt,
            startedAt: values.actualStartAt,
            visibility: 'members',
            published: Boolean(channel.autoPublishLive),
          }).returning();
          report.liveClassesCreated++;

          await writeAudit(db, ctx, {
            entityType: 'live_class',
            entityId: liveClass.id,
            action: 'create',
            newValue: { broadcastId: created.id, channel: channel.title, autoPublished: Boolean(channel.autoPublishLive) },
          });
        }
      }

      await db.update(s.mediaChannels)
        .set({ lastSyncedAt: now, lastSyncError: null, tokenStatus: 'valid' })
        .where(eq(s.mediaChannels.id, channel.id));
    } catch (err: any) {
      // Recorded per channel, never fatal to the run.
      const message = `${channel.title}: ${err?.message ?? err}`;
      report.errors.push(message);
      await db.update(s.mediaChannels)
        .set({ lastSyncError: String(err?.message ?? err).slice(0, 500) })
        .where(eq(s.mediaChannels.id, channel.id))
        .catch(() => {});
    }
  }

  // Broadcasts we believed were live but that no longer appear.
  const ended = await closeStaleBroadcasts(db, ctx, now);
  report.broadcastsEnded = ended.ended;
  report.recordingsLinked = ended.recordingsLinked;

  return report;
}

/**
 * Close broadcasts that have stopped, and attach their recordings.
 *
 * A broadcast disappears from the "live" search the moment it ends, so absence
 * is the end signal. The RECORDING is usually the same video id once processing
 * completes — but not always immediately available, which is why a broadcast
 * moves to `recording_processing` first and is retried, rather than being marked
 * `missing` on the first look.
 */
export async function closeStaleBroadcasts(db: DB, ctx: AuditContext, now: Date = new Date()) {
  let ended = 0;
  let recordingsLinked = 0;

  // Anything marked live but not polled in the last 15 minutes has stopped.
  const stale = await db.select().from(s.broadcasts).where(and(
    eq(s.broadcasts.status, 'live'),
    sql`${s.broadcasts.lastPolledAt} < ${new Date(now.getTime() - 15 * 60_000)}`
  ));

  for (const b of stale) {
    await db.update(s.broadcasts)
      .set({ status: 'recording_processing', actualEndAt: b.actualEndAt ?? now })
      .where(eq(s.broadcasts.id, b.id));
    await db.update(s.liveClasses)
      .set({ status: 'ended', endedAt: b.actualEndAt ?? now })
      .where(eq(s.liveClasses.broadcastId, b.id));
    ended++;

    await writeAudit(db, ctx, {
      entityType: 'broadcast',
      entityId: b.id,
      action: 'update',
      oldValue: { status: 'live' },
      newValue: { status: 'recording_processing' },
    });
  }

  // Processing broadcasts whose recording may now exist.
  const processing = await db.select().from(s.broadcasts)
    .where(eq(s.broadcasts.status, 'recording_processing'));

  for (const b of processing) {
    const channel = (await db.select().from(s.mediaChannels)
      .where(eq(s.mediaChannels.id, b.channelId)).limit(1))[0];
    if (!channel?.authorised) continue;

    try {
      const accessToken = await accessTokenFor(db, channel);
      const details = await api('videos', { part: 'snippet,contentDetails,status', id: b.externalId }, { accessToken });
      const v = details.items?.[0];
      if (!v) continue;

      // The recording lands as PENDING REVIEW like everything else. A class
      // being live does not make its recording federation curriculum.
      const [asset] = await db.insert(s.mediaAssets).values({
        channelId: channel.id,
        platform: 'youtube',
        externalId: b.externalId,
        url: `https://www.youtube.com/watch?v=${b.externalId}`,
        title: v.snippet?.title ?? b.title,
        description: v.snippet?.description ?? null,
        thumbnailUrl: v.snippet?.thumbnails?.high?.url ?? null,
        publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
        classification: 'pending_review',
        rights: 'not_cleared',
        rightsHolder: channel.title,
        teacherPersonId: channel.ownerPersonId ?? null,
        published: false,
        lastSyncedAt: now,
      }).onConflictDoUpdate({
        target: [s.mediaAssets.platform, s.mediaAssets.externalId],
        set: { lastSyncedAt: now },
      }).returning();

      await db.update(s.broadcasts)
        .set({ status: 'recorded', recordingAssetId: asset.id })
        .where(eq(s.broadcasts.id, b.id));
      await db.update(s.liveClasses)
        .set({ status: 'recorded', recordingAssetId: asset.id })
        .where(eq(s.liveClasses.broadcastId, b.id));
      recordingsLinked++;
    } catch {
      // Not ready yet, or the channel's token has gone. Left in
      // recording_processing for the next run rather than marked missing —
      // a recording that simply had not finished processing must not be
      // permanently written off.
    }
  }

  return { ended, recordingsLinked };
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a discovered asset, and decide whether it becomes federation content.
 *
 * Publication requires BOTH a federation-relevant classification AND cleared
 * rights. A video can be entirely relevant and still not be MMAKF's to publish,
 * and treating relevance as permission is how a federation ends up republishing
 * someone else's footage.
 */
export async function classifyAsset(
  db: DB,
  ctx: AuditContext,
  input: {
    assetId: number;
    classification: typeof s.mediaClass.enumValues[number];
    rights?: typeof s.rightsStatus.enumValues[number];
    rightsHolder?: string;
    rightsNote?: string;
    topic?: string;
    gradeRelevance?: string;
    publish?: boolean;
  }
) {
  assertCanAnywhere(ctx.principal, 'content:write');

  const before = (await db.select().from(s.mediaAssets).where(eq(s.mediaAssets.id, input.assetId)).limit(1))[0];
  if (!before) throw new YouTubeError('unknown_asset', 'Unknown media asset');

  const rights = input.rights ?? before.rights;
  const PUBLISHABLE = ['federation_official', 'federation_relevant', 'master_teaching', 'shotokan_technical', 'seminar', 'competition', 'historical'];
  const CLEARED = ['cleared', 'federation_owned', 'licensed'];

  if (input.publish) {
    if (!PUBLISHABLE.includes(input.classification)) {
      throw new YouTubeError(
        'not_publishable',
        `Content classified "${input.classification}" is not federation content and cannot be published.`
      );
    }
    if (!CLEARED.includes(rights)) {
      throw new YouTubeError(
        'rights_not_cleared',
        `Rights for this asset are "${rights}". Clear the rights before publishing — relevance is not permission.`
      );
    }
  }

  await db.update(s.mediaAssets).set({
    classification: input.classification,
    classifiedByUserId: ctx.principal.userId ?? null,
    classifiedAt: new Date(),
    rights,
    rightsHolder: input.rightsHolder ?? before.rightsHolder,
    rightsNote: input.rightsNote ?? before.rightsNote,
    topic: input.topic ?? before.topic,
    gradeRelevance: input.gradeRelevance ?? before.gradeRelevance,
    published: input.publish ?? before.published,
  }).where(eq(s.mediaAssets.id, input.assetId));

  await writeAudit(db, ctx, {
    entityType: 'media_asset',
    entityId: input.assetId,
    action: 'update',
    oldValue: { classification: before.classification, rights: before.rights, published: before.published },
    newValue: { classification: input.classification, rights, published: input.publish ?? before.published },
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** What is live right now, for the LIVE NOW surface. */
export async function liveNow(db: DB) {
  return db
    .select({
      code: s.liveClasses.code,
      title: s.liveClasses.title,
      startedAt: s.liveClasses.startedAt,
      visibility: s.liveClasses.visibility,
      teacherPersonId: s.liveClasses.teacherPersonId,
      videoId: s.broadcasts.externalId,
      thumbnailUrl: s.broadcasts.thumbnailUrl,
      viewers: s.broadcasts.concurrentViewers,
    })
    .from(s.liveClasses)
    .innerJoin(s.broadcasts, eq(s.liveClasses.broadcastId, s.broadcasts.id))
    .where(and(eq(s.liveClasses.status, 'live'), eq(s.liveClasses.published, true)))
    .orderBy(desc(s.liveClasses.startedAt));
}

export async function upcomingClasses(db: DB, limit = 20) {
  return db
    .select({
      code: s.liveClasses.code,
      title: s.liveClasses.title,
      scheduledStartAt: s.liveClasses.scheduledStartAt,
      teacherPersonId: s.liveClasses.teacherPersonId,
      thumbnailUrl: s.broadcasts.thumbnailUrl,
    })
    .from(s.liveClasses)
    .leftJoin(s.broadcasts, eq(s.liveClasses.broadcastId, s.broadcasts.id))
    .where(and(eq(s.liveClasses.status, 'upcoming'), eq(s.liveClasses.published, true)))
    .orderBy(s.liveClasses.scheduledStartAt)
    .limit(limit);
}

/** The review queue — everything discovered and not yet classified. */
export async function pendingReview(db: DB, principal: any, limit = 100) {
  assertCanAnywhere(principal, 'content:write');
  return db.select().from(s.mediaAssets)
    .where(eq(s.mediaAssets.classification, 'pending_review'))
    .orderBy(desc(s.mediaAssets.discoveredAt))
    .limit(limit);
}
