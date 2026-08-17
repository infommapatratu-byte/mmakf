// The seller surface — /portal/listings, /portal/listings/[id] and the
// /api/marketplace write path.
//
// Three things are worth testing about a surface, and only three:
//
//   1. THE MONEY BOUNDARY. A price is typed in rupees and stored in paise. That
//      conversion is the one piece of arithmetic on this surface, it happens in
//      exactly one place, and ₹450.50 has to arrive in the column as 45050 —
//      not 450.5, not anything with a fraction still on it, and not silently
//      rounded from something that was never a price.
//
//   2. THE SHAPE OF THE HANDLERS. No caller may name the seller. This is not
//      checked by reading each handler and hoping; it is checked by asserting
//      that no seller-side dispatch mentions a seller id or a user id at all,
//      so a future handler that grows one fails the build.
//
//   3. WHAT THE SURFACE PROMISES. The federation has set no commission, no
//      mandatory documents and no review turnaround. A page that quietly grows
//      "reviewed within 48 hours" is the failure this project treats as the
//      worst one available, and a regex is a cheap guard against it.
//
// The rendered HTML is not asserted here — see the note at the top of
// tests/accessibility.test.ts for why source guards beat a rendered scan for
// exactly this kind of regression.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, createListing, updateListing, myListings,
} from '../src/db/marketplace';
import { formatINR } from '../src/db/orders';
import type { Principal } from '../src/lib/rbac';

// The route is imported for the one pure function it owns. Everything else in
// it is a dispatch onto marketplace.ts, which has its own suite.
import { rupeesToPaise } from '../src/pages/api/marketplace/[...action]';

const ROUTE = readFileSync('src/pages/api/marketplace/[...action].ts', 'utf8');
const LIST_PAGE = readFileSync('src/pages/portal/listings.astro', 'utf8');
const ITEM_PAGE = readFileSync('src/pages/portal/listings/[id].astro', 'utf8');
const SURFACE = [ROUTE, LIST_PAGE, ITEM_PAGE];

/**
 * The surface with its prose removed.
 *
 * The conversion guard below reads raw source and looks for the literal token
 * it forbids. That is the right instrument — a second conversion is a second
 * rounding rule and no type will ever catch it — but pointed at a whole file it
 * also reads the COMMENTS, and this codebase explains itself at length. The
 * guard duly failed on the sentence in [...action].ts that warns a future
 * reader not to introduce a stray multiplication: naming the forbidden token is
 * the only way to warn about it, so the documentation and the check were in a
 * fight neither could win.
 *
 * Deleting the warning to satisfy a regex would be the wrong repair. It removes
 * the thing that PREVENTS the defect in order to preserve the thing that merely
 * DETECTS it. So the check measures code, and the comments stay.
 *
 * This is deliberately not a weakening. A conversion written in a comment
 * converts no money, and one written in a string literal is still caught,
 * because strings are left entirely intact. Only commentary is stripped.
 */
function codeOnly(src: string): string {
  return src
    // Block comments, JSDoc included. Non-greedy, so two of them cannot merge
    // into one match and swallow the code sitting between them.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // HTML comments — the .astro templates carry these.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Line comments, but never the // inside a URL, which would otherwise
    // truncate every https:// line and hide whatever followed it on it.
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ─── 1. The money boundary ──────────────────────────────────────────────────

describe('rupees to paise — the one conversion on the seller surface', () => {
  it('₹450.50 is 45050 paise, and never 450.5', () => {
    // The case named in the brief: what must never reach the column is 450.5,
    // the rupee figure itself, in a column that means paise — which is what a
    // surface with two conversions on it eventually stores. assertPriceMinor()
    // in marketplace.ts refuses any non-integer outright.
    expect(rupeesToPaise('450.50')).toBe(45050);
    expect(rupeesToPaise('450.50')).not.toBe(450.5);
    expect(Number.isInteger(rupeesToPaise('450.50'))).toBe(true);
  });

  it('the float multiplication this function avoids really is wrong', () => {
    // Stated as a fact rather than trusted as folklore — and the folklore was
    // wrong about WHICH prices. ₹450.50 and ₹1,799.99 both survive the
    // multiplication exactly; that is a property of those two numbers in binary,
    // not a rule, and it is why picking the examples by eye is not good enough.
    expect(450.5 * 100).toBe(45050);
    expect(1799.99 * 100).toBe(179999);

    // These are the ordinary prices that do NOT survive it. ₹19.99 truncates to
    // a paisa less than the seller asked for, which is the whole reason the
    // conversion is written the way it is.
    expect(19.99 * 100).not.toBe(1999);
    expect(8.2 * 100).not.toBe(820);
    expect(Math.floor(19.99 * 100)).toBe(1998);   // a paisa short of the price

    // And the conversion under test gets every one of them right.
    expect(rupeesToPaise('19.99')).toBe(1999);
    expect(rupeesToPaise('8.20')).toBe(820);
  });

  it('whole rupees, single paise digits and the awkward ones all land exactly', () => {
    expect(rupeesToPaise('1799')).toBe(179900);
    expect(rupeesToPaise('1799.99')).toBe(179999);
    expect(rupeesToPaise('0.5')).toBe(50);
    expect(rupeesToPaise('0.05')).toBe(5);
    expect(rupeesToPaise('0')).toBe(0);
    expect(rupeesToPaise('12.30')).toBe(1230);
  });

  it('accepts a price the way a person types one', () => {
    expect(rupeesToPaise(' 1,799.00 ')).toBe(179900);
    expect(rupeesToPaise('₹450.50')).toBe(45050);
    expect(rupeesToPaise(450.5)).toBe(45050);
    expect(rupeesToPaise(1799)).toBe(179900);
  });

  it('REFUSES rather than rounds what is not a price', () => {
    // ₹450.555 is a typo or a machine sending the wrong units. Turning it into
    // ₹450.56 hides which, and the seller finds out at reconciliation.
    expect(rupeesToPaise('450.555')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('  ')).toBeNull();
    expect(rupeesToPaise('-10')).toBeNull();
    expect(rupeesToPaise('1e3')).toBeNull();
    expect(rupeesToPaise(null)).toBeNull();
    expect(rupeesToPaise(undefined)).toBeNull();
    expect(rupeesToPaise(Number.NaN)).toBeNull();
    expect(rupeesToPaise(Infinity)).toBeNull();
    expect(rupeesToPaise({})).toBeNull();
    expect(rupeesToPaise(['450.50'])).toBeNull();
  });

  it('round-trips through the display formatter the shop already uses', () => {
    for (const typed of ['450.50', '1799', '1799.99', '0.05']) {
      const minor = rupeesToPaise(typed)!;
      expect(formatINR(minor)).toBe(`₹${Number(typed).toLocaleString('en-IN', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })}`);
    }
  });

  it('is the ONLY rupee-to-paise conversion in the seller surface', () => {
    // A second conversion site is a second rounding rule, and two rounding
    // rules on money is how ₹450.50 becomes 450.5 in a column meaning paise.
    const conversions = SURFACE.map(codeOnly).flatMap((src) => [
      ...src.matchAll(/\*\s*100\b/g),
      ...src.matchAll(/paise\s*\(/g),
    ]);
    expect(conversions.map((m) => m[0])).toEqual([]);

    const definitions = SURFACE.map(codeOnly).filter((src) => /function rupeesToPaise/.test(src));
    expect(definitions).toHaveLength(1);
  });
});

// ─── 2. No caller ever names the seller ─────────────────────────────────────

describe('the API accepts no identifier of WHOSE record this is', () => {
  /** The dispatch table, split into the acts a seller performs on their own
   *  record and the acts the federation performs on somebody else's. */
  const SELLER_SIDE = [
    'seller/apply', 'seller/withdraw',
    'listing/create', 'listing/update', 'listing/stock', 'listing/submit', 'listing/withdraw',
  ];
  const REVIEWER_SIDE = [
    'seller/approve', 'seller/reject', 'seller/suspend', 'seller/reinstate',
    'listing/review', 'listing/delist',
  ];

  function handlerBody(action: string): string {
    const start = ROUTE.indexOf(`'${action}':`);
    expect(start, `${action} is not in the dispatch table`).toBeGreaterThan(-1);
    const next = [...SELLER_SIDE, ...REVIEWER_SIDE]
      .map((a) => ROUTE.indexOf(`'${a}':`))
      .filter((i) => i > start)
      .sort((a, b) => a - b)[0] ?? ROUTE.indexOf('// ─── Status mapping');
    return ROUTE.slice(start, next);
  }

  it('the checker can tell the two families apart', () => {
    // Proved to fail before it is trusted to pass: the reviewer handlers DO
    // take a seller id, so a guard that cannot see one there is seeing nothing.
    expect(handlerBody('seller/approve')).toMatch(/sellerId/);
  });

  for (const action of SELLER_SIDE) {
    it(`${action} takes no sellerId and no userId from the caller`, () => {
      const body = handlerBody(action);
      expect(body, `${action} names a seller id`).not.toMatch(/sellerId/);
      expect(body, `${action} names a user id`).not.toMatch(/userId/);
    });
  }

  it('the seller is resolved from the session, and from nowhere else', () => {
    expect(ROUTE).toMatch(/identify\(request\.headers\.get\('cookie'\)\)/);
    expect(ROUTE).toMatch(/principal:\s*identity\.principal/);
    // No handler builds a principal of its own, which would be the way to
    // smuggle an identity in from the body.
    expect(ROUTE).not.toMatch(/bindings\s*:/);
  });

  it('neither page sends a seller id to the API', () => {
    for (const src of [LIST_PAGE, ITEM_PAGE]) {
      expect(src).not.toMatch(/sellerId/);
    }
  });

  it('neither page calls a "my" function with an id argument', () => {
    // myListings/mySellerAccount take no id by construction; this catches a
    // future refactor that adds one and a page that starts passing it.
    for (const src of [LIST_PAGE, ITEM_PAGE]) {
      expect(src).not.toMatch(/mySellerAccount\([^)]*,[^)]*,/);
      expect(src).not.toMatch(/myListings\(db\(\),\s*identity\.principal,\s*\{?\s*(sellerId|userId)/);
    }
  });

  it('paise are never accepted from a caller — only rupees', () => {
    // Accepting priceMinor would be a second way to set a price, one that skips
    // the single conversion, and the second way is the one still there after
    // somebody simplifies the first.
    expect(ROUTE).toMatch(/if \(b\.priceMinor !== undefined\)/);
    for (const src of [LIST_PAGE, ITEM_PAGE]) {
      expect(src).not.toMatch(/priceMinor:/);            // never sent
      expect(src).toMatch(/priceRupees/);                // always sent as rupees
    }
  });
});

// ─── 3. Authorisation is server-side, and the page says so ──────────────────

describe('the surface re-checks nothing locally and re-decides nothing', () => {
  it('the route holds no authorisation logic of its own', () => {
    // Every gate belongs to marketplace.ts. A second copy is the copy that
    // drifts, and a drifted gate here is an unapproved item on the public site.
    expect(ROUTE).not.toMatch(/assertCan\(/);
    expect(ROUTE).not.toMatch(/canAnywhere\(/);
    expect(ROUTE).not.toMatch(/visibleScopes\(/);
    expect(ROUTE).not.toMatch(/status\s*===\s*'approved'/);
  });

  it('every action is rate limited before anything else happens', () => {
    const post = ROUTE.slice(ROUTE.indexOf('export const POST'));
    const limited = post.indexOf('rateLimit(');
    const dispatched = post.indexOf('await handler(');
    expect(limited).toBeGreaterThan(-1);
    expect(limited).toBeLessThan(dispatched);
    // Applying to sell is registration-shaped: an account can only ever hold
    // one seller row, so a burst of these is never legitimate traffic.
    expect(ROUTE).toMatch(/'seller\/apply':\s*\{\s*bucket:[^}]*limit:\s*5/);
  });

  it('an unauthenticated caller is refused before the database is touched', () => {
    const post = ROUTE.slice(ROUTE.indexOf('export const POST'));
    expect(post.indexOf("json({ error: 'Sign in to do this' }, 401)"))
      .toBeLessThan(post.indexOf('await handler('));
  });

  it('the seller page hides the create form rather than disabling it', () => {
    // A disabled button is a decoration: `fetch` does not read the attribute.
    expect(LIST_PAGE).toMatch(/gate === 'seller' && approved &&/);
    expect(LIST_PAGE).not.toMatch(/<button[^>]*\bdisabled\b/);
    expect(ITEM_PAGE).not.toMatch(/<button[^>]*\bdisabled\b/);
  });

  it('the item page renders its edit form only for an approved seller', () => {
    expect(ITEM_PAGE).toMatch(/listing && sellerApproved &&/);
  });
});

// ─── 4. Nothing is invented ─────────────────────────────────────────────────

describe('the surface states no policy the federation has not set', () => {
  it('quotes the module strings rather than paraphrasing them', () => {
    expect(LIST_PAGE).toMatch(/COMMISSION_NOT_SET/);
    expect(LIST_PAGE).toMatch(/SELLER_REQUIREMENTS_NOT_SET/);
    expect(LIST_PAGE).toMatch(/LISTING_REVIEW_TURNAROUND_NOT_SET/);
    expect(ITEM_PAGE).toMatch(/LISTING_REVIEW_TURNAROUND_NOT_SET/);
  });

  it('promises no turnaround anywhere', () => {
    for (const src of SURFACE) {
      expect(src).not.toMatch(/within \d+\s*(hours|hrs|days|working days|business days)/i);
      expect(src).not.toMatch(/\b\d+\s*[-–]\s*\d+\s*(working )?days\b/i);
    }
  });

  it('names no commission, platform fee or payout split', () => {
    for (const src of SURFACE) {
      expect(src).not.toMatch(/\b\d+(\.\d+)?\s*%\s*(commission|fee|cut|platform)/i);
      expect(src).not.toMatch(/commission (of|is|rate)\b/i);
    }
  });

  it('refuses nothing for a missing GSTIN, PAN or bank detail', () => {
    // They are captured and their absence is reported. Whether MMAKF requires
    // any of them is a federation decision that has not been made.
    expect(ROUTE).not.toMatch(/gstin[^\n]*required/i);
    expect(LIST_PAGE).not.toMatch(/<input[^>]*id="gstin"[^>]*required/);
    expect(LIST_PAGE).not.toMatch(/<input[^>]*id="pan"[^>]*required/);
    expect(LIST_PAGE).not.toMatch(/<input[^>]*id="bankAccountNumber"[^>]*required/);
  });

  it('offers only the four categories the federation already uses', () => {
    expect(LIST_PAGE).toMatch(/LISTING_CATEGORIES\.map/);
    expect(ITEM_PAGE).toMatch(/LISTING_CATEGORIES\.map/);
    for (const invented of ['weapons', 'books', 'nutrition', 'footwear', 'other']) {
      expect(LIST_PAGE.toLowerCase()).not.toContain(`value="${invented}"`);
    }
  });

  it('never echoes a bank account number back to the page', () => {
    // mySellerAccount() masks it to the last four; nothing here undoes that by
    // reading the column directly.
    expect(LIST_PAGE).not.toMatch(/seller\.bankAccountNumber/);
    expect(ITEM_PAGE).not.toMatch(/bankAccountNumber/);
  });
});

// ─── 5. Rule 6 is stated BEFORE the edit ────────────────────────────────────

describe('RULE 6 is unmissable on the item page', () => {
  it('the warning precedes the edit form in the document', () => {
    const warning = ITEM_PAGE.indexOf('Editing this item will remove it from the public site');
    const form = ITEM_PAGE.indexOf('id="editForm"');
    expect(warning, 'no rule-6 warning on the item page').toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    expect(warning, 'the warning must come before the form, not after it').toBeLessThan(form);
  });

  it('the save button itself says what saving will cost', () => {
    expect(ITEM_PAGE).toMatch(/publiclyVisible\s*\n?\s*\?\s*'Save — this takes the item off the public site'/);
  });

  it('what happened is reported from the server answer, not guessed', () => {
    // updateListing() returns returnedToReview; the page repeats it rather than
    // deciding for itself what the save did.
    expect(ITEM_PAGE).toMatch(/data\.result\?\.returnedToReview/);
  });

  it('the page tells the seller that stock is not that kind of edit', () => {
    expect(ITEM_PAGE).toMatch(/never (disturbs|affects) an approval/i);
    expect(ITEM_PAGE).toMatch(/id="stockForm"/);
    // Stock has its own action, so it cannot be folded into the content patch.
    expect(ITEM_PAGE).toMatch(/'listing\/stock'/);
    expect(ROUTE).toMatch(/'listing\/stock':\s*\(ctx, b\) => mkt\.setListingStock/);
  });

  it('there is exactly one write path to reviewable content', () => {
    // Media go through listing/update, not a setter of their own — a second
    // path is a second place to forget the content hash.
    const mediaWrites = [...ROUTE.matchAll(/media:\s*media\(b\)/g)];
    expect(mediaWrites).toHaveLength(1);
    expect(ROUTE).not.toMatch(/listing\/media/);
  });
});

// ─── 6. The boundary, against a real database ───────────────────────────────
//
// The conversion is tested as a function above. This proves the whole path:
// what a seller types, through the one conversion, into the integer column, and
// back out as the string the public shop prints.

let db: any, JH: number, ADMIN: number;
let seq = 0;

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (principal: Principal) => ({ principal });

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [admin] = await db.insert(s.users)
    .values({ email: 'admin@mmakf.in', status: 'active' })
    .returning({ id: s.users.id });
  ADMIN = admin.id;
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
});

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: 'a-perfectly-ordinary-passphrase' });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Seen at the state office.');
  return principal;
}

describe('what a seller types reaches the column as paise', () => {
  it('typing 450.50 stores 45050 and prints ₹450.50', async () => {
    const me = await seller('boundary');
    const created = await createListing(db, ctxOf(me), {
      title: 'Cotton belt',
      category: 'accessories',
      // Exactly what the API route does with the form value, and the only way
      // this page is allowed to produce a price.
      priceMinor: rupeesToPaise('450.50')!,
      stockQty: 2,
    });

    const [row] = await db.select({ priceMinor: s.listings.priceMinor })
      .from(s.listings).where(eq(s.listings.id, created.listingId));

    expect(row.priceMinor).toBe(45050);
    expect(Number.isInteger(row.priceMinor)).toBe(true);
    expect(formatINR(row.priceMinor)).toBe('₹450.50');

    const mine = await myListings(db, me);
    expect(mine.find((l: any) => l.id === created.listingId)!.priceMinor).toBe(45050);
  });

  it('a float that survived to the module is refused, not stored', async () => {
    const me = await seller('float');
    await expect(createListing(db, ctxOf(me), {
      title: 'Bad price', category: 'accessories', priceMinor: 450.5,
    })).rejects.toThrow(/integer number of paise/);
  });

  it('editing the price re-enters through the same conversion', async () => {
    const me = await seller('edit-price');
    const created = await createListing(db, ctxOf(me), {
      title: 'Mitts', category: 'equipment', priceMinor: rupeesToPaise('1,799')!,
    });
    const result = await updateListing(db, ctxOf(me), created.listingId, {
      priceMinor: rupeesToPaise('1799.99')!,
    });
    expect(result.contentChanged).toBe(true);

    const [row] = await db.select({ priceMinor: s.listings.priceMinor })
      .from(s.listings).where(eq(s.listings.id, created.listingId));
    expect(row.priceMinor).toBe(179999);
    expect(formatINR(row.priceMinor)).toBe('₹1,799.99');
  });
});
