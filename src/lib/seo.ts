/**
 * SEO FOUNDATION — which URLs MMAKF advertises, and what it says about itself.
 *
 * Two failures shape every line here.
 *
 * THE FIRST: a sitemap is not a description of a site, it is an INVITATION.
 * Every `<loc>` is the federation telling a crawler "index this, and keep it".
 * The endpoint this replaced listed fifteen paths typed by hand in a `const
 * ROUTES` array. Twelve public pages had been built since — /athletes,
 * /officials, /dojos, /competitions, /rankings, /regulations, /press,
 * /calendar, /search, /verify, /scoreboard, /live — and none of them was in it.
 * A hand-written list does not stay true; it stays written. So routes are
 * ENUMERATED from the files that exist, and the only thing typed by hand is the
 * refusals, each with the reason it was refused.
 *
 * THE SECOND: an enumerated list fails in the opposite direction. The moment
 * somebody adds `src/pages/moderation/queue.astro`, an enumerator that defaults
 * to "public" publishes the location of the moderation queue to Google. Every
 * private area in this codebase is a DIRECTORY — admin/, api/, my/ — so a
 * directory is the unit of decision: a section must be declared public or
 * private, and an undeclared one is `unclassified`, which is never advertised
 * and fails tests/seo.test.ts until a human classifies it. The build fails
 * loudly instead of the site leaking quietly.
 *
 * Everything below is a pure function so it can be tested without a server.
 * The live proof lives in tests/seo-live.test.ts.
 */

import { eventDate } from './events';
import { SITE_ORIGIN, CREST_ABSOLUTE } from './brand';
import type { DirectoryEntry } from '../db/affiliation';

/** The canonical host, re-exported from src/lib/brand.ts rather than copied.
 *  A sitemap on a different host from the canonical tag is a split signal, and
 *  the way that happens is two files each holding their own idea of the origin. */
export { SITE_ORIGIN };

/**
 * Path prefixes that must never reach a crawler — neither in the sitemap nor as
 * an Allow in robots.txt. `/portal` is listed although no such directory exists
 * yet: it is the name the federation uses for member surfaces, and the cost of
 * reserving it now is nothing.
 */
export const PRIVATE_PREFIXES = ['/admin', '/api', '/my', '/portal'] as const;

/**
 * Directories under src/pages whose contents are public. Declaring these is
 * what makes an undeclared directory an error rather than a silent publication.
 */
export const PUBLIC_SECTIONS = ['/athlete', '/people', '/learn', '/training', '/kata'] as const;

/**
 * Public URLs that exist and are deliberately NOT advertised, with the reason.
 * A reason is mandatory: an exclusion nobody can justify later gets deleted by
 * somebody tidying up, and the page reappears in the index.
 */
export const EXCLUSIONS: Record<string, string> = {
  '/404': 'The error page. Indexing it puts a "page not found" result in search for the federation.',
  '/learn/apply':
    'The twenty-step application form. Indexing it would send a school straight into step one ' +
    'without ever reading what MMAKF does for schools — /karate-for-schools and /learn/schools are ' +
    'the pages that should meet a searcher, and both link here.',
  '/application': 'Sets X-Robots-Tag: noindex on its own response. A sitemap entry would contradict the page itself.',
  '/checkout': 'A transactional step that only means anything with a basket behind it; on its own it renders the reasons it cannot take an order.',
  '/unit': 'The Unit Portal sign-in. Same class of surface as /admin — an access-code gate, not a page for readers.',
  '/calendar.ics': 'A subscription feed, not a page. It is linked from /calendar, which is what a reader should find.',
  '/sitemap.xml': 'The sitemap does not list itself; robots.txt is how a crawler is told where it is.',
  '/robots.txt': 'A crawler directive, not content.',
};

/**
 * Dynamic routes and how their URLs are found — or the reason they have none.
 * A route absent from this map contributes nothing, which is the safe default:
 * an unexpanded page is merely undiscovered, while a wrongly expanded one
 * publishes records the federation did not agree to publish in bulk.
 */
export const DYNAMIC_ROUTE_POLICY: Record<string, string> = {
  '/people/[slug]': 'Expanded from the leadership register. These profiles are published content and are already linked from /governance.',
  '/athlete/[id]': 'NOT expanded. The public register is a LOOKUP — one identifier, one person. Many of its subjects are children (docs/PRIVACY.md), and turning it into a bulk crawl of every athlete is a decision for the federation, not for this endpoint. The profiles remain reachable and linked from /athletes.',
};

// ── path rules ──────────────────────────────────────────────────────────────

/** True when a path is inside a private area. Compares SEGMENTS: a plain
 *  `startsWith('/admin')` would also swallow a future public /administration
 *  page, which would then be missing from search with nobody able to say why. */
export function isPrivatePath(p: string): boolean {
  return PRIVATE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

/** True when the route still contains an unfilled segment, `[slug]` or `[...rest]`. */
export function isDynamicRoute(route: string): boolean {
  return route.includes('[');
}

/**
 * A path under src/pages → the URL Astro serves for it, or null when Astro
 * makes no route from it at all (a leading underscore, an unknown extension).
 * `calendar.ics.ts` keeps its `.ics`, because that is genuinely part of the URL.
 */
export function routeFromPageFile(file: string): string | null {
  const rel = file.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!/\.(astro|md|mdx|ts|js)$/.test(rel)) return null;
  // Astro excludes any path segment beginning with an underscore.
  if (rel.split('/').some((seg) => seg.startsWith('_'))) return null;

  let route = '/' + rel.replace(/\.(astro|md|mdx|ts|js)$/, '');
  route = route.replace(/\/index$/, '');
  return route === '' ? '/' : route;
}

export type RouteKind = 'public' | 'private' | 'excluded' | 'dynamic' | 'unclassified';

/** Why a route is or is not advertised. The reason travels with the verdict so
 *  the endpoint can be debugged without reading this file. */
export function classifyRoute(route: string): { kind: RouteKind; reason: string } {
  if (isPrivatePath(route)) {
    return { kind: 'private', reason: 'Inside a private area; advertising the URL advertises the surface.' };
  }
  if (EXCLUSIONS[route]) return { kind: 'excluded', reason: EXCLUSIONS[route] };
  if (isDynamicRoute(route)) {
    return { kind: 'dynamic', reason: DYNAMIC_ROUTE_POLICY[route] ?? 'No expansion policy is recorded for this route, so it contributes no URLs.' };
  }

  const section = '/' + route.split('/')[1];
  if (route.split('/').length > 2 && !PUBLIC_SECTIONS.includes(section as any)) {
    return {
      kind: 'unclassified',
      reason: `Section ${section} is declared neither public nor private. Add it to PUBLIC_SECTIONS or PRIVATE_PREFIXES in src/lib/seo.ts — until then it is not advertised.`,
    };
  }
  return { kind: 'public', reason: 'A public page of the federation site.' };
}

// ── XML ─────────────────────────────────────────────────────────────────────

/** The five characters that end an XML document early if they travel raw. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Paths → a sitemap document.
 *
 * No `lastmod`, no `changefreq`, no `priority`. Nothing in this system records
 * when a page's content last changed, so a lastmod could only be the time the
 * request was served — a measurement nobody took, restated to Google on every
 * fetch. Google ignores changefreq and priority outright. Omitting all three is
 * both more honest and no less effective.
 *
 * The private-path filter is repeated here on purpose. Classification is the
 * gate; this is the last thing standing between a mistake upstream and a
 * published admin URL.
 */
export function renderSitemap(paths: string[], origin: string = SITE_ORIGIN): string {
  const base = origin.replace(/\/$/, '');
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p || !p.startsWith('/') || isPrivatePath(p) || isDynamicRoute(p)) continue;
    seen.add(p);
  }
  const locs = [...seen]
    .sort()
    .map((p) => `  <url><loc>${xmlEscape(base + p)}</loc></url>`)
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs +
    '\n</urlset>\n'
  );
}

// ── robots ──────────────────────────────────────────────────────────────────

/**
 * robots.txt.
 *
 * What this deliberately does NOT contain: a `Disallow: /` (which would remove
 * the federation from search entirely — the single most expensive typo
 * available here), and a `Crawl-delay`, which is an operational policy MMAKF
 * has never set and which Google ignores anyway.
 *
 * Disallow is not a security control — it is a request, and it publishes the
 * list of paths worth trying. It is used here only for paths already obvious
 * from the site's own footer, which links to /admin and /unit.
 */
export function renderRobots(origin: string = SITE_ORIGIN): string {
  const base = origin.replace(/\/$/, '');
  const disallow = [...PRIVATE_PREFIXES]
    .map((p) => `Disallow: ${p}/`)
    .concat(['Disallow: /unit', 'Disallow: /checkout', 'Disallow: /application']);
  return [
    'User-agent: *',
    'Allow: /',
    ...disallow,
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

// ── structured data ─────────────────────────────────────────────────────────

export interface Graph {
  '@context'?: string;
  '@type': string;
  [k: string]: unknown;
}

const isHttpUrl = (u: unknown): u is string => {
  if (typeof u !== 'string' || !u.trim()) return false;
  try {
    const { protocol } = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** A path or an absolute URL → an absolute URL. Deliberately NOT written with
 *  `isHttpUrl`: that is a type guard, so the else-branch narrows to `never` and
 *  the compiler stops checking the interesting half of this function. */
const abs = (u: string, origin = SITE_ORIGIN): string =>
  /^https?:\/\//i.test(u) ? u : origin.replace(/\/$/, '') + (u.startsWith('/') ? u : '/' + u);

/**
 * The organisation, as a SportsOrganization.
 *
 * Every field is something the federation itself publishes: the name, the
 * founding year, the Patratu address, the office contact, and the channels
 * already recorded in the store. There is deliberately no `aggregateRating`
 * (there are no reviews — inventing one is a fabricated measurement AND a
 * documented Google penalty), no membership or staff count (the federation has
 * published no total), and no `award` at this level: honours on this platform
 * belong to PEOPLE and are recorded with the source they came from, on their
 * own profile. Attaching them to the organisation would strip the source.
 *
 * NOTE: src/layouts/Base.astro already emits this graph on every page. This
 * builder exists so there is one tested definition of it; see `notes` for the
 * exact edit that would make Base.astro call it instead of holding a copy.
 */
export function organizationGraph(opts: { sameAs?: string[] } = {}): Graph {
  const sameAs = (opts.sameAs ?? []).filter(isHttpUrl);
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsOrganization',
    name: 'Modern Martial Arts Karate-Do Federation of India',
    alternateName: [
      'MMAKF',
      'Modern Martial Arts Karate-Do Federation, Bharat',
    ],
    url: SITE_ORIGIN,
    // One definition of the crest path, from src/lib/brand.ts — the day the
    // transparent artwork lands, this follows without anyone remembering to.
    logo: CREST_ABSOLUTE,
    foundingDate: '1983',
    sport: 'Shotokan Karate',
    ...(sameAs.length ? { sameAs } : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'MMAKF Headquarters, Patratu',
      addressLocality: 'Ramgarh District',
      addressRegion: 'Jharkhand',
      addressCountry: 'IN',
    },
    contactPoint: {
      '@type': 'ContactPoint',
      // NO TELEPHONE. The number that was here is Sensei's personal mobile, and
      // the federation asked twice for it to be removed. Structured data is MORE
      // exposed than a page, not less — a search engine republishes it into a
      // knowledge panel, which is far harder to withdraw than a web page.
      email: 'admin@mmakf.in',
      contactType: 'customer service',
    },
  };
}

export interface Crumb {
  name: string;
  url: string;
}

/**
 * A BreadcrumbList, or null.
 *
 * Null is the common case and it is the point. A breadcrumb describes a
 * HIERARCHY; a top-level page has none, and emitting `MMAKF > About` so the
 * page has one more block of markup than it did before is exactly the
 * "SEO spam" the federation asked not to become. Two or more levels, or
 * nothing.
 */
export function breadcrumbGraph(trail: Crumb[], origin: string = SITE_ORIGIN): Graph | null {
  const items = (trail ?? []).filter((c) => c && c.name && c.url);
  if (items.length < 2) return null;
  const full: Crumb[] = [{ name: 'MMAKF', url: '/' }, ...items];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: full.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: abs(c.url, origin),
    })),
  };
}

/**
 * A SportsEvent, or null.
 *
 * Null whenever the fixture lacks a parseable date, a name or a place. The seed
 * carries a District Championship at Ramgarh whose exact date is explicitly NOT
 * on the federation's record; a builder that filled that in with a plausible
 * day would send somebody to a venue on the wrong date, which is the worst
 * thing this site can do to anybody. No `offers` either — a fee this system has
 * not been told is not zero, it is unknown.
 */
export function eventGraph(e: any, origin: string = SITE_ORIGIN): Graph | null {
  if (!e) return null;
  const name = String(e.t ?? e.name ?? '').trim();
  const place = String(e.loc ?? '').trim();
  const d = eventDate(e);
  if (!name || !place || !d) return null;
  const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name,
    startDate,
    location: { '@type': 'Place', name: place },
    organizer: {
      '@type': 'SportsOrganization',
      name: 'Modern Martial Arts Karate-Do Federation of India',
      url: origin.replace(/\/$/, ''),
    },
  };
}

/**
 * A SportsActivityLocation for one affiliated unit, or null.
 *
 * THIS IS THE CAPABILITY THE FEDERATION ASKED FOR, AND TODAY IT PRODUCES
 * NOTHING. The unit register is empty, so no location markup is emitted and no
 * "karate classes in <city>" page exists to emit it on. That is the correct
 * output: a location page is legitimate only where a real dojo exists, and a
 * national footprint assembled from cities MMAKF does not operate in would be
 * the doorway-page pattern the federation explicitly refused.
 *
 * A unit that is not CURRENTLY affiliated returns null. /dojos lists lapsed
 * clubs on purpose, with their standing stated in words, because a parent needs
 * to see them — but telling a search engine that a lapsed club is an MMAKF
 * location states the opposite of what the page says.
 */
export function activityLocationGraph(
  unit: Pick<DirectoryEntry, 'name' | 'city' | 'state' | 'affiliated'>,
  origin: string = SITE_ORIGIN
): Graph | null {
  if (!unit || !unit.name || !unit.affiliated) return null;
  // Only the fields the register actually holds. It carries no street address
  // and no telephone number for a unit, so neither is invented here — and the
  // district is deliberately dropped rather than squeezed into addressRegion,
  // which means the state. A district printed as a state is a wrong address.
  const address: Record<string, unknown> = { '@type': 'PostalAddress', addressCountry: 'IN' };
  if (unit.city) address.addressLocality = unit.city;
  if (unit.state) address.addressRegion = unit.state;
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name: unit.name,
    sport: 'Shotokan Karate',
    address,
    parentOrganization: {
      '@type': 'SportsOrganization',
      name: 'Modern Martial Arts Karate-Do Federation of India',
      url: origin.replace(/\/$/, ''),
    },
  };
}
