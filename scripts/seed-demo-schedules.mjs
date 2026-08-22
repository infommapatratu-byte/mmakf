#!/usr/bin/env node
// Seed a LOCAL demonstration register so the club-timings surfaces can be seen
// working end to end.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// /dojos resolves every listed club's own published timings through
// `directoryDay()`. That path is proven by tests/schedule-directory.test.ts
// against PGlite — but a test proves the resolver, not the page. Rendering the
// register with real rows needs a database with real units in it, and until the
// federation's own database is reachable from a developer's machine there was
// no way to look at the thing.
//
// This is that way. It writes into whatever DATABASE_URL points at, which on a
// developer's machine is `npm run dev:db`.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT REFUSES TO TOUCH ANYTHING THAT LOOKS REAL
// ─────────────────────────────────────────────────────────────────────────────
//
// Demonstration data in the federation's register would be indistinguishable
// from a real affiliated club on the public site — a parent could travel to a
// dojo this script invented. So:
//
//   · every row it writes is coded MMAKF-DEMO-*, and it only ever updates rows
//     it can identify by that prefix;
//   · it REFUSES to run against a host that is not loopback, because the only
//     safe target is a database on the machine you are sitting at;
//   · it is idempotent — running it twice changes nothing the second time.
//
// Nothing here is a fixture the application depends on. Delete the rows and the
// register is empty again, which is the correct state until the federation
// enters its own units.
//
//   npm run dev:db                                    (terminal 1)
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres" npm run db:migrate
//   DATABASE_URL="..." node scripts/seed-demo-schedules.mjs
//   DATABASE_URL="..." npm run dev                    then open /dojos

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// ── The `@/` resolve hook (same mapping as scripts/seed-technical-library.mjs) ──

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.js'];

function probe(base) {
  if (existsSync(base) && !base.endsWith(path.sep)) {
    try { if (!statSync(base).isDirectory()) return base; } catch { /* fall through */ }
  }
  for (const e of EXTS) {
    const c = base + e;
    if (existsSync(c)) return c;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const hit = probe(path.join(SRC, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      throw new Error(`Could not resolve "${specifier}" under ${SRC}.`);
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw err;
      if (!context?.parentURL?.startsWith('file:')) throw err;
      const parentDir = path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      const hit = probe(path.join(parentDir, specifier));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      throw err;
    }
  },
});

// ── Refusals ────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess a target database.');
  process.exit(1);
}

const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
if (!LOOPBACK.includes(host)) {
  console.error(
    `DATABASE_URL points at "${host}", which is not this machine.\n` +
    'This script writes demonstration clubs into the affiliation register, and a\n' +
    'demonstration club on a real deployment is a dojo a parent can travel to and\n' +
    'find is not there. Point it at the local database (npm run dev:db) or do not\n' +
    'run it.'
  );
  process.exit(1);
}

const { drizzle } = await import('drizzle-orm/postgres-js');
const postgres = (await import('postgres')).default;
const { eq, inArray, like } = await import('drizzle-orm');
const s = await import('@/db/schema');
const {
  createSchedule, draftVersion, publishVersion, defineSeason,
} = await import('@/db/scheduling');

const { tlsFor, tlsHint } = await import('./db-tls.mjs');
const client = postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 20, ...tlsFor(url) });
const db = drizzle(client, { schema: s });

const PREFIX = 'MMAKF-DEMO-';
const ctx = {
  principal: {
    userId: null,
    label: 'seed-demo-schedules',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  },
  reason: 'Local demonstration register.',
  authority: 'seed-demo-schedules',
};

/** publishVersion() records who published; a script needs a user row to be that. */
async function demoUser() {
  const existing = await db.select().from(s.users).where(eq(s.users.email, 'demo-seed@localhost')).limit(1);
  if (existing.length) return existing[0].id;
  const [row] = await db.insert(s.users)
    .values({ email: 'demo-seed@localhost', status: 'active' })
    .returning({ id: s.users.id });
  return row.id;
}

async function upsertState() {
  const code = `${PREFIX}ST-JH`;
  const found = await db.select().from(s.stateUnits).where(eq(s.stateUnits.code, code)).limit(1);
  if (found.length) return found[0].id;
  const [row] = await db.insert(s.stateUnits)
    .values({ code, state: 'Jharkhand', name: 'Jharkhand (demo)', status: 'active' })
    .returning({ id: s.stateUnits.id });
  return row.id;
}

async function upsertDojo(code, name, city, stateUnitId) {
  const full = PREFIX + code;
  const found = await db.select().from(s.dojos).where(eq(s.dojos.code, full)).limit(1);
  if (found.length) return found[0].id;
  const [row] = await db.insert(s.dojos)
    .values({
      code: full, name, city, stateUnitId, status: 'active',
      affiliatedOn: '2024-04-01', affiliationExpiresOn: '2027-03-31',
    })
    .returning({ id: s.dojos.id });
  return row.id;
}

/** Publish a training schedule for a dojo, unless it already has one. */
async function publishFor(dojoId, name, rules, seasons = []) {
  const owner = { scope: 'dojo', id: dojoId };
  let schedule;
  try {
    schedule = await createSchedule(db, ctx, { name, purpose: 'training', owner });
  } catch (err) {
    // ONE ACTIVE SCHEDULE PER OWNER + PURPOSE is a unique index, so a second
    // run lands here and that is the idempotency — enforced by the database
    // rather than by this script checking first and racing.
    // The driver's SQLSTATE is checked as well as the text, because the message
    // a wrapper produces is not something this script should have to predict.
    const message = [err?.code, err?.constraint_name, err?.message ?? err].join(' ');
    if (/23505|duplicate key|unique|already/i.test(message)) {
      console.log(`  · ${name}: already configured, left alone`);
      return;
    }
    // Anything else is a real failure and must not be swallowed: a seed that
    // reports success having written nothing is worse than one that stops.
    throw err;
  }
  const seasonIds = {};
  for (const season of seasons) {
    const created = await defineSeason(db, ctx, { ...season, owner, activate: true });
    seasonIds[season.code] = created.id;
  }
  const version = await draftVersion(db, ctx, schedule.id, {
    effectiveFrom: '2024-04-01',
    rules: rules.map((r) => (r.season ? { ...r, seasonId: seasonIds[r.season], season: undefined } : r)),
  });
  await publishVersion(db, ctx, version.id, 'Demonstration register seed.');
  console.log(`  · ${name}: published`);
}

const weekdays = (opensAt, closesAt) =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, kind: 'open' }));

try {
  ctx.principal.userId = await demoUser();
  const stateUnitId = await upsertState();

  // THREE CLUBS, THREE DIFFERENT ANSWERS — because the point of the register is
  // that they are allowed to differ.
  const hombu = await upsertDojo('DOJO-HQ', 'MMAKF Hombu Dojo (demo)', 'Patratu', stateUnitId);
  const evening = await upsertDojo('DOJO-BKR', 'MMAKF Bokaro Dojo (demo)', 'Bokaro', stateUnitId);
  const silent = await upsertDojo('DOJO-RNC', 'MMAKF Ranchi Centre (demo)', 'Ranchi', stateUnitId);

  console.log('Publishing demonstration timetables:');

  // The headquarters: mornings and evenings, and a Sunday that moves with the
  // season — the shape the federation's own published strings describe.
  await publishFor(hombu, 'Hombu training hours (demo)', [
    ...[1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => ([
      { dayOfWeek, opensAt: '06:00', closesAt: '09:00', kind: 'open' },
      { dayOfWeek, opensAt: '17:00', closesAt: '20:00', kind: 'open' },
    ])),
    { dayOfWeek: 7, opensAt: '06:00', closesAt: '10:00', kind: 'open', season: 'demo-summer' },
    { dayOfWeek: 7, opensAt: '15:00', closesAt: '18:00', kind: 'open', season: 'demo-summer' },
    { dayOfWeek: 7, opensAt: '08:00', closesAt: '11:30', kind: 'open', season: 'demo-winter' },
    { dayOfWeek: 7, opensAt: '16:00', closesAt: '18:30', kind: 'open', season: 'demo-winter' },
  ], [
    { code: 'demo-summer', name: 'Summer', startsOn: '2026-04-01', endsOn: '2026-09-30' },
    { code: 'demo-winter', name: 'Winter', startsOn: '2026-10-01', endsOn: '2027-03-31' },
  ]);

  // A club that trains after work only. Nothing like the headquarters, which is
  // the whole reason club schedules exist.
  await publishFor(evening, 'Bokaro evening batches (demo)', [
    ...weekdays('18:00', '21:00'),
    { dayOfWeek: 6, opensAt: '07:00', closesAt: '10:00', kind: 'open' },
  ]);

  // And one that has published nothing at all. It must render as "not
  // published", never as closed and never as the headquarters' hours.
  console.log('  · MMAKF Ranchi Centre (demo): deliberately left unpublished');
  void silent;

  const dojos = await db.select({ code: s.dojos.code, name: s.dojos.name })
    .from(s.dojos).where(like(s.dojos.code, `${PREFIX}%`));
  console.log(`\nDemonstration register: ${dojos.length} clubs`);
  for (const d of dojos) console.log(`  ${d.code}  ${d.name}`);
  console.log('\nOpen /dojos with the same DATABASE_URL to see them.');
} catch (err) {
  // A seed that stopped part way used to end as an unhandled rejection: node
  // printed a stack out of the driver and not one word about the run. Worse, the
  // close below then rejected on its own — there is nothing to close on a
  // connection that never opened — and that second failure is the one left on
  // screen, having buried the first. So the fault is caught and stated once
  // here, and the close is allowed to fail in silence, because by then it has
  // nothing left to tell anyone.
  console.error(`\nFAILED: ${err.message}`);

  // A certificate failure reads nothing like what it is, so nobody goes back to
  // re-check a password that was never at fault. The refusal at the top of this
  // file admits loopback only and tlsFor() leaves TLS off there, so today this
  // cannot fire — it is written anyway, because the day that refusal is relaxed
  // is exactly the day nobody remembers to come back and add it.
  const hint = tlsHint(err);
  if (hint) console.error(hint);

  // Not process.exit(): the close below is what releases the socket, and the
  // exit code still has to reach whoever ran this from a shell script.
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 }).catch(() => {});
}
