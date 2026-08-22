/**
 * SEO FOUNDATION — the sitemap, robots.txt and structured data.
 *
 * THE TEST THAT MATTERS IS THE ONE THAT LOOKS BORING
 * ──────────────────────────────────────────────────
 * A sitemap is an advertisement. Every URL in it is the federation saying
 * "index this". So the failure this file exists to prevent is not a malformed
 * `<urlset>` — a malformed sitemap is ignored and nothing is lost. It is a
 * sitemap that names `/admin/membership`, which hands a crawler the location of
 * the private surface and puts it in a public index forever. `describe('no
 * private path is ever advertised')` is the reason this file exists; everything
 * else is scaffolding around it.
 *
 * The second failure guarded here is fabrication. Structured data is read by
 * machines and restated as fact, so an `aggregateRating` on an organisation
 * with no reviews is not a shortcut — it is a lie that Google penalises and a
 * reader cannot check. The graph builders are asserted to emit ONLY fields the
 * federation has evidenced.
 *
 * WHAT THIS FILE DOES NOT DO: it does not fetch anything. Route classification
 * and the JSON-LD builders are pure functions and are tested as such. The live
 * proof — every advertised URL actually answering 200 from a running server —
 * is tests/seo-live.test.ts, which boots `astro dev`, because a route that was
 * never loaded is a route that was never built.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SITE_ORIGIN,
  PRIVATE_PREFIXES,
  EXCLUSIONS,
  DYNAMIC_ROUTE_POLICY,
  isPrivatePath,
  routeFromPageFile,
  isDynamicRoute,
  classifyRoute,
  xmlEscape,
  renderSitemap,
  renderRobots,
  organizationGraph,
  breadcrumbGraph,
  eventGraph,
  activityLocationGraph,
} from '@/lib/seo';

const read = (p: string) => readFileSync(p, 'utf8');

/** Every page file on disk, as posix-ish paths relative to src/pages. */
function pageFiles(dir = 'src/pages', prefix = '', out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) pageFiles(p, `${prefix}${entry}/`, out);
    else if (/\.(astro|md|mdx|ts|js)$/.test(entry)) out.push(`${prefix}${entry}`);
  }
  return out.sort();
}

const FILES = pageFiles();

/** What the shipped endpoint would emit, without booting a server. */
function staticRoutes(): string[] {
  return FILES.map(routeFromPageFile)
    .filter((r): r is string => !!r)
    .filter((r) => !isDynamicRoute(r))
    .filter((r) => classifyRoute(r).kind === 'public')
    .sort();
}

// ── the guard that matters ──────────────────────────────────────────────────

describe('no private path is ever advertised', () => {
  const routes = staticRoutes();

  it('finds real pages at all (a sitemap of nothing would pass every other test)', () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(routes).toContain('/');
    expect(routes).toContain('/governance');
  });

  it('excludes every route under every private prefix', () => {
    for (const prefix of PRIVATE_PREFIXES) {
      // The pages exist on disk — this assertion is not vacuous. /portal is the
      // exception: it is reserved before it is built.
      const onDisk = FILES.map(routeFromPageFile).filter((r) => r && r.startsWith(prefix));
      if (prefix !== '/portal') expect(onDisk.length, `no pages under ${prefix}`).toBeGreaterThan(0);
      expect(routes.filter((r) => r.startsWith(prefix)), `${prefix} leaked`).toEqual([]);
    }
  });

  it('classifies the known private pages as private, not merely absent', () => {
    for (const r of ['/admin', '/admin/membership', '/my', '/my/passport', '/api/health']) {
      expect(classifyRoute(r).kind).toBe('private');
    }
  });

  it('treats a path prefix as a path segment, so /administration is not private', () => {
    expect(isPrivatePath('/admin')).toBe(true);
    expect(isPrivatePath('/admin/queue')).toBe(true);
    // The failure this prevents: startsWith('/admin') also matches a future
    // public page called /administration, which would then vanish silently.
    expect(isPrivatePath('/administration')).toBe(false);
    expect(isPrivatePath('/myths')).toBe(false);
  });

  it('never advertises a page that tells crawlers not to index it', () => {
    // /application sets X-Robots-Tag: noindex. A sitemap entry and a noindex
    // header are a direct contradiction, and the crawler believes the header —
    // so the sitemap entry is pure noise pointing at a private form.
    const contradictions = routes.filter((r) => {
      const file = FILES.find((f) => routeFromPageFile(f) === r);
      return file ? /X-Robots-Tag[^\n]*noindex/i.test(read(path.join('src/pages', file))) : false;
    });
    expect(contradictions).toEqual([]);
  });

  it('every page on disk is classified deliberately, so a new page cannot slip in unreviewed', () => {
    const unclassified = FILES.map(routeFromPageFile).filter(
      (r): r is string => !!r && classifyRoute(r).kind === 'unclassified'
    );
    expect(unclassified).toEqual([]);
  });

  it('every PUBLIC dynamic route has a written expansion policy', () => {
    // THE GUARD THAT WAS MISSING, AND IT LET THE SAME BUG SHIP TWICE.
    //
    // A dynamic route contributes NOTHING to the sitemap unless something
    // expands it. That is the right default — /athlete/[id] must never be
    // bulk-crawled, and most of its subjects are children — but it is a SILENT
    // default: a public dynamic route with no policy simply never appears, and
    // nothing anywhere says so.
    //
    // /learn/[audience] went unadvertised that way until somebody noticed the
    // six pages that are how a school finds MMAKF at all. Then /kata/[slug] did
    // exactly the same thing, for the twenty-six kata pages, and survived a
    // review because the only check pointing at DYNAMIC_ROUTE_POLICY ran in the
    // other direction — it asserted that a policy KEY names a real route, which
    // catches a stale entry and cannot catch a missing one.
    //
    // A policy is not a promise to expand. /athlete/[id] and
    // /learn/applications/[ref] both carry one saying, at length, why they are
    // deliberately NOT expanded. What this refuses is the third state: a public
    // dynamic route nobody has thought about either way.
    const publicDynamic = FILES.map(routeFromPageFile)
      .filter((r): r is string => !!r && isDynamicRoute(r) && !isPrivatePath(r));

    const undecided = publicDynamic.filter((r) => !DYNAMIC_ROUTE_POLICY[r]);
    expect(
      undecided,
      'public dynamic routes with no entry in DYNAMIC_ROUTE_POLICY — decide whether each should be expanded into the sitemap, and write down why'
    ).toEqual([]);
  });

  it('and that check is not vacuous — an undeclared section IS unclassified', () => {
    // Proving the guard fires. Every private area in this codebase arrived as a
    // directory (admin/, api/, my/), so a directory nobody has declared must
    // stop the build rather than default to "advertise it".
    const verdict = classifyRoute('/moderation/queue');
    expect(verdict.kind).toBe('unclassified');
    expect(verdict.reason).toContain('PUBLIC_SECTIONS');
    // And it is not advertised while it is undecided: only 'public' is.
    expect(['/moderation/queue'].filter((r) => classifyRoute(r).kind === 'public')).toEqual([]);
  });

  it('every exclusion carries a reason a human wrote', () => {
    for (const [route, reason] of Object.entries(EXCLUSIONS)) {
      expect(route.startsWith('/'), `${route} is not a path`).toBe(true);
      expect(reason.length, `${route} has no reason`).toBeGreaterThan(20);
    }
  });
});

// ── route derivation ────────────────────────────────────────────────────────

describe('routes are derived from the files that exist, not typed by hand', () => {
  it('maps page files to the URL Astro will actually serve', () => {
    expect(routeFromPageFile('index.astro')).toBe('/');
    expect(routeFromPageFile('about.astro')).toBe('/about');
    expect(routeFromPageFile('admin/queue.astro')).toBe('/admin/queue');
    expect(routeFromPageFile('admin/index.astro')).toBe('/admin');
    expect(routeFromPageFile('people/[slug].astro')).toBe('/people/[slug]');
    // An endpoint whose filename carries its own extension keeps it.
    expect(routeFromPageFile('calendar.ics.ts')).toBe('/calendar.ics');
    expect(routeFromPageFile('sitemap.xml.ts')).toBe('/sitemap.xml');
  });

  it('ignores files Astro does not turn into routes', () => {
    expect(routeFromPageFile('_helpers.ts')).toBe(null);
    expect(routeFromPageFile('components/_partial.astro')).toBe(null);
    expect(routeFromPageFile('notes.txt')).toBe(null);
  });

  it('recognises dynamic segments in both forms', () => {
    expect(isDynamicRoute('/people/[slug]')).toBe(true);
    expect(isDynamicRoute('/api/v1/[...route]')).toBe(true);
    expect(isDynamicRoute('/about')).toBe(false);
  });

  it('picks up the pages the hand-written list had drifted away from', () => {
    // These twelve public pages existed while the old hand-listed sitemap named
    // fifteen routes and knew about none of them. That drift is the whole
    // reason enumeration replaced the list.
    for (const r of ['/athletes', '/officials', '/dojos', '/competitions', '/rankings',
                     '/regulations', '/press', '/calendar', '/search', '/verify',
                     '/scoreboard', '/live']) {
      expect(staticRoutes(), `${r} missing`).toContain(r);
    }
  });
});

// ── XML ─────────────────────────────────────────────────────────────────────

describe('the XML is well formed even when a URL is not', () => {
  it('escapes the five characters that would otherwise break the document', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('escapes ampersands inside a generated loc', () => {
    const xml = renderSitemap(['/x?a=1&b=2'], SITE_ORIGIN);
    expect(xml).toContain('<loc>https://www.mmakf.in/x?a=1&amp;b=2</loc>');
    expect(xml).not.toContain('&b=2');
  });

  it('emits absolute URLs on the canonical host', () => {
    const xml = renderSitemap(['/', '/about'], SITE_ORIGIN);
    expect(xml).toContain('<loc>https://www.mmakf.in/</loc>');
    expect(xml).toContain('<loc>https://www.mmakf.in/about</loc>');
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  });

  it('carries no lastmod, changefreq or priority', () => {
    // Nothing in this system records when a page's content last changed. A
    // lastmod of "today", regenerated on every request, is a measurement nobody
    // took — and this project does not state measurements it did not take.
    const xml = renderSitemap(['/', '/about'], SITE_ORIGIN);
    expect(xml).not.toMatch(/lastmod|changefreq|priority/);
  });

  it('de-duplicates, because two <loc> for one page is a crawl budget bug', () => {
    const xml = renderSitemap(['/about', '/about', '/'], SITE_ORIGIN);
    expect(xml.match(/<loc>/g)!.length).toBe(2);
  });

  it('refuses a private path even if a caller hands one in', () => {
    // Defence in depth: classification is the gate, but the renderer is the
    // last thing between a mistake and a published URL.
    const xml = renderSitemap(['/', '/admin/dashboard', '/api/health'], SITE_ORIGIN);
    expect(xml).not.toContain('/admin');
    expect(xml).not.toContain('/api');
    expect(xml.match(/<loc>/g)!.length).toBe(1);
  });
});

// ── structured data ─────────────────────────────────────────────────────────

describe('structured data states only what the federation has evidenced', () => {
  const org = organizationGraph({ sameAs: ['https://www.instagram.com/mmakf'] });

  it('is a SportsOrganization with the facts on record', () => {
    expect(org['@type']).toBe('SportsOrganization');
    expect(org.foundingDate).toBe('1983');
    expect(org.url).toBe(SITE_ORIGIN);
    expect((org.address as any).addressLocality).toBe('Ramgarh District');
    expect((org.address as any).addressRegion).toBe('Jharkhand');
    expect((org.address as any).addressCountry).toBe('IN');
  });

  it('has NO rating, NO award and NO membership count', () => {
    // There are no reviews. An aggregateRating here is a fabricated measurement
    // and a documented Google penalty. numberOfEmployees / member counts are
    // the same class of invention: the federation has published no total.
    const json = JSON.stringify(org);
    for (const forbidden of ['aggregateRating', 'ratingValue', 'reviewCount',
                             'numberOfEmployees', 'memberOf', 'award']) {
      expect(json, `${forbidden} is not evidenced`).not.toContain(forbidden);
    }
  });

  it('omits sameAs entirely rather than emitting an empty array', () => {
    expect(organizationGraph({ sameAs: [] })).not.toHaveProperty('sameAs');
    expect(organizationGraph({}).sameAs).toBeUndefined();
  });

  it('drops a channel URL that is not http(s)', () => {
    const g = organizationGraph({ sameAs: ['javascript:alert(1)', 'https://ok.example'] as any });
    expect(g.sameAs).toEqual(['https://ok.example']);
  });
});

describe('breadcrumbs describe a hierarchy that exists', () => {
  it('numbers positions from one and resolves every item to an absolute URL', () => {
    const bc = breadcrumbGraph([
      { name: 'Governance', url: '/governance' },
      { name: 'Shihan Pramod Kumar Pathak', url: '/people/shihan-pramod-kumar-pathak' },
    ]);
    expect(bc).not.toBeNull();
    expect(bc!['@type']).toBe('BreadcrumbList');
    const items = bc!.itemListElement as any[];
    // Home is prepended: a trail that starts halfway up is not a hierarchy.
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[0].name).toBe('MMAKF');
    expect(items[0].item).toBe('https://www.mmakf.in/');
    expect(items[2].item).toBe('https://www.mmakf.in/people/shihan-pramod-kumar-pathak');
  });

  it('returns null for a page with no hierarchy above it', () => {
    // A one-item breadcrumb on a top-level page describes nothing. Emitting it
    // anyway is markup for its own sake, which is the definition of SEO spam.
    expect(breadcrumbGraph([])).toBeNull();
    expect(breadcrumbGraph([{ name: 'About', url: '/about' }])).toBeNull();
  });
});

describe('events are emitted only where the federation scheduled one', () => {
  it('builds an Event from a dated, named, located fixture', () => {
    const e = eventGraph({ day: '15', mo: 'JUN', year: '2026', t: 'State Championship', loc: 'Ranchi' });
    expect(e).not.toBeNull();
    expect(e!['@type']).toBe('SportsEvent');
    expect(e!.startDate).toBe('2026-06-15');
    expect((e!.location as any).name).toBe('Ranchi');
    expect((e!.organizer as any)['@type']).toBe('SportsOrganization');
  });

  it('returns null when the date cannot be parsed, instead of guessing one', () => {
    // The seed carries a District Championship whose exact date is NOT on the
    // record. Structured data must not supply one.
    expect(eventGraph({ t: 'District Championship held at Ramgarh', year: '2022' })).toBeNull();
    expect(eventGraph({ day: '15', mo: 'JUN', year: '2026' })).toBeNull();
    expect(eventGraph(null)).toBeNull();
  });

  it('omits offers when no fee is published, rather than printing zero', () => {
    const e = eventGraph({ day: '1', mo: 'JAN', year: '2027', t: 'X', loc: 'Y' });
    expect(e).not.toHaveProperty('offers');
    expect(JSON.stringify(e)).not.toContain('price');
  });
});

describe('location markup exists as a capability and today emits nothing', () => {
  it('builds a SportsActivityLocation from a real affiliated unit', () => {
    const g = activityLocationGraph({
      kind: 'dojo', code: 'D-001', name: 'Patratu Dojo', city: 'Patratu',
      district: 'Ramgarh', state: 'Jharkhand', standing: 'chartered', affiliated: true,
    } as any);
    expect(g).not.toBeNull();
    expect(g!['@type']).toBe('SportsActivityLocation');
    expect((g!.address as any).addressLocality).toBe('Patratu');
  });

  it('refuses a unit that is not currently affiliated', () => {
    // A lapsed club is listed on /dojos with its standing stated in words —
    // that is honest. Telling a search engine it is an MMAKF location is not.
    const g = activityLocationGraph({
      kind: 'dojo', code: 'D-002', name: 'Lapsed Club', city: 'X',
      standing: 'lapsed', affiliated: false,
    } as any);
    expect(g).toBeNull();
  });

  it('emits nothing at all when the register is empty, which it is today', () => {
    // NO DOORWAY PAGES. The capability is built; the federation's unit register
    // carries no rows, so it produces no markup and no city pages.
    const emptyRegister: any[] = [];
    expect(emptyRegister.map((u) => activityLocationGraph(u)).filter(Boolean)).toEqual([]);
  });
});

// ── robots.txt ──────────────────────────────────────────────────────────────

describe('robots.txt opens the site and closes the private areas', () => {
  const txt = renderRobots(SITE_ORIGIN);

  it('never disallows the whole site', () => {
    // The single most expensive line available in this file. A stray
    // `Disallow: /` removes the federation from search and nobody notices for
    // weeks, because the site keeps working perfectly.
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).toMatch(/^Allow: \/$/m);
    expect(txt).not.toMatch(/^Disallow:\s*\/\s*$/m);
  });

  it('disallows every private prefix, derived from the same list the sitemap uses', () => {
    for (const p of PRIVATE_PREFIXES) expect(txt).toMatch(new RegExp(`^Disallow: ${p}/$`, 'm'));
    // /my was open to crawlers in the static file this replaced.
    expect(txt).toContain('Disallow: /my/');
  });

  it('points at the sitemap, absolutely', () => {
    expect(txt).toContain('Sitemap: https://www.mmakf.in/sitemap.xml');
  });

  it('invents no crawl-delay', () => {
    // MMAKF has set no such policy. Google ignores the directive; the crawlers
    // that honour it are not the ones costing anybody bandwidth.
    expect(txt).not.toMatch(/crawl-delay/i);
  });

  it('follows the host it is served from', () => {
    expect(renderRobots('https://staging.example.com/')).toContain(
      'Sitemap: https://staging.example.com/sitemap.xml'
    );
  });
});

// ── the shadowing guard ─────────────────────────────────────────────────────

describe('no static file in public/ shadows a route', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // WHY THIS EXISTS
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Every assertion in the block above passed for as long as it had existed,
  // and none of it was ever served. `public/robots.txt` sat beside
  // `src/pages/robots.txt.ts`, the static layer answers first, and what
  // production actually returned was:
  //
  //     User-agent: *
  //     Allow: /
  //     Disallow: /admin
  //     Disallow: /api/
  //
  // — advertising `/my` (every member's own area) and `/portal` (every client
  // portal) to crawlers as fair game. The endpoint's own header comment
  // described that exact defect as the thing it had been written to fix.
  //
  // The tests could not catch it because they tested renderRobots(), which is
  // the right unit and the wrong artefact: it is not what a crawler receives.
  // Nothing in the build warns that a static file outranks a route of the same
  // name, and the next collision — a /sitemap.xml or a /manifest.webmanifest
  // dropped into public/ — would be exactly as quiet.
  //
  // So the assertion is about the COLLISION, not about robots.

  /** Everything servable from public/, as the path it answers on. */
  function publicPaths(dir = 'public', prefix = '', out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) publicPaths(full, `${prefix}/${entry.name}`, out);
      else out.push(`${prefix}/${entry.name}`);
    }
    return out;
  }

  it('leaves every SSR endpoint reachable', () => {
    const routes = new Set(
      FILES.map(routeFromPageFile).filter((r): r is string => !!r)
    );
    const shadowed = publicPaths().filter((p) => routes.has(p));

    expect(
      shadowed,
      'These files in public/ are served BEFORE the route of the same name, so ' +
      'the endpoint that shares their path never runs and its tests measure ' +
      'something nobody receives. Delete the static file or rename the route:\n  ' +
      shadowed.join('\n  ')
    ).toEqual([]);
  });

  it('specifically, robots.txt is served by the endpoint', () => {
    // Named separately because this is the one that actually happened, and a
    // regression here re-publishes /my and /portal to every crawler.
    expect(publicPaths()).not.toContain('/robots.txt');
    expect(FILES.map(routeFromPageFile)).toContain('/robots.txt');
  });
});

// ── source guards ───────────────────────────────────────────────────────────

/** Prose in a comment is not behaviour. These guards assert on CODE. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the shipped files keep the properties above', () => {
  const sitemap = stripComments(read('src/pages/sitemap.xml.ts'));
  const sd = stripComments(read('src/components/StructuredData.astro'));
  const base = read('src/layouts/Base.astro');

  it('the sitemap enumerates instead of listing routes by hand', () => {
    expect(sitemap).toContain('import.meta.glob');
    // The endpoint this replaced held a literal array of fifteen paths.
    expect(sitemap).not.toMatch(/=\s*\[\s*'\/[a-z]/);
  });

  it('StructuredData does not emit a second canonical, org graph, or og: tag', () => {
    // Base.astro already emits all three on every page. Two canonicals is a
    // self-conflicting signal; two organisation graphs is a duplicate entity.
    expect(base).toContain('rel="canonical"');
    expect(base).toContain("'@type': 'SportsOrganization'");
    expect(sd).not.toContain('rel="canonical"');
    expect(sd).not.toContain('organizationGraph');
    expect(sd).not.toContain('property="og:');
  });

  it('StructuredData never emits a profile graph, because /people/[slug] already does', () => {
    expect(read('src/pages/people/[slug].astro')).toContain("'@type': 'Person'");
    expect(sd).not.toContain('Person');
  });
});
