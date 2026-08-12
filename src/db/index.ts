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

export function databaseUrl(): string {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
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
 */
function options() {
  return {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  } as const;
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
    client = postgres(url, options());
    cached = drizzle(client, { schema });
  }
  return cached;
}

/** For tests: inject a PGlite-backed client so suites run real Postgres. */
export function __setTestClient(c: any) {
  cached = c;
}

/** Health probe for /api/health. Never throws. */
export async function databaseHealthy(): Promise<boolean> {
  if (!isConfigured()) return false;
  const probe = postgres(databaseUrl(), { ...options(), max: 1 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
}
