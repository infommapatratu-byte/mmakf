// Realtime transport for the live scoreboard and the live classroom. Q-24.
//
// This module is a TRANSPORT and nothing else. It holds no state of its own, it
// publishes nothing, and it decides nothing about what is true. Every byte it
// sends was read from `domain_events` through `src/lib/domain-events.ts`, which
// remains the single source of truth. If this file disappeared, the federation
// would lose live delivery and lose no records — which is the correct blast
// radius for a transport.
//
// ─── WHY SERVER-SENT EVENTS AND NOT WEBSOCKETS ──────────────────────────────
//
// Five reasons, in the order they mattered:
//
//  1. THE DEPLOYMENT HAS NO PERSISTENT SERVER. This runs on Vercel serverless
//     functions. A WebSocket needs a process that outlives a request and holds
//     the socket; there is no such process here, and inventing one would mean a
//     second piece of infrastructure to run, pay for and secure. SSE is an
//     ordinary HTTP response that happens not to end yet, which is exactly what
//     a streaming serverless response already is.
//  2. A SCOREBOARD IS ONE-WAY. Nothing on a venue display or a live-class page
//     sends anything upstream over this channel — questions, scores and
//     attendance all go through their own authenticated POST endpoints, where
//     they are validated and audited. A duplex transport would buy a capability
//     nobody needs and would create a second, unaudited write path.
//  3. IT SURVIVES THE NETWORK IT WILL ACTUALLY RUN ON. A venue's guest wifi, a
//     school proxy or a mobile carrier will break a WebSocket upgrade far more
//     often than it will break `text/event-stream` over ordinary HTTPS.
//  4. THE BROWSER RECONNECTS BY ITSELF, WITH NO CLIENT LIBRARY. `EventSource`
//     is built in, retries on its own schedule, and replays the last id it saw
//     in `Last-Event-ID`. Rule 3 of this project forbids new dependencies; a
//     WebSocket client with reconnection and resume logic is a dependency
//     whether it arrives from npm or is written here.
//  5. RESUME IS THE WHOLE POINT OF THE `id` FIELD, and the feed already has the
//     only thing resume needs: a total order on `domain_events.id`. See
//     `pollChannel()`.
//
// ─── WHAT A SUBSCRIBER GETS, AND WHAT IT NEVER GETS ─────────────────────────
//
// A public channel carries the PUBLIC PROJECTION from domain-events.ts —
// `toPublicProjection()`, the federation's own field allowlist — and nothing
// else. This module deliberately does NOT define a second allowlist of its own.
// One allowlist that the scoreboard page and this stream both obey is the only
// way the two can agree; two allowlists disagree the first time either changes,
// and the disagreement shows up on a wall in a venue.
//
// A CONSEQUENCE WORTH STATING PLAINLY, because it shapes how a page should use
// this: the catalogue does not declare competitor NAMES public on any match
// event, so this stream does not carry them. What it carries for a match is the
// declared set — match, category, round, scores, and the winning entry id. A
// page that wants names treats the frame as a SIGNAL and re-reads
// `publicScoreboard()`, which is the surface that resolves names. Publishing
// names from here would mean inventing a public field the federation has not
// declared, which rule 1 forbids.
//
// An admin channel carries RAW events clamped to the caller's own clearance by
// `readFeed()`. There is no safeguarding or medical channel and there cannot be
// one: `MAX_STREAM_CLASSIFICATION` refuses it structurally, and the reason is
// under that constant.

import { eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { can, ForbiddenError, type Action, type Principal } from '@/lib/rbac';
import {
  publicFeed, readFeed, CLASSIFICATIONS,
  type Classification, type DomainEventRow, type DomainEventType, type PublicEvent,
} from '@/lib/domain-events';
import { liveClassQuestions, AcademyError } from '@/db/academy';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

// ─── The classification ladder ──────────────────────────────────────────────

/**
 * A local copy of the sensitivity ladder, typed so it cannot silently miss a
 * value: `Record<Classification, number>` makes a new `data_class` a COMPILE
 * error here rather than an `undefined` rank that compares false against
 * everything, i.e. fails open.
 *
 * It is a copy because domain-events.ts exports the names (`CLASSIFICATIONS`)
 * but not a comparator. `streamCatalogueDefects()` asserts this table against
 * that export — same members, same order — so drift is caught by the test
 * suite rather than by a stream that hands out more than it should. Exporting
 * a comparator from domain-events.ts is the proper fix and is reported as a
 * shared-file need.
 */
const RANK: Record<Classification, number> = {
  public: 0,
  member: 1,
  official: 2,
  confidential: 3,
  restricted: 4,
  highly_restricted: 5,
};

/**
 * NOTHING ABOVE THIS IS EVER STREAMED, whatever a channel or a principal's
 * clearance would otherwise allow.
 *
 * A stream is not a page. A page is opened, read and closed; a stream stays
 * open in a tab that may be on a shared office screen, on a laptop that gets
 * locked and carried, or on a display nobody is watching — for as long as the
 * duration cap allows, receiving whatever happens to be published in that time.
 * Safeguarding and medical material is read deliberately, in a case screen,
 * against an audit record naming who read what. Pushing it at a socket produces
 * neither the deliberation nor the record, so it is refused here rather than
 * left to depend on nobody defining the wrong channel later.
 */
const MAX_STREAM_CLASSIFICATION: Classification = 'confidential';

function atMost(a: Classification, b: Classification): Classification {
  return RANK[a] <= RANK[b] ? a : b;
}

// ─── The channel model ──────────────────────────────────────────────────────
//
// A subscriber NAMES a channel; the server decides whether they may have it.
// The name is never trusted to carry authority — it is a request, and
// `authoriseChannel()` is the answer.

export type ChannelKind = 'scoreboard' | 'live-class' | 'admin';

export interface ParsedChannel {
  kind: ChannelKind;
  /** Numeric subject for scoreboard/live-class; the scope name for admin. */
  subject: string;
  /** The canonical `kind:subject` form, safe to echo back to the client. */
  name: string;
}

/**
 * Bounded on purpose. The channel name arrives in a URL path and is echoed in
 * the `ready` frame, so it is length-capped and character-capped before it is
 * used for anything at all — including before it is put in an error message.
 */
const CHANNEL_RE = /^(scoreboard|live-class|admin):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export function parseChannel(raw: string | null | undefined): ParsedChannel | null {
  const m = CHANNEL_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const kind = m[1] as ChannelKind;
  const subject = m[2];
  if (kind !== 'admin' && !/^[1-9][0-9]{0,8}$/.test(subject)) return null;
  return { kind, subject, name: `${kind}:${subject}` };
}

/**
 * The competition event statuses at which a competition is public information.
 *
 * MIRRORED from `PUBLIC_EVENT_STATUSES` in
 * `src/pages/api/competition/[...action].ts`, which is that file's private
 * definition of the same rule. Two copies of a visibility rule is one too many,
 * so `tests/realtime.test.ts` cross-checks this list against that file's own
 * `publicEventDetail()` at every status in the enum — the two are compared by
 * BEHAVIOUR, not by hope. Exporting the constant is reported as a shared-file
 * need; when it is exported, this list is deleted and imported instead.
 */
const PUBLIC_EVENT_STATUSES: readonly string[] = [
  'published', 'registration_open', 'registration_closed',
  'check_in', 'live', 'results_pending', 'results_final', 'archived',
];

/**
 * What a scoreboard channel carries.
 *
 * Every type here satisfies two conditions, and the pair is load-bearing:
 * it has a declared public form (so `publicFeed()` never drops it, which is
 * what keeps the cursor watermark faithful — see `pollChannel()`), and its
 * public form names `competitionId` (so the subject filter can tell one
 * competition from another without reading an undeclared field).
 */
const SCOREBOARD_EVENT_TYPES: readonly DomainEventType[] = [
  'COMPETITION_SANCTIONED', 'DRAW_PUBLISHED',
  'MATCH_STARTED', 'MATCH_COMPLETED',
  'RESULT_FINALIZED', 'RESULT_CORRECTED',
];

/** What a live-class channel carries: on air, off air, recording available. */
const LIVE_CLASS_EVENT_TYPES: readonly DomainEventType[] = [
  'LIVE_STARTED', 'LIVE_ENDED', 'BROADCAST_PUBLISHED',
];

/**
 * THE ENTITY TYPES THIS TRANSPORT EXPECTS PRODUCERS TO USE.
 *
 * Nothing in the codebase calls `publish()` yet — the feed is built and tested,
 * and its producers are still to be wired in. So the subject filter below is a
 * CONVENTION this module states rather than a fact it observed, and it is
 * stated here in one place so a producer has something to conform to instead of
 * each guessing. A live-class event must be published with
 * `entityType: 'live_class'` and the class id as `entityId`; a competition
 * event must carry `competitionId` in its payload, which its catalogue entry
 * already declares public. A producer that does neither will publish events
 * this transport silently does not deliver, which is why it is named here and
 * reported as an open question rather than left implicit.
 */
export const LIVE_CLASS_ENTITY_TYPE = 'live_class';

/**
 * The admin channels that exist, each with the authority it demands and the
 * ceiling it reads to.
 *
 * The action is tested with `can(principal, action, {})` — an EMPTY resource,
 * which only a NATIONAL binding satisfies. That is deliberate and it is the
 * same rule `clearanceFor()` and `resetCursor()` apply in domain-events.ts, for
 * the same reason: the feed has no state, district or dojo column, so there is
 * no such thing as one state's share of it. Gating with `canAnywhere()` would
 * hand a dojo administrator the whole federation's feed — and over a stream
 * that stays open, so the mistake would keep paying out rather than leaking
 * once.
 */
export interface AdminScopeSpec {
  action: Action;
  upTo: Classification;
  /** null means every event type the ceiling allows. */
  eventTypes: readonly DomainEventType[] | null;
  means: string;
}

export const ADMIN_SCOPES = {
  operations: {
    action: 'audit:read',
    upTo: 'official',
    eventTypes: null,
    means: 'Everything the operations screen watches: the whole feed, up to official.',
  },
  competition: {
    action: 'result:read',
    upTo: 'official',
    eventTypes: [
      'COMPETITION_SANCTIONED', 'ENTRY_CREATED', 'ENTRY_ACCEPTED', 'ENTRY_REJECTED',
      'DRAW_PUBLISHED', 'MATCH_STARTED', 'MATCH_COMPLETED',
      'RESULT_FINALIZED', 'RESULT_CORRECTED', 'PROTEST_LODGED', 'PROTEST_DECIDED',
    ],
    means: 'The competition control desk: entries, draws, matches, results and protests.',
  },
  grading: {
    action: 'grading:read',
    upTo: 'official',
    eventTypes: [
      'GRADING_SCHEDULED', 'GRADING_APPROVED', 'GRADING_LOCKED',
      'RANK_AWARDED', 'CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED',
    ],
    means: 'The grading desk: panel decisions, locks, ranks and certificates.',
  },
  finance: {
    action: 'finance:read',
    upTo: 'confidential',
    eventTypes: [
      'ORDER_PAID', 'PAYMENT_FAILED', 'REFUND_ISSUED',
      'INVOICE_ISSUED', 'SETTLEMENT_RECORDED',
    ],
    means: 'The finance desk: payments, refunds, invoices and settlement.',
  },
} as const satisfies Record<string, AdminScopeSpec>;

export type AdminScope = keyof typeof ADMIN_SCOPES;

export const ADMIN_SCOPE_NAMES = Object.keys(ADMIN_SCOPES) as AdminScope[];

/**
 * Contradictions in this file's own tables, returned rather than thrown.
 *
 * Same reasoning as `catalogueDefects()` in domain-events.ts: a static table
 * either always fails or never does, and a module that refuses to load in
 * production over a developer's typo takes the site down. The test suite is
 * where this is allowed to fail.
 */
export function streamCatalogueDefects(): string[] {
  const defects: string[] = [];

  // The ladder copy, checked against the module that owns it — same members AND
  // same order, because the order IS the ranking.
  const local = Object.keys(RANK);
  if (local.join(',') !== CLASSIFICATIONS.join(',')) {
    defects.push(
      `the local classification ladder [${local.join(', ')}] no longer matches ` +
      `domain-events.ts [${CLASSIFICATIONS.join(', ')}]`
    );
  }

  for (const [name, spec] of Object.entries(ADMIN_SCOPES) as Array<[string, AdminScopeSpec]>) {
    if (RANK[spec.upTo] > RANK[MAX_STREAM_CLASSIFICATION]) {
      defects.push(`admin:${name} reads to '${spec.upTo}', above the stream cap '${MAX_STREAM_CLASSIFICATION}'`);
    }
    if (spec.eventTypes && !spec.eventTypes.length) {
      defects.push(`admin:${name} declares an empty event-type list, which delivers nothing`);
    }
    if (!spec.means?.trim()) defects.push(`admin:${name} has no description`);
  }

  return defects;
}

// ─── Authorisation ──────────────────────────────────────────────────────────

export interface ChannelGrant {
  channel: ParsedChannel;
  /**
   * 'projection' — the federation's public field allowlist is applied to every
   *   event before it leaves. Safe for an anonymous subscriber.
   * 'raw'        — whole events, clamped to the principal's clearance by
   *   `readFeed()`. Never for an anonymous subscriber.
   */
  mode: 'projection' | 'raw';
  upTo: Classification;
  eventTypes: readonly DomainEventType[] | null;
  /** Raw mode only: whose clearance `readFeed()` clamps to. */
  principal: Principal | null;
  /** Scoreboard only: the competition whose events this channel carries. */
  competitionId?: number;
  /** Live class only: the class whose events this channel carries. */
  liveClassId?: number;
  /** Told to the client in the `ready` frame so a page can label itself. */
  audience: 'public' | 'member' | 'admin';
}

export type Authorisation =
  | { ok: true; grant: ChannelGrant }
  | { ok: false; status: 400 | 401 | 403 | 404; code: string; message: string };

const CHANNEL_FORMS =
  'Channels are named scoreboard:<competitionId>, live-class:<classId> or admin:<scope>.';

/**
 * Decide whether this caller may subscribe to this channel.
 *
 * AUTHORISATION HAPPENS ONCE, AT SUBSCRIBE, AND THAT IS THE RISK THIS FUNCTION
 * CARRIES. A page check that is wrong leaks one render; a stream check that is
 * wrong leaks continuously until the duration cap closes it, and then the
 * browser reconnects and it leaks again. Two consequences follow and both are
 * implemented rather than assumed:
 *   · the duration cap (`MAX_DURATION_MS`) is what bounds a stale authorisation
 *     — a principal whose bindings are revoked keeps their stream until it
 *     expires, and then `identify()` and this function run again on the
 *     reconnect and refuse. That window is the price of streaming, and it is
 *     stated rather than hidden;
 *   · nothing above `MAX_STREAM_CLASSIFICATION` is reachable through any
 *     channel, so the worst a stale authorisation can hold open is bounded too.
 *
 * A refusal never confirms that a private thing exists: an unpublished
 * competition and a competition that was never created both answer 404.
 */
export async function authoriseChannel(
  db: DB,
  raw: string | null | undefined,
  identity: { principal: Principal } | null | undefined
): Promise<Authorisation> {
  const channel = parseChannel(raw);
  if (!channel) {
    return { ok: false, status: 400, code: 'bad_channel', message: `Unrecognised channel name. ${CHANNEL_FORMS}` };
  }

  if (channel.kind === 'scoreboard') return authoriseScoreboard(db, channel);
  if (channel.kind === 'live-class') return authoriseLiveClass(db, channel, identity?.principal ?? null);
  return authoriseAdmin(channel, identity?.principal ?? null);
}

async function authoriseScoreboard(db: DB, channel: ParsedChannel): Promise<Authorisation> {
  const competitionId = Number(channel.subject);

  const row = (await db.select({ status: s.competitionEvents.status })
    .from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, competitionId))
    .limit(1))[0] as { status: string } | undefined;

  // A competition the federation has not published is not a channel. Without
  // this check a draft competition's matches would stream to anyone who guessed
  // the id, while /scoreboard — which refuses anything outside a published draw
  // — showed nothing. The two surfaces would disagree, in public.
  if (!row || !PUBLIC_EVENT_STATUSES.includes(row.status)) {
    return {
      ok: false, status: 404, code: 'unknown_channel',
      message: 'No published competition with that reference.',
    };
  }

  return {
    ok: true,
    grant: {
      channel,
      mode: 'projection',
      upTo: 'member',                 // the ceiling publicFeed() applies anyway
      eventTypes: SCOREBOARD_EVENT_TYPES,
      principal: null,
      competitionId,
      audience: 'public',
    },
  };
}

/**
 * A live class is gated by the ACADEMY's rule, not by a copy of it.
 *
 * `assertLiveClassReadable()` in src/db/academy.ts is that rule — published or
 * not, public / members / course / private — and it is not exported. Rather
 * than restate it here and let the two drift, this calls `liveClassQuestions()`
 * purely as an authorisation probe and discards what it returns: if the caller
 * may read the class's question board, they may have the class's channel. The
 * cost is one query at subscribe time; the benefit is that a change to the
 * academy's visibility rules takes effect here with nothing to remember. The
 * /live page refuses to copy that rule for the same reason.
 *
 * Exporting the predicate itself is reported as a shared-file need; when it
 * exists, the probe becomes a direct call and the discarded rows go away.
 */
async function authoriseLiveClass(
  db: DB,
  channel: ParsedChannel,
  principal: Principal | null
): Promise<Authorisation> {
  const liveClassId = Number(channel.subject);
  const anonymous: Principal = { userId: null, label: 'anonymous', bindings: [] };

  try {
    await liveClassQuestions(db, { principal: principal ?? anonymous }, liveClassId);
  } catch (err: any) {
    // ONLY A DELIBERATE REFUSAL IS A REFUSAL. The probe runs two queries, so a
    // dropped connection or a bad migration arrives here looking exactly like a
    // rejection — and answering 403 would send an operator to the role bindings
    // for a database that was simply unreachable, while answering 401 would tell
    // a signed-in member to sign in again. Worse, `err.message` on an
    // infrastructure failure is a Postgres sentence naming tables and columns,
    // and this endpoint answers the unauthenticated public. So anything that is
    // not one of the academy's own decisions is rethrown, and the endpoint turns
    // it into the 503 it already has a path for.
    if (!(err instanceof AcademyError) && !(err instanceof ForbiddenError)) throw err;

    // An unknown class and a class this caller may not read answer differently
    // ONLY where the academy itself already distinguishes them: on a private
    // class the title is the thing being protected, so the academy's own
    // refusal message is what travels, not a message invented here.
    const code = err instanceof AcademyError ? String(err.code) : 'forbidden';
    if (code === 'unknown_live_class') {
      return { ok: false, status: 404, code: 'unknown_channel', message: 'No live class with that reference.' };
    }
    // The academy's own errors already carry a sentence written to be read by a
    // person, so they travel unchanged. `ForbiddenError` carries only an action
    // name, which is an authorisation term and not an explanation, so it gets a
    // sentence here instead of leaking 'Forbidden: content:read' onto a page.
    return {
      ok: false,
      status: principal ? 403 : 401,
      code,
      message: err instanceof ForbiddenError
        ? 'This class is not open to the public. Sign in with an account entitled to it.'
        : err.message,
    };
  }

  return {
    ok: true,
    grant: {
      channel,
      mode: 'projection',
      upTo: 'member',
      eventTypes: LIVE_CLASS_EVENT_TYPES,
      principal,
      liveClassId,
      audience: principal ? 'member' : 'public',
    },
  };
}

function authoriseAdmin(channel: ParsedChannel, principal: Principal | null): Authorisation {
  const scope = channel.subject as AdminScope;
  const spec = (ADMIN_SCOPES as Record<string, AdminScopeSpec>)[scope];
  if (!spec) {
    return {
      ok: false, status: 404, code: 'unknown_channel',
      message: `No such administrative channel. Available scopes: ${ADMIN_SCOPE_NAMES.join(', ')}.`,
    };
  }

  if (!principal) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'Sign in to subscribe to an administrative channel.' };
  }

  // Empty resource: only a national binding satisfies it. See ADMIN_SCOPES.
  if (!can(principal, spec.action, {})) {
    return {
      ok: false, status: 403, code: 'forbidden',
      message:
        `This channel carries the federation's national feed, so it requires '${spec.action}' ` +
        'held at national scope. A state, district or dojo binding does not reach it.',
    };
  }

  return {
    ok: true,
    grant: {
      channel,
      mode: 'raw',
      // Two independent ceilings, because one is not enough: the scope's own,
      // and the cap that no channel may exceed.
      upTo: atMost(spec.upTo, MAX_STREAM_CLASSIFICATION),
      eventTypes: spec.eventTypes,
      principal,
      audience: 'admin',
    },
  };
}

// ─── Limits ─────────────────────────────────────────────────────────────────
//
// Every number here is a bound on something that would otherwise be unbounded,
// and each is stated with what it costs when it bites.

/**
 * Events read from the database per poll.
 *
 * 200 is a batch a page can apply in one frame without the tab stuttering, and
 * a payload a phone on venue wifi can take. A subscriber further behind than
 * that is not throttled to the poll interval — `pollChannel()` reports the batch
 * was full and the loop comes straight back for the next one — so a backlog
 * drains quickly while a single response stays small.
 */
const MAX_BATCH = 200;

/**
 * The pause between CATCH-UP polls, as distinct from idle ones.
 *
 * A full batch means there is more waiting, so the loop must not sit out the
 * two-second poll interval. But it must not come back with no pause at all
 * either, and the reason is specific to this transport rather than general
 * caution: a `scoreboard:<id>` channel filters by competition in JavaScript,
 * not in SQL, so on a weekend with several competitions running a subscriber
 * resuming from a low `Last-Event-ID` can read the whole feed at whatever rate
 * the database will serve and emit almost none of it. Unauthenticated, three
 * connections at a time. 50ms still drains 4,000 events a second — far faster
 * than any backlog this federation will produce — while turning a tight loop
 * into a paced one.
 */
const CATCHUP_MS = 50;

/**
 * How long the loop waits when there was nothing new.
 *
 * 2 seconds. A scoreboard is read across a hall; two seconds of latency is
 * invisible to a spectator and it is 30 queries a minute per subscriber rather
 * than 600. This is a POLL of the feed, not a push — the database has no
 * server-side notification path this deployment can hold open, and pretending
 * otherwise would be a fake feature. What the subscriber gets is still a push:
 * the polling happens once on the server, not once per viewer's browser.
 */
const POLL_MS = 2_000;

/**
 * A comment frame when nothing has been sent for this long.
 *
 * 20 seconds, comfortably inside the 30–60s idle timeout that proxies, load
 * balancers and mobile carriers apply. Without it an idle scoreboard is severed
 * by an intermediary, the browser reconnects, and the cycle repeats forever —
 * invisibly, because every individual reconnection succeeds. A comment
 * (`: ...`) is chosen over a real event because it carries no `id`, so it
 * cannot disturb the resume position, and `EventSource` discards it without
 * dispatching anything to the page.
 */
const HEARTBEAT_MS = 20_000;

/**
 * The longest a single connection is allowed to live.
 *
 * 4 minutes, and it exists for two reasons. A serverless function has a
 * platform maximum duration; being severed by the platform mid-frame gives the
 * client a truncated event and no explanation. Ending it ourselves sends a
 * `closing` frame, leaves the last `id` delivered, and the browser reconnects
 * with `Last-Event-ID` — losing nothing. It is also what bounds a stale
 * authorisation (see `authoriseChannel()`) and what stops one subscriber
 * pinning a function instance open indefinitely.
 */
const MAX_DURATION_MS = 4 * 60_000;

/** What the browser is told to wait before reconnecting, via the `retry:` field. */
const RECONNECT_MS = 3_000;

/**
 * Concurrent streams per client, and in total, per function instance.
 *
 * A browser opens one `EventSource` per tab. Three allows a venue display, an
 * official's phone and a spare without argument, and stops a script opening
 * hundreds. 64 in total bounds one instance's sockets and memory.
 *
 * HONEST LIMITATION: this counter is per INSTANCE and in-process, so a client
 * spread across several instances gets several allowances. It is not moved to
 * Redis because a concurrency gauge there needs a decrement that a crashed
 * instance never sends, and a leaked counter locks a legitimate client out
 * permanently — a worse failure than a loose cap. The cross-instance control
 * that does work is the ordinary rate limit on OPENING a stream, which is
 * Redis-backed and is applied by the endpoint.
 */
const MAX_STREAMS_PER_CLIENT = 3;
const MAX_STREAMS_TOTAL = 64;

/**
 * Unread chunks tolerated before a subscriber is dropped.
 *
 * A client that has stopped reading but has not closed its socket would
 * otherwise make the server buffer for it indefinitely. `desiredSize` going
 * this far negative means the queue has outrun the reader; the stream closes
 * and the browser reconnects, which starts from the last id the client actually
 * consumed rather than pretending it received the rest.
 */
const STREAM_HIGH_WATER = 32;
const BACKPRESSURE_LIMIT = 64;

export const STREAM_LIMITS = {
  maxBatch: MAX_BATCH,
  pollSeconds: POLL_MS / 1000,
  catchupSeconds: CATCHUP_MS / 1000,
  heartbeatSeconds: HEARTBEAT_MS / 1000,
  maxDurationSeconds: MAX_DURATION_MS / 1000,
  maxStreamsPerClient: MAX_STREAMS_PER_CLIENT,
  maxStreamsTotal: MAX_STREAMS_TOTAL,
} as const;

const openPerClient = new Map<string, number>();
let openTotal = 0;

/**
 * Take a concurrency slot, or refuse. Returns the release function.
 *
 * The release is idempotent because it is called from two places that can both
 * happen — the loop's `finally` and the stream's `cancel()` — and a double
 * decrement would hand out a slot that is still in use.
 */
export function acquireStreamSlot(clientKey: string): (() => void) | null {
  if (openTotal >= MAX_STREAMS_TOTAL) return null;
  const held = openPerClient.get(clientKey) ?? 0;
  if (held >= MAX_STREAMS_PER_CLIENT) return null;

  openPerClient.set(clientKey, held + 1);
  openTotal++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    openTotal = Math.max(0, openTotal - 1);
    const now = (openPerClient.get(clientKey) ?? 1) - 1;
    if (now <= 0) openPerClient.delete(clientKey);
    else openPerClient.set(clientKey, now);
  };
}

/** Test-only: forget every held slot. Never called by the endpoint. */
export function __resetStreamSlots(): void {
  openPerClient.clear();
  openTotal = 0;
}

// ─── Framing ────────────────────────────────────────────────────────────────

/**
 * Event names are sanitised before they are framed.
 *
 * `event:` is a line in a line-oriented protocol. A name containing a newline
 * would not merely be wrong, it would split one frame into two and desynchronise
 * everything after it. Catalogue names cannot do this, but the raw feed also
 * carries rows written directly by other modules (`src/lib/approvals.ts` does),
 * so the value is not this module's to assume.
 */
function safeEventName(name: string): string {
  const cleaned = String(name).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return cleaned || 'event';
}

/**
 * One SSE frame.
 *
 * `data` is `JSON.stringify`'d, which cannot emit a raw newline, so the frame
 * is always exactly one `data:` line. `id` is an integer from
 * `domain_events.id`, so it cannot break the protocol either — and it is what
 * the browser replays in `Last-Event-ID`.
 */
export function frame(f: { id?: number; event: string; data: unknown }): string {
  const lines: string[] = [];
  if (f.id != null) lines.push(`id: ${f.id}`);
  lines.push(`event: ${safeEventName(f.event)}`);
  lines.push(`data: ${JSON.stringify(f.data)}`);
  return lines.join('\n') + '\n\n';
}

/** A comment frame. Carries no id, dispatches nothing, keeps the socket alive. */
export function comment(text: string): string {
  return `: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`;
}

// ─── Reading the feed for a channel ─────────────────────────────────────────

export interface PollResult {
  frames: string[];
  /**
   * Where the subscriber has now read to. This is the highest id the QUERY
   * returned, not the highest id FRAMED: events belonging to another
   * competition are filtered out after the window, and if the cursor did not
   * pass them a busy feed would re-read the same window forever.
   */
  cursor: number;
  /** The batch filled, so there is probably more waiting — do not sleep. */
  full: boolean;
  /** Raw mode: the clearance actually applied, for the `ready` frame. */
  clearance?: Classification;
}

function subjectMatches(grant: ChannelGrant, event: PublicEvent): boolean {
  if (grant.competitionId != null) {
    return Number((event.payload as any)?.competitionId) === grant.competitionId;
  }
  if (grant.liveClassId != null) {
    return event.entityType === LIVE_CLASS_ENTITY_TYPE && event.entityId === String(grant.liveClassId);
  }
  return true;
}

/**
 * What an admin subscriber receives for one raw event.
 *
 * The whole event, minus `actorUserId` and `publishedAt`. The actor's LABEL is
 * what an operations screen shows and what an operator can act on; the internal
 * user id adds nothing a screen uses and is one more identifier travelling over
 * a long-lived connection. `publishedAt` is an append timestamp with no meaning
 * to a consumer — `occurredAt` is when the fact happened, and conflating them
 * makes the feed lie about the day's timeline.
 */
function toAdminFrame(event: DomainEventRow) {
  return {
    id: event.id,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    classification: event.classification,
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : String(event.occurredAt),
    actorLabel: event.actorLabel,
    correlationId: event.correlationId,
    payload: event.payload,
  };
}

/**
 * Read one batch for a channel and turn it into frames.
 *
 * THE CURSOR IS THE ENTIRE RESUME MECHANISM. `domain_events.id` is the only
 * total order the feed has, the SQL is `id > cursor ORDER BY id LIMIT n`, and
 * the id of each event is what goes in the frame's `id:` field. A browser that
 * reconnects sends the last id it saw back in `Last-Event-ID`, that becomes the
 * cursor, and the subscriber resumes exactly where it stopped. Nothing is
 * remembered on the server between connections, which is what makes this work
 * on a deployment where the next connection reaches a different instance.
 *
 * WHERE THAT GUARANTEE ENDS, because domain-events.ts names the same gap and it
 * would be dishonest to restate the promise without it: `id` is allocated when
 * a publish BEGINS, not when it commits, so two concurrent publishers can commit
 * out of order and an event can become visible BELOW a cursor that has already
 * passed it. Such an event is not re-delivered, it is not delivered. The remedy
 * is a commit-ordered column or a fixed delay behind the head — both are
 * decisions for the feed, not for its transport. A page that cannot survive one
 * missed event must reconcile against `publicScoreboard()` rather than trust the
 * stream alone; which is, in any case, what a page wanting competitor names
 * already does.
 */
export async function pollChannel(
  db: DB,
  grant: ChannelGrant,
  cursor: number,
  limit: number = MAX_BATCH
): Promise<PollResult> {
  const batch = Math.min(Math.max(1, Math.trunc(limit) || MAX_BATCH), MAX_BATCH);

  if (grant.mode === 'raw') {
    const { clearance, events } = await readFeed(db, { principal: grant.principal }, {
      sinceId: cursor,
      limit: batch,
      upTo: grant.upTo,
      eventTypes: grant.eventTypes ? [...grant.eventTypes] : undefined,
    });
    let watermark = cursor;
    const frames: string[] = [];
    for (const e of events) {
      if (e.id > watermark) watermark = e.id;
      frames.push(frame({ id: e.id, event: e.eventType, data: toAdminFrame(e) }));
    }
    return { frames, cursor: watermark, full: events.length >= batch, clearance };
  }

  // Projection mode. publicFeed() applies the public ceiling in SQL and then
  // the catalogue's field allowlist — this module adds no allowlist of its own.
  const events = await publicFeed(db, {
    sinceId: cursor,
    limit: batch,
    eventTypes: grant.eventTypes ? [...grant.eventTypes] : undefined,
  });

  let watermark = cursor;
  const frames: string[] = [];
  for (const e of events) {
    if (e.id > watermark) watermark = e.id;
    if (!subjectMatches(grant, e)) continue;
    frames.push(frame({ id: e.id, event: e.eventType, data: e }));
  }
  return { frames, cursor: watermark, full: events.length >= batch };
}

/** The head of the feed: where a subscriber with no resume point starts. */
export async function currentHead(db: DB): Promise<number> {
  const rows = await db
    .select({ head: sql<number>`coalesce(max(${s.domainEvents.id}), 0)::int` })
    .from(s.domainEvents);
  return Number(rows[0]?.head ?? 0);
}

/**
 * Where this connection resumes from.
 *
 * `Last-Event-ID` is sent by the browser automatically on a reconnect; the
 * query parameter is for a client that is not an `EventSource` and for a first
 * connection that already knows where it stopped. Anything unparseable, negative
 * or absent means "from now" — the head — rather than 0, because 0 would replay
 * the federation's entire history to a scoreboard that just opened.
 *
 * AND IT IS CLAMPED TO THE HEAD, which is the part that is about safety rather
 * than about resumption. `domain_events.id` is an `integer`; a client that sends
 * `Last-Event-ID: 99999999999999999999` otherwise puts that number straight into
 * the `where id > …` of every poll, and Postgres answers "value out of range for
 * type integer" — so a header anyone can set turns into a database error inside
 * a stream that has already returned 200 and can no longer report it as a 400.
 * A cursor above the head also means nothing: there is no such event, so the
 * only honest reading of it is "from now", which is what the head is.
 */
export async function resolveCursor(
  db: DB,
  headerValue: string | null | undefined,
  queryValue: string | null | undefined
): Promise<number> {
  const head = await currentHead(db);
  const raw = (headerValue ?? queryValue ?? '').trim();
  if (!raw) return head;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return head;
  return Math.min(n, head);
}

// ─── The stream ─────────────────────────────────────────────────────────────

export interface StreamOptions {
  pollMs?: number;
  catchupMs?: number;
  heartbeatMs?: number;
  maxDurationMs?: number;
  maxBatch?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface OpenStreamInit {
  cursor: number;
  release?: (() => void) | null;
  signal?: AbortSignal | null;
  options?: StreamOptions;
}

/**
 * Open the stream for an authorised channel.
 *
 * The response headers are as load-bearing as the body:
 *   · `text/event-stream` is what makes a browser treat this as SSE at all;
 *   · `no-store, no-transform` stops a CDN caching a stream — and
 *     `no-transform` specifically stops an intermediary "optimising" it by
 *     buffering, which turns a live feed into a four-minute silence followed by
 *     everything at once;
 *   · `X-Accel-Buffering: no` says the same thing to an nginx in the path,
 *     which is the proxy most likely to be there and which buffers by default.
 *
 * NO `Access-Control-Allow-Origin`, DELIBERATELY, including on the public
 * scoreboard channel. `EventSource` sends cookies, so a permissive CORS header
 * would let any page on the internet open an authenticated admin channel using
 * a signed-in official's browser and read the result. The public channel is
 * left closed too rather than opened case by case: one rule that is always true
 * is safer than a rule with an exception nobody re-checks when a new channel is
 * added. A third-party venue display that genuinely needs this is a deliberate
 * decision for the federation to take, with an origin allowlist.
 */
export function openStream(db: DB, grant: ChannelGrant, init: OpenStreamInit): Response {
  const opts = init.options ?? {};
  const pollMs = opts.pollMs ?? POLL_MS;
  const catchupMs = opts.catchupMs ?? CATCHUP_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxDurationMs = opts.maxDurationMs ?? MAX_DURATION_MS;
  const maxBatch = opts.maxBatch ?? MAX_BATCH;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const encoder = new TextEncoder();
  let cursor = init.cursor;
  let finished = false;

  const release = () => init.release?.();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Not awaited: `start()` resolving is what lets the response begin, and
      // this loop runs for minutes. It cannot reject — every path is caught.
      void pump(controller);
    },
    cancel() {
      // The subscriber closed the tab. Stop the loop and give the slot back.
      finished = true;
      release();
    },
  }, { highWaterMark: STREAM_HIGH_WATER, size: () => 1 });

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>) {
    const send = (chunk: string): boolean => {
      if (finished) return false;
      try {
        controller.enqueue(encoder.encode(chunk));
        return true;
      } catch {
        finished = true;                      // the consumer went away mid-write
        return false;
      }
    };

    const startedAt = now();
    let lastSentAt = startedAt;

    send(`retry: ${RECONNECT_MS}\n\n`);
    send(frame({
      id: cursor,
      event: 'ready',
      data: {
        channel: grant.channel.name,
        audience: grant.audience,
        cursor,
        // Told, not guessed: a page that knows the duration cap can say
        // "reconnecting" instead of "connection lost".
        limits: {
          pollSeconds: pollMs / 1000,
          heartbeatSeconds: heartbeatMs / 1000,
          maxDurationSeconds: maxDurationMs / 1000,
          maxEventsPerPoll: maxBatch,
        },
      },
    }));

    try {
      while (!finished) {
        if (init.signal?.aborted) break;

        if (now() - startedAt >= maxDurationMs) {
          send(frame({
            event: 'closing',
            data: {
              reason: 'duration_cap',
              reconnect: true,
              message: 'This connection reached its time limit. Reconnect with Last-Event-ID to resume.',
            },
          }));
          break;
        }

        if (controller.desiredSize != null && controller.desiredSize < -BACKPRESSURE_LIMIT) {
          send(frame({
            event: 'closing',
            data: { reason: 'slow_consumer', reconnect: true, message: 'The client stopped reading this stream.' },
          }));
          break;
        }

        const batch = await pollChannel(db, grant, cursor, maxBatch);
        cursor = batch.cursor;

        if (batch.frames.length) {
          for (const f of batch.frames) if (!send(f)) break;
          lastSentAt = now();
        } else if (now() - lastSentAt >= heartbeatMs) {
          send(comment(`keep-alive ${new Date(now()).toISOString()}`));
          lastSentAt = now();
        }

        // A full batch means a backlog, not a rate limit — the batch cap is
        // there to keep each response small, so come back for the next one
        // after the catch-up pause rather than the idle one, and never with no
        // pause at all (see CATCHUP_MS for why "no pause" was the wrong answer).
        await sleep(batch.full ? catchupMs : pollMs, init.signal ?? undefined);
      }
    } catch (err) {
      // The database went away, or the query failed. Say so and close: a client
      // left hanging on a dead stream shows stale figures as if they were live.
      console.error('[stream] poll failed', { channel: grant.channel.name, error: String(err) });
      send(frame({
        event: 'error',
        data: {
          reason: 'upstream_unavailable',
          reconnect: true,
          message: 'Live updates stopped. The page should fall back to refreshing.',
        },
      }));
    } finally {
      finished = true;
      release();
      try { controller.close(); } catch { /* already closed by cancel() */ }
    }
  }

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
