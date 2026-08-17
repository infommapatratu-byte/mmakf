/**
 * SEO FOUNDATION — the live proof.
 *
 * tests/seo.test.ts asserts that the route classifier and the JSON-LD builders
 * behave. That is not the same claim as "the sitemap works". A sitemap can be
 * perfectly generated and still advertise thirty-three URLs that 404, because
 * the route derivation disagreed with Astro's by one character. So this file
 * boots a real `astro dev`, fetches /sitemap.xml over HTTP, and loads EVERY URL
 * it names. A route nobody requested is a route nobody built.
 *
 * It is slow — roughly a minute, because each page compiles on first request —
 * and it is deliberately a separate file so the fast guards stay fast.
 *
 * If the server does not come up, these tests FAIL. They do not skip. A green
 * run that quietly verified nothing is the failure mode this whole project is
 * organised against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startAstroDev, type DevServer } from './helpers/astro-dev';
import { PRIVATE_PREFIXES, EXCLUSIONS } from '@/lib/seo';

let server: DevServer | null = null;
let base = '';
/** Body of /sitemap.xml, and the paths it advertises. */
let sitemapXml = '';
let paths: string[] = [];

// ONE astro dev AT A TIME — see ./helpers/astro-dev.ts. The ASTRO_CACHE_DIR
// this suite used to pass was doing nothing: astro consults cacheDir for the
// content store on BUILD only, and in dev writes <root>/.astro/data-store.json
// unconditionally. Three servers therefore always shared one file.
beforeAll(async () => {
  server = await startAstroDev({ label: 'seo-live', probePath: '/sitemap.xml' });
  base = server.base;

  const res = await fetch(base + '/sitemap.xml', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`/sitemap.xml answered ${res.status}:\n${server.log().slice(-3000)}`);
  }
  sitemapXml = await res.text();

  paths = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    m[1].replace(/^https?:\/\/[^/]+/, '')
  );
  // Generous, because this hook may now WAIT for its turn at the lock behind
  // another live suite as well as booting a server of its own.
}, 600_000);

afterAll(async () => {
  // Awaited: stop() holds the dev-server lock until the child has genuinely
  // exited, so the next suite cannot start a server while this one is still
  // writing .astro/data-store.json.
  await server?.stop();
});

/**
 * A minimal XML well-formedness check.
 *
 * There is no XML parser in this project's dependencies and adding one to test
 * a thirty-line document is not a trade worth making. This walks the document
 * and enforces the properties a sitemap actually gets wrong: unbalanced or
 * mis-nested elements, and — the one that has really happened — a raw `&` from
 * a query string, which ends the document at that byte for every real parser.
 *
 * Its limits, stated: it does not validate attribute syntax beyond quoting, it
 * does not resolve namespaces, and it does not check the sitemap schema.
 */
function parseXml(xml: string): { root: string; depthReached: number } {
  let body = xml.trim();
  const decl = body.match(/^<\?xml[^?]*\?>/);
  if (!decl) throw new Error('missing XML declaration');
  body = body.slice(decl[0].length);

  // Every ampersand must open a legal entity reference.
  const badAmp = body.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  if (badAmp) throw new Error(`raw ampersand at "${body.slice(body.indexOf(badAmp[0]), 40)}"`);

  const stack: string[] = [];
  let depthReached = 0;
  let root = '';
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"]*")*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  let cursor = 0;
  while ((m = tag.exec(body))) {
    const between = body.slice(cursor, m.index);
    if (/[<>]/.test(between)) throw new Error(`stray angle bracket near "${between.slice(0, 40)}"`);
    cursor = m.index + m[0].length;
    const [, closing, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== name) throw new Error(`</${name}> does not close <${stack[stack.length - 1]}>`);
    } else {
      if (!stack.length && !root) root = name;
      else if (!stack.length) throw new Error(`second root element <${name}>`);
      stack.push(name);
      depthReached = Math.max(depthReached, stack.length);
    }
  }
  if (stack.length) throw new Error(`unclosed <${stack[stack.length - 1]}>`);
  if (/[<>]/.test(body.slice(cursor))) throw new Error('trailing angle bracket');
  return { root, depthReached };
}

describe('the parser used below is strict enough to be worth trusting', () => {
  // A checker that has never failed proves nothing (docs/TESTING-STRATEGY.md §1).
  it('rejects the four ways a sitemap has actually been broken', () => {
    const ok = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://x/a</loc></url></urlset>';
    expect(() => parseXml(ok)).not.toThrow();
    expect(() => parseXml('<urlset></urlset>')).toThrow(/declaration/);
    expect(() => parseXml(ok.replace('</loc>', '</lo>'))).toThrow();
    expect(() => parseXml(ok.replace('</urlset>', ''))).toThrow(/unclosed/);
    expect(() => parseXml(ok.replace('https://x/a', 'https://x/a?b=1&c=2'))).toThrow(/ampersand/);
  });
});

describe('/sitemap.xml, served', () => {
  it('answers 200 as XML', async () => {
    const r = await fetch(`${base}/sitemap.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/xml/);
  });

  it('parses, and is a urlset of url/loc', () => {
    const { root, depthReached } = parseXml(sitemapXml);
    expect(root).toBe('urlset');
    expect(depthReached).toBe(3); // urlset > url > loc
    expect(sitemapXml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  });

  it('advertises a real number of real pages', () => {
    expect(paths.length).toBeGreaterThan(25);
    expect(new Set(paths).size).toBe(paths.length); // no duplicates
    expect(paths).toContain('/');
  });

  it('names every URL absolutely, on the canonical host, over https', () => {
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
      expect(loc, loc).toMatch(/^https:\/\/www\.mmakf\.in\//);
      // The canonical tag Base.astro emits uses this exact origin. A sitemap on
      // a different host than the canonical is a split signal.
      expect(() => new URL(loc)).not.toThrow();
    }
  });

  // ── the assertion this entire stream exists to make ──────────────────────
  it('contains NO private path', () => {
    for (const prefix of PRIVATE_PREFIXES) {
      const leaked = paths.filter((p) => p === prefix || p.startsWith(prefix + '/'));
      expect(leaked, `${prefix} leaked into the sitemap`).toEqual([]);
    }
    // Named surfaces, checked against the raw document rather than the parsed
    // paths, so a mangling bug cannot hide one.
    for (const s of ['/admin', '/api/', '/my/', '/portal', '/unit', '/checkout', '/application']) {
      expect(sitemapXml, `${s} appears in the sitemap body`).not.toContain(s);
    }
  });

  it('omits every route excluded on purpose', () => {
    for (const route of Object.keys(EXCLUSIONS)) {
      expect(paths, `${route} was supposed to be excluded`).not.toContain(route);
    }
  });

  it('advertises no URL that answers anything but 200', async () => {
    const bad: string[] = [];
    for (const p of paths) {
      const r = await fetch(base + p, { redirect: 'manual' });
      if (r.status !== 200) bad.push(`${p} -> ${r.status}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('advertises no URL that tells crawlers not to index it', async () => {
    const contradictions: string[] = [];
    for (const p of paths) {
      const r = await fetch(base + p, { redirect: 'manual' });
      const tag = r.headers.get('x-robots-tag') || '';
      if (/noindex/i.test(tag)) contradictions.push(`${p} -> ${tag}`);
    }
    expect(contradictions).toEqual([]);
  }, 300_000);

  it('is not vacuous: /application really does carry that header', async () => {
    // Proving the previous test can fail. /application sets X-Robots-Tag on its
    // own response, and it is excluded for exactly that reason.
    const r = await fetch(`${base}/application`);
    expect(r.headers.get('x-robots-tag')).toMatch(/noindex/i);
  });
});

describe('/robots.txt, served', () => {
  let txt = '';

  beforeAll(async () => {
    const r = await fetch(`${base}/robots.txt`);
    expect(r.status).toBe(200);
    txt = await r.text();
  });

  it('does not wall the federation out of search', () => {
    // The most expensive single line available in this repository.
    expect(txt).not.toMatch(/^Disallow:\s*\/\s*$/m);
    expect(txt).toMatch(/^Allow: \/$/m);
  });

  it('invents no crawl-delay', () => {
    expect(txt).not.toMatch(/crawl-delay/i);
  });

  it('points a crawler at the sitemap, absolutely', () => {
    const m = txt.match(/^Sitemap:\s*(\S+)$/m);
    expect(m, 'no Sitemap: line').not.toBeNull();
    expect(m![1]).toBe('https://www.mmakf.in/sitemap.xml');
  });

  it('allows nothing that the sitemap treats as private', () => {
    // Whichever robots.txt is in service — the generated endpoint or the static
    // file still sitting in public/ ahead of it — it must never hand a crawler
    // an explicit Allow into a private area.
    const allows = [...txt.matchAll(/^Allow:\s*(\S+)$/gm)].map((m) => m[1]);
    for (const a of allows) {
      for (const prefix of PRIVATE_PREFIXES) {
        expect(a === prefix || a.startsWith(prefix + '/'), `Allow: ${a} is private`).toBe(false);
      }
    }
  });
});
