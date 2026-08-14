// Federation-wide search, as JSON (§10, §11).
//
// This endpoint exists to make the search box in GlobalSearch.astro respond as
// somebody types. It is an ACCELERATOR: /search renders the same answers on the
// server without it, and the component's form posts there when JavaScript is
// off. Nothing essential is behind this route.
//
// FOUR THINGS IT DOES THAT A SEARCH ENDPOINT USUALLY DOES NOT.
//
//  · IT REQUIRES A SESSION. globalSearch() would happily serve an anonymous
//    caller the public domains, but a per-keystroke endpoint open to the
//    internet is a free scraping interface for the dojo directory. Anonymous
//    search still works — on /search, one page load at a time.
//
//  · IT DOES NOT WRITE AN AUDIT ROW. Every other read of the register that
//    matters is audited, and this one deliberately is not: at one row per
//    keystroke the audit table fills with fragments of half-typed names, and an
//    audit trail that has to be de-duplicated before it can be read stops being
//    evidence. Staff surfaces that search deliberately — /search, and any admin
//    screen that adopts globalSearch() — pass an audit context. See the same
//    reasoning at the top of src/pages/search.astro.
//
//  · IT NEVER CACHES. Results are filtered by the caller's own scopes, so a
//    shared cache serving one administrator's results to another is a
//    disclosure. `no-store` plus `Vary: Cookie` says so twice, because a CDN
//    that ignores one may honour the other.
//
//  · IT ANSWERS "NOT CONFIGURED" WITH 200 AND A STATE, NOT AN ERROR. Production
//    has no DATABASE_URL. A 500 there would be read as a fault to be fixed at
//    3am; the truth is that nothing is wrong and there is nothing to search, and
//    the component renders that sentence. The failure that IS a fault — a query
//    that threw — returns 503 and says so.

import type { APIRoute } from 'astro';
import { identify } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { SearchError, MAX_QUERY_LENGTH } from '@/lib/search';
import {
  globalSearch,
  GROUP_ORDER,
  MAX_PER_GROUP,
  type GlobalKind,
  type GlobalSearchResponse,
} from '@/lib/global-search';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The answer depends on who is asking. Without this a caching layer may
      // serve one caller's permitted results to another.
      Vary: 'Cookie',
    },
  });
}

/** The shape the component reads. Kept flat so it can be rendered without a schema. */
function empty(state: GlobalSearchResponse['state'], query: string): GlobalSearchResponse {
  return { state, query, groups: [], total: 0, truncated: false, skipped: [], notices: [] };
}

export const GET: APIRoute = async ({ request, url }) => {
  // Generous enough to type through, tight enough that the endpoint is not a
  // bulk export tool: a scripted caller hits this long before a person does.
  const rl = await rateLimit(request, 'search-global', 90, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) {
    // Just the error. Dressing a refusal up as an empty GlobalSearchResponse
    // would hand the caller a `state` and a `groups: []` that a careless surface
    // renders as "nothing matched" — a refusal and an empty register are not
    // the same fact.
    return json({ error: 'Sign in to search the federation.' }, 401);
  }

  // Trimmed before length checks so a box full of spaces is an empty query — the
  // suggestion case — rather than a query of twelve characters that matches
  // nothing.
  const raw = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH + 1);

  if (!isConfigured()) {
    // Not an error. The federation database is simply not configured for this
    // environment, and the component prints that rather than an empty list —
    // which would say "nothing matched", the one thing this cannot know.
    return json(empty('not_configured', raw.trim()), 200);
  }

  const rawPerGroup = url.searchParams.get('perGroup');
  let perGroup: number | undefined;
  if (rawPerGroup !== null) {
    const n = Number(rawPerGroup);
    // Refused, not coerced: NaN reaching the limit is how a search returns
    // "nothing, and that is all of it".
    if (!Number.isFinite(n)) return json({ error: 'perGroup must be a number.' }, 400);
    perGroup = Math.min(Math.max(1, Math.trunc(n)), MAX_PER_GROUP);
  }

  // An unrecognised kind is DROPPED rather than 400ing the whole request, and an
  // explicit list that survives as empty is honoured as "none" rather than
  // silently widened to everything — reading `[]` as "search all types" is the
  // fail-open mistake.
  const rawKinds = url.searchParams.getAll('kind');
  const kinds: GlobalKind[] | undefined = rawKinds.length
    ? (rawKinds.filter((k) => (GROUP_ORDER as readonly string[]).includes(k)) as GlobalKind[])
    : undefined;

  try {
    const result = await globalSearch(db(), identity.principal, raw, { perGroup, kinds });
    return json(result, 200);
  } catch (err: any) {
    // A refused input — a query of the wrong type, an impossible page size — is
    // the caller's to fix and is named.
    if (err instanceof SearchError) {
      return json({ error: err.message, code: err.code }, 400);
    }
    // Anything else is ours. Reported as a failed search, never as an empty one:
    // telling a caller "no results" when the query never ran is the opposite of
    // the truth.
    console.error('[search/global] failed', err);
    return json({ error: 'The search could not be completed.' }, 503);
  }
};
