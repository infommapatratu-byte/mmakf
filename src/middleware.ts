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

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths authenticated by cryptographic signature, not by origin. */
const SIGNATURE_AUTHENTICATED = ['/api/payments/webhook'];

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

  if (!MUTATING.has(request.method)) return next();

  const path = url.pathname;

  if (SIGNATURE_AUTHENTICATED.some((p) => path === p || path.startsWith(`${p}/`))) {
    return next();
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

  return next();
});
