// The scheduling engine, exposed over HTTP.
//
// SEASON -> SCHEDULE -> VERSION -> RULES -> PUBLISH -> EXCEPTION -> READ
//
// Until this file existed the engine had no API at all. Everything went through
// page-level POST handlers in /admin/schedules, which meant three things:
// a club's own site could not read its timetable, a mobile client had no way
// in, and the validation a write needs lived in a page rather than behind one
// endpoint.
//
// Every action below is ONE call into src/db/scheduling.ts and nothing else. No
// scheduling policy is decided here: not whether two sessions overlap, not
// whether a season may be moved, not who may publish, not what a day resolves
// to. Those live in the module, which is tested, and duplicating any of them at
// the edge is how the two would come to disagree — with the endpoint winning,
// silently.
//
// So this file does exactly five things:
//   1. turns a request into an identity (identify(), never a cookie read),
//   2. rate limits,
//   3. parses and shape-checks the body,
//   4. hands the module's own error message and code back to the caller,
//   5. keeps reads and writes apart.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY GET IS PUBLIC AND POST IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// A published timetable IS public. It is on /facilities, /schedule, /dojos and
// every club page; refusing it over HTTP while printing it in HTML would be a
// pretence rather than a control. So GET is unauthenticated, rate limited, and
// routed exclusively through `publicTimetable()` / `publishedWeek()` /
// `directoryDay()` — the reads that redact exception reasons by construction
// rather than by remembering to pass a flag.
//
// A DRAFT is not public, and no GET here can reach one: drafts are invisible to
// every read in the module. An administrator half way through rebuilding a
// club's week must not have the public timetable change under them line by line.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE
// ─────────────────────────────────────────────────────────────────────────────
//
// This route adds NO authorisation of its own, and that is deliberate rather
// than lazy. `assertMayWriteSchedule()` resolves the owning unit through
// `resourceForOwner()` — which carries the dojo, district AND state ids — and
// hands it to the same `can()` every other surface uses. It is already
// scope-aware for ids, so the IDOR gap that /api/grading has to close at the
// edge does not exist here. Adding a second check would be a second model to
// keep in step.
//
// `schedule:publish` is checked separately from `schedule:write` by the module,
// so a club administrator who may edit a draft does not thereby put it in force.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import {
  isSchedulingError,
  defineSeason, activateSeason, moveSeason, listSeasons,
  createSchedule, draftVersion, setRules, publishVersion, withdrawVersion,
  addException, removeException,
  publishedWeek, openingHoursOn, todayIso, addDays,
  type OwnerScope, type SchedulePurpose, type ScheduleOwner, type RuleInput,
} from '@/db/scheduling';
import { directoryDay, directoryRange, openAtAnyPoint, MAX_RANGE_DAYS as DIRECTORY_MAX_DAYS } from '@/db/schedule-directory';

export const prerender = false;

// --- Wire helpers -----------------------------------------------------------

function json(body: unknown, status: number, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });
}

/**
 * SchedulingError.code -> HTTP status.
 *
 * 404  the named record does not exist
 * 409  the record exists but its state refuses the request — a published
 *      version cannot be edited, a season cannot overlap its neighbour, a
 *      session is already cancelled
 * 400  the request itself is malformed: a reversed range, an unparsable time,
 *      an owner that names no unit
 *
 * `season_overlap` and `overlapping_rules` are 409 rather than 400: the request
 * is well formed and the STORED state is what refuses it, which is a different
 * thing for a client deciding whether to retry.
 */
const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,

  season_overlap: 409,
  not_draft: 409,
  not_published: 409,
  already_booked: 409,
  already_cancelled: 409,
  not_cancellable: 409,
  not_reschedulable: 409,
  class_not_active: 409,
  class_not_allowed: 409,
  facility_closed: 409,
  conflict: 409,
  ambiguous_incumbent: 409,
  inheritance_cycle: 409,
  migration_blocked: 409,
  in_the_past: 409,

  bad_date: 400,
  bad_day: 400,
  bad_exception: 400,
  bad_input: 400,
  bad_owner: 400,
  bad_purpose: 400,
  bad_range: 400,
  bad_rule: 400,
  bad_slug: 400,
  bad_time: 400,
  bad_timezone: 400,
  class_required: 400,
  code_required: 400,
  name_required: 400,
  no_rules: 400,
  overlapping_rules: 409,
  range_too_long: 400,
  reason_required: 400,
  publisher_required: 400,
  unparsable_hours: 400,
};

class BadRequest extends Error {}

function requireInt(body: Record<string, unknown>, field: string): number {
  const raw = body[field];
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`"${field}" must be a record id.`);
  return n;
}

function requireText(body: Record<string, unknown>, field: string, max = 2000): string {
  const raw = body[field];
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequest(`"${field}" is required.`);
  if (raw.length > max) throw new BadRequest(`"${field}" is too long (limit ${max} characters).`);
  return raw.trim();
}

function optionalText(body: Record<string, unknown>, field: string, max = 2000): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new BadRequest(`"${field}" must be text.`);
  if (raw.length > max) throw new BadRequest(`"${field}" is too long (limit ${max} characters).`);
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

const OWNER_SCOPES: OwnerScope[] = ['national', 'state', 'district', 'dojo', 'institution'];

/**
 * The owner, as the caller states it.
 *
 * Only the SHAPE is checked here. Whether `national` may carry an id, and
 * whether a `dojo` id names a dojo that exists, is `normaliseOwner()`'s
 * decision and then the database's — this file must not develop a second
 * opinion about what a valid owner is.
 */
function requireOwner(body: Record<string, unknown>): ScheduleOwner {
  const raw = body.owner as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('"owner" must be an object: { scope, id }.');
  }
  const scope = String(raw.scope ?? '') as OwnerScope;
  if (!OWNER_SCOPES.includes(scope)) {
    throw new BadRequest(`"owner.scope" must be one of ${OWNER_SCOPES.join(', ')}.`);
  }
  const id = raw.id === null || raw.id === undefined ? null : Number(raw.id);
  if (id !== null && !Number.isInteger(id)) throw new BadRequest('"owner.id" must be a unit id or null.');
  return { scope, id };
}

const PURPOSES: SchedulePurpose[] = ['operating', 'training', 'office', 'administrative', 'class'];

function requirePurpose(body: Record<string, unknown>): SchedulePurpose {
  const raw = String(body.purpose ?? '') as SchedulePurpose;
  if (!PURPOSES.includes(raw)) throw new BadRequest(`"purpose" must be one of ${PURPOSES.join(', ')}.`);
  return raw;
}

/**
 * Rules, shape-checked only.
 *
 * The overlap check, the reversed-range check and the midnight-crossing refusal
 * all live in `setRules()`. This bounds the ARRAY — an unbounded rules array is
 * a request that can hold the connection open — and leaves every judgement to
 * the module.
 */
const MAX_RULES = 400;

function requireRules(body: Record<string, unknown>, field = 'rules'): RuleInput[] {
  const raw = body[field];
  if (!Array.isArray(raw)) throw new BadRequest(`"${field}" must be an array.`);
  if (raw.length > MAX_RULES) throw new BadRequest(`"${field}" holds more than ${MAX_RULES} rules.`);
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new BadRequest(`"${field}[${i}]" must be an object.`);
    }
    const row = r as Record<string, unknown>;
    const dayOfWeek = Number(row.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      throw new BadRequest(`"${field}[${i}].dayOfWeek" must be 1 (Monday) to 7 (Sunday).`);
    }
    return {
      dayOfWeek,
      opensAt: row.opensAt == null ? null : String(row.opensAt),
      closesAt: row.closesAt == null ? null : String(row.closesAt),
      kind: row.kind === 'closed' ? 'closed' : 'open',
      seasonId: row.seasonId == null ? null : Number(row.seasonId),
      label: row.label == null ? null : String(row.label).slice(0, 200),
      displayOrder: row.displayOrder == null ? undefined : Number(row.displayOrder),
      notes: row.notes == null ? null : String(row.notes).slice(0, 2000),
    } as RuleInput;
  });
}

const WRITE_ACTIONS = [
  'season', 'season/activate', 'season/move',
  'create', 'draft', 'rules', 'publish', 'withdraw',
  'exception', 'exception/remove',
] as const;
type WriteAction = (typeof WRITE_ACTIONS)[number];

const READ_ACTIONS = ['week', 'day', 'directory', 'directory-range', 'seasons'] as const;
type ReadAction = (typeof READ_ACTIONS)[number];

const isWrite = (v: string): v is WriteAction => (WRITE_ACTIONS as readonly string[]).includes(v);
const isRead = (v: string): v is ReadAction => (READ_ACTIONS as readonly string[]).includes(v);

function notConfigured() {
  return json(
    {
      error:
        'The federation database is not configured on this deployment, so schedules cannot be ' +
        'read or written. This is not a result about your request, and it is not a statement ' +
        'that any club is closed.',
      code: 'not_configured',
    },
    503,
  );
}

/** One place where a module error becomes a status, for both verbs. */
function fromError(err: any) {
  if (err instanceof BadRequest) return json({ error: err.message, code: 'bad_request' }, 400);
  if (err instanceof ForbiddenError) {
    return json({ error: err.message, code: 'forbidden' }, 403);
  }
  if (isSchedulingError(err)) {
    // The module's own message is returned verbatim. It is written for the
    // person who has to fix the request — "Sunday has two overlapping sessions:
    // 06:00–10:00 and 08:00–11:30" — and paraphrasing it here would lose the
    // times.
    return json({ error: err.message, code: err.code }, STATUS_BY_CODE[err.code] ?? 400);
  }
  console.error('[api/schedules] unhandled', err);
  return json({ error: 'The scheduling service failed to answer.', code: 'internal' }, 500);
}

// --- Reads ------------------------------------------------------------------
//
// Published only, and never a draft. Cached for a minute at the edge: a
// timetable that changed a minute ago is not a correctness problem, and a
// register page hitting this per club is.

const READ_CACHE = 'public, max-age=30, s-maxage=60';

/** At most a fortnight per request, so one call cannot walk a year of days. */
const MAX_RANGE_DAYS = 14;
const MAX_DIRECTORY_IDS = 500;

export const GET: APIRoute = async ({ request, params, url }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');

  const rl = await rateLimit(request, `schedules-read-${isRead(action) ? action : 'unknown'}`, 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!isRead(action)) {
    return json({ error: 'Unknown schedule read', code: 'unknown_action', actions: READ_ACTIONS }, 404);
  }
  if (!isConfigured()) return notConfigured();

  const q = url.searchParams;
  const database = db();

  try {
    const target = {
      dojoId: q.get('dojoId') ? Number(q.get('dojoId')) : undefined,
      districtUnitId: q.get('districtUnitId') ? Number(q.get('districtUnitId')) : undefined,
      stateUnitId: q.get('stateUnitId') ? Number(q.get('stateUnitId')) : undefined,
      venueId: q.get('venueId') ? Number(q.get('venueId')) : undefined,
    };

    switch (action) {
      // A run of days for one unit or room. The shape /facilities and a club
      // page both render.
      case 'week': {
        const from = q.get('from') || todayIso();
        const to = q.get('to') || addDays(from, 6);
        const days = daysApart(from, to);
        if (days > MAX_RANGE_DAYS) {
          throw new BadRequest(`A request may span at most ${MAX_RANGE_DAYS} days; this one spans ${days}.`);
        }
        const week = await publishedWeek(database, target, from, to);
        return json({ ok: true, from, to, week }, 200, READ_CACHE);
      }

      // One day, for one unit or room.
      case 'day': {
        const on = q.get('on') || todayIso();
        const purpose = (q.get('purpose') || 'training') as SchedulePurpose;
        if (!PURPOSES.includes(purpose)) throw new BadRequest(`"purpose" must be one of ${PURPOSES.join(', ')}.`);
        // principal: null — a public read never receives an administrator's
        // free-text reason for a closure, only the KIND of day it is.
        const day = await openingHoursOn(database, { ...target, purpose }, on, { principal: null });
        return json({ ok: true, day }, 200, READ_CACHE);
      }

      // Many clubs, one day, in a fixed number of queries. What a directory or
      // a "near me" search needs, and the reason /dojos no longer caps itself.
      case 'directory': {
        // A positive integer, not merely an integer: Number('') is 0, so an
        // empty  would otherwise arrive as the id zero and be answered
        // for rather than refused.
        const raw = (q.get('dojoIds') || '')
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (!raw.length) throw new BadRequest('"dojoIds" must be a comma-separated list of dojo ids.');
        if (raw.length > MAX_DIRECTORY_IDS) {
          throw new BadRequest(`"dojoIds" holds ${raw.length} ids; the limit is ${MAX_DIRECTORY_IDS}.`);
        }
        const on = q.get('on') || todayIso();
        const resolved = await directoryDay(database, raw, on);
        // A club that has published nothing is PRESENT with configured:false.
        // Dropping it would make "we did not ask" and "they have not said"
        // indistinguishable to the caller.
        return json({ ok: true, on, clubs: Object.fromEntries(resolved) }, 200, READ_CACHE);
      }

      // Many clubs, a run of days. What a "find a club open this weekend"
      // surface needs, and the read that keeps "closed all weekend" apart from
      // "this club has published nothing" — a distinction the caller cannot
      // reconstruct from an empty array.
      case 'directory-range': {
        const raw = (q.get('dojoIds') || '')
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (!raw.length) throw new BadRequest('"dojoIds" must be a comma-separated list of dojo ids.');
        if (raw.length > MAX_DIRECTORY_IDS) {
          throw new BadRequest(`"dojoIds" holds ${raw.length} ids; the limit is ${MAX_DIRECTORY_IDS}.`);
        }
        const from = q.get('from') || todayIso();
        const to = q.get('to') || addDays(from, 6);
        const span = daysApart(from, to);
        if (span > DIRECTORY_MAX_DAYS) {
          throw new BadRequest(`A range may span at most ${DIRECTORY_MAX_DAYS} days; this one spans ${span}.`);
        }
        const range = await directoryRange(database, raw, from, to);
        const clubs: Record<string, unknown> = {};
        for (const [dojoId, days] of range.clubs) {
          clubs[String(dojoId)] = {
            // 'open' | 'closed' | 'not_published' — stated, so a caller never has
            // to infer "they have not said" from an absence of windows.
            standing: openAtAnyPoint(days),
            days,
          };
        }
        return json({ ok: true, from, to, clubs }, 200, READ_CACHE);
      }

      case 'seasons': {
        const owner = {
          scope: (q.get('scope') || 'national') as OwnerScope,
          id: q.get('ownerId') ? Number(q.get('ownerId')) : null,
        };
        if (!OWNER_SCOPES.includes(owner.scope)) {
          throw new BadRequest(`"scope" must be one of ${OWNER_SCOPES.join(', ')}.`);
        }
        return json({ ok: true, seasons: await listSeasons(database, owner) }, 200, READ_CACHE);
      }
    }
  } catch (err: any) {
    return fromError(err);
  }
  return json({ error: 'Unknown schedule read', code: 'unknown_action' }, 404);
};

function daysApart(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new BadRequest('Dates must be YYYY-MM-DD.');
  if (b < a) throw new BadRequest(`${from}..${to} ends before it starts.`);
  return Math.round((b - a) / 86_400_000) + 1;
}

// --- Writes -----------------------------------------------------------------

export const POST: APIRoute = async ({ request, params }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');

  const rl = await rateLimit(request, `schedules-${isWrite(action) ? action : 'unknown'}`, 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to change a schedule' }, 401);

  if (!isWrite(action)) {
    return json({ error: 'Unknown schedule action', code: 'unknown_action', actions: WRITE_ACTIONS }, 404);
  }
  if (!isConfigured()) return notConfigured();

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    // A week of rules for a club with many sessions is the largest body here.
    if (raw.length > 65536) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const database = db();

  try {
    const ctx: AuditContext = {
      principal: identity.principal,
      ip: clientIp(request),
      reason: optionalText(body, 'reason', 1000) ?? null,
      // A shared credential is recorded as shared, so the trail never implies
      // an individual took a decision it cannot attribute.
      authority: identity.shared ? `shared:${identity.via}` : 'user',
    };

    switch (action) {
      case 'season': {
        const season = await defineSeason(database, ctx, {
          code: requireText(body, 'code', 64),
          name: requireText(body, 'name', 200),
          owner: requireOwner(body),
          startsOn: requireText(body, 'startsOn', 10),
          endsOn: requireText(body, 'endsOn', 10),
          inheritable: body.inheritable === true,
          notes: optionalText(body, 'notes') ?? null,
          activate: body.activate === true,
        });
        return json({ ok: true, season }, 201);
      }

      case 'season/activate': {
        const season = await activateSeason(database, ctx, requireInt(body, 'seasonId'));
        return json({ ok: true, season }, 200);
      }

      case 'season/move': {
        const season = await moveSeason(
          database, ctx, requireInt(body, 'seasonId'),
          requireText(body, 'startsOn', 10), requireText(body, 'endsOn', 10),
          requireText(body, 'reason', 1000),
        );
        return json({ ok: true, season }, 200);
      }

      // The schedule OBJECT. It says nothing until a version is published
      // against it, which is why this returns 201 and not "published".
      case 'create': {
        const schedule = await createSchedule(database, ctx, {
          name: requireText(body, 'name', 200),
          purpose: requirePurpose(body),
          owner: requireOwner(body),
          venueId: body.venueId == null ? null : requireInt(body, 'venueId'),
          classId: body.classId == null ? null : requireInt(body, 'classId'),
          timezone: optionalText(body, 'timezone', 64),
          inheritsFromScheduleId: body.inheritsFromScheduleId == null ? null : requireInt(body, 'inheritsFromScheduleId'),
          publicVisible: body.publicVisible !== false,
          notes: optionalText(body, 'notes') ?? null,
        });
        return json({ ok: true, schedule }, 201);
      }

      case 'draft': {
        const version = await draftVersion(database, ctx, requireInt(body, 'scheduleId'), {
          effectiveFrom: requireText(body, 'effectiveFrom', 10),
          effectiveTo: optionalText(body, 'effectiveTo', 10) ?? null,
          reason: optionalText(body, 'reason', 1000) ?? null,
          rules: body.rules === undefined ? undefined : requireRules(body),
        });
        return json({ ok: true, version }, 201);
      }

      // Wholesale replacement of a DRAFT's rules. Refused on anything
      // published — there is no path in the module that edits a timetable which
      // has been in force, and this endpoint does not invent one.
      case 'rules': {
        const count = await setRules(database, ctx, requireInt(body, 'versionId'), requireRules(body));
        return json({ ok: true, rules: count }, 200);
      }

      case 'publish': {
        const result = await publishVersion(
          database, ctx, requireInt(body, 'versionId'),
          requireText(body, 'reason', 1000),
        );
        return json({ ok: true, ...result }, 200);
      }

      case 'withdraw': {
        const version = await withdrawVersion(
          database, ctx, requireInt(body, 'versionId'),
          requireText(body, 'reason', 1000),
        );
        return json({ ok: true, version }, 200);
      }

      case 'exception': {
        const exception = await addException(database, ctx, {
          scheduleId: requireInt(body, 'scheduleId'),
          onDate: requireText(body, 'onDate', 10),
          kind: requireText(body, 'kind', 64) as any,
          effect: requireText(body, 'effect', 32) as any,
          opensAt: optionalText(body, 'opensAt', 5) ?? null,
          closesAt: optionalText(body, 'closesAt', 5) ?? null,
          reason: requireText(body, 'reason', 1000),
        });
        return json({ ok: true, exception }, 201);
      }

      case 'exception/remove': {
        await removeException(
          database, ctx, requireInt(body, 'exceptionId'),
          requireText(body, 'reason', 1000),
        );
        return json({ ok: true }, 200);
      }
    }
  } catch (err: any) {
    return fromError(err);
  }

  return json({ error: 'Unknown schedule action', code: 'unknown_action' }, 404);
};
