// The federation's marks, in one place.
//
// The crest path was written out in four files — Crest.astro, Base.astro's
// og:image, /governance's placeholder, and the PWA manifest. Four copies of an
// asset path is the same failure as four copies of a rule: the day one changes,
// three do not, and the site shows two different logos depending on the page.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS RIGHT NOW: THE TRANSPARENT CREST
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation's crest artwork has a TRANSPARENT background. The file shipped
// here is `logo.jpg`, and JPEG cannot store transparency at all — so the crest
// arrived with an opaque white disc baked in behind it. On the dark navigation
// band that reads as a white box around the logo, which is exactly the defect
// the federation reported.
//
// The fix is the artwork itself, not CSS. Blend modes are the tempting
// workaround and they are wrong here: `multiply` keys out white but destroys the
// crest on the dark nav, and `screen` keys out black, which takes the karate
// figures with it. There is no compositing trick that recovers an alpha channel
// JPEG never stored.
//
// So: drop the transparent artwork at `public/logo.png` and change ONE line
// below. Every surface follows, because every surface reads from here.

/**
 * The federation crest.
 *
 * Now the transparent PNG. The JPEG it replaced could not carry an alpha
 * channel, so the crest shipped with an opaque white disc baked in behind it —
 * a white box on the dark navigation band. Verified RGBA, colour type 6, with
 * the corner pixel at alpha 0.
 * It is deliberately NOT an existence check at runtime: on Vercel the static
 * assets are served by the CDN and are not guaranteed to be on the function's
 * filesystem, so `fs.existsSync` would answer about the wrong machine and could
 * silently fall back to the wrong logo in production.
 */
export const CREST = '/logo.png';

/**
 * The crest as a social preview image. Absolute, because Open Graph consumers
 * do not resolve relative URLs.
 */
export const SITE_ORIGIN = 'https://www.mmakf.in';
export const CREST_ABSOLUTE = SITE_ORIGIN + CREST;

/**
 * Alt text for the crest.
 *
 * ONE string, because a logo described three different ways by three components
 * is three different things to a screen reader. Where the crest is decorative —
 * sitting beside the wordmark that already says "MMAKF" — pass alt="" instead
 * and let the text carry the meaning, rather than making a reader hear the
 * federation's full name twice.
 */
export const CREST_ALT = 'MMAKF — Modern Martial Arts Karate-Do Federation of India';
