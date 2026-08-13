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
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import {
  PUBLIC_NAV, PUBLIC_ACTIONS, LEARN_NAV, LEARN_ACTIONS,
} from '@/lib/surface';
import { AUDIENCES } from '@/data/audiences';

let proc: ChildProcess | null = null;
let base = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Its OWN Astro cache — two `astro dev` servers sharing one cacheDir race on
  // the rename of data-store.json and the loser exits with a message that names
  // neither the other suite nor the file. See astro.config.mjs.
  proc = spawn(
    process.execPath,
    ['node_modules/astro/astro.js', 'dev', '--port', String(port), '--host', '127.0.0.1'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASTRO_CACHE_DIR: '.astro-test-routes' } }
  );

  let log = '';
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));

  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
      if (r.status) return;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('astro dev never came up:\n' + log.slice(-3000));
}, 120_000);

afterAll(() => { proc?.kill(); });

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

  // ── SEO landings ──
  '/karate-for-schools',
  '/karate-for-corporates',
  '/karate-for-universities',

  // ── Public pages added or rebuilt ──
  '/shotokan',
  '/people',
  '/network',
  '/documents',

  // ── Admin ──
  '/admin/applications',
  '/admin/tasks',
  '/admin/coaches',
  '/admin/support',

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
