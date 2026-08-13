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

export const GET: APIRoute = async ({ site }) => {
  const origin = (site?.href || SITE_ORIGIN).replace(/\/$/, '');

  const routes = discoveredRoutes();
  const paths = routes.filter((r) => classifyRoute(r).kind === 'public');

  if (routes.includes('/people/[slug]')) paths.push(...(await peopleRoutes()));

  const body = renderSitemap(paths, origin);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
};
