// The Supabase Data API lockdown — drizzle/0010_data_api_lockdown.sql.
//
// THE DEFECT THIS SUITE EXISTS TO STOP COMING BACK: row-level security was off
// on every table in the schema, so the only thing standing between Supabase's
// `anon` role and the federation's records was the GRANT layer. Grants are one
// mutable statement wide. `grant select on all tables in schema public to anon`
// — typed into the SQL editor to make one public listing work, emitted by a
// dashboard toggle, or carried in by a restored backup — took the database from
// fully denied to fully readable, with no error, no failing test and no log
// line. persons, users, safeguarding_cases, medical_records, case_notes and
// audit_events are children's records. They should not be one statement from
// being published.
//
// Supabase publishes the anon key as non-secret ON THE ASSUMPTION that RLS is
// enabled. This schema did not hold up that assumption.
//
// WHAT IS MEASURED HERE, AND WHAT IS NOT. Everything below runs against a real
// Postgres engine (PGlite) on this machine. The Supabase roles and the legacy
// default privileges are REPRODUCED locally from Supabase's documented setup;
// no connection is made to the federation's project, and nothing here is a
// measurement of it. The hosted project is checked by the pre-cutover step in
// the notes, not by this file.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

// Counted from the files rather than written down, so adding a table cannot
// quietly weaken the assertion that every table is covered.
const EXPECTED_TABLES = MIGRATIONS.reduce(
  (n, f) => n + (readFileSync(`drizzle/${f}`, 'utf8').match(/CREATE TABLE /g) || []).length,
  0
);

/** Apply every migration in filename order, exactly as scripts/migrate.mjs does. */
async function applyMigrations(pg: PGlite) {
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
}

/**
 * Run a statement as one of the PostgREST roles.
 *
 * Returns rather than throws, because the two failure modes have to be told
 * apart: DENIED (no grant) and ALLOWED-BUT-EMPTY (grant present, RLS holding).
 * A test that only asserted "it threw" would pass in the world where a later
 * GRANT re-opens everything.
 */
async function asRole(pg: PGlite, role: string, sql: string):
  Promise<{ denied: boolean; rows: any[]; message: string }> {
  await pg.exec(`SET ROLE ${role}`);
  try {
    const r = await pg.query(sql);
    return { denied: false, rows: (r.rows as any[]) ?? [], message: '' };
  } catch (e: any) {
    return { denied: true, rows: [], message: String(e?.message ?? e) };
  } finally {
    await pg.exec('RESET ROLE');
  }
}

const asAnon = (pg: PGlite, sql: string) => asRole(pg, 'anon', sql);

const rowsOf = async (pg: PGlite, sql: string) => (await pg.query(sql)).rows as any[];

// The project as Supabase hands it over: PostgREST roles present, and the
// legacy default privileges that grant every newly created table to anon.
let hosted: PGlite;
// The same migrations against a plain Postgres with no Supabase roles at all —
// which is what CI, `npm run dev:db` and any other provider look like.
let bare: PGlite;

beforeAll(async () => {
  hosted = new PGlite();
  await hosted.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  await applyMigrations(hosted);
  await hosted.exec(`
    INSERT INTO persons (federation_id, full_name, status)
    VALUES ('MMAKF-TEST-0001', 'Test Person', 'pending');
  `);

  bare = new PGlite();
  await applyMigrations(bare);
}, 180_000);

describe('Supabase Data API lockdown', () => {
  it('enables row-level security on EVERY table in the schema', async () => {
    // The invariant, and the reason it is asserted after applying all
    // migrations rather than by reading the lockdown file: ENABLE RLS is a
    // per-table act, so a table created by a LATER migration is not covered by
    // an earlier lockdown. When this fails, a migration has added a table
    // behind the lockdown and the lockdown loop must be run again.
    const open = await rowsOf(hosted, `
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      ORDER BY c.relname
    `);
    expect(open.map((r) => r.name)).toEqual([]);
  });

  it('covers all of the tables, not merely all of the tables it happened to see', async () => {
    const [{ total }] = await rowsOf(hosted, `
      SELECT count(*)::int AS total
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `);
    expect(total).toBe(EXPECTED_TABLES);
  });

  it('holds on a plain Postgres with no Supabase roles present', async () => {
    // CI and the local dev database have no anon/authenticated role. The
    // migration must still apply — and must still enable RLS — or the invariant
    // is untestable exactly where it is cheapest to test.
    const [{ total, secured }] = await rowsOf(bare, `
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE c.relrowsecurity)::int AS secured
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `);
    expect(total).toBe(EXPECTED_TABLES);
    expect(secured).toBe(total);
  });

  it('ATTACK: a stray GRANT to anon becomes a no-op instead of a breach', async () => {
    // The exact statement from the failure scenario — someone opening up one
    // public listing, or following a Supabase quickstart. Before the lockdown
    // this returned the row. It must now return nothing, WITHOUT an error,
    // because the second layer is the one still standing.
    const before = await asAnon(hosted, 'SELECT count(*)::int AS c FROM persons');
    expect(before.denied).toBe(true);

    await hosted.exec(`
      GRANT USAGE ON SCHEMA public TO anon;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
    `);
    try {
      for (const table of ['persons', 'users', 'safeguarding_cases', 'medical_records', 'case_notes', 'audit_events']) {
        const r = await asAnon(hosted, `SELECT * FROM ${table}`);
        expect(r.denied, `${table} should be readable-but-empty, not denied, once granted`).toBe(false);
        expect(r.rows, `${table} leaked rows to anon after a stray GRANT`).toEqual([]);
      }
      // The row is really there — the emptiness above is RLS, not an empty table.
      const [{ c }] = await rowsOf(hosted, 'SELECT count(*)::int AS c FROM persons');
      expect(c).toBe(1);
    } finally {
      await hosted.exec(`
        REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;
        REVOKE USAGE ON SCHEMA public FROM anon;
      `);
    }
  });

  it('revokes the legacy default grants a pre-cutover Supabase project applies', async () => {
    // The revoke has to be ours. ALTER DEFAULT PRIVILEGES governs objects
    // created AFTER it runs and never reaches back, so a platform change to the
    // default cannot retract the grants already attached to these 117 tables.
    const r = await asAnon(hosted, 'SELECT * FROM persons');
    expect(r.denied).toBe(true);
    expect(r.message).toMatch(/permission denied/i);
  });

  it.each(['anon', 'authenticated', 'service_role'])(
    'leaves %s holding no privilege on any table in the schema', async (role) => {
      // service_role included deliberately: it carries BYPASSRLS, so RLS is not
      // a control against it and the revoke is the only one there is. The
      // application uses no Supabase SDK, so nothing legitimate speaks as any of
      // these three.
      const [priv] = await rowsOf(hosted, `
        SELECT
          count(*) FILTER (WHERE has_table_privilege('${role}', c.oid, 'SELECT'))::int   AS sel,
          count(*) FILTER (WHERE has_table_privilege('${role}', c.oid, 'INSERT'))::int   AS ins,
          count(*) FILTER (WHERE has_table_privilege('${role}', c.oid, 'UPDATE'))::int   AS upd,
          count(*) FILTER (WHERE has_table_privilege('${role}', c.oid, 'DELETE'))::int   AS del,
          count(*) FILTER (WHERE has_table_privilege('${role}', c.oid, 'TRUNCATE'))::int AS trunc
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      `);
      expect(priv).toEqual({ sel: 0, ins: 0, upd: 0, del: 0, trunc: 0 });
    });

  it('ATTACK: anon cannot write, and cannot erase the audit spine', async () => {
    // TRUNCATE matters on its own: GRANT ALL includes it, and one statement
    // empties audit_events rather than one row at a time.
    for (const write of [
      `INSERT INTO persons (federation_id, full_name) VALUES ('MMAKF-ATTACK', 'Injected')`,
      `UPDATE users SET password_hash = 'attacker-controlled'`,
      `DELETE FROM audit_events`,
      `TRUNCATE audit_events`,
    ]) {
      const r = await asAnon(hosted, write);
      expect(r.denied, `anon was allowed to run: ${write}`).toBe(true);
      expect(r.message).toMatch(/permission denied/i);
    }
  });

  it('ATTACK: anon cannot grant itself a national role binding', async () => {
    // The escalation that needs no password and leaves no anomaly: write one
    // role_bindings row, then sign in through the ordinary admin UI as a
    // legitimately-authorised user. src/lib/rbac.ts resolves roles from this
    // table on every request, so a row inserted behind its back is
    // indistinguishable from one the federation granted.
    const r = await asAnon(hosted, `
      INSERT INTO role_bindings (user_id, role, scope_type, scope_id)
      VALUES (1, 'SUPER_ADMIN', 'national', NULL)
    `);
    expect(r.denied).toBe(true);
  });

  it('leaves no default privilege for a table created after the lockdown', async () => {
    await hosted.exec('CREATE TABLE lockdown_probe (id serial PRIMARY KEY, note text)');
    try {
      const r = await asAnon(hosted, 'SELECT * FROM lockdown_probe');
      expect(r.denied).toBe(true);
      const [{ acl }] = await rowsOf(hosted,
        `SELECT coalesce(relacl::text, '') AS acl FROM pg_class WHERE relname = 'lockdown_probe'`);
      expect(acl).not.toMatch(/\banon=/);
      expect(acl).not.toMatch(/\bauthenticated=/);
    } finally {
      await hosted.exec('DROP TABLE lockdown_probe');
    }
  });

  it('leaves anon no sequence privilege, so it cannot read or advance the ID counters', async () => {
    // MATERIALIZED because has_sequence_privilege() raises rather than returning
    // false when the planner hands it a TOAST relation.
    const [{ n }] = await rowsOf(hosted, `
      WITH seqs AS MATERIALIZED (
        SELECT c.oid FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
      )
      SELECT count(*)::int AS n FROM seqs WHERE has_sequence_privilege('anon', oid, 'USAGE')
    `);
    expect(n).toBe(0);
  });

  it('stops anon enumerating the data model, which RLS alone does not', async () => {
    // Measured limitation of RLS on its own: the rows are hidden but the shape
    // is not. information_schema answers by privilege, so the grants had to go
    // as well — otherwise every table and column name stays readable and the
    // Data API answers 200 with [] rather than refusing.
    const tables = await asAnon(hosted, `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(tables.rows[0].c).toBe(0);
    const columns = await asAnon(hosted, `SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'persons'`);
    expect(columns.rows[0].c).toBe(0);
  });

  it('costs the application nothing: the owner still reads, writes and joins', async () => {
    // RLS with no policy is a deny for everyone EXCEPT the table owner, and the
    // app connects as the owner. If this ever fails, the lockdown has broken
    // the federation rather than protected it.
    await hosted.exec(`
      INSERT INTO persons (federation_id, full_name, status)
      VALUES ('MMAKF-TEST-0002', 'Second Person', 'active');
    `);
    const joined = await rowsOf(hosted, `
      SELECT p.federation_id, u.email
      FROM persons p
      LEFT JOIN users u ON u.person_id = p.id
      WHERE p.federation_id = 'MMAKF-TEST-0002'
    `);
    expect(joined).toHaveLength(1);
    await hosted.exec(`UPDATE persons SET city = 'Patratu' WHERE federation_id = 'MMAKF-TEST-0002'`);
    const [{ city }] = await rowsOf(hosted, `SELECT city FROM persons WHERE federation_id = 'MMAKF-TEST-0002'`);
    expect(city).toBe('Patratu');
    await hosted.exec(`DELETE FROM persons WHERE federation_id = 'MMAKF-TEST-0002'`);
  });

  it('does NOT force row-level security, which would lock the owner out of its own tables', async () => {
    // FORCE applies RLS to the table owner too. With no policies defined that
    // returns zero rows to the application on every query in the system —
    // silently, because a policy denial is not an error. ENABLE without FORCE is
    // what makes this migration safe to ship against a running federation.
    const forced = await rowsOf(hosted, `
      SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relforcerowsecurity ORDER BY 1
    `);
    expect(forced.map((r) => r.name)).toEqual([]);
  });

  it('has no migration creating a table behind the lockdown', () => {
    // Ordering is load-bearing: the loop can only secure tables that exist when
    // it runs. So the invariant is not "the lockdown is the last file" — a later
    // migration that only alters a column is harmless — but "no migration after
    // the lockdown creates a table". A migration that does needs a fresh
    // lockdown after IT, and this is the assertion that says so by name rather
    // than leaving the diagnosis to a list of 117 table names.
    const lockdowns = MIGRATIONS.filter((f) => /_data_api_lockdown\.sql$/.test(f));
    expect(lockdowns.length).toBeGreaterThan(0);
    const last = lockdowns[lockdowns.length - 1];
    const behind = MIGRATIONS.slice(MIGRATIONS.indexOf(last) + 1)
      .filter((f) => /CREATE TABLE /.test(readFileSync(`drizzle/${f}`, 'utf8')));
    expect(behind).toEqual([]);
  });

  it('ships no policy, because a policy would be a permission we cannot justify', async () => {
    // Deny-by-default matches src/lib/rbac.ts: authorisation is decided in the
    // application, over an owner connection. A policy here would be a second,
    // unreviewed authorisation engine.
    const [{ c }] = await rowsOf(hosted, `SELECT count(*)::int AS c FROM pg_policies WHERE schemaname = 'public'`);
    expect(c).toBe(0);
  });
});
