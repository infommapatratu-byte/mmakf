// Re-send same-origin form submissions as JSON, because the edge refuses forms.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A SITE BUILT ON PLAIN FORMS NEEDS THIS
// ═══════════════════════════════════════════════════════════════════════════
//
// Vercel's edge answers 403 "Cross-site POST form submissions are forbidden" to
// every POST carrying one of the three encodings an HTML form can produce. The
// full evidence is in src/lib/form-intake.ts; the short version is that it
// refuses a POST to a STATIC FILE, so it is not this application refusing it,
// and `application/json` is the only body type that gets through.
//
// This file is the client half. `readSubmission()` is the server half.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT COSTS, STATED PLAINLY
// ═══════════════════════════════════════════════════════════════════════════
//
// THIS BREAKS THE NO-JAVASCRIPT GUARANTEE, and that guarantee is written into
// half the page headers in this repository. It is not being abandoned by
// choice: while the edge rule stands, a no-JavaScript form submission cannot
// reach this application AT ALL. A visitor with scripting off gets Vercel's
// plain-text 403 whether or not this file exists.
//
// So the honest position is: with this, forms work for everybody running
// JavaScript, which is nearly everybody. Without it, forms work for nobody.
// The fix for the remainder is the Vercel setting, not more code here — and
// when that setting is changed, THIS FILE BECOMES UNNECESSARY AND SHOULD BE
// DELETED, along with nothing else, because `readSubmission()` keeps reading
// ordinary form posts exactly as before.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT REFUSES TO TOUCH
// ═══════════════════════════════════════════════════════════════════════════
//
//   · GET forms. They are not blocked and they are how every filter on this
//     site works — /black-belts, /teachers, /clubs. Upgrading them would turn a
//     shareable filtered URL into an opaque POST.
//   · Cross-origin actions. The upgrade re-sends to the form's own action, and
//     only when that resolves to this origin. A form posting elsewhere is left
//     to the browser.
//   · Forms with a file input. JSON cannot carry a file. Left alone, and they
//     will fail against the edge rule — no form in this repository uploads a
//     file, and pretending otherwise would be worse than the failure.
//   · Anything marked `data-no-upgrade`, so a page can opt out without editing
//     this file.
//
// ═══════════════════════════════════════════════════════════════════════════
// IT MUST NOT SWALLOW A FAILURE
// ═══════════════════════════════════════════════════════════════════════════
//
// If the fetch fails, or the server answers something this cannot render, the
// form is submitted the ordinary way so the visitor sees the real outcome —
// even if that outcome is the edge's own 403. A silent no-op here would be a
// button that does nothing, which is worse than an error page: the person
// retypes their application and presses it again.

function isFileForm(form: HTMLFormElement): boolean {
  return Array.from(form.elements).some(
    (el) => el instanceof HTMLInputElement && el.type === 'file'
  );
}

/** Same-origin, after resolving a relative action against this document. */
function targetsThisOrigin(action: string): boolean {
  try {
    return new URL(action, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The submitted values, as an object.
 *
 * Built from `FormData`, so it inherits the browser's own rules about which
 * controls are successful — an unchecked checkbox is absent, a disabled field
 * is absent, and the submitter button's own name/value is included. Rebuilding
 * that by hand from `form.elements` is where this kind of code usually goes
 * wrong.
 *
 * A field that appears more than once becomes an array, which is what
 * `readSubmission()` expands back into repeated appends.
 */
function valuesOf(form: HTMLFormElement, submitter: HTMLElement | null): Record<string, unknown> {
  const fd = new FormData(form, submitter as HTMLButtonElement | null);
  const out: Record<string, unknown> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value !== 'string') continue; // a File; see the header
    if (key in out) {
      const existing = out[key];
      if (Array.isArray(existing)) existing.push(value);
      else out[key] = [existing, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function shouldUpgrade(form: HTMLFormElement): boolean {
  if ((form.method || 'get').toLowerCase() !== 'post') return false;
  if (form.hasAttribute('data-no-upgrade')) return false;
  if (isFileForm(form)) return false;
  return targetsThisOrigin(form.getAttribute('action') || window.location.href);
}

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (event.defaultPrevented) return;
  if (!shouldUpgrade(form)) return;

  const submitter = (event as SubmitEvent).submitter ?? null;
  const action = form.getAttribute('action') || window.location.href;
  const url = new URL(action, window.location.href);

  event.preventDefault();

  // Disable the submit control while it is in flight. Every one of these
  // handlers is a state change, and a double-click is a duplicate application.
  const button = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
    ? submitter : null;
  if (button) button.disabled = true;
  const release = () => { if (button) button.disabled = false; };

  /** Give up and let the browser do it, so the visitor sees a real result. */
  const fallBack = () => {
    release();
    form.removeAttribute('data-upgrading');
    form.setAttribute('data-no-upgrade', '');
    form.submit();
  };

  fetch(url.toString(), {
    method: 'POST',
    // The header that gets past the edge rule, and the one a cross-site form
    // cannot set without a preflight this application never answers.
    headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
    body: JSON.stringify(valuesOf(form, submitter)),
    credentials: 'same-origin',
    redirect: 'follow',
  })
    .then(async (res) => {
      // A handler that redirected — which is what every successful write in
      // this codebase does — has already been followed by `redirect: 'follow'`,
      // so `res.url` is the page to land on.
      if (res.redirected && res.url) {
        window.location.assign(res.url);
        return;
      }
      const body = await res.text();
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) {
        // A JSON error from an API-shaped handler. Nothing here can render it
        // meaningfully, so hand the visitor the ordinary submission.
        fallBack();
        return;
      }
      // Replace the document with what the handler rendered — its success
      // banner, or its validation message with the form still filled in. The
      // URL is set to the action so a reload repeats the right request.
      window.history.replaceState({}, '', url.toString());
      document.open();
      document.write(body);
      document.close();
    })
    .catch(fallBack);
});
