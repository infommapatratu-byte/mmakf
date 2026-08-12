// The connection itself — how it is secured, what names it, and what the word
// "healthy" is allowed to mean.
//
// Three defects found in shipped code. None of them announces itself; every one
// of them looks like a clean go-live.
//
//  1. NOTHING EVER ASKED FOR TLS. The options block set max, idle_timeout,
//     connect_timeout and prepare — not ssl — and postgres.js defaults to
//     `ssl: false`. The string `sslmode` appeared nowhere in this repository, so
//     whether the federation's queries crossed the public internet encrypted
//     depended entirely on whether an operator happened to paste a query
//     parameter no document mentioned. Against a server that does not insist on
//     TLS there is no error to notice: the cutover looks perfect and every
//     result row — session tokens out of user_sessions, safeguarding rows,
//     members' dates of birth, payment records — travels in the clear.
//
//  2. POSTGRES_URL WAS A SECOND, UNDOCUMENTED WAY IN. It is the variable name
//     Vercel's Postgres integrations inject on their own. Adding one in the
//     dashboard while trying to get a connection working would have activated
//     the entire federation system against a database nobody chose, with
//     DATABASE_URL still unset.
//
//  3. "HEALTHY" MEANT "SOMETHING ANSWERED select 1" — which an empty,
//     never-migrated database answers perfectly. DEPLOYMENT.md Step 5 makes
//     /api/health THE go-live check, so the runbook's own verification step
//     would have certified the wrong database as a success. The probe also
//     built a brand-new pool per call, paying a full handshake and a type
//     round trip while the invocation already held a working connection.
//
// The module is reached through its namespace rather than by named import on
// purpose: a guarantee that has gone missing then fails as an assertion inside
// the test that covers it, instead of a link error that takes the whole file
// down before a single test runs.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbm from '../src/db';

// ─── Transport security ─────────────────────────────────────────────────────
//
// Hosts are .invalid (RFC 2606) throughout. Nothing here connects anywhere, and
// no real MMAKF connection string or credential appears in this file.

describe('TLS is requested in code, not left to a query parameter', () => {
  const REMOTE = 'postgresql://app:redacted@pooler.example.invalid:6543/postgres';

  it('a remote database gets TLS with the certificate actually verified', () => {
    // postgres.js ships `ssl: false`. Omitting the option is therefore a
    // decision to send everything in plaintext, not a neutral default.
    const opts: any = dbm.connectionOptions(REMOTE);
    expect(opts.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('encryption alone is not enough: sslmode=require would not check who answered', () => {
    // postgres.js maps 'require', 'allow' and 'prefer' to rejectUnauthorized
    // = false (connection.js), which is libpq-standard: those modes encrypt but
    // authenticate nobody, so an active man in the middle still reads and
    // rewrites the traffic. Whatever this returns, it must not be one of them.
    const opts: any = dbm.connectionOptions(REMOTE);
    expect(['require', 'allow', 'prefer']).not.toContain(opts.ssl);
    expect(opts.ssl?.rejectUnauthorized).toBe(true);
  });

  it('an sslmode the operator wrote in the URL wins, and is not silently downgraded', () => {
    // postgres.js resolves an `ssl` passed in the options object BEFORE the
    // one parsed out of the query string. Setting ours unconditionally would
    // therefore override a URL that asked for verify-full — a fix that makes
    // the careful operator worse off. Leaving the key absent hands the decision
    // back to the string they wrote.
    for (const mode of ['verify-full', 'verify-ca', 'require', 'disable']) {
      const opts: any = dbm.connectionOptions(`${REMOTE}?sslmode=${mode}`);
      expect(Object.prototype.hasOwnProperty.call(opts, 'ssl'), `sslmode=${mode} was overridden`).toBe(false);
    }
  });

  it('loopback is exempt — the local dev database speaks no TLS at all', () => {
    // scripts/dev-db.mjs serves PGlite over the wire protocol on 127.0.0.1:5433
    // and cannot negotiate TLS. Demanding it there would break `astro dev` for
    // everyone while protecting bytes that never touch a network.
    for (const host of ['127.0.0.1:5433', 'localhost:5432', '[::1]:5432']) {
      const opts: any = dbm.connectionOptions(`postgresql://postgres:postgres@${host}/postgres`);
      expect(opts.ssl, host).toBe(false);
    }
  });

  it('a URL it cannot parse fails CLOSED, with TLS on', () => {
    // The safe direction for an unknown destination is encrypted-and-verified.
    // A string this malformed will not connect anyway; what matters is that the
    // fallback is never "send it in the clear".
    const opts: any = dbm.connectionOptions('not-a-url');
    expect(opts.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('the pooler settings survive: max 1 and prepare false', () => {
    // prepare:false is what keeps a transaction-mode pooler from producing
    // "prepared statement does not exist" under load. A rewrite of this block
    // that loses it fails at load, not at review.
    const opts: any = dbm.connectionOptions(REMOTE);
    expect(opts.max).toBe(1);
    expect(opts.prepare).toBe(false);
    expect(opts.connect_timeout).toBe(10);
    expect(opts.idle_timeout).toBe(20);
  });
});

// ─── One variable names the database ────────────────────────────────────────

describe('DATABASE_URL is the only way to point the federation at a database', () => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('an injected POSTGRES_URL does NOT activate the federation system', () => {
    // The scenario: someone adds a Postgres integration in the Vercel dashboard
    // while trying to get the real connection working. It injects POSTGRES_URL.
    // Under the old fallback, isConfigured() went true against a database that
    // had never been migrated and that nobody had chosen — silently, with
    // DATABASE_URL still unset.
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_URL = 'postgresql://someone-elses:database@integration.example.invalid:5432/verceldb';
    expect(dbm.databaseUrl()).toBe('');
    expect(dbm.isConfigured()).toBe(false);
  });

  it('DATABASE_URL still configures it', () => {
    process.env.DATABASE_URL = 'postgresql://app:redacted@pooler.example.invalid:6543/postgres';
    delete process.env.POSTGRES_URL;
    expect(dbm.databaseUrl()).toBe('postgresql://app:redacted@pooler.example.invalid:6543/postgres');
    expect(dbm.isConfigured()).toBe(true);
  });
});

// ─── What "healthy" means ───────────────────────────────────────────────────

describe('the health probe', () => {
  let client: PGlite;
  const saved = process.env.DATABASE_URL;

  // Port 1 refuses instantly. If the probe still dials the URL itself, these
  // tests report unhealthy; if it uses the connection the invocation already
  // holds — the one thing under test — the dead port is never touched.
  const DEAD = 'postgresql://app:redacted@127.0.0.1:1/postgres';

  beforeAll(async () => {
    client = new PGlite();
    dbm.__setTestClient(drizzle(client));
    process.env.DATABASE_URL = DEAD;
    return () => {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    };
  });

  it('probes through the connection the invocation already holds', async () => {
    // The old probe built a whole new pool per call: TCP, TLS, SCRAM and a type
    // round trip, on an endpoint that is unauthenticated, unthrottled and
    // published in the runbook as the thing to curl.
    await client.exec('CREATE TABLE IF NOT EXISTS _mmakf_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())');
    expect(await dbm.databaseHealthy()).toBe(true);
  });

  it('an unmigrated database is NOT healthy, however cheerfully it answers', async () => {
    // `select 1` succeeds on any reachable Postgres, including an empty one and
    // including the wrong one. DEPLOYMENT.md Step 5 prescribes exactly this
    // endpoint as the proof the cutover worked, so "ok" has to mean "the
    // migrations are here", not "something is listening".
    await client.exec('DROP TABLE IF EXISTS _mmakf_migrations');
    expect(await dbm.databaseHealthy()).toBe(false);
    await client.exec('CREATE TABLE _mmakf_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())');
    expect(await dbm.databaseHealthy()).toBe(true);
  });

  it('an unconfigured environment is not healthy, and never touches a client', async () => {
    delete process.env.DATABASE_URL;
    expect(await dbm.databaseHealthy()).toBe(false);
    process.env.DATABASE_URL = DEAD;
  });
});

// ─── The trap that has to stay written down ─────────────────────────────────

describe('the owner/row-level-security dependency is recorded where the connection is made', () => {
  it('src/db/index.ts says what happens if the app stops owning its tables', () => {
    // Postgres exempts a table's OWNER from row-level security. The app connects
    // as the owner, so RLS can be switched on without a policy and nothing
    // breaks — which makes the ordering of any future move to a least-privilege
    // role load-bearing, and quiet in one direction: with RLS on and no matching
    // policy a SELECT returns zero rows rather than an error, so the site
    // renders an empty federation with HTTP 200. A trap that is written down has
    // cost its last hour; this test is what keeps it written down.
    const src = readFileSync('src/db/index.ts', 'utf8');
    expect(/row-level security/i.test(src), 'the RLS note is gone from src/db/index.ts').toBe(true);
    expect(/owner/i.test(src), 'the ownership note is gone from src/db/index.ts').toBe(true);
  });
});
