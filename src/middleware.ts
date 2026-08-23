// Request middleware — cross-site request forgery defence (§53).
//
// Before this, `SameSite=Lax` was the only CSRF control on the whole site. Lax
// is site-scoped, not origin-scoped: any subdomain of mmakf.in — including one
// an attacker gets control of — could drive authenticated writes to the admin
// API using the office's own session cookie. And `/api/data/[key]` parsed
// `request.json()` without checking Content-Type, so a cross-site form posted
// with `enctype="text/plain"` was accepted as JSON.
//
// Two checks on every state-changing request:
//
//   1. ORIGIN. `Sec-Fetch-Site: same-origin` is trusted where the browser sends
//      it (it cannot be set by script). Otherwise the `Origin` header must match
//      the host we were reached on. A request with neither is refused rather
//      than waved through, because "no Origin" is exactly what a forged
//      cross-site form produces.
//
//   2. CONTENT TYPE. JSON endpoints must be sent `application/json`, which a
//      simple cross-site form cannot produce without triggering a CORS
//      preflight that we never answer.
//
// Webhooks are exempt from the Origin check and authenticated by signature
// instead: they are server-to-server and legitimately carry no Origin. They are
// listed explicitly, so exemption is never accidental.

import { defineMiddleware } from 'astro:middleware';
import { isSameOrigin, isJsonContentType } from '@/lib/origin';
import { surfaceForHost, rewriteTarget, type Surface } from '@/lib/surface';

declare global {
  namespace App {
    interface Locals {
      surface: Surface;
    }
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Set by src/pages/404.astro, read in proceed(), never sent to a client. */
const NOT_FOUND_MARKER = 'x-mmakf-not-found';

/** The marker is internal plumbing. Strip it before the response leaves. */
function headersWithoutMarker(res: Response): Headers {
  const headers = new Headers(res.headers);
  headers.delete(NOT_FOUND_MARKER);
  return headers;
}

/**
 * Paths authenticated by cryptographic signature, not by origin.
 *
 * Listed as EXACT paths, and each one has to be added deliberately. The match
 * below is `===` or a `/`-delimited prefix, so a provider-specific route that
 * sits beside an existing entry rather than under it — as
 * /api/payments/razorpay/webhook does — is NOT covered by that entry and would
 * otherwise be refused for having no Origin, which is exactly what a
 * server-to-server delivery looks like.
 */
const SIGNATURE_AUTHENTICATED = [
  '/api/payments/webhook',
  '/api/payments/razorpay/webhook',
];

function deny(reason: string): Response {
  // Deliberately terse: an attacker learns nothing, and the reason is logged
  // server-side for the operator.
  console.warn(`[csrf] refused: ${reason}`);
  return new Response(JSON.stringify({ error: 'Request refused' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}


export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;

  // ── Which of the three surfaces was asked for ────────────────────────────
  //
  // Decided from the Host header and put on locals, so a page never has to
  // parse the host itself. See src/lib/surface.ts for why the three hosts share
  // one application rather than being three deployments.
  // THE HOST THE VISITOR TYPED, NOT THE ONE THE FUNCTION WAS INVOKED ON.
  //
  // A LIVE BUG. learn.mmakf.in and admin.mmakf.in resolved, returned 200, and
  // served the PUBLIC HOMEPAGE — because behind Vercel's proxy `url.host` is
  // the internal invocation host, so surfaceForHost() saw something that was on
  // no list and fell back to 'public' for every request on every subdomain. The
  // surface router had never actually run in production.
  //
  // `x-forwarded-host` is set by the edge and is the public name.
  //
  // IT IS USED FOR ROUTING ONLY, NEVER FOR THE CSRF COMPARISON BELOW. The
  // header is forgeable by anything speaking directly to the origin, and
  // deciding "is this request same-origin?" from a value the caller supplies
  // would answer the question with the attacker's own input. Choosing which
  // navigation to render from it is harmless: the worst a forged value achieves
  // is the wrong menu, and every page re-checks its own authority regardless.
  const publicHost = request.headers.get('x-forwarded-host') || url.host;
  const surface = surfaceForHost(publicHost);
  context.locals.surface = surface;

  const target = rewriteTarget(surface, url.pathname);

  // THE REWRITE HAPPENS LAST, AND ONLY THROUGH HERE.
  //
  // It is tempting to rewrite at the top of this function and return. Do not:
  // whether Astro re-runs middleware for a rewritten route is a framework
  // detail, and if it does not, an early return would carry every POST to
  // learn.mmakf.in and admin.mmakf.in straight past the CSRF checks below.
  // That is a silent hole that only opens on two of the three hosts, which is
  // the hardest kind to notice.
  //
  // Deferring it means the checks run first, unconditionally, on every host.
  // Re-entry is harmless either way because rewriteTarget() is idempotent — an
  // already-prefixed path returns null.
  const proceed = async (): Promise<Response> => {
    if (!target) return next();

    const res = await context.rewrite(target + url.search);
    if (res.status !== 404) return res;

    // ── WAS THIS A REAL MISS, OR A REAL PAGE UNDER A BORROWED STATUS? ──────
    //
    // Both happen, and they need opposite answers.
    //
    // A rewrite that FOUND THE PAGE still carries 404, because the platform
    // chose that status for the un-prefixed path — /apply — before the rewrite
    // to /learn/apply ever ran. On learn.mmakf.in that shipped every page of
    // the surface as a 404 carrying twelve kilobytes of correct HTML: browsers
    // render it, search engines conclude the page does not exist, and the whole
    // surface was unindexable while looking perfect. Only / and /portal escaped,
    // because those paths happen to exist at the top level too.
    //
    // A rewrite that FOUND NOTHING must keep its 404, and it arrives in two
    // shapes — which is why both are tested. On the learn host Astro renders no
    // page at all and the body is empty; on the admin host it renders the 404
    // page, body and all. Emptiness alone would have forced that second one to
    // 200 and told the world every mistyped admin URL was a page.
    //
    // NONE OF THIS REPRODUCES LOCALLY: `astro dev` already answers 200 for a
    // rewritten hit. The wrong status is the platform, which selected the 404
    // route for the un-prefixed path before this middleware ever ran.
    //
    // Only 404 responses are buffered, so nothing that streams is affected.
    const isNotFoundPage = res.headers.has(NOT_FOUND_MARKER);
    const headers = headersWithoutMarker(res);
    const body = await res.arrayBuffer();

    if (isNotFoundPage || body.byteLength === 0) {
      return new Response(body, { status: 404, statusText: res.statusText, headers });
    }
    return new Response(body, { status: 200, statusText: 'OK', headers });
  };

  if (!MUTATING.has(request.method)) return proceed();

  const path = url.pathname;

  if (SIGNATURE_AUTHENTICATED.some((p) => path === p || path.startsWith(`${p}/`))) {
    return proceed();
  }

  if (!isSameOrigin(request.headers, url.host)) {
    return deny(`cross-origin ${request.method} ${path}`);
  }

  if (path.startsWith('/api/')) {
    const contentType = request.headers.get('content-type') || '';
    if (!isJsonContentType(contentType)) {
      return deny(`non-JSON content type "${contentType}" on ${path}`);
    }
  }

  return proceed();
});
