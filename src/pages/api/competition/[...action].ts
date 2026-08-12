// Competition administration, entry, draws and the live scoreboard — one API.
//
// Every write here is a thin shell over src/db/competition.ts, src/db/draws.ts
// and src/db/matches.ts. Those modules hold the state machines, the eligibility
// evidence, the append-only scoring log and the placing rules. This file does
// four things and nothing else:
//
//   1. identify() the caller — never a cookie read of its own (§75);
//   2. rate limit, cap and parse the body;
//   3. call the module and let ITS typed error decide the status code;
//   4. return the module's own message, which was written to be read by a human.
//
// TWO DELIBERATE DEPARTURES, both documented where they occur:
//
//  · MAT ASSIGNMENT writes matches.mat / matches.scheduled_at directly, because
//    no module function owns it yet. Authorisation still goes through rbac and
//    the change is still audited through writeAudit — nothing is re-implemented
//    — but the write itself belongs in src/db/matches.ts as assignMat(). That is
//    reported as a shared-file need rather than done here.
//
//  · THE SCORING RULESET is held in the shared store, per event, because there
//    is no competition_rulesets table. src/db/matches.ts refuses to score
//    without an approved ruleset, and this file refuses to invent one: point
//    values, tie-breaks and placings are MMAKF competition regulation. What is
//    provided is the MECHANISM to capture the federation's own ruleset — keyed
//    to the event, validated by requireRuleset() on the way in AND on the way
//    out, and audited. A client never supplies point values on a scoring
//    request; the server loads the recorded ruleset itself.
//
// The public read path (publicEvents / publicEventDetail / publicScoreboard) is
// exported for the three pages that render it, so there is ONE definition of
// what the public may see rather than one per page. It is read-only, takes no
// principal, and is deliberately narrow: an event the federation has not
// published is not there, an unpublished draw is not there, and a result that is
// not locked FINAL is not there.

import type { APIRoute } from 'astro';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { assertCan, ForbiddenError } from '@/lib/rbac';
import { isConfigured, db, schema as s } from '@/db';
import { writeAudit, type AuditContext } from '@/db/federation';
import { get as storeGet, set as storeSet } from '@/lib/storage';
import {
  CompetitionError, LEGAL_TRANSITIONS,
  createEvent, transitionEvent, sanctionEvent, addCategory,
  enterEvent, checkIn, recordWeighIn, withdraw,
  listEvents, eventWithCategories, categoryEntries,
  type EventStatus,
} from '@/db/competition';
import { DrawError, generateDraw, publishDraw, readDraw } from '@/db/draws';
import {
  MatchError, requireRuleset, allowedTransitions,
  transitionMatch, recordMatchEvent, correctMatchEvent, completeMatch,
  finaliseResults, officialResults, explainMatch,
  type ScoringRuleset, type MatchState,
} from '@/db/matches';

export const prerender = false;

// ─── Shared plumbing ────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * The module's error code decides the status. Nothing here inspects a message.
 *
 * Codes are named consistently across the three modules — unknown_* for a
 * missing row, already_* for a repeated act — so this is a rule rather than a
 * list that goes stale each time a module gains a case.
 */
function statusForCode(code: string): number {
  if (/^unknown_/.test(code)) return 404;
  if (/^(already_|duplicate_)/.test(code)) return 409;
  if (/^(no_change|results_exist|superseded|log_inconsistent|sequence_contention|results_finalised|match_closed|entries_locked)$/.test(code)) return 409;
  return 400;
}

function errorResponse(err: any): Response {
  if (err instanceof ForbiddenError) {
    return json(
      {
        error: 'You do not hold the authority for this action in this scope.',
        code: 'forbidden',
        action: err.action,
      },
      403
    );
  }
  if (err instanceof CompetitionError || err instanceof DrawError || err instanceof MatchError) {
    return json({ error: err.message, code: err.code }, statusForCode(err.code));
  }
  // Never leak a stack trace to the caller.
  console.error('[competition] unexpected', err);
  return json({ error: 'The request could not be completed.' }, 500);
}

/** Federation records need the federation database. Say so plainly. */
function requireDatabase(): Response | null {
  if (isConfigured()) return null;
  return json(
    {
      error:
        'The federation database is not configured on this deployment, so competition records cannot be read or written. Set DATABASE_URL.',
      code: 'database_not_configured',
    },
    503
  );
}

async function readBody(request: Request, cap = 16384): Promise<any> {
  const raw = await request.text();
  if (raw.length > cap) throw new CompetitionError('request_too_large', 'Request too large.');
  let parsed: any;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    throw new CompetitionError('invalid_json', 'Invalid request.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompetitionError('invalid_body', 'Invalid request.');
  }
  return parsed;
}

function intField(body: any, name: string, required = true): number | null {
  const v = body[name];
  if (v == null || v === '') {
    if (required) throw new CompetitionError('missing_field', `${name} is required.`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new CompetitionError('bad_field', `${name} must be a whole number.`);
  return n;
}

function textField(body: any, name: string, required = false, max = 2000): string | null {
  const v = body[name];
  if (v == null || v === '') {
    if (required) throw new CompetitionError('missing_field', `${name} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new CompetitionError('bad_field', `${name} must be text.`);
  const t = v.trim();
  if (!t.length) {
    if (required) throw new CompetitionError('missing_field', `${name} is required.`);
    return null;
  }
  if (t.length > max) throw new CompetitionError('bad_field', `${name} is too long.`);
  return t;
}

function dateField(body: any, name: string): Date | null {
  const t = textField(body, name, false, 40);
  if (t == null) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new CompetitionError('bad_field', `${name} is not a valid date and time.`);
  return d;
}

function auditContext(
  identity: NonNullable<Awaited<ReturnType<typeof identify>>>,
  request: Request,
  reason?: string | null
): AuditContext {
  return {
    principal: identity.principal,
    ip: clientIp(request),
    reason: reason ?? null,
    // A shared credential is recorded as shared: the trail must never imply an
    // individual took an act it cannot attribute to one.
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };
}

// ─── The scoring ruleset ────────────────────────────────────────────────────
//
// Held per event in the shared store until a competition_rulesets table exists.
// Recording one is an administrative act with an audit row; reading one back
// re-validates it, so a ruleset edited into an incoherent state stops scoring
// rather than silently changing what a point is worth.

const rulesetKey = (eventId: number) => `competitionRuleset:${eventId}`;

export interface StoredRuleset {
  ruleset: ScoringRuleset;
  recordedAt: string;
  recordedBy: string;
  /** What the federation says this ruleset IS — its published reference. */
  authority: string | null;
}

export type RulesetLookup =
  | { ok: true; stored: StoredRuleset }
  | { ok: false; reason: string };

export async function loadRuleset(eventId: number): Promise<RulesetLookup> {
  let raw: any = null;
  try {
    raw = await storeGet<any>(rulesetKey(eventId));
  } catch {
    return { ok: false, reason: 'The shared store could not be read, so the scoring ruleset is unavailable.' };
  }
  if (!raw || typeof raw !== 'object' || !raw.ruleset) {
    return {
      ok: false,
      reason:
        'No scoring ruleset has been recorded for this event. Point values, tie-breaks and placings are set by the competition regulations in force — they are not assumed here — so nothing can be scored until an officer records them against this event.',
    };
  }
  try {
    requireRuleset(raw.ruleset as ScoringRuleset);
  } catch (err: any) {
    return {
      ok: false,
      reason: `The recorded scoring ruleset for this event is not usable: ${err?.message ?? 'it failed validation'}`,
    };
  }
  return {
    ok: true,
    stored: {
      ruleset: raw.ruleset as ScoringRuleset,
      recordedAt: String(raw.recordedAt ?? ''),
      recordedBy: String(raw.recordedBy ?? ''),
      authority: raw.authority == null ? null : String(raw.authority),
    },
  };
}

/** The ruleset or a refusal — used by every endpoint that would otherwise guess. */
async function requireStoredRuleset(eventId: number): Promise<ScoringRuleset> {
  const found = await loadRuleset(eventId);
  if (!found.ok) throw new MatchError('ruleset_not_recorded', found.reason);
  return found.stored.ruleset;
}

// ─── Read projections ───────────────────────────────────────────────────────
//
// Authorisation for every one of these comes from a module read that asserts
// first (eventWithCategories / categoryEntries / listEvents). What follows is
// projection only — joining names onto ids — never a second opinion on access.

async function eventById(dbc: any, eventId: number) {
  return (await dbc.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, eventId)).limit(1))[0] ?? null;
}

/** entryId → { entryNo, name, dojo } for a set of entries. */
async function entryLabels(dbc: any, entryIds: number[]) {
  const map = new Map<number, { entryNo: string; name: string | null; dojo: string | null }>();
  if (!entryIds.length) return map;
  const rows = await dbc
    .select({
      id: s.eventEntries.id,
      entryNo: s.eventEntries.entryNo,
      fullName: s.persons.fullName,
      dojoName: s.dojos.name,
    })
    .from(s.eventEntries)
    .leftJoin(s.persons, eq(s.eventEntries.personId, s.persons.id))
    .leftJoin(s.dojos, eq(s.eventEntries.dojoId, s.dojos.id))
    .where(inArray(s.eventEntries.id, entryIds));
  for (const r of rows as any[]) {
    map.set(r.id, { entryNo: r.entryNo, name: r.fullName ?? null, dojo: r.dojoName ?? null });
  }
  return map;
}

/** Match rows with competitor names attached. */
async function matchesWithNames(dbc: any, where: any) {
  const rows = await dbc
    .select({
      id: s.matches.id,
      matchNo: s.matches.matchNo,
      drawId: s.matches.drawId,
      categoryId: s.matches.categoryId,
      eventId: s.matches.eventId,
      round: s.matches.round,
      roundOrder: s.matches.roundOrder,
      poolLabel: s.matches.poolLabel,
      mat: s.matches.mat,
      scheduledAt: s.matches.scheduledAt,
      startedAt: s.matches.startedAt,
      endedAt: s.matches.endedAt,
      status: s.matches.status,
      redEntryId: s.matches.redEntryId,
      blueEntryId: s.matches.blueEntryId,
      redScore: s.matches.redScore,
      blueScore: s.matches.blueScore,
      redPenalties: s.matches.redPenalties,
      bluePenalties: s.matches.bluePenalties,
      winnerEntryId: s.matches.winnerEntryId,
      winMethod: s.matches.winMethod,
      updatedAt: s.matches.updatedAt,
      categoryLabel: s.eventCategories.label,
      categoryCode: s.eventCategories.code,
      discipline: s.eventCategories.discipline,
    })
    .from(s.matches)
    .leftJoin(s.eventCategories, eq(s.matches.categoryId, s.eventCategories.id))
    .where(where)
    .orderBy(asc(s.matches.mat), asc(s.matches.scheduledAt), asc(s.matches.roundOrder), asc(s.matches.id));

  const ids = new Set<number>();
  for (const r of rows as any[]) {
    for (const v of [r.redEntryId, r.blueEntryId, r.winnerEntryId]) if (v != null) ids.add(v);
  }
  const labels = await entryLabels(dbc, [...ids]);
  return (rows as any[]).map((r) => ({
    ...r,
    red: r.redEntryId == null ? null : labels.get(r.redEntryId) ?? null,
    blue: r.blueEntryId == null ? null : labels.get(r.blueEntryId) ?? null,
    winner: r.winnerEntryId == null ? null : labels.get(r.winnerEntryId) ?? null,
  }));
}

/** Entry counts per category, by status. */
async function entryCounts(dbc: any, eventId: number) {
  const rows = await dbc
    .select({
      categoryId: s.eventEntries.categoryId,
      status: s.eventEntries.status,
      n: sql<number>`count(*)::int`,
    })
    .from(s.eventEntries)
    .where(eq(s.eventEntries.eventId, eventId))
    .groupBy(s.eventEntries.categoryId, s.eventEntries.status);
  const byCategory = new Map<number, Record<string, number>>();
  for (const r of rows as any[]) {
    const bucket = byCategory.get(r.categoryId) ?? {};
    bucket[r.status] = Number(r.n);
    byCategory.set(r.categoryId, bucket);
  }
  return byCategory;
}

async function drawsForEvent(dbc: any, categoryIds: number[]) {
  if (!categoryIds.length) return [] as any[];
  return dbc.select().from(s.draws)
    .where(inArray(s.draws.categoryId, categoryIds))
    .orderBy(asc(s.draws.categoryId), asc(s.draws.id));
}

async function officialsForEvent(dbc: any, eventId: number) {
  return dbc
    .select({
      id: s.eventOfficials.id,
      personId: s.eventOfficials.personId,
      role: s.eventOfficials.role,
      mat: s.eventOfficials.mat,
      fullName: s.persons.fullName,
      federationId: s.persons.federationId,
    })
    .from(s.eventOfficials)
    .leftJoin(s.persons, eq(s.eventOfficials.personId, s.persons.id))
    .where(eq(s.eventOfficials.eventId, eventId))
    .orderBy(asc(s.eventOfficials.role), asc(s.eventOfficials.id));
}

/**
 * Everything /admin/competition needs about one event, in one call.
 * eventWithCategories() authorises; nothing below widens that decision.
 */
export async function adminEventDetail(principal: any, eventId: number) {
  const dbc = db();
  const { event, categories } = await eventWithCategories(dbc, principal, eventId);
  const categoryIds = (categories as any[]).map((c) => c.id);
  const [counts, draws, matches, officials, ruleset] = await Promise.all([
    entryCounts(dbc, eventId),
    drawsForEvent(dbc, categoryIds),
    matchesWithNames(dbc, eq(s.matches.eventId, eventId)),
    officialsForEvent(dbc, eventId),
    loadRuleset(eventId),
  ]);

  const supersededDrawIds = new Set(
    (draws as any[]).filter((d) => d.supersedesDrawId != null).map((d) => d.supersedesDrawId)
  );

  return {
    event,
    legalNextStatuses: LEGAL_TRANSITIONS[event.status as EventStatus] ?? [],
    categories: (categories as any[]).map((c) => ({
      ...c,
      counts: counts.get(c.id) ?? {},
      draws: (draws as any[])
        .filter((d) => d.categoryId === c.id)
        .map((d) => ({ ...d, superseded: supersededDrawIds.has(d.id) })),
    })),
    matches,
    officials,
    ruleset,
  };
}

// ─── The public read path ───────────────────────────────────────────────────
//
// One definition of public visibility, used by /competitions and /scoreboard.
// These functions take NO principal and perform NO writes.

/** An event is public information from publication onwards, and never before. */
const PUBLIC_EVENT_STATUSES: readonly string[] = [
  'published', 'registration_open', 'registration_closed',
  'check_in', 'live', 'results_pending', 'results_final', 'archived',
];

/** Entry lists become public once entries have closed, not while they are open. */
const ENTRY_LIST_PUBLIC_FROM: readonly string[] = [
  'registration_closed', 'check_in', 'live', 'results_pending', 'results_final', 'archived',
];

/** Entry states that describe someone who is actually in the competition. */
const PUBLIC_ENTRY_STATUSES: readonly string[] = ['confirmed', 'checked_in', 'weighed_in', 'withdrawn'];

/** A result is public only once it is LOCKED. Provisional never appears. */
const PUBLIC_RESULT_STATUSES: readonly string[] = ['final', 'corrected'];

const PUBLIC_EVENT_COLUMNS = {
  id: s.competitionEvents.id,
  code: s.competitionEvents.code,
  title: s.competitionEvents.title,
  kind: s.competitionEvents.kind,
  status: s.competitionEvents.status,
  startsOn: s.competitionEvents.startsOn,
  endsOn: s.competitionEvents.endsOn,
  venue: s.competitionEvents.venue,
  city: s.competitionEvents.city,
  registrationOpensAt: s.competitionEvents.registrationOpensAt,
  registrationClosesAt: s.competitionEvents.registrationClosesAt,
  sanctionReference: s.competitionEvents.sanctionReference,
  sanctionedAt: s.competitionEvents.sanctionedAt,
  rulesetVersion: s.competitionEvents.rulesetVersion,
  contactEmail: s.competitionEvents.contactEmail,
  contactPhone: s.competitionEvents.contactPhone,
  description: s.competitionEvents.description,
  resultsFinalisedAt: s.competitionEvents.resultsFinalisedAt,
};

export async function publicEvents(limit = 60) {
  const dbc = db();
  return dbc
    .select(PUBLIC_EVENT_COLUMNS)
    .from(s.competitionEvents)
    .where(inArray(s.competitionEvents.status, PUBLIC_EVENT_STATUSES as any))
    .orderBy(asc(s.competitionEvents.startsOn), asc(s.competitionEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** The draws that are published and have not been superseded, by category. */
async function publishedDraws(dbc: any, categoryIds: number[]) {
  if (!categoryIds.length) return [] as any[];
  const rows = await dbc.select().from(s.draws).where(inArray(s.draws.categoryId, categoryIds));
  const superseded = new Set(
    (rows as any[]).filter((d) => d.supersedesDrawId != null).map((d) => d.supersedesDrawId)
  );
  return (rows as any[]).filter((d) => d.publishedAt != null && !superseded.has(d.id));
}

/**
 * One event, as the public may see it.
 * Returns null when the event is not public — the caller renders "not found"
 * rather than "you may not see this", which would confirm it exists.
 */
export async function publicEventDetail(eventId: number) {
  const dbc = db();
  const event = (await dbc.select(PUBLIC_EVENT_COLUMNS).from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, eventId)).limit(1))[0] as any;
  if (!event || !PUBLIC_EVENT_STATUSES.includes(event.status)) return null;

  const categories = await dbc.select().from(s.eventCategories)
    .where(eq(s.eventCategories.eventId, eventId))
    .orderBy(asc(s.eventCategories.displayOrder), asc(s.eventCategories.code));
  const categoryIds = (categories as any[]).map((c) => c.id);

  const entriesPublic = ENTRY_LIST_PUBLIC_FROM.includes(event.status);

  const entryRows = categoryIds.length
    ? await dbc
        .select({
          id: s.eventEntries.id,
          entryNo: s.eventEntries.entryNo,
          categoryId: s.eventEntries.categoryId,
          status: s.eventEntries.status,
          seed: s.eventEntries.seed,
          fullName: s.persons.fullName,
          dojoName: s.dojos.name,
        })
        .from(s.eventEntries)
        .leftJoin(s.persons, eq(s.eventEntries.personId, s.persons.id))
        .leftJoin(s.dojos, eq(s.eventEntries.dojoId, s.dojos.id))
        .where(and(
          eq(s.eventEntries.eventId, eventId),
          inArray(s.eventEntries.status, PUBLIC_ENTRY_STATUSES as any)
        ))
        .orderBy(asc(s.eventEntries.entryNo))
    : [];

  const draws = await publishedDraws(dbc, categoryIds);
  const brackets = new Map<number, any>();
  for (const d of draws) {
    // readDraw refuses an unpublished draw to a null viewer; these are published,
    // so the refusal cannot fire — the filter above is what makes that true.
    const { matches } = await readDraw(dbc, d.id, null);
    brackets.set(d.categoryId, { draw: d, matches });
  }

  const resultRows = new Map<number, any[]>();
  for (const id of categoryIds) {
    const rows = (await officialResults(dbc, id)).filter((r: any) =>
      PUBLIC_RESULT_STATUSES.includes(r.status)
    );
    if (rows.length) resultRows.set(id, rows);
  }
  const resultEntryIds = [...resultRows.values()].flat().map((r: any) => r.entryId);
  const resultLabels = await entryLabels(dbc, resultEntryIds);

  return {
    event,
    entriesPublic,
    categories: (categories as any[]).map((c) => {
      const entries = (entryRows as any[]).filter((e) => e.categoryId === c.id);
      const bracket = brackets.get(c.id) ?? null;
      const results = (resultRows.get(c.id) ?? []).map((r: any) => ({
        placing: r.placing,
        medal: r.medal,
        status: r.status,
        corrected: r.corrected,
        matchesWon: r.matchesWon,
        matchesLost: r.matchesLost,
        competitor: resultLabels.get(r.entryId) ?? null,
      }));
      return {
        id: c.id,
        code: c.code,
        label: c.label,
        discipline: c.discipline,
        gender: c.gender,
        ageGroup: c.ageGroup,
        drawFormat: c.drawFormat,
        maxEntries: c.maxEntries,
        entryCount: entries.filter((e) => e.status !== 'withdrawn').length,
        entries: entriesPublic
          ? entries.map((e) => ({
              entryNo: e.entryNo,
              name: e.fullName ?? null,
              dojo: e.dojoName ?? null,
              seed: e.seed,
              status: e.status,
            }))
          : [],
        bracket,
        results,
      };
    }),
  };
}

/**
 * The live scoreboard for one event, by mat.
 *
 * Only matches belonging to a PUBLISHED draw appear: a scoreboard is not a
 * place to leak a bracket nobody has published. Nothing here writes, and no
 * caller of this function can reach a write — it is a separate read path.
 */
export async function publicScoreboard(eventId: number, mat?: string | null) {
  const dbc = db();
  const event = (await dbc.select(PUBLIC_EVENT_COLUMNS).from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, eventId)).limit(1))[0] as any;
  if (!event || !PUBLIC_EVENT_STATUSES.includes(event.status)) return null;

  const categories = await dbc.select({ id: s.eventCategories.id })
    .from(s.eventCategories).where(eq(s.eventCategories.eventId, eventId));
  const drawIds = (await publishedDraws(dbc, (categories as any[]).map((c) => c.id))).map((d: any) => d.id);

  const refreshedAt = new Date().toISOString();
  if (!drawIds.length) {
    return { event, mats: [], matches: [], refreshedAt, note: 'No draw for this event has been published yet.' };
  }

  const all = await matchesWithNames(dbc, and(
    eq(s.matches.eventId, eventId),
    inArray(s.matches.drawId, drawIds)
  ));

  const filtered = mat ? all.filter((m: any) => (m.mat ?? '') === mat) : all;
  const matNames = [...new Set(all.map((m: any) => m.mat ?? ''))].sort();

  // "Current" is what an official would point at: a bout in progress, else one
  // that has been called, else the next one scheduled. Nothing is inferred about
  // a bout that has finished.
  const byMat = matNames
    .filter((name) => !mat || name === mat)
    .map((name) => {
      const rows = filtered.filter((m: any) => (m.mat ?? '') === name);
      const running = rows.filter((m: any) => m.status === 'in_progress' || m.status === 'paused');
      const called = rows.filter((m: any) => m.status === 'called');
      const upcoming = rows.filter((m: any) => m.status === 'scheduled');
      const current = running[0] ?? called[0] ?? upcoming[0] ?? null;
      const next = current ? upcoming.find((m: any) => m.id !== current.id) ?? null : null;
      const done = rows
        .filter((m: any) => ['completed', 'walkover', 'disqualification'].includes(m.status))
        .slice(-5)
        .reverse();
      return { mat: name, current, next, recent: done, queued: upcoming.length };
    });

  return { event, mats: matNames, byMat, refreshedAt, note: null as string | null };
}

// ─── GET ────────────────────────────────────────────────────────────────────

const PUBLIC_ACTIONS = new Set(['public-events', 'public-event', 'scoreboard']);

export const GET: APIRoute = async ({ params, request, url }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  const isPublic = PUBLIC_ACTIONS.has(action);

  const rl = await rateLimit(request, isPublic ? 'competition-public' : 'competition-read', isPublic ? 240 : 240, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const unavailable = requireDatabase();
  if (unavailable) return unavailable;

  try {
    if (isPublic) {
      if (action === 'public-events') {
        return json({ events: await publicEvents(Number(url.searchParams.get('limit') ?? 60)) }, 200);
      }
      const eventId = Number(url.searchParams.get('event') ?? url.searchParams.get('id') ?? '');
      if (!Number.isInteger(eventId)) return json({ error: 'An event id is required.' }, 400);

      if (action === 'public-event') {
        const detail = await publicEventDetail(eventId);
        if (!detail) return json({ error: 'No published event with that reference.' }, 404);
        return json(detail, 200);
      }
      // scoreboard
      const board = await publicScoreboard(eventId, url.searchParams.get('mat'));
      if (!board) return json({ error: 'No published event with that reference.' }, 404);
      return json(board, 200);
    }

    const identity = await identify(request.headers.get('cookie'));
    if (!identity) return json({ error: 'Sign in to read competition records.' }, 401);

    if (action === 'events') {
      const statusParam = url.searchParams.get('status');
      const status = statusParam
        ? (statusParam.split(',').map((x) => x.trim()).filter(Boolean) as EventStatus[])
        : undefined;
      const events = await listEvents(db(), identity.principal, { status, limit: 200 });
      return json({ events }, 200);
    }

    if (action === 'event') {
      const id = Number(url.searchParams.get('id') ?? '');
      if (!Number.isInteger(id)) return json({ error: 'An event id is required.' }, 400);
      return json(await adminEventDetail(identity.principal, id), 200);
    }

    if (action === 'category') {
      const id = Number(url.searchParams.get('id') ?? '');
      if (!Number.isInteger(id)) return json({ error: 'A category id is required.' }, 400);
      const dbc = db();
      const { category, entries } = await categoryEntries(dbc, identity.principal, id);
      const draws = await drawsForEvent(dbc, [id]);
      const matches = await matchesWithNames(dbc, eq(s.matches.categoryId, id));
      const results = await officialResults(dbc, id);
      return json({ category, entries, draws, matches, results }, 200);
    }

    if (action === 'match') {
      const id = Number(url.searchParams.get('id') ?? '');
      if (!Number.isInteger(id)) return json({ error: 'A match id is required.' }, 400);
      const dbc = db();
      const detail = await explainMatch(dbc, id);
      const event = await eventById(dbc, detail.match.eventId);
      // explainMatch is deliberately unguarded so a disputed log can always be
      // rendered; the read is gated here against the event's own placement.
      assertCan(identity.principal, 'competition:read', {
        stateUnitId: event?.stateUnitId ?? null,
        districtUnitId: event?.districtUnitId ?? null,
        dojoId: event?.organiserDojoId ?? null,
      });
      return json(
        { ...detail, allowedTransitions: allowedTransitions(detail.match.status as MatchState) },
        200
      );
    }

    if (action === 'draw') {
      const id = Number(url.searchParams.get('id') ?? '');
      if (!Number.isInteger(id)) return json({ error: 'A draw id is required.' }, 400);
      return json(await readDraw(db(), id, identity.principal), 200);
    }

    return json({ error: 'Unknown competition endpoint.' }, 404);
  } catch (err: any) {
    return errorResponse(err);
  }
};

// ─── POST ───────────────────────────────────────────────────────────────────

/** Scoring is tapped repeatedly at the mat side; the others are not. */
function limitFor(action: string): { bucket: string; limit: number } {
  if (action === 'score' || action === 'reverse-score') return { bucket: 'competition-score', limit: 300 };
  return { bucket: 'competition-write', limit: 90 };
}

export const POST: APIRoute = async ({ params, request }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  const { bucket, limit } = limitFor(action);
  const rl = await rateLimit(request, bucket, limit, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to record a competition action.' }, 401);

  const unavailable = requireDatabase();
  if (unavailable) return unavailable;

  try {
    const body = await readBody(request, action === 'set-ruleset' ? 65536 : 16384);
    const dbc = db();
    const ctx = auditContext(identity, request, textField(body, 'reason', false, 1000));

    switch (action) {
      // ─── Events ──────────────────────────────────────────────────────────
      case 'create-event': {
        const row = await createEvent(dbc, ctx, {
          title: textField(body, 'title', true, 200)!,
          kind: String(body.kind ?? '') as any,
          startsOn: textField(body, 'startsOn', false, 20),
          endsOn: textField(body, 'endsOn', false, 20),
          venue: textField(body, 'venue', false, 200),
          city: textField(body, 'city', false, 120),
          stateUnitId: intField(body, 'stateUnitId', false),
          districtUnitId: intField(body, 'districtUnitId', false),
          organiserDojoId: intField(body, 'organiserDojoId', false),
          registrationOpensAt: dateField(body, 'registrationOpensAt'),
          registrationClosesAt: dateField(body, 'registrationClosesAt'),
          contactEmail: textField(body, 'contactEmail', false, 200),
          contactPhone: textField(body, 'contactPhone', false, 40),
          description: textField(body, 'description', false, 4000),
          rulesetVersion: textField(body, 'rulesetVersion', false, 120),
        });
        return json({ event: row }, 201);
      }

      case 'transition-event': {
        const row = await transitionEvent(dbc, ctx, {
          eventId: intField(body, 'eventId')!,
          to: String(body.to ?? '') as EventStatus,
          reason: textField(body, 'reason', true, 1000)!,
        });
        return json({ event: row }, 200);
      }

      case 'sanction-event': {
        const row = await sanctionEvent(dbc, ctx, {
          eventId: intField(body, 'eventId')!,
          sanctionedByPersonId: intField(body, 'sanctionedByPersonId')!,
          sanctionReference: textField(body, 'sanctionReference', true, 200)!,
          rulesetVersion: textField(body, 'rulesetVersion', false, 120),
          reason: textField(body, 'reason', false, 1000),
        });
        return json({ event: row }, 200);
      }

      // ─── Categories ──────────────────────────────────────────────────────
      case 'add-category': {
        const row = await addCategory(dbc, ctx, {
          eventId: intField(body, 'eventId')!,
          code: textField(body, 'code', true, 40)!,
          label: textField(body, 'label', true, 160)!,
          discipline: String(body.discipline ?? '') as any,
          gender: textField(body, 'gender', false, 40),
          ageGroup: textField(body, 'ageGroup', false, 60),
          minAgeYears: intField(body, 'minAgeYears', false),
          maxAgeYears: intField(body, 'maxAgeYears', false),
          bornOnOrAfter: textField(body, 'bornOnOrAfter', false, 20),
          bornOnOrBefore: textField(body, 'bornOnOrBefore', false, 20),
          minWeightGrams: intField(body, 'minWeightGrams', false),
          maxWeightGrams: intField(body, 'maxWeightGrams', false),
          minGradeOrdinal: intField(body, 'minGradeOrdinal', false),
          minGradeKind: (textField(body, 'minGradeKind', false, 10) as any) ?? null,
          teamSize: intField(body, 'teamSize', false),
          drawFormat: (textField(body, 'drawFormat', false, 40) as any) ?? null,
          maxEntries: intField(body, 'maxEntries', false),
          entriesPerDojo: intField(body, 'entriesPerDojo', false),
          feeCode: textField(body, 'feeCode', false, 60),
          displayOrder: intField(body, 'displayOrder', false) ?? 0,
        });
        return json({ category: row }, 201);
      }

      // ─── Entries ─────────────────────────────────────────────────────────
      case 'enter': {
        const members = Array.isArray(body.members)
          ? body.members.slice(0, 12).map((m: any) => ({
              personId: Number(m?.personId),
              role: typeof m?.role === 'string' ? m.role : null,
              position: Number.isInteger(m?.position) ? m.position : null,
            }))
          : undefined;
        const row = await enterEvent(dbc, ctx, {
          categoryId: intField(body, 'categoryId')!,
          personId: intField(body, 'personId', false),
          members,
          dojoId: intField(body, 'dojoId', false),
          orderId: intField(body, 'orderId', false),
        });
        return json(row, 201);
      }

      case 'check-in': {
        const row = await checkIn(dbc, ctx, intField(body, 'entryId')!);
        return json({ entry: row }, 200);
      }

      case 'weigh-in': {
        const result = await recordWeighIn(dbc, ctx, {
          entryId: intField(body, 'entryId')!,
          grams: intField(body, 'grams')!,
          officialPersonId: intField(body, 'officialPersonId')!,
        });
        return json(result, 200);
      }

      case 'withdraw': {
        const row = await withdraw(dbc, ctx, {
          entryId: intField(body, 'entryId')!,
          reason: textField(body, 'reason', true, 1000)!,
        });
        return json({ entry: row }, 200);
      }

      // ─── Draws ───────────────────────────────────────────────────────────
      case 'generate-draw': {
        const row = await generateDraw(dbc, ctx, {
          categoryId: intField(body, 'categoryId')!,
          format: (textField(body, 'format', false, 40) as any) ?? null,
          seed: textField(body, 'seed', false, 120),
          reason: textField(body, 'reason', false, 1000),
        });
        return json(row, 201);
      }

      case 'publish-draw': {
        const row = await publishDraw(dbc, ctx, intField(body, 'drawId')!);
        return json({ draw: row }, 200);
      }

      // ─── The scoring ruleset ─────────────────────────────────────────────
      case 'set-ruleset': {
        const eventId = intField(body, 'eventId')!;
        const event = await eventById(dbc, eventId);
        if (!event) throw new CompetitionError('unknown_event', 'Unknown competition event');
        // Recording the regulations an event is scored under is an act over the
        // event, so it takes the same authority as writing the event itself.
        assertCan(identity.principal, 'competition:write', {
          stateUnitId: event.stateUnitId,
          districtUnitId: event.districtUnitId,
          dojoId: event.organiserDojoId,
        });

        let candidate: any = body.ruleset;
        if (typeof candidate === 'string') {
          try {
            candidate = JSON.parse(candidate);
          } catch {
            throw new MatchError('bad_ruleset', 'The ruleset must be valid JSON.');
          }
        }
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new MatchError('bad_ruleset', 'The ruleset must be a JSON object.');
        }
        // requireRuleset() is the module's own validator: every point value, every
        // awardTo, every ending action is checked there and refused here.
        const ruleset = requireRuleset(candidate as ScoringRuleset);

        const previous = await loadRuleset(eventId);
        const stored: StoredRuleset = {
          ruleset,
          recordedAt: new Date().toISOString(),
          recordedBy: identity.principal.label,
          authority: textField(body, 'authority', false, 200),
        };
        await storeSet(rulesetKey(eventId), stored);

        await writeAudit(dbc, { ...ctx, authority: stored.authority ?? ctx.authority ?? null }, {
          entityType: 'competition_event_ruleset',
          entityId: eventId,
          action: 'update',
          oldValue: previous.ok ? { code: previous.stored.ruleset.code, recordedAt: previous.stored.recordedAt } : { recorded: false },
          newValue: { code: ruleset.code, actions: Object.keys(ruleset.actions), recordedAt: stored.recordedAt },
        });
        return json({ stored }, 200);
      }

      // ─── Matches ─────────────────────────────────────────────────────────
      case 'transition-match': {
        const row = await transitionMatch(dbc, ctx, {
          matchId: intField(body, 'matchId')!,
          to: String(body.to ?? '') as MatchState,
          reason: textField(body, 'reason', false, 1000) ?? undefined,
          winnerEntryId: intField(body, 'winnerEntryId', false),
          winMethod: textField(body, 'winMethod', false, 60) ?? undefined,
        });
        return json({ match: row }, 200);
      }

      /**
       * Mat and time assignment.
       *
       * The one write in this file that does not go through a module function,
       * because none owns it yet. It still asks rbac for authority and still
       * writes an audit row; what it must NOT become is a general-purpose match
       * editor, so exactly two columns are writable and a closed bout is refused.
       */
      case 'assign-mat': {
        const matchId = intField(body, 'matchId')!;
        const match = (await dbc.select().from(s.matches).where(eq(s.matches.id, matchId)).limit(1))[0] as any;
        if (!match) throw new MatchError('unknown_match', 'Unknown match');
        const event = await eventById(dbc, match.eventId);
        if (!event) throw new MatchError('unknown_event', 'Unknown competition event');
        assertCan(identity.principal, 'competition:write', {
          stateUnitId: event.stateUnitId,
          districtUnitId: event.districtUnitId,
          dojoId: event.organiserDojoId,
        });
        if (event.resultsFinalisedAt) {
          throw new MatchError(
            'results_finalised',
            'Results for this event are finalised; the schedule it was run to cannot be rewritten afterwards.'
          );
        }
        if (['completed', 'walkover', 'disqualification', 'cancelled', 'under_protest'].includes(match.status)) {
          throw new MatchError(
            'match_closed',
            `This bout is ${String(match.status).replace(/_/g, ' ')}; moving it to another mat would change a record of where it was fought.`
          );
        }
        const mat = textField(body, 'mat', false, 40);
        const scheduledAt = dateField(body, 'scheduledAt');
        if (mat == null && scheduledAt == null && body.clear !== true) {
          throw new CompetitionError('nothing_to_change', 'Give a mat, a time, or both.');
        }
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (body.clear === true) {
          patch.mat = null;
          patch.scheduledAt = null;
        } else {
          if (mat != null) patch.mat = mat;
          if (scheduledAt != null) patch.scheduledAt = scheduledAt;
        }
        const [row] = await dbc.update(s.matches).set(patch)
          .where(eq(s.matches.id, matchId)).returning();
        await writeAudit(dbc, ctx, {
          entityType: 'match',
          entityId: matchId,
          action: 'update',
          oldValue: { mat: match.mat, scheduledAt: match.scheduledAt },
          newValue: { mat: row.mat, scheduledAt: row.scheduledAt },
        });
        return json({ match: row }, 200);
      }

      case 'score': {
        const matchId = intField(body, 'matchId')!;
        const match = (await dbc.select({ eventId: s.matches.eventId }).from(s.matches)
          .where(eq(s.matches.id, matchId)).limit(1))[0] as any;
        if (!match) throw new MatchError('unknown_match', 'Unknown match');
        // The ruleset comes from the record, never from the request: a client
        // that could name its own point values could decide a championship.
        const ruleset = await requireStoredRuleset(match.eventId);
        const result = await recordMatchEvent(dbc, ctx, {
          matchId,
          side: String(body.side ?? '') as any,
          action: textField(body, 'scoringAction', true, 60)!,
          officialPersonId: intField(body, 'officialPersonId')!,
          clockSeconds: intField(body, 'clockSeconds', false),
          penaltyCode: textField(body, 'penaltyCode', false, 40),
          note: textField(body, 'note', false, 500),
          ruleset,
        });
        return json(result, 201);
      }

      case 'reverse-score': {
        const result = await correctMatchEvent(dbc, ctx, {
          eventId: intField(body, 'matchEventId')!,
          reason: textField(body, 'reason', true, 1000)!,
          officialPersonId: intField(body, 'officialPersonId')!,
          clockSeconds: intField(body, 'clockSeconds', false),
        });
        return json(result, 201);
      }

      case 'complete-match': {
        const matchId = intField(body, 'matchId')!;
        const match = (await dbc.select({ eventId: s.matches.eventId }).from(s.matches)
          .where(eq(s.matches.id, matchId)).limit(1))[0] as any;
        if (!match) throw new MatchError('unknown_match', 'Unknown match');
        const ruleset = await requireStoredRuleset(match.eventId);
        const decision = body.decision && typeof body.decision === 'object' && !Array.isArray(body.decision)
          ? {
              winnerEntryId: Number(body.decision.winnerEntryId),
              winMethod: String(body.decision.winMethod ?? ''),
              reason: String(body.decision.reason ?? ''),
            }
          : undefined;
        const result = await completeMatch(dbc, ctx, { matchId, ruleset, decision });
        return json(result, 200);
      }

      case 'finalise-results': {
        const categoryId = intField(body, 'categoryId')!;
        const category = (await dbc.select({ eventId: s.eventCategories.eventId })
          .from(s.eventCategories).where(eq(s.eventCategories.id, categoryId)).limit(1))[0] as any;
        if (!category) throw new MatchError('unknown_category', 'Unknown event category');
        const ruleset = await requireStoredRuleset(category.eventId);
        const result = await finaliseResults(dbc, ctx, { categoryId, ruleset });
        return json(result, 200);
      }

      default:
        return json({ error: 'Unknown competition endpoint.' }, 404);
    }
  } catch (err: any) {
    return errorResponse(err);
  }
};
