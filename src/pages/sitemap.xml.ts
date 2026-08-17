/**
 * /sitemap.xml — the URLs MMAKF asks search engines to index.
 *
 * WHY THIS ENUMERATES INSTEAD OF LISTING
 * ──────────────────────────────────────
 * The previous version of this file held `const ROUTES = ['/', '/about', ...]`
 * — fifteen paths typed by hand. By the time anyone looked, twelve more public
 * pages existed (/athletes, /officials, /dojos, /competitions, /rankings,
 * /regulations, /press, /calendar, /search, /verify, /scoreboard, /live) and
 * the sitemap knew about none of them. Nothing had gone wrong; a hand-written
 * list simply does not follow the code. So the routes come from the files.
 *
 * WHY `import.meta.glob` AND NOT `readdir`
 * ────────────────────────────────────────
 * This is SSR on Vercel. At request time there is no `src/pages` on disk — the
 * function is a bundle. `import.meta.glob` is resolved by Vite at BUILD time
 * into a literal map of module paths, so the route list is baked into the
 * bundle and is correct for exactly the code that was deployed. It is
 * non-eager: only the KEYS are read, so no page module is ever imported and no
 * page's dependencies are dragged into this endpoint.
 *
 * WHAT IS REFUSED, AND BY WHOM
 * ────────────────────────────
 * Classification lives in src/lib/seo.ts with a written reason per refusal, and
 * `renderSitemap` re-applies the private-path filter as a last line of defence.
 * A page in a section that has been declared neither public nor private is
 * `unclassified`: it is NOT advertised, and tests/seo.test.ts fails until
 * somebody decides. Failing the build beats leaking the URL.
 */

import type { APIRoute } from 'astro';
import { get } from '@/lib/storage';
import { slugify } from '@/lib/people';
import { classifyRoute, renderSitemap, routeFromPageFile, SITE_ORIGIN } from '@/lib/seo';
import { AUDIENCES } from '@/data/audiences';
import { TECHNIQUES, SYSTEMS, CONCEPTS } from '@/data/shotokan';
import { KATA } from '@/data/kata';
import { isConfigured, db } from '@/db';
import { publishableClubs } from '@/db/clubs';

export const prerender = false;

/** Build-time map of every page module. Keys only — nothing here is imported. */
const PAGE_MODULES = import.meta.glob('./**/*.{astro,md,mdx,ts,js}');

/** Every route Astro serves, derived from the files that were deployed. */
export function discoveredRoutes(): string[] {
  return Object.keys(PAGE_MODULES)
    .map(routeFromPageFile)
    .filter((r): r is string => r !== null)
    .sort();
}

/**
 * Profiles of the people the federation has published.
 *
 * These are editorial records, already linked from /governance, and the slug is
 * computed with the SAME `slugify` the profile page matches on — a second
 * implementation here would advertise URLs that 404.
 *
 * Only the leadership register is expanded. /athlete/[id] deliberately is not:
 * see DYNAMIC_ROUTE_POLICY in src/lib/seo.ts.
 */
async function peopleRoutes(): Promise<string[]> {
  try {
    const leadership = (await get<any[]>('leadership')) || [];
    return leadership
      .map((p: any) => slugify(p?.name || ''))
      .filter(Boolean)
      .map((s: string) => `/people/${s}`);
  } catch {
    // A sitemap that 500s because the editorial store blinked is worse than a
    // sitemap missing six profiles. The static routes are still worth serving.
    return [];
  }
}

/**
 * The six audience pages on the learn surface.
 *
 * Expanded from the SAME array the pages render from, so the sitemap cannot
 * advertise a slug that returns 404 — which is precisely what happened twice in
 * the navigation before the route list was derived rather than hand-written.
 *
 * These are the most search-valuable pages the federation has: they are how a
 * school looking for karate finds MMAKF at all. They were missing from the
 * sitemap entirely, because /learn/[audience] is dynamic and a dynamic route
 * contributes nothing without an expansion policy — the safe default, and the
 * wrong outcome here.
 *
 * No editorial store, no database, no failure mode: the array is compiled in.
 */
function audienceRoutes(): string[] {
  return AUDIENCES.map((a) => `/learn/${a.slug}`);
}

/**
 * The twenty-six kata of the Shotokan canon.
 *
 * Expanded from the same array /kata and /kata/[slug] render from. These are
 * among the most search-valuable pages the federation has — a student looking
 * up a form is how a great many people find MMAKF at all — and they were
 * absent from the sitemap entirely, because /kata/[slug] is dynamic and a
 * dynamic route contributes nothing without an expansion policy.
 *
 * That is the SAME defect, with the same cause, that /learn/[audience] had and
 * that the note above it describes. It happened twice because nothing checked
 * that a public dynamic route has a policy AT ALL — only that a policy key
 * names a real route, which is the other direction. tests/seo.test.ts now
 * checks both, so there is no third time.
 */
function kataRoutes(): string[] {
  return KATA.map((k) => `/kata/${k.slug}`);
}

/**
 * The Shotokan technical library.
 *
 * Expanded from the SAME arrays the pages render from, for the same reason as
 * the audience pages: a sitemap that computes slugs its own way advertises URLs
 * that 404. These are the pages §45 asks to be genuinely indexable — real
 * educational content about public martial-arts knowledge, not keyword-stuffed
 * doorways.
 *
 * Compiled in. No store, no database, no failure mode.
 */
function techniqueRoutes(): string[] {
  return TECHNIQUES.map((t) => `/shotokan/techniques/${t.slug}`);
}

function kumiteRoutes(): string[] {
  return [...SYSTEMS, ...CONCEPTS].map((k) => `/shotokan/kumite/${k.slug}`);
}

/**
 * The affiliated clubs that have a public page.
 *
 * FROM THE REGISTER, AND ONLY THE VERIFIED PART OF IT. publishableClubs()
 * returns clubs that are currently affiliated AND carry a slug an administrator
 * set. The federation's instruction is explicit — "DO NOT generate fake
 * location pages. Only index real verified locations" — and the two halves of
 * that filter are the two ways this could go wrong: advertising a lapsed club
 * as the federation's recommendation, and minting a URL from a name that will
 * change.
 *
 * A database failure returns NOTHING rather than throwing. A sitemap missing
 * the club pages is a smaller harm than a sitemap that 500s and takes the
 * hundred static routes down with it — the same reasoning peopleRoutes()
 * applies to the editorial store.
 */
async function clubRoutes(): Promise<string[]> {
  if (!isConfigured()) return [];
  try {
    const clubs = await publishableClubs(db());
    return clubs.map((c) => `/clubs/${c.slug}`);
  } catch {
    return [];
  }
}

export const GET: APIRoute = async ({ site }) => {
  const origin = (site?.href || SITE_ORIGIN).replace(/\/$/, '');

  const routes = discoveredRoutes();
  const paths = routes.filter((r) => classifyRoute(r).kind === 'public');

  if (routes.includes('/people/[slug]')) paths.push(...(await peopleRoutes()));
  if (routes.includes('/learn/[audience]')) paths.push(...audienceRoutes());
  if (routes.includes('/kata/[slug]')) paths.push(...kataRoutes());
  if (routes.includes('/shotokan/techniques/[slug]')) paths.push(...techniqueRoutes());
  if (routes.includes('/shotokan/kumite/[slug]')) paths.push(...kumiteRoutes());
  if (routes.includes('/clubs/[slug]')) paths.push(...(await clubRoutes()));

  const body = renderSitemap(paths, origin);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
};
