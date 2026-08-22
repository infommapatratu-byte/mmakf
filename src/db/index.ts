// Database access for federation records (Wave 2a).
//
// Postgres holds federation records — people, units, credentials, audit.
// Redis continues to hold editorial CMS content; see
// docs/FEDERATION-ARCHITECTURE.md §1.2 for why the two coexist.
//
// DRIVER: postgres.js over standard TCP, deliberately provider-neutral. Any
// Postgres works — Supabase, Railway, Render, Fly, RDS, or a self-hosted server
// — because nothing here depends on a vendor SDK. Moving hosts is a change of
// connection string, not a change of code.
//
// §70 (no fake features): when DATABASE_URL is absent the federation modules
// must report "not configured" rather than pretending to work. `isConfigured()`
// is the single check; `db()` throws if called without it.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export { schema };

let cached: ReturnType<typeof drizzle> | null = null;
let client: ReturnType<typeof postgres> | null = null;

/**
 * The federation database, and ONLY if somebody chose it.
 *
 * This used to fall back to POSTGRES_URL. That looks harmless and is not:
 * adding a Postgres integration in the Vercel dashboard — which is exactly what
 * an operator does while trying to get the real connection working — INJECTS
 * POSTGRES_URL automatically. Under the fallback, isConfigured() went true
 * against a database nobody had chosen and no migration had ever touched, with
 * DATABASE_URL still unset. The federation would then read an empty register
 * and report, in perfectly good faith, that it has no members.
 *
 * One variable, named for the thing it is. An operator who wants a different
 * database sets it deliberately.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL || '';
}

/** True when a federation database is configured for this environment. */
export function isConfigured(): boolean {
  return databaseUrl().length > 0;
}

/**
 * Connection settings tuned for serverless.
 *
 * Each function invocation is its own short-lived process, so a large pool per
 * instance would exhaust the server's connection limit under load — hence
 * `max: 1` and an idle timeout that lets the socket go rather than holding it.
 *
 * `prepare: false` is required when the URL points at a transaction-mode pooler
 * (PgBouncer, Supabase port 6543): prepared statements are bound to a backend
 * connection the pooler is free to swap out mid-session. Leaving it on is the
 * classic "prepared statement does not exist" failure under load.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND TLS, WHICH postgres.js DOES NOT TURN ON FOR YOU
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * postgres.js ships `ssl: false`. Omitting the option is therefore a DECISION
 * TO SEND EVERYTHING IN PLAINTEXT — every password hash, every child's date of
 * birth, every safeguarding note — not a neutral default. Across the public
 * internet to a managed database, that is the whole register in the clear.
 *
 * `sslmode=require` is not the fix either. postgres.js maps `require`, `allow`
 * and `prefer` to rejectUnauthorized:false, which is libpq-standard behaviour:
 * they encrypt, and they authenticate nobody. An active man in the middle
 * presents any certificate at all and reads and rewrites the traffic. What is
 * wanted is encryption WITH the certificate verified.
 *
 * Three rules, and the second is the one that is easy to get wrong:
 *
 *   1. A remote host gets ssl: { rejectUnauthorized: true }.
 *   2. IF THE OPERATOR WROTE sslmode INTO THE URL, WE SET NOTHING. postgres.js
 *      resolves an `ssl` passed in the options object BEFORE the one parsed out
 *      of the query string, so setting ours unconditionally would override an
 *      operator who asked for verify-full — a "fix" that makes the careful
 *      person worse off. Leaving the key absent hands the decision back to them.
 *   3. Loopback is exempt. scripts/dev-db.mjs serves PGlite over the wire
 *      protocol on 127.0.0.1 and cannot negotiate TLS at all; demanding it
 *      there would break `astro dev` for everyone to protect bytes that never
 *      reach a network.
 *
 * A URL that cannot be parsed FAILS CLOSED, with TLS on and verified. Such a
 * string will not connect anyway; what matters is that the fallback direction
 * is never "send it in the clear".
 *
 * Exported so all of this is testable without opening a socket — see
 * tests/db-connection.test.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE TRAP THAT MUST STAY WRITTEN DOWN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Migration 0011 switches ROW-LEVEL SECURITY on for every table in `public` and
 * writes no policy at all. That closes Supabase's HTTP Data API — the `anon`
 * key can reach nothing — and the application keeps working for exactly one
 * reason: POSTGRES EXEMPTS A TABLE'S OWNER FROM ROW-LEVEL SECURITY, and this
 * app connects as the role that owns them.
 *
 * So the ownership is load-bearing, and the failure mode if it changes is the
 * worst kind: QUIET. With RLS enabled and no policy matching, a SELECT does not
 * error — it returns ZERO ROWS. Move this connection to a least-privilege role
 * without writing policies first and the site does not break. It renders an
 * empty federation, with HTTP 200, and reports that MMAKF has no members.
 *
 * If that move is ever made, write the policies FIRST and verify against a
 * database with records in it. Deliberately NOT `FORCE ROW LEVEL SECURITY`,
 * which would apply RLS to the owner too and break the site immediately —
 * arguably louder, but it would take production down to fix a door that is
 * already shut.
 */
export function connectionOptions(url: string): Record<string, unknown> {
  const base = {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  };

  // Rule 2 — before anything else, because it overrides the other two.
  if (/[?&]sslmode=/i.test(url)) return base;

  // ── RULE 4: A PRIVATE ROOT IS SUPPLIED, NOT SURRENDERED TO ─────────────────
  //
  // Managed Postgres is routinely fronted by a certificate chaining to the
  // VENDOR'S OWN root rather than a public CA. Supabase's pooler serves
  // `*.pooler.supabase.com` under `Supabase Intermediate 2021 CA` and
  // `Supabase Root 2021 CA`, and that root is in no trust store Node ships —
  // so rule 1 fails closed with SELF_SIGNED_CERT_IN_CHAIN and the federation
  // register is unreachable. Measured against the live pooler, both ports.
  //
  // That failure is CORRECT, and the tempting repair is the wrong one: falling
  // back to rejectUnauthorized:false converts an outage into a channel any
  // active intermediary can read and rewrite — the whole register, in the
  // clear, to anyone positioned to take it. The repair is to TEACH THE CLIENT
  // THE ROOT. Set DATABASE_CA_CERT to the provider's CA in PEM and
  // verification passes with the guarantee intact rather than discarded.
  //
  // Named for the job and not for the vendor, so any provider with a private
  // root works — the same neutrality DATABASE_URL buys everywhere else here.
  // Absent the variable nothing changes: rule 1 still demands a publicly
  // verifiable certificate, which is the right default for a provider that has
  // one.
  const ca = process.env.DATABASE_CA_CERT?.trim();
  const verified = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Rule: fail closed.
    return { ...base, ssl: verified };
  }

  // `new URL()` keeps IPv6 literals in their brackets; strip them so the
  // loopback comparison sees ::1 rather than [::1].
  const bare = host.replace(/^\[|\]$/g, '');
  const loopback = bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';

  return loopback ? { ...base, ssl: false } : { ...base, ssl: verified };
}

/**
 * The Drizzle client. Throws when unconfigured — callers should branch on
 * isConfigured() and render the configuration-required state instead.
 */
export function db() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      'Federation database not configured: set DATABASE_URL. ' +
      'Surfaces must check isConfigured() before querying.'
    );
  }
  if (!cached) {
    client = postgres(url, connectionOptions(url) as any);
    cached = drizzle(client, { schema });
  }
  return cached;
}

/** For tests: inject a PGlite-backed client so suites run real Postgres. */
export function __setTestClient(c: any) {
  cached = c;
}

// ─── WHY A FAULT CLASS LEAVES THIS MODULE, WHEN A CONNECTION STRING NEVER DOES
//
// /api/health reported `"database":"error"` and nothing else, and that one word
// cost the federation five days of a locked admin console. The register was
// REFUSING THE APPLICATION'S CREDENTIALS — PostgresError 28P01, `password
// authentication failed for user "postgres"` — and from outside that is
// indistinguishable from a paused project, a withdrawn route, or a database that
// answers perfectly and was never migrated. Each of those is a different fix,
// and the only way to tell them apart was to stream the deployment's runtime log
// while provoking a login.
//
// So the CLASS of the fault is published and the fault itself is not. One token
// off a fixed list leaves here — a SQLSTATE or a Node error code — with no
// message attached, because THE MESSAGE IS WHERE THE IDENTIFIERS LIVE: `password
// authentication failed for user "postgres"` names the role, and a DNS failure
// names the host. Anything unrecognised reports 'other' rather than being
// echoed, so a driver that grows a new message later cannot leak one through
// this hole. Same bar as dbVars in /api/health: names and classes yes, values
// never.
const FAULT_CODES = new Set([
  '28P01',  // the password was refused
  '28000',  // the role, or its authentication method, was refused
  '3D000',  // no such database
  '42P01',  // answering, but the migrations are not there
  '53300',  // too many connections
  '57P03',  // the server is still starting up
  'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
]);

/** Drizzle wraps the driver error, so the code is not always on the top one. */
function faultCode(err: unknown): string {
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    const c = typeof e.code === 'string' ? e.code : '';
    if (c && FAULT_CODES.has(c)) return c;
  }
  return 'other';
}

let lastFault: string | null = null;

/** The class of the last refusal, or null when the register last answered. */
export function lastRegisterFault(): string | null {
  return lastFault;
}

export type RegisterUrlShape =
  | 'not_configured' | 'unparseable' | 'no_user' | 'pooled_host_bare_user' | 'ok';

/**
 * The SHAPE of the configured connection string — never any part of its value.
 *
 * There is one misconfiguration that reports itself as the wrong problem, and it
 * is the one this federation hit. A TRANSACTION POOLER MULTIPLEXES MANY PROJECTS
 * ONTO ONE HOSTNAME, so the username has to say which project the session
 * belongs to: the tenant is carried in the role, as `<role>.<project-ref>`.
 * Handed a bare role the pooler cannot route the session at all — and it
 * refuses rather than guessing, with `password authentication failed`. That
 * sends an operator to reset a password which was never wrong, and the reset
 * does not fix it, so they reset it again.
 *
 * Reporting the shape turns that into one sentence. No host, no role, no
 * project reference and no password leaves: the return value is one of five
 * fixed words.
 */
export function connectionShape(url: string = databaseUrl()): RegisterUrlShape {
  if (!url) return 'not_configured';
  let u: URL;
  try { u = new URL(url); } catch { return 'unparseable'; }
  let user = u.username || '';
  try { user = decodeURIComponent(user); } catch { /* leave it as written */ }
  if (!user) return 'no_user';
  if (/(^|\.)pooler\./i.test(u.hostname) && !user.includes('.')) return 'pooled_host_bare_user';
  return 'ok';
}

/** * Health probe for /api/health. Never throws.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE OBVIOUS VERSION DOES NOT.
 *
 * IT ASKS A QUESTION ONLY THE RIGHT DATABASE CAN ANSWER. `select 1` succeeds
 * against any reachable Postgres — an empty one, a staging one, somebody
 * else's. docs/DEPLOYMENT.md prescribes this endpoint as the proof the cutover
 * worked, so "ok" has to mean "the migrations are here", not "something is
 * listening". It reads the migration ledger instead.
 *
 * IT USES THE CONNECTION THE INVOCATION ALREADY HOLDS. Opening a second client
 * per health check burns a pooler slot every time a monitor polls — on a
 * transaction pooler with a small connection limit, a health check that
 * exhausts the pool is a health check that CAUSES the outage it is watching
 * for. It also means the probe exercises the same TLS settings as the real
 * client rather than a second set that could silently differ.
 */
export async function databaseHealthy(): Promise<boolean> {
  if (!cached && !isConfigured()) return false;
  try {
    const { sql: raw } = await import('drizzle-orm');
    await db().execute(raw`select 1 from _mmakf_migrations limit 1`);
    lastFault = null;
    return true;
  } catch (err) {
    // Unreachable, unmigrated, or refusing us. All three are "not healthy" and
    // all three need a different fix, so the CLASS is kept — see FAULT_CODES
    // above for what may leave and why the message never does.
    lastFault = faultCode(err);
    return false;
  }
}
