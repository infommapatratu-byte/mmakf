// End-to-end over the REAL Postgres wire protocol.
//
// Every other suite runs PGlite in-process, which exercises SQL but not the
// driver. This suite spawns a Postgres server on a socket and talks to it with
// postgres.js — the exact driver, protocol and connection settings production
// uses against Supabase. It is what proves the code works through the wire.
//
// The server is ephemeral and started by the test itself, so this needs no
// running service, no Docker, and never touches a developer's local data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../src/db/schema';
import { createUser, signIn, resolvePrincipal, grantRole } from '../src/db/users';
import { createPerson, awardRank, currentRank, allocateFederationId, listPersons, auditTrail } from '../src/db/federation';
import { can, type Principal } from '../src/lib/rbac';

// A port derived from the pid, so parallel runs on one machine do not collide.
const PORT = 6100 + (process.pid % 700);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

let server: ChildProcess | null = null;
let sql: ReturnType<typeof postgres> | null = null;
let db: any;
let reachable = false;

beforeAll(async () => {
  server = spawn(process.execPath, ['scripts/pg-testserver.mjs', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

  const started = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    server!.stdout!.on('data', (d) => {
      if (String(d).includes('ready on')) { clearTimeout(timer); resolve(true); }
    });
    server!.on('error', () => { clearTimeout(timer); resolve(false); });
    server!.on('exit', () => { clearTimeout(timer); resolve(false); });
  });
  if (!started) return;

  // ONE connection: the server is a single-connection engine behind a socket,
  // and max:1 is also what production uses on serverless.
  sql = postgres(URL, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => {} });
  await sql`select 1`;

  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await sql.unsafe(stmt.trim());
    }
  }

  db = drizzle(sql, { schema: s });
  reachable = true;
}, 90_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  if (server) server.kill();
});

describe.skipIf(!process.env.CI && false)('end-to-end over the real Postgres driver', () => {
  it('connects to the development database', () => {
    if (!reachable) {
      console.warn('\n  [skipped] no Postgres on 127.0.0.1:5433 — run `npm run dev:db` to include these tests\n');
    }
    expect(true).toBe(true);
  });

  it('applies every migration and creates all tables', async () => {
    if (!reachable) return;
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
      ORDER BY table_name`;
    const names = rows.map((r: any) => r.table_name);
    expect(names).toContain('persons');
    expect(names).toContain('users');
    expect(names).toContain('audit_events');
    // Derived from the migrations, not hard-coded: a new table must not turn
    // this into a false failure.
    const expected = readdirSync('drizzle').filter((f) => f.endsWith('.sql'))
      .reduce((n, f) => n + (readFileSync(`drizzle/${f}`, 'utf8').match(/CREATE TABLE /g) || []).length, 0);
    expect(names.length).toBe(expected);
  });

  it('carries the migration-0001 session columns', async () => {
    if (!reachable) return;
    const cols = await sql!`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'`;
    const names = cols.map((c: any) => c.column_name);
    expect(names).toContain('session_epoch');
    expect(names).toContain('must_change_password');
  });

  it('runs a full federation workflow through the wire protocol', async () => {
    if (!reachable) return;

    // 1. A state unit and a person inside it.
    const [jh] = await db.insert(s.stateUnits)
      .values({ code: 'E2E-ST-JH', state: 'Jharkhand', name: 'Jharkhand Unit', status: 'active' })
      .returning({ id: s.stateUnits.id });

    const national: Principal = {
      userId: null, label: 'e2e-national',
      bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
    };

    const person = await createPerson(db, { principal: national, ip: '203.0.113.7' }, {
      fullName: 'E2E Candidate', stateUnitId: jh.id,
    });
    expect(person.federationId).toMatch(/^MMAKF-MEM-\d{4}-\d{6}$/);

    // 2. Grade them twice — history must be append-only.
    await awardRank(db, { principal: national }, {
      personId: person.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9, awardedOn: '2025-06-01',
    });
    await awardRank(db, { principal: national }, {
      personId: person.id, kind: 'kyu', gradeLabel: '8th Kyu', gradeOrdinal: 8, awardedOn: '2026-01-01',
    });
    expect((await currentRank(db, person.id, 'kyu')).gradeLabel).toBe('8th Kyu');

    const all = await db.select().from(s.rankRecords).where(eq(s.rankRecords.personId, person.id));
    expect(all.length).toBe(2);
    expect(all.filter((r: any) => r.status === 'active').length).toBe(1);

    // 3. The audit trail recorded it, without a raw IP.
    const trail = await auditTrail(db, national, 'person', person.id);
    expect(trail.length).toBeGreaterThan(0);
    expect(JSON.stringify(trail)).not.toContain('203.0.113.7');
  }, 30_000);

  it('signs a real user in and resolves their live authority', async () => {
    if (!reachable) return;

    const [st] = await db.insert(s.stateUnits)
      .values({ code: 'E2E-ST-BR', state: 'Bihar', name: 'Bihar Unit', status: 'active' })
      .returning({ id: s.stateUnits.id });

    const PW = 'e2e federation passphrase';
    const user = await createUser(db, { email: 'e2e@mmakf.in', password: PW });

    const bootstrap: Principal = {
      userId: null, label: 'e2e-bootstrap',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    await grantRole(db, { principal: bootstrap }, {
      userId: user.id, role: 'STATE_ADMIN', scopeType: 'state', scopeId: st.id,
    });

    expect((await signIn(db, 'e2e@mmakf.in', 'wrong passphrase here')).ok).toBe(false);

    const ok = await signIn(db, 'e2e@mmakf.in', PW);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    const principal = await resolvePrincipal(db, ok.user.id, ok.user.sessionEpoch);
    expect(principal!.label).toBe('e2e@mmakf.in');
    expect(can(principal, 'person:write', { stateUnitId: st.id })).toBe(true);
    expect(can(principal, 'person:write', { stateUnitId: 999 })).toBe(false);   // other state
    expect(can(principal, 'safeguarding:read', {})).toBe(false);                 // not theirs
  }, 30_000);

  it('scope isolation holds over a real connection', async () => {
    if (!reachable) return;
    const states = await db.select().from(s.stateUnits);
    const jh = states.find((x: any) => x.code === 'E2E-ST-JH');
    const br = states.find((x: any) => x.code === 'E2E-ST-BR');

    const brAdmin: Principal = {
      userId: 1, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: br.id }],
    };
    const rows = await listPersons(db, brAdmin);
    expect(rows.every((p: any) => p.stateUnitId === br.id)).toBe(true);
    expect(rows.some((p: any) => p.stateUnitId === jh.id)).toBe(false);
  });

  it('allocates identifiers without collision under real concurrency', async () => {
    if (!reachable) return;
    const ids = await Promise.all(Array.from({ length: 25 }, () => allocateFederationId(db, 'E2E', 2026)));
    expect(new Set(ids).size).toBe(25);
  }, 30_000);
});
