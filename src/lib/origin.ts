// Same-origin determination for CSRF defence.
//
// Extracted from the middleware so it can be tested directly: an origin check
// that is wrong in one branch is invisible until it is exploited.

/**
 * Is this request same-origin?
 *
 *  · `Sec-Fetch-Site` is set by the browser and cannot be forged by script, so
 *    it is trusted where present. `none` means a direct navigation.
 *  · Otherwise `Origin` must match the host we were reached on. The HOST is
 *    compared rather than the full origin because TLS terminates at the edge,
 *    so the proxied protocol can legitimately differ.
 *  · `Referer` is a weaker fallback for older browsers.
 *  · A request with none of the three is REFUSED — that is exactly what a
 *    forged cross-site form produces.
 */
/**
 * The hosts MMAKF actually serves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIST HAD TO EXIST — A LIVE BUG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every form on the APEX domain was refused with "Cross-site POST form
 * submissions are forbidden". A school filling in the school application at
 * mmakf.in/learn/apply lost the lot on submit.
 *
 * The chain: Vercel 308-redirects mmakf.in to www.mmakf.in. A POST that crosses
 * that redirect is replayed against the new host, and the browser recomputes
 * `Sec-Fetch-Site` from the ORIGINAL initiator — which is now a different host.
 * mmakf.in and www.mmakf.in are the same SITE and not the same ORIGIN, so the
 * header arrives as `same-site`, and the check accepted only `same-origin` and
 * `none`.
 *
 * The tempting fix is to accept `same-site`. That would undo the reason this
 * module exists: the middleware's own note warns that Lax cookies are
 * site-scoped, so ANY subdomain of mmakf.in — including one an attacker takes
 * over — could then drive authenticated writes. `same-site` does not say WHICH
 * subdomain.
 *
 * So `same-site` is accepted only when the `Origin` header names a host on this
 * list. A hijacked subdomain is same-site and is not on it.
 */
const TRUSTED_HOSTS = new Set([
  'mmakf.in',
  'www.mmakf.in',
  'learn.mmakf.in',
  'admin.mmakf.in',
  // The workforce surface. Added with it — a surface missing from this list has
  // every form on it refused, which is the bug this whole block documents.
  'employee.mmakf.in',
  'employee.localhost',
  'employee.127.0.0.1.nip.io',
  // Development. Kept here rather than behind an environment check because a
  // production deployment never receives an Origin naming localhost, and a
  // conditional that reads the environment is one more thing to get wrong.
  'localhost',
  'learn.localhost',
  'admin.localhost',
  '127.0.0.1',
  'learn.127.0.0.1.nip.io',
  'admin.127.0.0.1.nip.io',
]);

/** Host, lowercased, without a port or a trailing dot. */
function normaliseHost(host: string | null | undefined): string {
  return String(host ?? '').toLowerCase().trim().split(':')[0].replace(/\.$/, '');
}

/** Is this a host the federation itself serves? */
export function isTrustedHost(host: string | null | undefined): boolean {
  return TRUSTED_HOSTS.has(normaliseHost(host));
}

/**
 * @param host  The host this request was received on, WHERE IT IS KNOWN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS PARAMETER IS A FAST PATH, NOT A CONTROL — AND THAT IS A BUG FIX
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE SECOND TIME every form on the apex domain was refused, and the first fix
 * is why the second was so hard to see.
 *
 * `eb1004e` added TRUSTED_HOSTS and the `same-site` branch below, and it is
 * correct. Its unit tests pass `'www.mmakf.in'` as `host` and go green. But the
 * production caller is `src/middleware.ts`, which passes `url.host` — and that
 * same file, twenty lines above the call, records that **behind Vercel's proxy
 * `url.host` is the internal invocation host**, not the name the visitor typed.
 * It is the reason `publicHost` exists there at all.
 *
 * So in production `isTrustedHost(host)` was asking whether an internal Vercel
 * hostname is one of the federation's public hosts. It never is. The
 * conjunction could not be satisfied, the `same-site` branch always returned
 * false, and every POST that crossed the apex-to-www redirect was refused —
 * for months, with a green test suite, because the test called the function
 * with a value the caller never supplies.
 *
 * THE FIX IS TO STOP ASKING. Whether the request is forged is decided by WHERE
 * IT CAME FROM, and `Origin` / `Sec-Fetch-Site` are set by the browser and
 * cannot be forged by script or by a cross-site form. The host it arrived on
 * adds nothing: a request whose initiator is `www.mmakf.in` is the federation's
 * own however the edge routed it, and one whose initiator is `evil.example` is
 * forged however the edge routed it.
 *
 * `host` is therefore used only as an exact-match shortcut, which is why it is
 * still accepted and why passing an internal hostname is now harmless rather
 * than fatal.
 */
export function isSameOrigin(headers: Headers | Record<string, string>, host: string): boolean {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const rec = headers as Record<string, string>;
    return rec[name] ?? rec[name.toLowerCase()] ?? null;
  };

  /**
   * The Origin/Referer host, where the browser sent one.
   *
   * A malformed value CONTINUES to the next header rather than abandoning the
   * search. It used to `return null` on the first unparseable one, so an
   * opaque `Origin: null` — which is what some browsers send once a request has
   * crossed an origin boundary through a redirect — discarded a perfectly good
   * `Referer` sitting behind it and refused the request.
   */
  const initiator = (): string | null => {
    for (const header of ['origin', 'referer']) {
      const value = get(header);
      if (!value) continue;
      try {
        const h = normaliseHost(new URL(value).host);
        if (h) return h;
      } catch {
        continue;
      }
    }
    return null;
  };

  const fetchSite = get('sec-fetch-site');
  if (fetchSite) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
    // Explicitly refused before the same-site branch, so a future edit cannot
    // widen this by accident.
    if (fetchSite === 'cross-site') return false;
    if (fetchSite === 'same-site') {
      // The apex-to-www redirect, and the cross-surface links between
      // www / learn / admin / employee. The INITIATOR must be a host the
      // federation serves — which a subdomain an attacker has taken over is
      // not, and which is the whole of the protection here. See the note on
      // `host` above for why the receiving host is no longer part of this test.
      const from = initiator();
      return !!from && isTrustedHost(from);
    }
    return false;
  }

  // No Sec-Fetch-Site: an older browser. Same rule, one step weaker.
  const from = initiator();
  if (!from) return false;
  if (from === normaliseHost(host)) return true;
  return isTrustedHost(from);
}

/**
 * A cross-site form can only send these content types without triggering a CORS
 * preflight, so requiring JSON closes that path on API routes.
 */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('application/json');
}
