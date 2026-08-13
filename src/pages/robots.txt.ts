/**
 * /robots.txt — served, not shipped as a static file.
 *
 * WHY AN ENDPOINT RATHER THAN public/robots.txt
 * ─────────────────────────────────────────────
 * The disallow list and the sitemap URL are the same two facts the sitemap
 * endpoint already depends on. Held in a static file they are a third copy that
 * drifts: `public/robots.txt` disallowed `/admin` and `/api/` and nothing else,
 * while `/my/**` — every member's own area — was open to crawlers.
 * `renderRobots()` in src/lib/seo.ts derives the list from PRIVATE_PREFIXES, so
 * a path that is private to the sitemap is private here by construction.
 *
 * WHAT THIS FILE MUST NEVER SAY
 * ─────────────────────────────
 *   `Disallow: /`         removes the federation from search entirely.
 *   `Crawl-delay: n`      an operational policy MMAKF never set, ignored by
 *                         Google, and obeyed by the crawlers you least mind.
 *
 * AND WHAT DISALLOW IS NOT: a security control. It is a request a crawler may
 * ignore, and it publishes the list of paths worth trying. Nothing here is
 * relied on for access control — /admin, /my and the unit portal each enforce
 * their own session server-side. These lines exist so a well-behaved crawler
 * does not waste its budget on pages that will only ever show it a sign-in
 * form, and they name only paths the site's own footer already links to.
 *
 * NOTE: `public/robots.txt` still exists and is served by the static layer
 * ahead of this route. It is outside this stream's ownership; the exact
 * deletion needed to bring this endpoint into service is recorded in `notes`.
 */

import type { APIRoute } from 'astro';
import { renderRobots, SITE_ORIGIN } from '@/lib/seo';

export const prerender = false;

export const GET: APIRoute = ({ site }) => {
  const origin = (site?.href || SITE_ORIGIN).replace(/\/$/, '');
  return new Response(renderRobots(origin), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
};
