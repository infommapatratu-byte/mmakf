#!/usr/bin/env node
// External link checker for the regulations register.
//
//   npm run links:check
//
// The federation publishes links to rulebooks it does not control. Those bodies
// republish periodically, and a rotted link on a regulations page is worse than
// no page — a member clicks "Download the competition rules" and gets nothing.
//
// STATUS CODES ARE NOT ENOUGH, and this is the whole reason the script exists:
//
//   · wkf.net soft-404s. A superseded rules PDF returns HTTP 200 with
//     Content-Type image/png and a ~1.6KB body — a placeholder image served
//     under a .pdf path.
//   · wada-ama.org returned HTTP 202 with a ZERO-byte body for a documented
//     resource URL.
//
// Both are "healthy" to any checker that looks at the status code, and both are
// dead to a human. So a link claiming to be a PDF must actually return a PDF,
// of a plausible size.


const MIN_PDF_BYTES = 20_000;   // a real rulebook; a placeholder is ~1-2KB
const MIN_PAGE_BYTES = 5_000;
const TIMEOUT_MS = 30_000;

const IGNORE = /mmakf\.in|localhost|127\.0\.0\.1|example\.(com|in)|schema\.org|w3\.org/;

/**
 * Read the RENDERED pages, not the source.
 *
 * Source scanning is not good enough here and the reason is concrete: the
 * regulations page composes its URLs from a base constant
 * (`const W = 'https://www.wkf.net/files/pdf/documents'`) plus a filename. A
 * source scan sees only the stem — which happens to soft-404 at 1,623 bytes —
 * and MISSES every actual rulebook link. Checking the rendered HTML is the only
 * way to see the URLs a member will really click.
 *
 * Point it at production, or at a local dev server:
 *   npm run links:check
 *   npm run links:check -- --site http://localhost:4399
 */
async function collectUrls(site, paths) {
  const found = new Map();

  for (const path of paths) {
    const pageUrl = `${site}${path}`;
    let html;
    try {
      const res = await fetch(pageUrl, { headers: { 'User-Agent': 'MMAKF-link-check/1.0' } });
      if (!res.ok) {
        console.warn(`  ! could not read ${pageUrl} (HTTP ${res.status}) — its links are unchecked`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      console.warn(`  ! could not read ${pageUrl} (${err.message}) — its links are unchecked`);
      continue;
    }

    for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      const url = m[1].replace(/&amp;/g, '&');
      if (IGNORE.test(url)) continue;
      if (!found.has(url)) found.set(url, path);
    }
  }
  return found;
}

async function check(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MMAKF-link-check/1.0)' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const size = buf.length;

    if (!res.ok) return { ok: false, why: `HTTP ${res.status}`, type, size };
    // 202 Accepted with nothing in it is not a document.
    if (size === 0) return { ok: false, why: `HTTP ${res.status} with an EMPTY body`, type, size };

    const promisesPdf = /\.pdf($|\?)/i.test(url);
    if (promisesPdf && type !== 'application/pdf') {
      return { ok: false, why: `SOFT-404: .pdf URL served as ${type || 'unknown'}`, type, size };
    }
    if (promisesPdf && size < MIN_PDF_BYTES) {
      return { ok: false, why: `SOFT-404: PDF is only ${size} bytes — almost certainly a placeholder`, type, size };
    }
    if (!promisesPdf && size < MIN_PAGE_BYTES) {
      return { ok: false, why: `Suspiciously small page (${size} bytes)`, type, size };
    }
    return { ok: true, why: 'ok', type, size };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timed out' : String(err.message).slice(0, 90), type: '', size: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITE = arg('site', 'https://www.mmakf.in').replace(/\/$/, '');
const PATHS = ['/regulations', '/press', '/governance', '/'];

console.log(`Reading rendered pages from ${SITE}`);
const urls = [...(await collectUrls(SITE, PATHS))];
if (!urls.length) {
  console.error('No external URLs found. Is the site reachable?');
  process.exit(1);
}

console.log(`Checking ${urls.length} external link(s)\n`);

const failures = [];
// Small concurrency: these are other organisations' servers, not ours.
const QUEUE = 4;
let cursor = 0;

async function worker() {
  while (cursor < urls.length) {
    const [url, source] = urls[cursor++];
    const r = await check(url);
    const kb = r.size ? `${(r.size / 1024).toFixed(0)}KB` : '-';
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${(r.type || '-').padEnd(24)} ${kb.padStart(8)}  ${url}`);
    if (!r.ok) {
      console.log(`     ↳ ${r.why}   (published in ${source})`);
      failures.push({ url, why: r.why, source });
    }
  }
}

await Promise.all(Array.from({ length: QUEUE }, worker));

console.log(`\n${urls.length - failures.length}/${urls.length} links healthy.`);
if (failures.length) {
  console.log('\nBROKEN:');
  for (const f of failures) console.log(`  ${f.url}\n    ${f.why}`);
  process.exit(1);
}
