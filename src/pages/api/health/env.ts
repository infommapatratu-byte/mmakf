// Environment diagnosis, without ever revealing an environment.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS ENDPOINT EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// /api/health has reported `"database": "not_configured"` across three separate
// production deployments while the operator was certain DATABASE_URL was set in
// Vercel. Both statements can be true at once, and the flat health payload
// cannot tell them apart. It answers ONE question — is the string non-empty —
// and every distinct cause collapses into the same word:
//
//   · the variable was never linked to this project (a SHARED variable in the
//     team store does not reach a project until it is attached to it)
//   · it exists but only for Preview or Development, not Production
//   · it is on a different Vercel project than the one building this repository
//   · it is present and empty
//   · it is present with a trailing newline or wrapping quotes from a paste,
//     so it is non-empty and unparseable
//   · the code reads a different variable name
//
// Six causes, one message, and no way to choose between them from outside. That
// is what has made this take three deployments.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT WILL AND WILL NOT SAY
// ─────────────────────────────────────────────────────────────────────────────
//
// It reports the SHAPE of a value and never any part of it:
//
//   present · length · has a protocol · has a host · has a port · has a
//   database name · has credentials · begins or ends with whitespace · is
//   wrapped in quotes
//
// It NEVER returns the URL, the host, the username, the password, the database
// name, a query parameter, or any substring of any of them. `length` is the
// only number that leaves, and a length alone identifies nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND IT IS NOT PUBLIC
// ─────────────────────────────────────────────────────────────────────────────
//
// Even shape is more than a stranger should learn. Knowing the connection
// string is 147 characters and carries a password tells an attacker the
// database exists and is reachable, which is a reconnaissance step this site
// has no reason to offer.
//
// So it requires an operator with 'audit:read'. If nobody is signed in it
// returns 404 rather than 401 — a 401 confirms the endpoint exists, and this
// one has no reason to admit that to an unauthenticated caller.

import type { APIRoute } from 'astro';
import { identify } from '@/lib/session';
import { canAnywhere } from '@/lib/rbac';

export const prerender = false;

/** The shape of a secret, with none of its content. */
interface Shape {
  present: boolean;
  length: number;
  /** Set only when something is structurally wrong, and never quotes a value. */
  problems: string[];
}

function shapeOf(raw: string | undefined): Shape {
  if (raw === undefined) return { present: false, length: 0, problems: ['not set in this environment'] };

  const problems: string[] = [];
  const len = raw.length;

  if (len === 0) problems.push('present but empty');
  if (raw !== raw.trim()) {
    // The single most common paste error, and it is invisible in a dashboard
    // field. A trailing newline makes the value non-empty, so isConfigured()
    // returns true and the connection then fails on a host with a newline in it.
    problems.push('has leading or trailing whitespace — a trailing newline survives a paste and is invisible in the dashboard');
  }
  if (/^["'].*["']$/s.test(raw.trim())) {
    problems.push('is wrapped in quotes — Vercel stores the value literally, so the quotes become part of the string');
  }
  return { present: true, length: len, problems };
}

/** Structural facts about a connection string. Never its contents. */
function urlShape(raw: string | undefined): Record<string, unknown> {
  const value = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return { parseable: false };

  try {
    const u = new URL(value);
    return {
      parseable: true,
      // The protocol is not a secret and it is the fastest way to spot the
      // wrong string pasted entirely — an https:// here means somebody copied
      // the project URL rather than the connection string.
      protocol: u.protocol.replace(':', ''),
      hasHost: u.hostname.length > 0,
      hasPort: u.port.length > 0,
      port: u.port || null,
      hasUsername: u.username.length > 0,
      hasPassword: u.password.length > 0,
      hasDatabaseName: u.pathname.replace(/^\//, '').length > 0,
      // Which pooler, if any. This decides whether migrations can run at all:
      // the transaction pooler cannot hold the DDL transaction each migration
      // file opens.
      poolerHint:
        u.port === '6543' ? 'transaction pooler — migrations CANNOT run through this'
        : u.hostname.includes('pooler.') ? 'session pooler — suitable for migrations'
        : 'direct connection',
      // A pooler needs prepare:false, which src/db/index.ts already sets. Noted
      // so an operator reading this does not go looking for it.
      sslModeSpecified: /[?&]sslmode=/i.test(value),
    };
  } catch {
    return {
      parseable: false,
      // Not the value, and not the position — just the fact.
      note: 'the value is not a parseable URL',
    };
  }
}

export const GET: APIRoute = async ({ request }) => {
  const identity = await identify(request.headers.get('cookie'));
  const principal = identity?.principal ?? null;

  // 404, not 401. A 401 confirms the endpoint exists and that there is
  // something here worth authenticating for.
  if (!principal || !canAnywhere(principal, 'audit:read')) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const raw = process.env.DATABASE_URL;

  return new Response(
    JSON.stringify(
      {
        deployment: {
          // §42: every verification records which deployment answered it.
          commit: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
          // 'production' | 'preview' | 'development'. THE FIELD THAT SETTLES
          // the "is it ticked for Production?" question from the inside.
          vercelEnv: process.env.VERCEL_ENV || null,
          region: process.env.VERCEL_REGION || null,
        },
        DATABASE_URL: {
          ...shapeOf(raw),
          structure: urlShape(raw),
        },
        // The other names a reader might expect to work. databaseUrl() reads
        // DATABASE_URL and nothing else — it deliberately stopped falling back
        // to POSTGRES_URL, because a fallback means a misconfiguration connects
        // to the wrong database instead of failing. Reported so an operator who
        // set the wrong name can see it immediately.
        otherNames: {
          POSTGRES_URL: process.env.POSTGRES_URL !== undefined,
          POSTGRES_PRISMA_URL: process.env.POSTGRES_PRISMA_URL !== undefined,
          SUPABASE_DB_URL: process.env.SUPABASE_DB_URL !== undefined,
          DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED !== undefined,
        },
        editorialStore: {
          UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL !== undefined,
          KV_REST_API_URL: process.env.KV_REST_API_URL !== undefined,
        },
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        // Never indexed, never cached at the edge.
        'X-Robots-Tag': 'noindex, nofollow',
      },
    }
  );
};
