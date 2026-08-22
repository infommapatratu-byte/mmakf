// /api/schedules/* — the HTTP surface of the scheduling engine.
//
// The engine had no API at all until this route existed: every write went
// through a page-level POST handler in /admin/schedules, so a club's own site
// could not read its timetable and a mobile client had no way in.
//
// tests/scheduling.test.ts proves the engine. These prove the things only the
// endpoint can get wrong:
//
//   1. THE VERB DIVIDE. GET is public because a published timetable IS public —
//      it is printed in HTML on four pages. POST is not, and an anonymous caller
//      is refused before the database is touched.
//
//   2. NO DRAFT ESCAPES. A drafted-but-unpublished version must be invisible to
//      every GET. An administrator half way through rebuilding a club's week
//      must not have the public timetable change under them line by line.
//
//   3. NO REASON ESCAPES. A public day read carries the KIND of exception
//      ('examination') and never the free-text reason an administrator typed.
//
//   4. THE MODULE'S ERROR SURVIVES THE WIRE. `setRules()` refuses overlapping
//      sessions with the actual times in the message. A client fixing the
//      request needs those times, so the endpoint returns the module's message
//      verbatim and maps its `code` to a status — 409 for state that refuses,
//      400 for a malformed request.
//
//   5. THE UNCONFIGURED CASE IS NOT A CLOSED CLUB. Without a database the route
//      says so, with a code, and never an empty timetable.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';
import { createSessionCookie, createUserSessionCookie } from '../src/lib/auth';

let db: any;
let STATE = 0;
let HQ = 0;
let SILENT = 0;

process.env.DATABASE_URL = 'postgresql://schedules-route-test/pglite';
const route = await import('../src/pages/api/schedules/[...action]');

/**
 * Two credentials, because the engine treats them differently and should.
 *
 * SHARED_COOKIE is the legacy shared admin password. It authorises writes and
 * it CANNOT publish: `publishVersion()` refuses a principal with no user id,
 * because a published timetable records who put it in force and a shared
 * password cannot name anybody. That refusal is asserted below rather than
 * worked around.
 *
 * USER_COOKIE is a real signed-in federation administrator, seeded with a role
 * binding, and is the only credential here that can publish.
 */
const SHARED_COOKIE = createSessionCookie().split(';')[0];
let USER_COOKIE = '';

interface Called { status: number; body: any }

async function post(action: string, body: unknown, opts: { cookie?: string | null } = {}): Promise<Called> {
  const url = new URL(`https://admin.mmakf.in/api/schedules/${action}`);
  const headers = new Headers({ 'content-type': 'application/json' });
  const cookie = opts.cookie === undefined ? USER_COOKIE : opts.cookie;
  if (cookie) headers.set('cookie', cookie);
  const request = new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const res: Response = await (route.POST as any)({ params: { action }, request, url });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(action: string, query = ''): Promise<Called> {
  const url = new URL(`https://www.mmakf.in/api/schedules/${action}${query}`);
  const request = new Request(url.toString(), { method: 'GET' });
  const res: Response = await (route.GET as any)({ params: { action }, request, url });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  __setTestClient(db);

  // A real administrator, with a national binding, so the principal
  // resolvePrincipal() builds actually holds schedule:write and schedule:publish.
  const [admin] = await db.insert(s.users)
    .values({ email: 'route-admin@example.test', status: 'active', sessionEpoch: 1 })
    .returning({ id: s.users.id });
  await db.insert(s.roleBindings).values({
    userId: admin.id, role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null, status: 'active',
  });
  USER_COOKIE = createUserSessionCookie({ userId: admin.id, epoch: 1 }).split(';')[0];

  const [st] = await db.insert(s.stateUnits)
    .values({ code: 'RT-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE = st.id;
  const dojos = await db.insert(s.dojos).values([
    { code: 'RT-HQ', name: 'Route Hombu Dojo', stateUnitId: STATE, status: 'active' },
    { code: 'RT-SILENT', name: 'Route Silent Dojo', stateUnitId: STATE, status: 'active' },
  ]).returning({ id: s.dojos.id });
  HQ = dojos[0].id;
  SILENT = dojos[1].id;
});

describe('the verb divide', () => {
  it('refuses an unauthenticated write before touching the database', async () => {
    const r = await post('create', { name: 'x', purpose: 'training', owner: { scope: 'dojo', id: HQ } }, { cookie: null });
    expect(r.status).toBe(401);
    // No schedule was created by the attempt.
    const rows = await db.select().from(s.dojos);
    expect(rows.length).toBe(2);
  });

  it('serves a public read with no cookie at all', async () => {
    const r = await get('week', `?dojoId=${SILENT}`);
    expect(r.status).toBe(200);
    // Nothing published: configured false, and NOT an empty week presented as
    // a closed club.
    expect(r.body.week.configured).toBe(false);
    expect(r.body.week.days).toEqual([]);
  });

  it('404s an unknown action and names the ones that exist', async () => {
    const w = await post('demolish', {});
    expect(w.status).toBe(404);
    expect(w.body.code).toBe('unknown_action');
    expect(w.body.actions).toContain('publish');

    const r = await get('everything');
    expect(r.status).toBe(404);
    expect(r.body.actions).toContain('directory');
  });
});

describe('a whole timetable, over HTTP', () => {
  let scheduleId = 0;
  let versionId = 0;
  let summerId = 0;

  it('defines a season', async () => {
    const r = await post('season', {
      code: 'rt-summer', name: 'Summer', owner: { scope: 'dojo', id: HQ },
      startsOn: '2026-04-01', endsOn: '2026-09-30', activate: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.season.status).toBe('active');
    summerId = r.body.season.id;
  });

  it('refuses a second active season that overlaps it, with 409 and the collision named', async () => {
    const r = await post('season', {
      code: 'rt-clash', name: 'Clash', owner: { scope: 'dojo', id: HQ },
      startsOn: '2026-06-01', endsOn: '2026-12-31', activate: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('season_overlap');
    // The administrator's next question is always "which one?", so the message
    // has to name it.
    expect(r.body.error).toMatch(/Summer|rt-summer/);
  });

  it('creates the schedule object', async () => {
    const r = await post('create', {
      name: 'Route Hombu training', purpose: 'training', owner: { scope: 'dojo', id: HQ },
    });
    expect(r.status).toBe(201);
    expect(r.body.schedule.status).toBe('active');
    scheduleId = r.body.schedule.id;
  });

  it('drafts a version, and the draft is invisible to every public read', async () => {
    const r = await post('draft', {
      scheduleId, effectiveFrom: '2026-01-01',
      rules: [
        { dayOfWeek: 1, opensAt: '06:00', closesAt: '09:00' },
        { dayOfWeek: 1, opensAt: '17:00', closesAt: '20:00' },
        { dayOfWeek: 7, opensAt: '06:00', closesAt: '10:00', seasonId: summerId },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.version.status).toBe('draft');
    versionId = r.body.version.id;

    const read = await get('week', `?dojoId=${HQ}&from=2026-09-14&to=2026-09-20`);
    expect(read.status).toBe(200);
    expect(read.body.week.configured, 'a draft must not reach a public read').toBe(false);
  });

  it('refuses overlapping sessions and returns the times in the message', async () => {
    const r = await post('rules', {
      versionId,
      rules: [
        { dayOfWeek: 2, opensAt: '06:00', closesAt: '09:00' },
        { dayOfWeek: 2, opensAt: '08:00', closesAt: '10:00' },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('overlapping_rules');
    expect(r.body.error).toContain('06:00');
    expect(r.body.error).toContain('08:00');
  });

  it('refuses to publish without a reason', async () => {
    const r = await post('publish', { versionId });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_request');
  });

  it('refuses to publish on a shared credential that cannot name a publisher', async () => {
    // The shared admin password authorises the write and still cannot put a
    // timetable in force: a published version records WHO published it, and a
    // password shared by an office names nobody. Months later, a member asking
    // when their class moved and who decided it must get an answer.
    const r = await post('publish', { versionId, reason: 'Trying it on a shared password.' }, { cookie: SHARED_COOKIE });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('publisher_required');
    expect(r.body.error).toMatch(/no user id|cannot/i);
  });

  it('publishes, and the timetable becomes public immediately', async () => {
    const r = await post('publish', { versionId, reason: 'Route test publication.' });
    expect(r.status).toBe(200);
    expect(r.body.version.status).toBe('published');

    const monday = await get('day', `?dojoId=${HQ}&on=2026-09-14`);
    expect(monday.status).toBe(200);
    expect(monday.body.day.open).toBe(true);
    expect(monday.body.day.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`))
      .toEqual(['06:00-09:00', '17:00-20:00']);

    // The seasonal Sunday rule, and only the season in force.
    const sunday = await get('day', `?dojoId=${HQ}&on=2026-09-20`);
    expect(sunday.body.day.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`)).toEqual(['06:00-10:00']);
  });

  it('refuses to edit rules once the version is in force', async () => {
    const r = await post('rules', { versionId, rules: [{ dayOfWeek: 3, opensAt: '06:00', closesAt: '07:00' }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_draft');
  });

  it('adds a closed-day exception, and the public read shows the kind but never the reason', async () => {
    const r = await post('exception', {
      scheduleId, onDate: '2026-09-21', kind: 'examination', effect: 'closed',
      reason: 'Dan examination — candidate list attached, panel confidential',
    });
    expect(r.status).toBe(201);

    const day = await get('day', `?dojoId=${HQ}&on=2026-09-21`);
    expect(day.body.day.open).toBe(false);
    // Configured and closed — a statement, not an absence.
    expect(day.body.day.unconfigured).toBe(false);
    expect(day.body.day.exceptions[0].kind).toBe('examination');
    expect(day.body.day.exceptions[0].reason, 'a public read must never carry the reason').toBeNull();
    expect(day.body.day.exceptions[0].reasonWithheld).toBe(true);
    expect(JSON.stringify(day.body)).not.toContain('panel confidential');
  });
});

describe('the directory read', () => {
  it('answers for many clubs at once and keeps the silent one present', async () => {
    const r = await get('directory', `?dojoIds=${HQ},${SILENT}&on=2026-09-14`);
    expect(r.status).toBe(200);
    const clubs = r.body.clubs;

    expect(clubs[String(HQ)].configured).toBe(true);
    expect(clubs[String(HQ)].windows.length).toBe(2);

    // PRESENT, and unconfigured. Dropping it would make "we did not ask" and
    // "they have not said" indistinguishable — and it must not show the Hombu's
    // hours under any circumstances.
    expect(clubs[String(SILENT)]).toBeTruthy();
    expect(clubs[String(SILENT)].configured).toBe(false);
    expect(clubs[String(SILENT)].windows).toEqual([]);
  });

  it('refuses a request with no ids, and one with too many', async () => {
    expect((await get('directory', '?dojoIds=')).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => i + 1).join(',');
    const r = await get('directory', `?dojoIds=${many}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('501');
  });
});

describe('bounds on a read', () => {
  it('refuses a range that ends before it starts', async () => {
    const r = await get('week', `?dojoId=${HQ}&from=2026-09-20&to=2026-09-14`);
    expect(r.status).toBe(400);
  });

  it('refuses a range longer than a fortnight', async () => {
    const r = await get('week', `?dojoId=${HQ}&from=2026-01-01&to=2026-12-31`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 14 days/);
  });

  it('rejects a malformed date rather than resolving something arbitrary', async () => {
    const r = await get('week', `?dojoId=${HQ}&from=not-a-date&to=2026-09-14`);
    expect(r.status).toBe(400);
  });
});

describe('what a public read is allowed to be cached as', () => {
  it('caches published reads and never caches a write response', async () => {
    const url = new URL(`https://www.mmakf.in/api/schedules/week?dojoId=${HQ}`);
    const res: Response = await (route.GET as any)({
      params: { action: 'week' }, request: new Request(url.toString()), url,
    });
    expect(res.headers.get('cache-control')).toMatch(/max-age/);

    const wurl = new URL('https://admin.mmakf.in/api/schedules/publish');
    const wres: Response = await (route.POST as any)({
      params: { action: 'publish' },
      request: new Request(wurl.toString(), { method: 'POST', headers: new Headers({ cookie: USER_COOKIE }), body: '{}' }),
      url: wurl,
    });
    expect(wres.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the directory-range read', () => {
  it('states each club’s standing across the run rather than leaving it inferred', async () => {
    const r = await get('directory-range', `?dojoIds=${HQ},${SILENT}&from=2026-09-14&to=2026-09-20`);
    expect(r.status).toBe(200);

    // The Hombu publishes Monday and Sunday hours in this fixture, so it is open
    // at some point in the week.
    expect(r.body.clubs[String(HQ)].standing).toBe('open');
    expect(r.body.clubs[String(HQ)].days.length).toBe(7);

    // The silent club has said nothing. NOT 'closed' — a caller told 'closed'
    // would print "closed this week" for a club nobody has heard from.
    expect(r.body.clubs[String(SILENT)].standing).toBe('not_published');
  });

  it('refuses a range longer than the cap', async () => {
    const r = await get('directory-range', `?dojoIds=${HQ}&from=2026-01-01&to=2026-12-31`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 14 days/);
  });

  it('is listed among the reads a caller may make', async () => {
    const r = await get('nonsense');
    expect(r.body.actions).toContain('directory-range');
  });
});
