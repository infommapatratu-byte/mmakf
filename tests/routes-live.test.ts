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
  // Renders the signed-out state during a test run, which is still worth
  // fetching: it queries the register in its frontmatter, and a null
  // dereference there is a 500 at request time and a perfectly clean build.
  '/my/practice',

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

  it('embeds only material whose rights are cleared', async () => {
    // §23 and §49, stated as the RULE rather than as the absence.
    //
    // This assertion used to be "no page emits a YouTube iframe anywhere". That
    // was true, and it was the wrong claim: it described the state of the
    // register — nothing external is cleared — rather than the rule, and a
    // codebase whose only guarantee is "we never embed" can never show MMAKF's
    // own footage either.
    //
    // The rule is now enforced in one place, TechnicalPlayer.astro, which
    // refuses to embed anything outside the cleared set. So the register page,
    // which shows the federation's own recordings, DOES carry a player — and
    // the pages that carry only third-party references still must not.
    for (const path of ['/shotokan/techniques/gyaku-zuki', '/shotokan/kihon', '/shotokan/kata']) {
      const { body } = await load(path);
      expect(body, `${path} embedded a recording nobody cleared`).not.toMatch(/youtube\.com\/(embed|iframe_api)/i);
    }

    // And the third-party half of the register is still refused ON the page that
    // does embed — the player is asked for all of them and says no to those.
    const { body } = await load('/shotokan/videos');
    expect(body, 'the register did not render the player at all').toMatch(/iframe_api|tp-stage/);

    // The held recordings are listed on this page as a table rather than as 121
    // blocked player cards, so the guarantee to assert is not the blocked
    // branch's wording — it is that NONE of them reaches an embed.
    //
    // Checked by id, against the two collections that matter most: SKIF NZ's is
    // the only complete twenty-six-kata set found, and Colchester's Enoeda and
    // Ohta demonstrations are the best technical material in the register. They
    // are also the least MMAKF's to publish, which is exactly why they are the
    // ones worth naming in a test rather than trusting to a template.
    for (const heldId of ['9D2yOzDsW8k', 'tXPZFarJMh0', 'bpUAkkrwNVs', 'JrWz-5rfziU']) {
      expect(body, `a third-party recording (${heldId}) was embedded`)
        .not.toMatch(new RegExp(`youtube\\.com/embed/${heldId}`));
      expect(body, `${heldId} vanished from the register instead of being listed`).toContain(heldId);
    }
    expect(body, 'the register stopped stating the third-party standing').toMatch(/Third-party upload/i);
  }, 120_000);

  it('never invents a chapter timestamp', async () => {
    // §30. MMAKF's own footage has no reviewed chapters, so the player must say
    // so rather than deriving plausible ones from the duration.
    const { body } = await load('/shotokan/videos');
    expect(body).toMatch(/No chapters have been recorded/i);
  }, 60_000);

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

/**
 * THE SAME RULE, ON THE PAGES THAT ACTUALLY CARRIED THE BREACHES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS BLOCK EXISTS SEPARATELY FROM THE ONE ABOVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The guard above was written to stop personal contact details reaching public
 * pages, and its PAGES list is the eight training and audience routes. It omits
 * '/', '/about', '/contact', '/governance' and '/registration' — which is every
 * page that was actually carrying one.
 *
 * At the moment this block was added, the homepage carried a "UPI / Payments"
 * card and a personal Gmail address, and the SITE-WIDE FOOTER carried the same
 * Gmail on every page of the site. The narrower guard passed throughout,
 * because it tested three routes that never had the problem and matched only
 * one historical mobile number and the literal `@ybl`.
 *
 * So this block widens both axes at once — the pages, and the shapes:
 *
 *   · any ten-digit Indian mobile, not one remembered number;
 *   · any UPI handle shape, not one provider suffix;
 *   · any consumer-mail address, which is what a personal address looks like
 *     when the federation's own domain is available.
 *
 * The shapes are the ones tests/operations.test.ts already applies to
 * notification templates. They were never applied to pages, which is how the
 * same class of value survived on the front page while being correctly refused
 * inside an email.
 */
describe('no personal contact detail reaches any public page', () => {
  // Every page that carried one, plus the surfaces a visitor actually lands on.
  const PUBLIC_PAGES = [
    '/', '/about', '/contact', '/governance', '/registration',
    '/team', '/black-belts', '/teachers', '/people', '/affiliation', '/shop',
  ];

  for (const path of PUBLIC_PAGES) {
    it(`${path} publishes no personal mobile, UPI handle or consumer mailbox`, async () => {
      const { body, status } = await load(path);
      if (status >= 400) return; // a route that is not configured here is a different test's business

      // A ten-digit Indian mobile, however it is punctuated. The federation
      // publishes no telephone number at all — `contact.phone` is empty and
      // documented as empty — so ANY number of this shape is one somebody typed.
      expect(body.replace(/<[^>]+>/g, ' '), `${path} shows a mobile number`)
        .not.toMatch(/\b[6-9]\d{4}[\s-]?\d{5}\b/);

      // Any UPI handle, not just @ybl. A handle is `something@provider` with no
      // dot in the provider part, which is what separates it from an email.
      expect(body, `${path} shows a UPI handle`)
        .not.toMatch(/\b[a-z0-9._-]{3,}@(ybl|ok[a-z]+|paytm|upi|apl|axl|ibl|sbi|hdfcbank|icici)\b/i);

      // A personal mailbox. The federation has admin@mmakf.in; a gmail address
      // on a federation page is somebody's own, and it was in the footer of
      // every page on this site.
      expect(body, `${path} shows a consumer email address`)
        .not.toMatch(/[a-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|rediffmail)\.com/i);
    }, 60_000);
  }

  it('the homepage does not offer a UPI payment route', async () => {
    const { body } = await load('/');
    // `fed.upi` is admin-editable, so the card was a standing invitation to
    // republish a personal handle on the federation's front page. The card is
    // gone rather than emptied — an empty card is one edit away from a full one.
    expect(body).not.toMatch(/UPI\s*\/\s*Payments/i);
  }, 60_000);

  it('the homepage speaks in the federation’s voice, not a dojo’s', async () => {
    const { body } = await load('/');
    const text = body.replace(/<[^>]+>/g, ' ');
    // src/lib/surface.ts states the rule: "'Book a free trial', 'Explore
    // programs', 'Train under Shihan' … are a dojo's calls to action. A
    // national federation's are register, affiliate, request training, verify."
    // The hero said one thing and the navigation on the same page said the other.
    expect(text, 'the hero sells training under a named individual')
      .not.toMatch(/Train under\s+(Grandmaster|Shihan|Sensei)/i);
    expect(text, 'the hero calls the federation “our dojo”').not.toMatch(/at our dojo/i);
  }, 60_000);

  it('no public page asserts a figure the register cannot produce', async () => {
    for (const path of ['/', '/about', '/affiliation', '/governance']) {
      const { body, status } = await load(path);
      if (status >= 400) continue;
      const text = body.replace(/<[^>]+>/g, ' ');
      // The three src/data/seed.ts deleted by name. They were removed from the
      // record and survived hard-coded in page prose on four routes.
      expect(text, `${path} claims a student count`).not.toMatch(/5,?000\+?\s*students/i);
      expect(text, `${path} claims a school count`).not.toMatch(/130\+?\s*schools?/i);
      expect(text, `${path} claims a black-belt count`).not.toMatch(/34\s*active black belts/i);
    }
  }, 60_000);

  it('no public page repeats the lineage claim the federation withdrew', async () => {
    for (const path of ['/', '/about', '/people', '/governance']) {
      const { body, status } = await load(path);
      if (status >= 400) continue;
      const text = body.replace(/<[^>]+>/g, ' ');
      // `federation.lineage` was emptied because the site "claimed a 'Tiger Lee
      // lineage' in nine places". /about carried the same assertion in other
      // words — "direct inheritor of the Shotokan Karate-Do in India" — which is
      // a stronger claim than the one that was withdrawn.
      expect(text, `${path} claims a lineage`).not.toMatch(/direct inheritor/i);
      expect(text, `${path} claims the Tiger Lee lineage`).not.toMatch(/tiger lee lineage/i);
    }
  }, 60_000);
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

/**
 * THE APEX-DOMAIN FORM REFUSAL, PROVED OVER HTTP.
 *
 * Reported from production: every form submitted from mmakf.in rather than
 * www.mmakf.in answered "Cross-site POST form submissions are forbidden", and
 * had done for months.
 *
 * tests/hardening.test.ts pins the unit-level logic. This block proves the
 * MIDDLEWARE — the thing that actually refused the request — accepts the shape
 * a browser really sends after the apex-to-www redirect, and still refuses a
 * forged one. The previous fix passed its unit tests and failed in production
 * precisely because nothing exercised the real call.
 */
describe('a form POSTed from the apex domain is not refused', () => {
  /** POST with the headers a browser sets, and report what the server said. */
  async function post(path: string, headers: Record<string, string>) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: 'probe=1',
      redirect: 'manual',
      signal: AbortSignal.timeout(40_000),
    });
    const body = await res.text();
    return { status: res.status, body, refused: body.includes('Request refused') };
  }

  it('THE BUG: same-site from the apex is accepted by the middleware', async () => {
    // Chrome submitting a form on https://mmakf.in that 308s to www: the
    // initiator stays the apex, so Sec-Fetch-Site is `same-site`, not
    // `same-origin`. This returned 403 "Request refused" before the fix.
    const r = await post('/start/individual', {
      'sec-fetch-site': 'same-site',
      origin: 'https://mmakf.in',
    });
    expect(r.refused, `middleware refused the apex POST: ${r.status}`).toBe(false);
    expect(r.status).not.toBe(403);
  }, 60_000);

  it('an ordinary same-origin POST is unaffected', async () => {
    const r = await post('/start/individual', { 'sec-fetch-site': 'same-origin' });
    expect(r.refused).toBe(false);
    expect(r.status).not.toBe(403);
  }, 60_000);

  it('ATTACK: a genuinely cross-site POST is still refused', async () => {
    const r = await post('/start/individual', {
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });
    expect(r.status).toBe(403);
    expect(r.refused).toBe(true);
  }, 60_000);

  it('ATTACK: a hijacked sibling subdomain is still refused', async () => {
    // same-site is what a subdomain takeover produces, and it is the reason the
    // check cannot simply accept `same-site`.
    const r = await post('/start/individual', {
      'sec-fetch-site': 'same-site',
      origin: 'https://evil.mmakf.in',
    });
    expect(r.status).toBe(403);
    expect(r.refused).toBe(true);
  }, 60_000);

  it('ATTACK: a POST carrying no origin information at all is refused', async () => {
    const r = await post('/start/individual', {});
    expect(r.status).toBe(403);
    expect(r.refused).toBe(true);
  }, 60_000);
});

/**
 * A SUBMISSION SENT AS JSON IS READ AS A FORM.
 *
 * The client half (src/scripts/form-upgrade.ts) re-sends every same-origin form
 * post as `application/json`, because Vercel's edge refuses the three encodings
 * an HTML form can produce. This proves the server half actually parses it —
 * that `readSubmission()` is wired into the page handlers and not merely
 * written.
 */
describe('a form submission sent as JSON reaches the handler', () => {
  it('a JSON submission reaches the page handler rather than being refused', async () => {
    const res = await fetch(`${base}/careers/does-not-exist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ applicantName: 'Test Person', applicantEmail: 'not-an-email' }),
      signal: AbortSignal.timeout(40_000),
    });
    const body = await res.text();

    // THE CLAIM THIS TEST MAKES, and no more: the middleware did not refuse the
    // JSON body, and the page handler ran to completion and rendered.
    expect(res.status, 'the JSON submission was refused before the handler').not.toBe(403);
    expect(body, 'the handler did not render').toContain('Careers — MMAKF');
    expect(body).not.toMatch(/Internal server error|Cannot read propert|is not defined/i);

    // NOT asserted here: which branch the page took. This suite runs with no
    // DATABASE_URL, so /careers/[slug] renders its "not configured" branch —
    // reading the vacancy is exactly what it cannot do. Asserting a validation
    // message would be asserting the test environment, not the behaviour.
    // The parsing itself is covered field-by-field in tests/form-intake.test.ts.
  }, 60_000);

  it('an /api/ route still refuses a non-JSON body, unchanged', async () => {
    // The API rule is what makes JSON safe: a cross-site form cannot send
    // application/json without a preflight this application never answers.
    // Nothing in the form-intake change may weaken it.
    const res = await fetch(`${base}/api/queue/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'act=approve',
      signal: AbortSignal.timeout(40_000),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Request refused');
  }, 60_000);
});

/**
 * THE PAGE A REAL USER WAS BLOCKED ON.
 *
 * Reported from production with a screen recording: a visitor completing the
 * individual training enquiry at mmakf.in/start/individual pressed Continue and
 * got Vercel's plain-text 403. Nobody could register.
 *
 * The edge rule is not ours to switch off, so the fix is that the page accepts
 * the JSON body `src/scripts/form-upgrade.ts` re-sends. This proves the exact
 * failing route does.
 */
describe('the individual enquiry accepts the submission the client re-sends', () => {
  it('POST /start/individual as JSON reaches the wizard, not a refusal', async () => {
    const res = await fetch(`${base}/start/individual`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
      },
      // Step one of the wizard: who the training is for.
      body: JSON.stringify({ step: '1', learner: 'child' }),
      signal: AbortSignal.timeout(40_000),
    });
    const body = await res.text();

    expect(res.status, 'the enquiry was refused before the handler').not.toBe(403);
    expect(body).not.toContain('Cross-site POST form submissions are forbidden');
    expect(body).not.toMatch(/Internal server error|Cannot read propert|is not defined/i);
    // It rendered the wizard rather than an error page.
    expect(body).toMatch(/MMAKF/i);
  }, 60_000);

  it('POST /register as JSON is likewise not refused', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ step: '1' }),
      signal: AbortSignal.timeout(40_000),
    });
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toContain('Cross-site POST form submissions are forbidden');
  }, 60_000);
});
