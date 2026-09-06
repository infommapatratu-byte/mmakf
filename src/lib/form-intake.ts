// Reading a form submission that the edge may not let through as a form.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PRODUCTION FAULT THIS EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Reported from production, and reproduced against www.mmakf.in on
// 6 September 2026: EVERY form on the site answered
//
//     403  Cross-site POST form submissions are forbidden
//
// That string is not in this repository and never has been. It is Vercel's,
// emitted at the EDGE, and the request never reaches this application at all.
// The evidence, in full, because the conclusion is otherwise hard to believe:
//
//   POST /start/individual  Content-Type: application/x-www-form-urlencoded
//     → 403  "Cross-site POST form submissions are forbidden"
//   POST /start/individual  + Origin: https://www.mmakf.in
//                           + Sec-Fetch-Site: same-origin
//     → 403  (a perfectly formed same-origin submission, still refused)
//   POST /robots.txt        → 403  (a STATIC FILE. No function runs. Not us.)
//   POST /no-such-path-xyz  → 403  (before routing. Not us.)
//   PUT  /start/individual  → 403  {"error":"Request refused"}   ← OUR message
//   POST /start/individual  Content-Type: application/json
//                           → reaches the function
//
// So the rule is keyed on CONTENT TYPE. The three encodings an HTML form can
// produce — `application/x-www-form-urlencoded`, `multipart/form-data`,
// `text/plain` — are refused, and so is a POST with no content type.
// `application/json` is not.
//
// Which is to say: on this deployment a plain `<form method="post">` cannot
// work, whatever it posts to and whatever it contains.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE DOES ABOUT IT, AND WHAT IT DELIBERATELY DOES NOT
// ═══════════════════════════════════════════════════════════════════════════
//
// IT DOES NOT FIX THE CAUSE. The cause is a Vercel project setting and only the
// account holder can change it. This is the half that can be fixed in code:
// every page handler accepts EITHER encoding, so a submission that arrives as
// JSON is read exactly as a form submission is. `src/scripts/form-upgrade.ts`
// is the other half — it re-sends same-origin form posts as JSON.
//
// IT IS NOT A CSRF HOLE. `src/middleware.ts` still runs its origin check on
// every mutating request, unchanged, and `/api/` paths still require JSON as
// they always have. What changes here is only how a body is PARSED once that
// check has passed. A cross-site form still cannot send `application/json`
// without a CORS preflight this application never answers — which is the very
// property the API rule was built on.
//
// IT RETURNS A `FormData` IN BOTH CASES, so the 31 page handlers that read
// `Astro.request.formData()` change by one function name and nothing else.
// Their `form.get('act')` calls, their `String(form.get(k) ?? '').trim()`
// helpers and their checkbox tests all keep working unaltered. A parallel
// "read it as an object" API would have meant editing every one of them, and
// every edit is a chance to drop a field.
//
// IT DOES NOT CARRY FILES. JSON cannot, so a submission with a file in it is
// left to the multipart path and will be refused by the edge while the rule
// stands. No form in this repository uploads a file — uploads go through
// `/api/uploads`, which has always been JSON — and that is stated rather than
// silently relied upon.

/**
 * The body of a submission, however it was encoded.
 *
 * A JSON object becomes a `FormData` field-for-field:
 *
 *   · a string, number or boolean becomes its string form, so `true` arrives as
 *     `"true"` and a checkbox sent as `"on"` arrives as `"on"`;
 *   · an array appends once per element, which is how a multi-select and a
 *     checkbox group already arrive;
 *   · `null` and `undefined` are SKIPPED rather than becoming the strings
 *     "null" and "undefined" — every handler in this codebase reads fields with
 *     `String(form.get(k) ?? '')`, and an absent field must stay absent so that
 *     `?? ''` does its job.
 *
 * A malformed JSON body yields an EMPTY FormData rather than throwing. The
 * handlers all validate what they read and answer with a sentence; a parse
 * error thrown here would become a 500 instead, which tells the person less and
 * the logs no more.
 */
export async function readSubmission(request: Request): Promise<FormData> {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const form = new FormData();
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return form;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return form;

    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v === null || v === undefined) continue;
          form.append(key, String(v));
        }
        continue;
      }
      // An object nested inside a form field is not something any form can
      // produce, so it is not something any handler expects. Skipped rather
      // than stringified into "[object Object]".
      if (typeof value === 'object') continue;
      form.append(key, String(value));
    }
    return form;
  }

  return request.formData();
}
