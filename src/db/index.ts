// Database access for federation records (Wave 2a).
//
// Postgres (Neon) holds federation records — people, units, credentials, audit.
// Redis continues to hold editorial CMS content; see
// docs/FEDERATION-ARCHITECTURE.md §1.2 for why the two coexist.
//
// §70 (no fake features): when DATABASE_URL is absent the federation modules
// must report "not configured" rather than pretending to work. `isConfigured()`
// is the single check; `db()` throws if called without it.

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

export { schema };

let cached: ReturnType<typeof drizzle> | null = null;

export function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    ''
  );
}

/** True when a federation database is configured for this environment. */
export function isConfigured(): boolean {
  return databaseUrl().length > 0;
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
  if (!cached) cached = drizzle(neon(url), { schema });
  return cached;
}

/** For tests: inject a PGlite-backed client so suites run real Postgres. */
export function __setTestClient(client: any) {
  cached = client;
}

/** Health probe for /api/health. Never throws. */
export async function databaseHealthy(): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const sql = neon(databaseUrl());
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
