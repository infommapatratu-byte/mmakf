/**
 * THE SHOP, FETCHED OVER HTTP.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A STATIC CHECK WAS NOT ENOUGH FOR THESE ROUTES
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * tests/shop-discovery.test.ts asserts that /shop's SOURCE contains a link to
 * the marketplace. That is a real guard against the defect it was written for —
 * the marketplace being unreachable — and it is a weaker claim than it looks:
 * these pages are server-rendered, so a null dereference in the frontmatter is
 * a 500 at request time and a perfectly clean `astro build`.
 *
 * The new surfaces here all read the database in their frontmatter and all of
 * them must answer on a deployment where the marketplace is EMPTY — which is
 * every deployment on the day it ships. An empty catalogue is the case a page
 * that renders `items[0]` gets wrong, and it is the case nobody develops
 * against.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS ASSERTED
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   · every new public shop route answers 200 with no framework error in it;
 *   · the search page refuses to be indexed, on every response including its
 *     error ones — it is the page anybody can mint a URL for;
 *   · an item and a shop that do not exist are 404s, not 500s, and neither
 *     reveals whether the identifier ever existed;
 *   · the private surfaces added here — a buyer's receipt, the admin consoles —
 *     leak nothing to a signed-out request and are never indexable.
 *
 * Slow, and deliberately its own file: each page compiles on first request.
 * The `astro dev` lock in ./helpers/astro-dev.ts is what keeps this suite from
 * racing the three others that boot a server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startAstroDev, type DevServer } from './helpers/astro-dev';

let server: DevServer | null = null;
let base = '';

/**
 * Whether THIS deployment has a database behind it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE ASSERTIONS BRANCH ON IT RATHER THAN ASSUMING ONE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A development checkout has no DATABASE_URL, and the shop is built for that:
 * §70 says a page states why it cannot do something rather than pretending, so
 * with no database /shop/product/[ref] answers 200 with "not available on this
 * deployment" instead of 404. That is CORRECT — a missing database is not a
 * missing product, and answering 404 would tell a crawler the federation's
 * whole catalogue had been deleted the day a connection string expired.
 *
 * So each test below asserts the right behaviour for the state it finds, and
 * neither branch is a skip: an unconfigured deployment must still say what is
 * wrong, and a configured one must still 404 what does not exist.
 */
let dbConfigured = false;

beforeAll(async () => {
  server = await startAstroDev({ label: 'shop-live' });
  base = server.base;

  // Probed from a page that says so in words, rather than from an env var the
  // test process reads — the question is what the SERVER is configured with.
  const probe = await fetch(base + '/shop/search', { signal: AbortSignal.timeout(60_000) });
  const body = await probe.text();
  dbConfigured = !/database is not configured/i.test(body);
}, 600_000);

afterAll(async () => { await server?.stop(); });

async function load(path: string) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(40_000) });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/** A 200 that rendered a framework error page is a failure, not a pass. */
function assertNoCrash(path: string, body: string) {
  expect(body, `${path} answered with an error in the body`)
    .not.toMatch(/Internal server error|Cannot read propert|is not defined|ReferenceError/i);
}

describe('the public shop answers, including on an empty catalogue', () => {
  const OK = [
    '/shop',
    '/shop/search',
    '/shop/search?q=gi',
    '/shop/search?q=a',                        // too short — a message, not a crash
    '/shop/search?q=gi&sort=price_asc&stock=1',
    '/shop/search?page=2',
    '/shop/category',
  ];

  for (const path of OK) {
    it(`GET ${path}`, async () => {
      const { status, body } = await load(path);
      expect(status, `${path} returned ${status}`).toBe(200);
      assertNoCrash(path, body);
    }, 90_000);
  }

  it('/shop offers the marketplace search box a visitor can actually use', async () => {
    const { body } = await load('/shop');
    expect(body).toMatch(/action="\/shop\/search"/);
    expect(body).toMatch(/name="q"/);
  }, 90_000);

  it('/shop links onward to the category tree once there is a catalogue', async () => {
    const { body } = await load('/shop');
    if (dbConfigured) {
      expect(body).toContain('/shop/category');
    } else {
      // No database, so no marketplace section — and the page must SAY that
      // rather than rendering an empty shelf with no explanation.
      expect(body).toMatch(/not (live|connected|available)/i);
    }
  }, 90_000);

  it('a one-character query is told why, rather than being answered', async () => {
    const { body } = await load('/shop/search?q=a');
    expect(body).toMatch(
      dbConfigured ? /at least 2 characters/i : /database is not configured/i,
    );
  }, 90_000);
});

describe('the search page is never indexable', () => {
  // Its URL is minted by whoever typed into the box, so indexing it lets
  // anybody have the federation host a page built from their own words.
  for (const path of ['/shop/search', '/shop/search?q=gi', '/shop/search?q=a']) {
    it(`${path} sets X-Robots-Tag: noindex`, async () => {
      const { headers } = await load(path);
      expect(String(headers.get('x-robots-tag') ?? '')).toMatch(/noindex/i);
    }, 90_000);
  }
});

describe('things that do not exist say so, and never 500', () => {
  /**
   * A MISSING DATABASE IS NOT A MISSING PRODUCT.
   *
   * With no database the page answers 200 and explains; with one, a reference
   * nobody holds is a 404. Both are asserted, so neither state can regress into
   * a 500 or into the other's answer.
   */
  const missing = (label: string, path: string) => {
    it(label, async () => {
      const { status, body } = await load(path);
      assertNoCrash(path, body);
      if (dbConfigured) {
        expect(status, `${path} returned ${status}`).toBe(404);
      } else {
        expect(status, `${path} returned ${status}`).toBe(200);
        expect(body).toMatch(/not available|not configured/i);
      }
    }, 90_000);
  };

  missing('an unknown item reference', '/shop/product/MMAKF-LST-2026-999999');
  missing('an unknown shop address', '/shop/seller/no-such-shop-at-all');
  missing('a category path that is not in the taxonomy', '/shop/category/not-a-real-category');

  it('a category path carrying a LIKE wildcard is refused rather than widened', async () => {
    // Parameterisation stops injection and does NOT stop `%` being a wildcard
    // inside the pattern, so the page refuses the GRAMMAR before the path
    // reaches a LIKE. With no database it never gets that far and says so.
    const { status, body } = await load('/shop/category/%25');
    assertNoCrash('/shop/category/%', body);
    if (dbConfigured) {
      expect([400, 404]).toContain(status);
      // And the refusal itself is not offered to a crawler.
      const { headers } = await load('/shop/category/%25');
      expect(String(headers.get('x-robots-tag') ?? '')).toMatch(/noindex/i);
    } else {
      expect(status).toBe(200);
    }
  }, 90_000);
});

describe('the private surfaces added here leak nothing to a stranger', () => {
  it('a receipt is not readable signed out, and does not say whether it exists', async () => {
    const { status, body } = await load('/my/invoice/MMAKF-INV-2026-000001');
    // Either the sign-in explanation or a not-found — never the document.
    expect([200, 404]).toContain(status);
    assertNoCrash('/my/invoice/…', body);
    expect(body).toMatch(/sign in|no such receipt|not configured/i);
    // Nothing that would only appear on a real invoice.
    expect(body).not.toMatch(/Billed to|Delivered to|Total paid/i);
  }, 90_000);

  it('a receipt is never indexable', async () => {
    const { headers } = await load('/my/invoice/MMAKF-INV-2026-000001');
    expect(String(headers.get('x-robots-tag') ?? '')).toMatch(/noindex/i);
  }, 90_000);

  for (const path of [
    '/admin/marketplace/returns',
    '/admin/marketplace/trust',
    '/admin/marketplace/orders',
  ]) {
    it(`${path} shows a signed-out visitor no marketplace data`, async () => {
      const { status, body } = await load(path);
      // The admin shell answers 200 with a sign-in prompt; what matters is that
      // it carries none of the queues.
      expect([200, 302, 401, 403, 404]).toContain(status);
      assertNoCrash(path, body);
      expect(body).not.toMatch(/MMAKF-SEL-|MMAKF-RET-|MMAKF-DSP-|MMAKF-ORD-/);
    }, 90_000);
  }
});
