// THE PUBLIC API CONTRACT — /api/v1/*
//
// This suite is the contract. Everything it asserts is something an outside
// consumer is entitled to rely on, and something that would break their code
// silently if it changed:
//
//   1. THE ENVELOPE. Every 200 carries `apiVersion`, `data` and `meta`; every
//      error carries `apiVersion`, `error` and `code`. A client branching on
//      `code` must never have to parse an English sentence.
//
//   2. PAGINATION IS STABLE. Keyset, not offset. Walking a list must visit
//      every record exactly once even when rows are inserted mid-walk — the
//      failure an offset page produces is a skipped record, which nobody
//      notices until a medal is missing from someone's table.
//
//   3. A PROVISIONAL RESULT IS NEVER PUBLIC. Provisional is a working figure.
//      Published as a result it becomes a claim the federation cannot defend,
//      and it will be quoted back long after it is corrected. Tested against
//      rows written STRAIGHT INTO the table, bypassing every module guard, so
//      the API's own filter is what is under test.
//
//   4. AN UNKNOWN ROUTE 404s WITHOUT LEAKING. No stack trace, no SQL, no table
//      name — a 404 that describes the schema is a free map for an attacker.
//
// Rows are inserted directly rather than driven through the domain modules on
// purpose: the subject here is what the API is willing to SHOW, so the fixtures
// must be able to reach states (a provisional placing, an unpublished ranking)
// that the modules exist to prevent a caller from publishing.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { inArray } from 'drizzle-orm';
import { PUBLIC_EVENT_STATUSES } from '../src/lib/search';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';

let db: any;

/** Ids the assertions refer to by name. */
let JH = 0, KA = 0;
let FINAL_EVENT = 0, PLAIN_EVENT = 0, DRAFT_EVENT = 0, UNDATED_EVENT = 0;
let LOCKED_CATEGORY = 0, PROVISIONAL_ONLY_CATEGORY = 0;
let PUBLISHED_PERIOD = 0, UNPUBLISHED_PERIOD = 0;

// The route is imported after DATABASE_URL is set below; `isConfigured()` reads
// the variable on every call, so a static import is safe.
process.env.DATABASE_URL = 'postgresql://api-contract-test/pglite';
const route = await import('../src/pages/api/v1/[...route]');

// ─── Calling the route ──────────────────────────────────────────────────────
//
// The handler reads exactly three things from its context — `params`, `request`
// and `url` — so the object below is a complete context as far as this route is
// concerned, and a cast is honest rather than a shortcut.

interface Called {
  status: number;
  body: any;
  headers: Headers;
}

async function call(path: string, query = ''): Promise<Called> {
  const url = new URL(`https://www.mmakf.in/api/v1${path ? `/${path}` : ''}${query}`);
  const request = new Request(url.toString(), { method: 'GET' });
  const res: Response = await (route.GET as any)({ params: { route: path }, request, url });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { unparsed: text }; }
  return { status: res.status, body, headers: res.headers };
}

/** Walk a paginated collection to exhaustion, returning every row it yielded. */
async function walk(path: string, limit: number, pick: (b: any) => any[]): Promise<any[]> {
  const seen: any[] = [];
  let query = `?limit=${limit}`;
  for (let guard = 0; guard < 50; guard++) {
    const r = await call(path, query);
    expect(r.status).toBe(200);
    seen.push(...pick(r.body));
    if (!r.body.page?.nextCursor) return seen;
    query = `?limit=${limit}&cursor=${encodeURIComponent(r.body.page.nextCursor)}`;
  }
  throw new Error('pagination did not terminate');
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

let personSeq = 0;
async function person(name: string, stateUnitId: number | null = null): Promise<number> {
  personSeq++;
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(personSeq).padStart(6, '0')}`,
    fullName: name,
    status: 'active',
    stateUnitId,
  }).returning({ id: s.persons.id });
  return p.id;
}

let eventSeq = 0;
async function event(over: Record<string, unknown>): Promise<number> {
  eventSeq++;
  const [e] = await db.insert(s.competitionEvents).values({
    code: `MMAKF-EVT-2026-${String(eventSeq).padStart(6, '0')}`,
    kind: 'open_national',
    stateUnitId: JH,
    ...over,
  }).returning({ id: s.competitionEvents.id });
  return e.id;
}

let entrySeq = 0;
async function entry(eventId: number, categoryId: number, personId: number): Promise<number> {
  entrySeq++;
  const [row] = await db.insert(s.eventEntries).values({
    entryNo: `MMAKF-ENT-2026-${String(entrySeq).padStart(6, '0')}`,
    eventId, categoryId, personId, status: 'confirmed',
  }).returning({ id: s.eventEntries.id });
  return row.id;
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

  // ── Units ────────────────────────────────────────────────────────────────
  [{ id: JH }] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand Association', status: 'active' })
    .returning({ id: s.stateUnits.id });
  [{ id: KA }] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-KA', state: 'Karnataka', name: 'Karnataka Association', status: 'active' })
    .returning({ id: s.stateUnits.id });

  // Seven chartered dojos, plus one whose charter lapsed and one that never
  // reached affiliation at all. Codes are deliberately out of insertion order:
  // the directory cursor sorts by code, and an accidental reliance on id order
  // would pass with sorted fixtures.
  const dojoCodes = ['DJ-007', 'DJ-002', 'DJ-005', 'DJ-001', 'DJ-004', 'DJ-006', 'DJ-003'];
  for (const code of dojoCodes) {
    await db.insert(s.dojos).values({
      code, name: `Dojo ${code}`, stateUnitId: JH, city: 'Ramgarh',
      status: 'active', affiliatedOn: '2024-01-01', affiliationExpiresOn: '2030-01-01',
    });
  }
  await db.insert(s.dojos).values({
    code: 'DJ-LAPSED', name: 'Lapsed Dojo', stateUnitId: KA, city: 'Bengaluru',
    status: 'expired', affiliatedOn: '2018-01-01', affiliationExpiresOn: '2022-01-01',
  });
  // Never affiliated: no affiliation date and no ledger entry. publicDirectory
  // must leave it out under every option.
  await db.insert(s.dojos).values({
    code: 'DJ-REFUSED', name: 'Refused Applicant', stateUnitId: KA, status: 'revoked',
  });

  // ── Officials ────────────────────────────────────────────────────────────
  const refA = await person('Referee Alpha', JH);
  const refB = await person('Referee Bravo', JH);
  const refC = await person('Referee Charlie', KA);
  const refLapsed = await person('Referee Lapsed', KA);
  await db.insert(s.officialQuals).values([
    { personId: refA, kind: 'referee', level: 'National A', grantedOn: '2024-01-01', expiresOn: '2030-01-01', status: 'active' },
    { personId: refB, kind: 'judge', level: 'National B', grantedOn: '2024-06-01', expiresOn: null, status: 'active' },
    { personId: refC, kind: 'referee', level: 'State', grantedOn: '2025-01-01', expiresOn: '2030-01-01', status: 'active' },
    // Expired yesterday's-era licence: publicOfficialsDirectory filters it out.
    { personId: refLapsed, kind: 'judge', level: 'State', grantedOn: '2015-01-01', expiresOn: '2016-01-01', status: 'active' },
  ]);

  // ── Events ───────────────────────────────────────────────────────────────
  FINAL_EVENT = await event({
    title: 'National Championship 2026', status: 'results_final',
    startsOn: '2026-03-01', endsOn: '2026-03-02', venue: 'Patratu', city: 'Ramgarh',
    sanctionReference: 'MMAKF/SANC/2026/001',
  });
  PLAIN_EVENT = await event({ title: 'Open Nationals', status: 'published', startsOn: '2026-05-01' });
  await event({ title: 'Registration Open Meet', status: 'registration_open', startsOn: '2026-06-01' });
  await event({ title: 'Live Meet', status: 'live', startsOn: '2026-07-01' });
  await event({ title: 'Archived Meet', status: 'archived', startsOn: '2025-01-01' });
  // No start date yet. It must sort LAST rather than first, and must not break
  // the cursor — a NULL sort key is where keyset pagination usually falls over.
  UNDATED_EVENT = await event({ title: 'Dates To Be Fixed', status: 'published', startsOn: null });
  // Never announced. It must not appear anywhere in this API.
  DRAFT_EVENT = await event({ title: 'Secret Planning Event', status: 'draft', startsOn: '2026-04-01' });

  // ── Categories, entries and results ──────────────────────────────────────
  const [locked] = await db.insert(s.eventCategories).values({
    eventId: FINAL_EVENT, code: 'SEN-M-KUM', label: 'Senior Male Kumite',
    discipline: 'kumite', gender: 'male', ageGroup: 'senior', displayOrder: 1,
  }).returning({ id: s.eventCategories.id });
  LOCKED_CATEGORY = locked.id;

  const [pending] = await db.insert(s.eventCategories).values({
    eventId: FINAL_EVENT, code: 'SEN-F-KAT', label: 'Senior Female Kata',
    discipline: 'kata', gender: 'female', ageGroup: 'senior', displayOrder: 2,
  }).returning({ id: s.eventCategories.id });
  PROVISIONAL_ONLY_CATEGORY = pending.id;

  const winner = await person('Champion Person', JH);
  const runnerUp = await person('Runner Up Person', JH);
  const disputed = await person('Disputed Placing Person', KA);
  const kataOne = await person('Kata Competitor One', JH);

  const winnerEntry = await entry(FINAL_EVENT, LOCKED_CATEGORY, winner);
  const runnerUpEntry = await entry(FINAL_EVENT, LOCKED_CATEGORY, runnerUp);
  const disputedEntry = await entry(FINAL_EVENT, LOCKED_CATEGORY, disputed);
  const kataEntry = await entry(FINAL_EVENT, PROVISIONAL_ONLY_CATEGORY, kataOne);

  await db.insert(s.competitionResults).values([
    { eventId: FINAL_EVENT, categoryId: LOCKED_CATEGORY, entryId: winnerEntry, personId: winner, placing: 1, medal: 'gold', status: 'final', finalisedAt: new Date('2026-03-02T18:00:00Z') },
    { eventId: FINAL_EVENT, categoryId: LOCKED_CATEGORY, entryId: runnerUpEntry, personId: runnerUp, placing: 2, medal: 'silver', status: 'final', finalisedAt: new Date('2026-03-02T18:00:00Z') },
    // The row this suite exists for: a working figure, in the same table, in
    // the same category, one row away from the locked ones.
    { eventId: FINAL_EVENT, categoryId: LOCKED_CATEGORY, entryId: disputedEntry, personId: disputed, placing: 3, medal: 'bronze', status: 'provisional', correctionReason: 'placing under protest' },
    // A whole category with nothing locked. It must be omitted rather than
    // served as an empty medal table.
    { eventId: FINAL_EVENT, categoryId: PROVISIONAL_ONLY_CATEGORY, entryId: kataEntry, personId: kataOne, placing: 1, medal: 'gold', status: 'provisional' },
  ]);

  // ── Rankings ─────────────────────────────────────────────────────────────
  const [ruleset] = await db.insert(s.rankingRulesets).values({
    code: 'MMAKF-RANK-TEST', title: 'Test ranking ruleset', rules: {},
    effectiveFrom: '2026-01-01', status: 'active',
  }).returning({ id: s.rankingRulesets.id });

  [{ id: PUBLISHED_PERIOD }] = await db.insert(s.rankingPeriods).values({
    rulesetId: ruleset.id, label: '2026 Q1', categoryKey: 'kumite|male|senior|*',
    computedAt: new Date('2026-04-01T00:00:00Z'), publishedAt: new Date('2026-04-02T00:00:00Z'),
    athleteCount: 7, eventCount: 1,
  }).returning({ id: s.rankingPeriods.id });

  // Computed but never published: a working document, not a statement.
  [{ id: UNPUBLISHED_PERIOD }] = await db.insert(s.rankingPeriods).values({
    rulesetId: ruleset.id, label: '2026 Q2', categoryKey: 'kumite|male|senior|*',
    computedAt: new Date('2026-07-01T00:00:00Z'), publishedAt: null,
  }).returning({ id: s.rankingPeriods.id });

  // Seven athletes, with a tie at rank 3 so the cursor has to break it on the
  // person id rather than assuming rank is unique.
  const ranks = [1, 2, 3, 3, 5, 6, 7];
  for (let i = 0; i < ranks.length; i++) {
    const pid = await person(`Ranked Athlete ${i + 1}`, JH);
    await db.insert(s.rankingEntries).values({
      periodId: PUBLISHED_PERIOD, personId: pid, rank: ranks[i],
      points: 1000 - i * 10, contributions: { contributions: [] },
    });
  }

  // Legacy register rows, used by /api/verify only when no database is
  // configured. A database IS configured here, so verification must not fall
  // back to them — that is asserted below.
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────

describe('the envelope is the same shape on every response', () => {
  it('wraps a collection in apiVersion / data / meta / page', async () => {
    const r = await call('events');
    expect(r.status).toBe(200);
    expect(r.body.apiVersion).toBe('1');
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.meta.count).toBe(r.body.data.length);
    expect(typeof r.body.meta.generatedAt).toBe('string');
    expect(new Date(r.body.meta.generatedAt).toString()).not.toBe('Invalid Date');
    expect(r.body.page).toMatchObject({ limit: expect.any(Number) });
    expect(r.body.page).toHaveProperty('nextCursor');
  });

  it('wraps a single record in the same envelope, without a page block', async () => {
    const r = await call(`events/${FINAL_EVENT}`);
    expect(r.status).toBe(200);
    expect(r.body.apiVersion).toBe('1');
    expect(r.body.data.event.code).toMatch(/^MMAKF-EVT-/);
    expect(r.body.page).toBeUndefined();
  });

  it('gives every error a machine-readable code beside the sentence', async () => {
    const cases = [
      await call('events', '?limit=0'),
      await call('events', '?cursor=not-a-cursor'),
      await call('dojos', '?kind=temple'),
      await call('officials', '?registry=president'),
      await call('events/not-a-number'),
      await call('rankings/999999'),
      await call('nonsense'),
    ];
    for (const c of cases) {
      expect(c.status).toBeGreaterThanOrEqual(400);
      expect(c.body.apiVersion).toBe('1');
      expect(typeof c.body.error).toBe('string');
      expect(typeof c.body.code).toBe('string');
      expect(c.body.code).not.toBe('');
    }
  });

  it('describes itself at the root, and says plainly that it cannot be written to', async () => {
    const r = await call('');
    expect(r.status).toBe(200);
    expect(r.body.data.readOnly).toBe(true);
    expect(r.body.data.writeSupport).toMatch(/API-key/i);
    expect(r.body.data.resources.map((x: any) => x.path)).toContain('/api/v1/verify/{number}');
    expect(r.body.data.methods).toEqual(['GET', 'HEAD', 'OPTIONS']);
    // `docs/` is not copied into the deployed output, so `/docs/api/OPENAPI.md`
    // 404s on the deployment even though the dev server serves it. The index
    // must not advertise it as a URL a consumer can follow.
    expect(r.body.data.documentation).not.toMatch(/^\//);
    expect(r.body.data.documentation).toMatch(/repository/i);
  });

  it('refuses every write method with 405 and the reason', async () => {
    const url = new URL('https://www.mmakf.in/api/v1/events');
    const res: Response = await (route.ALL as any)({
      params: { route: 'events' },
      request: new Request(url.toString(), { method: 'POST' }),
      url,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    const body = await res.json();
    expect(body.code).toBe('read_only');
    expect(body.error).toMatch(/read-only/i);
  });
});

describe('CORS is open because the API is anonymous, and must stay that way', () => {
  it('allows any origin and never allows credentials', async () => {
    const r = await call('events');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // The invariant: a wildcard origin WITH credentials would let any site a
    // signed-in visitor lands on replay their session against this API.
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
  });

  it('answers a preflight without a body', async () => {
    const res: Response = await (route.OPTIONS as any)({});
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('HEAD is a read, and must not be answered as an attempted write', () => {
  // REGRESSION GUARD. Astro maps HEAD onto GET only while a route exports no
  // `ALL` handler; this route exports one, and it swallowed HEAD — `curl -I
  // /api/v1` answered `405 read_only`, telling a monitor that the safest read
  // in HTTP had been refused because the API cannot be written to. Every other
  // endpoint on the site answers HEAD 200.
  async function head(path: string): Promise<Response> {
    const url = new URL(`https://www.mmakf.in/api/v1${path ? `/${path}` : ''}`);
    return (route.HEAD as any)({
      params: { route: path },
      request: new Request(url.toString(), { method: 'HEAD' }),
      url,
    });
  }

  it('answers HEAD with the GET status and headers, and no body', async () => {
    const res = await head('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.text()).toBe('');
  });

  it('carries the status through rather than flattening it to 200 or 405', async () => {
    expect((await head('events')).status).toBe(200);
    expect((await head('nonsense')).status).toBe(404);
    expect((await head('events/999999')).status).toBe(404);
  });
});

describe('cache lifetimes reflect how often the data actually changes', () => {
  it('never caches a verification, because a revocation must be visible at once', async () => {
    const r = await call('verify/MMAKF-MEM-2026-999999');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('caches a locked result far longer than a live fixture list', async () => {
    const results = await call(`events/${FINAL_EVENT}/results`);
    const events = await call('events');
    const age = (h: Called) => Number(/max-age=(\d+)/.exec(h.headers.get('Cache-Control') ?? '')?.[1] ?? -1);
    expect(age(results)).toBeGreaterThan(age(events));
    expect(events.headers.get('Cache-Control')).toMatch(/^public,/);
  });
});

describe('only what the federation has published is served', () => {
  it('omits an event that has never been published, under every filter', async () => {
    const all = await walk('events', 2, (b) => b.data);
    const ids = all.map((e: any) => e.id);
    expect(ids).not.toContain(DRAFT_EVENT);
    expect(ids).toContain(FINAL_EVENT);
    expect(ids).toContain(UNDATED_EVENT);
  });

  it('404s a draft event by id rather than admitting it exists', async () => {
    const r = await call(`events/${DRAFT_EVENT}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
    // The same answer an id that was never allocated gets.
    const missing = await call('events/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe(r.body.error);
  });

  it('refuses a status filter naming a state that is not public', async () => {
    const r = await call('events', '?status=draft');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_status');
    expect(r.body.allowed).toContain('published');
    expect(r.body.allowed).not.toContain('draft');
  });

  it('404s an unpublished ranking table exactly as it does a missing one', async () => {
    const unpublished = await call(`rankings/${UNPUBLISHED_PERIOD}`);
    const missing = await call('rankings/999999');
    expect(unpublished.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(unpublished.body.error).toBe(missing.body.error);

    const list = await walk('rankings', 5, (b) => b.data);
    expect(list.map((p: any) => p.id)).toEqual([PUBLISHED_PERIOD]);
  });

  it('leaves a never-affiliated applicant out of the dojo directory', async () => {
    const all = await walk('dojos', 3, (b) => b.data);
    const codes = all.map((d: any) => d.code);
    expect(codes).not.toContain('DJ-REFUSED');
    // A LAPSED charter is listed, and labelled — hiding it would let a parent
    // conclude they mistyped the club's name.
    expect(codes).toContain('DJ-LAPSED');
    const lapsed = all.find((d: any) => d.code === 'DJ-LAPSED');
    expect(lapsed.affiliated).toBe(false);
    expect(lapsed.standing).toBe('lapsed');
    expect(lapsed.note).toMatch(/expired/i);
  });

  it('serves no contact detail in either directory', async () => {
    const dojos = await walk('dojos', 10, (b) => b.data);
    const officials = await walk('officials', 10, (b) => b.data);
    for (const row of [...dojos, ...officials]) {
      for (const key of ['email', 'phone', 'addressLine', 'address', 'dob']) {
        expect(row).not.toHaveProperty(key);
      }
    }
  });

  it('omits an expired licence and marks an open-ended one as open-ended', async () => {
    const officials = await walk('officials', 10, (b) => b.data);
    const names = officials.map((o: any) => o.name);
    expect(names).not.toContain('Referee Lapsed');
    expect(names).toContain('Referee Alpha');
    const openEnded = officials.find((o: any) => o.name === 'Referee Bravo');
    expect(openEnded.openEnded).toBe(true);
    expect(openEnded.expiresOn).toBeNull();
    // A state NAME, never the internal unit id.
    expect(officials.find((o: any) => o.name === 'Referee Alpha').state).toBe('Jharkhand');
    for (const o of officials) expect(o).not.toHaveProperty('stateUnitId');
  });
});

describe('a provisional result is never public — the invariant this API exists to keep', () => {
  it('serves only locked placings for an event', async () => {
    const r = await call(`events/${FINAL_EVENT}/results`);
    expect(r.status).toBe(200);

    const placings = r.body.data.categories.flatMap((c: any) => c.placings);
    expect(placings.length).toBe(2);
    for (const p of placings) expect(['final', 'corrected']).toContain(p.status);
    expect(placings.map((p: any) => p.placing).sort()).toEqual([1, 2]);

    // The provisional bronze, and the person it names, appear nowhere in the
    // payload — not as a placing, and not as a stray label. `meta` is excluded
    // from the scan because it is where the API STATES that provisional
    // placings are withheld, which is the opposite of leaking one.
    expect(JSON.stringify(r.body.data)).not.toMatch(/provisional/i);
    expect(JSON.stringify(r.body.data)).not.toContain('Disputed Placing Person');
  });

  it('drops a category whose every placing is provisional, and says how many', async () => {
    const r = await call(`events/${FINAL_EVENT}/results`);
    const ids = r.body.data.categories.map((c: any) => c.categoryId);
    expect(ids).toContain(LOCKED_CATEGORY);
    expect(ids).not.toContain(PROVISIONAL_ONLY_CATEGORY);
    expect(r.body.meta.categoriesWithoutLockedResults).toBe(1);
  });

  it('keeps the same filter on the event detail route', async () => {
    const r = await call(`events/${FINAL_EVENT}`);
    const placings = r.body.data.categories.flatMap((c: any) => c.results);
    expect(placings.length).toBe(2);
    for (const p of placings) expect(p.status).not.toBe('provisional');
    expect(JSON.stringify(r.body)).not.toContain('Disputed Placing Person');
    // The correction reason is an official's working note and is not published.
    expect(JSON.stringify(r.body)).not.toContain('under protest');
  });

  it('publishes no per-competitor entry roster, only a count', async () => {
    const r = await call(`events/${FINAL_EVENT}`);
    const category = r.body.data.categories.find((c: any) => c.id === LOCKED_CATEGORY);
    expect(category.entryCount).toBe(3);
    expect(category).not.toHaveProperty('entries');
    expect(r.body.meta.entryRosterIncluded).toBe(false);
  });
});

describe('pagination is stable', () => {
  it('walks every published event exactly once, in a total order', async () => {
    const oneAtATime = await walk('events', 1, (b) => b.data);
    const inBulk = await walk('events', 200, (b) => b.data);
    expect(oneAtATime.map((e: any) => e.id)).toEqual(inBulk.map((e: any) => e.id));
    expect(new Set(oneAtATime.map((e: any) => e.id)).size).toBe(oneAtATime.length);
    // An event with no date sorts LAST, not first — the NULL sort key is given
    // the same sentinel in the ordering and in the cursor predicate.
    expect(oneAtATime[oneAtATime.length - 1].id).toBe(UNDATED_EVENT);
  });

  it('ATTACK: a row inserted mid-walk cannot make the walk skip a record', async () => {
    // The offset-pagination failure, reproduced deliberately. With OFFSET, a row
    // inserted before the boundary shifts everything after it and the next page
    // starts one record too late — losing a record with nothing to show for it.
    const first = await call('events', '?limit=2');
    expect(first.status).toBe(200);
    const firstIds = first.body.data.map((e: any) => e.id);

    const injected = await event({ title: 'Inserted Mid-Walk', status: 'published', startsOn: '2020-01-01' });

    const rest: number[] = [];
    let cursor = first.body.page.nextCursor;
    while (cursor) {
      const next = await call('events', `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...next.body.data.map((e: any) => e.id));
      cursor = next.body.page.nextCursor;
    }

    // The injected event sorts before the cursor, so it is legitimately missed —
    // that is what a keyset walk promises. What must NOT happen is a record the
    // walk had not yet reached going missing.
    const walked = new Set([...firstIds, ...rest]);
    const published = await db.select({ id: s.competitionEvents.id }).from(s.competitionEvents);
    const expected = (await walk('events', 200, (b) => b.data)).map((e: any) => e.id);
    for (const id of expected) {
      if (id === injected) continue;
      expect(walked.has(id)).toBe(true);
    }
    expect(published.length).toBeGreaterThan(walked.size); // the draft is still hidden
    expect(new Set([...firstIds, ...rest]).size).toBe(firstIds.length + rest.length);
  });

  it('breaks a tied rank on the person, so no entry is visited twice', async () => {
    const oneAtATime = await walk(`rankings/${PUBLISHED_PERIOD}`, 1, (b) => b.data.entries);
    const inBulk = await walk(`rankings/${PUBLISHED_PERIOD}`, 200, (b) => b.data.entries);
    expect(oneAtATime.length).toBe(7);
    expect(oneAtATime.map((e: any) => e.federationId)).toEqual(inBulk.map((e: any) => e.federationId));
    expect(new Set(oneAtATime.map((e: any) => e.federationId)).size).toBe(7);
    expect(oneAtATime.map((e: any) => e.rank)).toEqual([1, 2, 3, 3, 5, 6, 7]);
    // The internal row id is the cursor key, and is not published.
    for (const e of oneAtATime) expect(e).not.toHaveProperty('personId');
  });

  it('walks both directories to exhaustion without repeating a row', async () => {
    const dojos = await walk('dojos', 2, (b) => b.data);
    expect(new Set(dojos.map((d: any) => d.code)).size).toBe(dojos.length);
    expect(dojos.map((d: any) => d.code)).toEqual([...dojos.map((d: any) => d.code)].sort());

    // Three active, unexpired match-official licences; the lapsed one is gone.
    // `kind` (referee / judge / technical delegate) is a column inside the
    // official register, not a separate registry — the API exposes the three
    // REGISTRIES the module defines and invents no finer split.
    const oneAtATime = await walk('officials', 1, (b) => b.data);
    const inBulk = await walk('officials', 50, (b) => b.data);
    expect(oneAtATime.length).toBe(3);
    expect(oneAtATime.map((o: any) => o.name)).toEqual(inBulk.map((o: any) => o.name));
    expect(new Set(oneAtATime.map((o: any) => o.name)).size).toBe(3);

    // An empty register is served as empty, not as an error.
    const examiners = await call('officials', '?registry=examiner');
    expect(examiners.status).toBe(200);
    expect(examiners.body.data).toEqual([]);
    expect(examiners.body.page.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not issue, rather than silently restarting', async () => {
    // Silently restarting is the dangerous failure: the caller receives page 1
    // believing it is page 4, and duplicates records with no signal at all.
    for (const bad of ['not-a-cursor', '', encodeURIComponent(Buffer.from('||').toString('base64url'))]) {
      const r = await call('events', `?cursor=${bad}`);
      if (bad === '') {
        expect(r.status).toBe(200); // an empty cursor is no cursor
      } else {
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('invalid_cursor');
      }
    }
  });

  it('caps the page size instead of letting a caller ask for the whole register', async () => {
    for (const limit of ['0', '-1', '201', '1.5', 'many']) {
      const r = await call('events', `?limit=${limit}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_limit');
    }
    expect((await call('events', '?limit=200')).status).toBe(200);
  });
});

describe('verification answers with its provenance, and never invents one', () => {
  it('404s a number that matches nothing', async () => {
    const r = await call('verify/MMAKF-MEM-2026-999999');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('credential_not_found');
  });

  it('reports a real member with the provenance the register can support', async () => {
    const r = await call('verify/MMAKF-MEM-2026-000001');
    expect(r.status).toBe(200);
    expect(r.body.data.found).toBe(true);
    expect(r.body.data.member.name).toBe('Referee Alpha');
    // No rank record exists for this person, so there is no grade to claim and
    // no provenance to assert. An absent claim is the correct answer.
    expect(r.body.data.member.grade).toBeNull();
    expect(r.body.data.provenance).toBeNull();
    expect(r.body.meta.provenanceNote).toMatch(/examined/);
  });

  it('rejects an empty or oversized number without touching the register', async () => {
    const long = await call(`verify/${'X'.repeat(80)}`);
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('invalid_request');
    // `/verify` with nothing after it is not a resource.
    const bare = await call('verify');
    expect(bare.status).toBe(404);
    expect(bare.body.code).toBe('unknown_route');
  });
});

describe('an unknown route 404s without handing back the machinery', () => {
  const leaks = [
    /\bat\s+\w+\s*\(/,          // a stack frame
    /\.ts:\d+/,                  // a source position
    /\bselect\b.*\bfrom\b/i,     // SQL
    /competition_events|ranking_periods|persons\b/, // table names
    /node_modules/,
    /postgres|drizzle|pglite/i,
  ];

  const paths = [
    'nonsense',
    'events/1/nonsense',
    'events/1/results/extra',
    'rankings/1/entries',
    'dojos/1',
    'officials/1',
    'admin',
    'data',
    '../verify',
  ];

  it('answers every unknown path with the same 404 envelope', async () => {
    for (const p of paths) {
      const r = await call(p);
      expect(r.status, p).toBe(404);
      expect(r.body.code, p).toBe('unknown_route');
      expect(r.body.resources, p).toContain('events');
      const serialised = JSON.stringify(r.body);
      for (const leak of leaks) expect(serialised, `${p} leaked ${leak}`).not.toMatch(leak);
    }
  });

  it('404s an unknown route even when no database is configured', async () => {
    // Routing is decided before configuration. Otherwise, on the deployment
    // MMAKF actually runs — where DATABASE_URL is unset — every typo would be
    // answered "the service is down", telling the caller their URL was right.
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const unknown = await call('nonsense');
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('unknown_route');

      // A route that DOES exist reports the real reason, and says it is not a
      // statement about the record asked for.
      const real = await call('events');
      expect(real.status).toBe(503);
      expect(real.body.code).toBe('database_not_configured');

      // The index needs nothing and keeps working.
      expect((await call('')).status).toBe(200);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it('leaks nothing on a malformed id either', async () => {
    for (const p of ['events/abc', "events/1' OR '1'='1", 'rankings/-5']) {
      const r = await call(p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
      const serialised = JSON.stringify(r.body);
      for (const leak of leaks) expect(serialised, `${p} leaked ${leak}`).not.toMatch(leak);
    }
  });
});


describe('the visibility rule this API filters on still agrees with the one that owns it', () => {
  // WHY THIS TEST EXISTS.
  //
  // `PUBLIC_EVENT_STATUSES` is written out THREE times: privately in
  // src/pages/api/competition/[...action].ts (the definition of record, used by
  // publicEventDetail), exported from src/lib/search.ts, and mirrored again in
  // src/lib/realtime.ts. /api/v1/events LISTS events by filtering on search.ts's
  // copy, and serves one event by asking publicEventDetail — so the list and the
  // detail route are governed by two different constants that merely happen to
  // match today.
  //
  // Drift is not hypothetical and it is not symmetric: a status added to
  // search.ts but not to the competition route puts an event the federation has
  // NOT announced into the public list. So the two are compared here by
  // BEHAVIOUR, at every value the enum can hold — the same treatment
  // tests/realtime.test.ts gives its own copy. When the owning constant is
  // exported and the copies deleted, this test becomes trivially true, which is
  // the correct outcome, not a reason to remove it.
  const ALL_EVENT_STATUSES = [
    'draft', 'technical_review', 'sanction_review', 'approved', 'published',
    'registration_open', 'registration_closed', 'check_in', 'live',
    'results_pending', 'results_final', 'archived', 'cancelled', 'postponed',
  ] as const;

  it('serves an event by id exactly when its status is in the list the LIST filters on', async () => {
    const made: { id: number; status: string }[] = [];
    try {
      for (const status of ALL_EVENT_STATUSES) {
        made.push({ id: await event({ title: `Drift check ${status}`, status, startsOn: '2026-11-01' }), status });
      }

      for (const { id, status } of made) {
        const listSaysPublic = (PUBLIC_EVENT_STATUSES as readonly string[]).includes(status);
        const detail = await call(`events/${id}`);
        const detailSaysPublic = detail.status === 200;
        expect(
          detailSaysPublic,
          `status "${status}": the LIST would ${listSaysPublic ? '' : 'not '}serve it, the DETAIL route ` +
            `${detailSaysPublic ? 'does' : 'does not'} — the two copies of PUBLIC_EVENT_STATUSES have drifted`
        ).toBe(listSaysPublic);
      }

      // And the list itself must not contain any of the non-public ones.
      const walked = await walk('events', 200, (b) => b.data);
      const walkedIds = new Set(walked.map((e: any) => e.id));
      for (const { id, status } of made) {
        if (!(PUBLIC_EVENT_STATUSES as readonly string[]).includes(status)) {
          expect(walkedIds.has(id), `an event at "${status}" reached the public list`).toBe(false);
        }
      }
    } finally {
      if (made.length) {
        await db.delete(s.competitionEvents).where(inArray(s.competitionEvents.id, made.map((m) => m.id)));
      }
    }
  });
});
