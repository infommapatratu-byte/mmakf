/**
 * EVERY ROUTE THIS SESSION ADDED, FETCHED OVER HTTP.
 *
 * tests/navigation.test.ts checks that a link resolves to a route ON DISK. That
 * is a weaker claim than it looks, and it let a 404 straight through:
 *
 *   /learn/coaches was in the navigation. `resolves()` matched it against the
 *   dynamic route /learn/[audience] and passed. The page then returned 404 for
 *   every request, because `coaches` is not an audience slug.
 *
 * A static check proves a route COULD answer. Only a request proves it does.
 *
 * These pages are server-rendered, so a null dereference in the frontmatter is
 * a 500 at request time and a perfectly clean `astro build`. That distinction
 * has already cost this project its homepage once.
 *
 * Slow — each page compiles on first request — and deliberately a separate file
 * so the fast guards stay fast. If the server does not come up these tests
 * FAIL; they do not skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startAstroDev, type DevServer } from './helpers/astro-dev';
import {
  PUBLIC_NAV, PUBLIC_ACTIONS, LEARN_NAV, LEARN_ACTIONS,
} from '@/lib/surface';
import { AUDIENCES } from '@/data/audiences';

let server: DevServer | null = null;
let base = '';

// ONE astro dev AT A TIME. Three suites boot one, and in DEV astro writes its
// content store to <root>/.astro/data-store.json regardless of cacheDir — so
// concurrent servers race on the rename and the loser dies with EPERM, which
// vitest then reports as 144 SKIPPED tests rather than as a failure. The lock
// and the readiness logic both live in ./helpers/astro-dev.ts; the full
// account, with astro's own source lines, is in that file's header.
beforeAll(async () => {
  server = await startAstroDev({ label: 'routes-live' });
  base = server.base;
}, 600_000);

afterAll(async () => { await server?.stop(); });

/** Fetch, and treat an error page served with a 200 as a failure. */
async function load(path: string) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(40_000) });
  const body = await res.text();
  return { status: res.status, body };
}

const OK_ROUTES = [
  // ── The two that were 404ing on production ──
  '/training/individual',
  '/training/estimate',
  '/training/estimate?go=1&city=Ranchi&ageBand=adult&sessionsPerWeek=2',

  // ── The learn surface, reached through www while the subdomain has no DNS ──
  '/learn',
  '/learn/schools',
  '/learn/corporates',
  '/learn/universities',
  '/learn/government',
  '/learn/communities',
  '/learn/individuals',
  // The one the static check missed.
  '/learn/coaches',
  '/learn/apply',
  '/learn/apply?audience=school',
  '/learn/applications/MMAKF-APP-2026-000001',

  // ── The router page, and the door two of its eleven options open ──
  //
  // /start offered "Individual" and "Parent or guardian" — both pointing at
  // /start/individual — for as long as it was live, and there was no such
  // route. Nothing derived from a menu covers it, because /start declares its
  // destinations in its own frontmatter rather than in src/lib/surface.ts.
  '/start',
  '/start/individual',

  // ── SEO landings ──
  '/karate-for-schools',
  '/karate-for-corporates',
  '/karate-for-universities',

  // ── Public pages added or rebuilt ──
  '/shotokan',

  // ── The Shotokan technical library ──
  //
  // Every one of these renders from src/data/shotokan in its frontmatter, so a
  // bad slug reference or a null dereference is a 500 at request time and a
  // perfectly clean build. The detail routes are also fetched with nonsense
  // slugs further down: "renders something" and "refuses what does not exist"
  // are different claims, and only the second stops an empty, indexable page
  // appearing for every typo anybody makes.
  '/shotokan/kihon',
  '/shotokan/kata',
  '/shotokan/kumite',
  '/shotokan/techniques',
  '/shotokan/stances',
  '/shotokan/terminology',
  '/shotokan/live',
  '/shotokan/videos',
  '/shotokan/techniques/gyaku-zuki',
  '/shotokan/techniques/zenkutsu-dachi',
  '/shotokan/techniques/mae-geri',
  '/shotokan/kumite/sen-no-sen',
  '/shotokan/kumite/gohon-kumite',
  '/shotokan/kumite/shiai-kumite',

  '/people',
  '/network',
  '/documents',

  // ── Admin ──
  //
  // These answer 200 with AdminShell's sign-in prompt when nobody is signed in,
  // which is the state a test run is in. That is still worth fetching: a null
  // dereference in the frontmatter is a 500 at request time and a clean
  // `astro build`, and every one of these pages queries the database in its
  // frontmatter.
  '/admin/applications',
  '/admin/tasks',
  '/admin/coaches',
  '/admin/support',
  '/admin/leads',
  '/admin/fees',
  '/admin/quotes',
  '/admin/programs',
  '/admin/bookings',
  '/admin/venues',
  '/admin/attendance',
  '/admin/workflows',
  '/admin/audit',
  '/admin/notifications',
  '/admin/dashboard',
  '/admin/command',

  // The member's own inbox. Linked from /my and from a push notification's
  // click target, so it is reachable by two routes that are not a menu.
  '/my',
  '/my/notifications',

  // ── The client portal ──
  '/learn/portal',

  // ── Pages whose navigation changed underneath them ──
  '/',
  '/about',
  '/training',
  '/governance',
  '/verify',
];

/**
 * EVERY LINK IN EVERY MENU, DERIVED FROM THE MENU ITSELF.
 *
 * The list above is hand-written and therefore has the same weakness as the
 * pages it checks: somebody adds a navigation entry and forgets to add it here.
 * That is exactly how /learn/coaches and then /learn/request both shipped as
 * 404s — both were in the navigation, both matched /learn/[audience] in the
 * static check, and neither had a file.
 *
 * Deriving the list from PUBLIC_NAV, PUBLIC_ACTIONS, LEARN_NAV and LEARN_ACTIONS
 * means a new menu entry is fetched the moment it is added, with no second list
 * to remember. The admin menu is excluded: those pages legitimately answer 200
 * with a sign-in prompt, which the block below checks separately.
 */
const NAV_PATHS = [
  ...new Set([
    ...PUBLIC_NAV.map((n) => n.href),
    ...PUBLIC_NAV.flatMap((n) => (n.children ?? []).map((c) => c.href)),
    ...PUBLIC_ACTIONS.map((a) => a.href),
    ...LEARN_NAV.map((n) => n.href),
    ...LEARN_ACTIONS.map((a) => a.href),
    // The audience data drives links on several pages and is the other place a
    // slug can be added without a file appearing.
    ...AUDIENCES.map((a) => `/learn/${a.slug}`),
    ...AUDIENCES.map((a) => a.action.href),
    ...AUDIENCES.filter((a) => a.publicPath).map((a) => a.publicPath as string),
  ]),
];

describe('every route the navigation offers actually answers', () => {
  for (const path of OK_ROUTES) {
    it(`GET ${path}`, async () => {
      const { status, body } = await load(path);
      expect(status, `${path} returned ${status}`).toBe(200);
      // A 200 that rendered a framework error page is still a failure.
      expect(body, `${path} answered 200 with an error in the body`)
        .not.toMatch(/Internal server error|Cannot read propert|is not defined/i);
    }, 60_000);
  }
});

describe('every navigation link, taken from the navigation', () => {
  for (const path of NAV_PATHS) {
    it(`GET ${path}`, async () => {
      const { status, body } = await load(path);
      expect(
        status,
        `${path} is offered in the navigation and answered ${status}. ` +
        'A link that only resolves through a dynamic route is still a 404 to a visitor.'
      ).toBe(200);
      expect(body, `${path} answered 200 with an error in the body`)
        .not.toMatch(/Internal server error|Cannot read propert|is not defined/i);
    }, 60_000);
  }
});

describe('routes that must NOT be 200', () => {
  it('an unknown audience is a 404, not a 500', async () => {
    const { status } = await load('/learn/not-an-audience');
    expect(status).toBe(404);
  });
});

describe('the wizard renders from the one definition', () => {
  it('serves step one with the fields the definition names', async () => {
    const { body } = await load('/learn/apply');
    expect(body).toMatch(/name="institutionName"/);
    expect(body).toMatch(/name="institutionType"/);
    expect(body).toMatch(/Step\b/);
    // Twenty steps, stated on the page rather than hard-coded in the markup.
    expect(body).toMatch(/of\s*20/);
  }, 60_000);

  it('carries the audience through from an audience page', async () => {
    const { body } = await load('/learn/apply?audience=school');
    expect(body).toMatch(/name="audience"\s+value="school"/);
  }, 60_000);
});

describe('the Shotokan technical library, over HTTP', () => {
  it('refuses an unknown technique rather than rendering an empty one', async () => {
    // An empty page for every typo is an indexable URL for every typo. The
    // prototype-shaped slugs are here because a plain object lookup answers
    // them truthily, and this library uses a Map precisely so it does not.
    for (const slug of ['not-a-technique', '__proto__', 'constructor']) {
      const res = await fetch(`${base}/shotokan/techniques/${slug}`, { signal: AbortSignal.timeout(40_000) });
      expect(res.status, `/shotokan/techniques/${slug}`).toBe(404);
    }
  }, 90_000);

  it('refuses an unknown kumite record', async () => {
    const res = await fetch(`${base}/shotokan/kumite/not-a-thing`, { signal: AbortSignal.timeout(40_000) });
    expect(res.status).toBe(404);
  }, 60_000);

  it('states the syllabus gap on a technique page rather than omitting it', async () => {
    // The absence must be VISIBLE. A page that silently omitted the grade would
    // read as an oversight; one that names it is honest and is also correct.
    const { body } = await load('/shotokan/techniques/gyaku-zuki');
    expect(body).toMatch(/has not published its grading syllabus/i);
    expect(body).toMatch(/Not placed at a grade/i);
  }, 60_000);

  it('never states a grade for a technique', async () => {
    for (const path of ['/shotokan/techniques/gyaku-zuki', '/shotokan/techniques/mae-geri', '/shotokan/kihon']) {
      const text = (await load(path)).body.replace(/<[^>]+>/g, ' ');
      expect(text, `${path} placed a technique at a grade`)
        .not.toMatch(/\b\d+(st|nd|rd|th)\s+kyu\b/i);
    }
  }, 90_000);

  it('states no competition rule value on the sport pages', async () => {
    // §20. The principle survives a rule change; the value does not.
    for (const path of ['/shotokan/kumite', '/shotokan/kumite/shiai-kumite']) {
      const text = (await load(path)).body.replace(/<[^>]+>/g, ' ');
      expect(text, `${path} stated a scoring value`).not.toMatch(/\bworth\s+(one|two|three|\d)\s+points?\b/i);
      expect(text, `${path} stated a bout length`).not.toMatch(/\bbout\s+(is|lasts)\s+\w+\s+minutes?\b/i);
    }
  }, 60_000);

  it('embeds no third-party video player anywhere in the library', async () => {
    // §23 and §49. The register attributes and links; it does not embed a
    // recording whose rights nobody has cleared, and an <iframe> to YouTube is
    // exactly what "embedding it anyway" would look like in the markup.
    for (const path of ['/shotokan/videos', '/shotokan/techniques/gyaku-zuki', '/shotokan/kihon']) {
      const { body } = await load(path);
      expect(body, `${path} embedded a video player`).not.toMatch(/<iframe[^>]+youtube/i);
    }
  }, 90_000);

  it('shows the rights position on the source register', async () => {
    const { body } = await load('/shotokan/videos');
    expect(body).toMatch(/Third-party upload/i);
    expect(body).toMatch(/rights/i);
    // The Yale finding is the page's own evidence for why link health is
    // checked per recording. If it ever stops being rendered, the argument
    // for the whole check has quietly disappeared from the site.
    expect(body).toMatch(/ALL EIGHT ARE DEAD/i);
  }, 60_000);

  it('serves every route §33 of the directive names', async () => {
    // The directive lists the curriculum browser's sections by path. Four of
    // them had no file and were reachable from nowhere; this asserts all eight
    // answer, so a listed section cannot quietly go missing again.
    for (const path of [
      '/shotokan', '/shotokan/kihon', '/shotokan/kata', '/shotokan/kumite',
      '/shotokan/techniques', '/shotokan/stances', '/shotokan/terminology',
      '/shotokan/live', '/shotokan/videos',
    ]) {
      const { status } = await load(path);
      expect(status, path).toBe(200);
    }
  }, 120_000);

  it('finds a technique by name even with no database configured', async () => {
    // §31, and the reason it was failing in production: /search reads Postgres,
    // the technical library does not live there, and the dev server this suite
    // boots has no DATABASE_URL — which is exactly production's state. If the
    // technical results were behind the database guard, this returns nothing.
    const { body } = await load('/search?q=gyaku+zuki');
    expect(body).toMatch(/technical library/i);
    expect(body).toMatch(/href="[^"]*\/shotokan\/techniques\/gyaku-zuki"/);
  }, 60_000);

  it('finds a kata and a tactical concept from the same search box', async () => {
    const kata = await load('/search?q=bassai+dai');
    expect(kata.body).toMatch(/href="[^"]*\/kata\/bassai-dai"/);
    const sen = await load('/search?q=sen+no+sen');
    expect(sen.body).toMatch(/href="[^"]*\/shotokan\/kumite\/sen-no-sen"/);
  }, 90_000);

  it('the media-sync cron refuses an unauthenticated caller', async () => {
    // It polls a third party and writes to the media register. An open endpoint
    // is one an attacker can use to exhaust the day's API quota, which is how
    // live detection stops working for everybody else.
    const res = await fetch(`${base}/api/cron/media-sync`, { signal: AbortSignal.timeout(40_000) });
    expect(res.status).toBe(401);
  }, 60_000);

  it('links kihon, kata and kumite to one another', async () => {
    const { body } = await load('/shotokan/techniques/gyaku-zuki');
    expect(body).toMatch(/href="[^"]*\/kata\/bassai-dai"/);
    expect(body).toMatch(/href="[^"]*\/shotokan\/kumite\/[a-z-]+"/);
    expect(body).toMatch(/href="[^"]*\/shotokan\/terminology#/);
  }, 60_000);
});

describe('what the public pages must never say', () => {
  const PAGES = [
    '/learn', '/learn/schools', '/learn/corporates', '/learn/universities',
    '/karate-for-schools', '/training/individual', '/training/estimate',
    '/learn/coaches',
  ];

  for (const path of PAGES) {
    it(`${path} promises no response time the federation never published`, async () => {
      const { body } = await load(path);
      const text = body.replace(/<[^>]+>/g, ' ');
      // The federation has published no service standard. This is where an
      // invented one would hide — in reassuring page copy nobody re-reads.
      expect(text, `${path} promises a turnaround`)
        .not.toMatch(/within \d+\s*(hours?|days?|working days?)/i);
      expect(text, `${path} promises a turnaround`)
        .not.toMatch(/\b(24|48|72)[\s-]*hours?\b/i);
    }, 60_000);

    it(`${path} quotes no fee`, async () => {
      const { body } = await load(path);
      const text = body.replace(/<[^>]+>/g, ' ');
      // The framework holds no published rules, so any rupee figure on these
      // pages is one somebody typed. `₹X` in the explanatory prose on
      // /training/estimate is the single allowed form and carries no digits.
      const amounts = text.match(/₹\s?[\d,]+/g) ?? [];
      expect(amounts, `${path} shows a price: ${amounts.join(', ')}`).toEqual([]);
    }, 60_000);

    it(`${path} carries neither the personal number nor the personal UPI`, async () => {
      const { body } = await load(path);
      // The federation asked twice for both to be removed. Matched by shape
      // rather than by spelling, because it came back once as
      // "+91-99391-44318" after being removed as "9939144318".
      expect(body).not.toMatch(/9\D?9\D?3\D?9\D?1\D?4\D?4\D?3\D?1\D?8/);
      expect(body).not.toMatch(/@ybl\b/i);
    }, 60_000);
  }
});

describe('breadcrumbs', () => {
  it('renders a visible trail AND matching markup on a page with a hierarchy', async () => {
    const { body } = await load('/karate-for-schools');

    // Both, from the same array. Markup describing a trail the page does not
    // show is what Google's structured-data guidance calls misleading.
    expect(body, 'no visible breadcrumb trail').toMatch(/aria-label="Breadcrumb"/);
    expect(body, 'no BreadcrumbList markup').toMatch(/"@type"\s*:\s*"BreadcrumbList"/);

    const json = body.match(/\{[^<]*"BreadcrumbList"[\s\S]*?\}\s*<\/script>/)?.[0] ?? '';
    expect(json).toMatch(/"name"\s*:\s*"MMAKF"/);
    expect(json).toMatch(/"name"\s*:\s*"Training"/);
    expect(json).toMatch(/"name"\s*:\s*"For schools"/);
    // Absolute URLs, as the schema requires.
    expect(json).toMatch(/https:\/\/www\.mmakf\.in\/training/);
  }, 60_000);

  it('renders NO breadcrumb on a top-level page', async () => {
    // A breadcrumb describes a hierarchy. "MMAKF > About" on a top-level page
    // is one more block of markup and no more information — which is the SEO
    // padding the federation asked not to produce.
    for (const path of ['/', '/about', '/verify']) {
      const { body } = await load(path);
      expect(body, `${path} emitted a breadcrumb it has no hierarchy for`)
        .not.toMatch(/"@type"\s*:\s*"BreadcrumbList"/);
    }
  }, 60_000);

  it('renders no breadcrumb on a page that is not indexed', async () => {
    // Describing a hierarchy to a crawler that is being told, in the same
    // <head>, not to index the page.
    const { body } = await load('/admin/tasks');
    expect(body).not.toMatch(/"@type"\s*:\s*"BreadcrumbList"/);
  }, 60_000);
});

describe('the admin surface is never indexable', () => {
  it('sends noindex on an admin page', async () => {
    const res = await fetch(base + '/admin/tasks', { signal: AbortSignal.timeout(40_000) });
    const body = await res.text();
    // Belt and braces: the meta tag here, robots.txt separately. A header
    // travels with the response and cannot be missed by a crawler that never
    // fetched robots.txt.
    expect(body).toMatch(/name="robots"[^>]*noindex/i);
  }, 60_000);

  it('does not send noindex on a public page', async () => {
    const { body } = await load('/karate-for-schools');
    expect(body).not.toMatch(/name="robots"[^>]*noindex/i);
  }, 60_000);
});
