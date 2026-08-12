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
export function isSameOrigin(headers: Headers | Record<string, string>, host: string): boolean {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const rec = headers as Record<string, string>;
    return rec[name] ?? rec[name.toLowerCase()] ?? null;
  };

  const fetchSite = get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';

  for (const header of ['origin', 'referer']) {
    const value = get(header);
    if (!value) continue;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * A cross-site form can only send these content types without triggering a CORS
 * preflight, so requiring JSON closes that path on API routes.
 */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('application/json');
}
