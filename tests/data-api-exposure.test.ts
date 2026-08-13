// The federation's tables must not be readable over HTTP the moment they exist.
//
// MMAKF speaks to Postgres one way only: postgres.js over TCP, as the role in
// DATABASE_URL. It uses no Supabase SDK and no PostgREST client. But a managed
// Postgres can publish every table in `public` over HTTP by itself: Supabase
// keeps two roles, `anon` and `authenticated`, that PostgREST assumes on behalf
// of anyone holding the project's publishable key, and a project may be created
// with default privileges that grant those roles everything created in `public`
// from then on.
//
// Nothing the application does would notice. /api/health opens a TCP connection
// as the app role and reports "database":"ok" whether or not the same tables are
// also being served to the internet. The migration chain, the type checker and
// the build are all equally blind to it. So the only two things that can catch
// it are a migration that revokes the grant, and a runbook step that makes the
// operator look — which is what this suite holds in place.
//
// Neither half of this has been exercised against Supabase: no database password
// has been supplied to this project and nothing here has connected to one. What
// is measured below is the SQL, against a real Postgres engine, with the two
// PostgREST roles present.

import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

async function applyChain(target: PGlite) {
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await target.exec(stmt.trim());
    }
  }
}

/** Every privilege any PostgREST identity holds on a table in `public`. */
const EXPOSED_TABLES = `
  SELECT c.relname AS table_name,
         pg_get_userbyid(a.grantee) AS role,
         a.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND pg_get_userbyid(a.grantee) IN ('anon', 'authenticated')
   ORDER BY 1, 2, 3`;

/** The standing instruction that would re-expose every table created later. */
const EXPOSED_BY_DEFAULT = `
  SELECT d.defaclobjtype,
         pg_get_userbyid(a.grantee) AS role,
         a.privilege_type
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE pg_get_userbyid(a.grantee) IN ('anon', 'authenticated')`;

// ─────────────────────────────────────────────────────────────────────────────

describe('a hosted project cannot publish the federation register over HTTP', () => {
  let exposed: PGlite;

  beforeAll(async () => {
    exposed = new PGlite();

    // The shape a Supabase project has before our migrations run: the two
    // PostgREST roles exist, and a standing default-privilege grant hands them
    // everything subsequently created in `public`. This is the state the
    // migration chain must land into and close, not one it may assume away.
    await exposed.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    `);

    await applyChain(exposed);
  }, 180_000);

  it('leaves no PostgREST identity holding a privilege on any table', async () => {
    const rows = (await exposed.query(EXPOSED_TABLES)).rows as Array<Record<string, string>>;
    // Named so a failure says which table leaked, not merely that one did.
    const summary = rows.slice(0, 8).map((r) => `${r.table_name}:${r.role}:${r.privilege_type}`);
    expect(rows.length, `tables reachable through the Data API: ${summary.join(', ')}`).toBe(0);
  });

  it('revokes persons in particular — the table holding members and minors', async () => {
    const rows = (await exposed.query(
      `${EXPOSED_TABLES.replace("AND c.relkind = 'r'", "AND c.relkind = 'r' AND c.relname = 'persons'")}`
    )).rows;
    expect(rows).toEqual([]);
  });

  it('cancels the standing grant, so a table added tomorrow is not exposed either', async () => {
    expect((await exposed.query(EXPOSED_BY_DEFAULT)).rows).toEqual([]);

    // A later migration creating a table must not reopen the hole. This is the
    // half a one-time REVOKE would miss.
    await exposed.exec('CREATE TABLE a_later_migration_table (id integer)');
    const rows = (await exposed.query(EXPOSED_TABLES)).rows;
    expect(rows, 'a table created after the chain inherited a PostgREST grant').toEqual([]);
  });
});

describe('the revocation stays vendor-neutral', () => {
  it('applies unchanged to a Postgres that has no PostgREST roles at all', async () => {
    // §1.1: DATABASE_URL is the only input and any provider is drop-in. A
    // migration that assumed Supabase's roles existed would break Railway,
    // Render, RDS, and the local development database this project is built on.
    const plain = new PGlite();
    await applyChain(plain);
    const rows = await plain.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
    );
    expect(rows.rows[0].n).toBeGreaterThan(0);
    await plain.close();
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the provisioning runbook makes the operator close the Data API', () => {
  const doc = readFileSync('docs/FEDERATION-ARCHITECTURE.md', 'utf8');

  /** §10.1 only — the section an operator follows literally on go-live day. */
  const runbook = (() => {
    const start = doc.indexOf('### 10.1');
    expect(start, '§10.1 is gone; the runbook moved without this test being updated').toBeGreaterThan(-1);
    const rest = doc.slice(start + 8);
    const end = rest.search(/\n(?:---|##) /);
    return rest.slice(0, end === -1 ? undefined : end);
  })();

  it('names the Data API and the anon role, which no document mentioned', () => {
    // The operator cannot switch off a thing the runbook never names.
    expect(runbook).toMatch(/Data API/i);
    expect(runbook).toMatch(/\banon\b/);
    expect(runbook).toMatch(/PostgREST/i);
  });

  it('gives a query that proves the tables are not published, not an assurance that they are not', () => {
    // A step saying "make sure the Data API is off" is checked by opinion. A
    // step that pastes SQL and reads the row count is checked by the database.
    expect(runbook).toMatch(/aclexplode/);
    expect(runbook).toMatch(/pg_default_acl/);
  });

  it('puts the exposure check before the health probe, not after it', () => {
    // "database":"ok" is returned by a database with every table published to
    // the internet. If the check comes after it, the operator has already
    // declared go-live complete.
    const check = runbook.search(/aclexplode/);
    const health = runbook.search(/api\/health/);
    expect(check).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(-1);
    expect(check, 'the exposure check must run before the health probe').toBeLessThan(health);
  });

  it('cites the migration that makes the check a confirmation rather than a hope', () => {
    const cited = runbook.match(/\b\d{4}_[a-z0-9_]+\.sql\b/);
    expect(cited, '§10.1 must name the migration that performs the revoke').not.toBeNull();
    expect(MIGRATIONS).toContain(cited![0]);
  });
});
