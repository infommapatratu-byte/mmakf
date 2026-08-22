// Bulk product import — and, mostly, everything it refuses to do.
//
// THE INSTRUCTION UNDER TEST is the one the schema itself quotes:
//
//     "NEVER DIRECTLY IMPORT INTO PRODUCTION CATALOGUE."
//
// A happy-path assertion — "five rows in, five products out" — would pass just
// as well against a loop that inserted approved listings, which is the exact
// defect the staging tables exist to prevent. So what is asserted here is:
//
//   · a submitted import produces DRAFTS, and nothing it produces is approved,
//     published, or visible to the public predicate;
//   · a prohibited category and an unauthorised brand FAIL VALIDATION, with the
//     policy engine's own sentences and not a re-implementation's;
//   · a file over the bound is refused WHOLE — never trimmed to fit;
//   · `raw` is byte-identical after validation, so the evidence of what the
//     seller actually uploaded survives;
//   · one seller cannot see, validate, submit or cancel another's import, and
//     "not yours" and "does not exist" are the same answer;
//   · the price grammar agrees with the route's rupeesToPaise() value for
//     value, differentially, because this module carries a second copy of it;
//   · an invalid row is SKIPPED AND RECORDED, never dropped.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, asc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller, createListing } from '../src/db/marketplace';
import { addVariant, adoptProposedTaxonomy, categoryBySlug } from '../src/db/catalogue';
import {
  startImport, validateImport, importPreview, submitImport, cancelImport,
  myImports, importsForSeller, importedRupeesToPaise, normalisedTitle,
  MAX_IMPORT_ROWS, IMPORT_ROW_BOUND_NOTE, IMPORT_STOCK_NOT_TAKEN,
  LEGACY_AXIS_UNMAPPED, IMPORT_TEMPLATE_COLUMNS,
} from '../src/db/product-import';
// The canonical conversion. The import module carries a second copy of the
// GRAMMAR because it converts inside the database and not at the request, and
// the whole risk of that copy is that it drifts. This import is what catches it.
import { rupeesToPaise } from '../src/pages/api/marketplace/[...action]';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, ADMIN: number;
const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let seq = 0;

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  return { principal, sellerId: applied.sellerId, ctx: ctxOf(principal) };
}

/** A well-formed row, so each test can vary the one cell it is about. */
const row = (over: Record<string, unknown> = {}) => ({
  title: 'Karate-gi 170cm white',
  category: 'karate-gi',
  price: '1799.00',
  ...over,
});

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' }).returning();
  JH = jh.id;

  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
  await adoptProposedTaxonomy(db, ctxOf(national()));
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('THE PRICE GRAMMAR — one rule, two copies, proved to agree', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('agrees with the route’s rupeesToPaise() value for value', () => {
    // A DIFFERENTIAL PROOF rather than a table of hand-computed answers. The
    // module reproduces the grammar because it converts against rows already in
    // the database, where the API route is not reachable; the only danger of
    // that is drift, and this is what fails when somebody edits one of them.
    const corpus = [
      '0', '1', '1799', '1799.00', '1799.5', '1799.50', '1799.99', '450.50', '₹450.50',
      '1,799', ' 1799 ', '₹ 1,799.99', '19.99', '8.20', '999999999', '999999999.99',
      // And every shape that must be refused by BOTH.
      '450.555', '-100', '1e3', '1799,50', 'free', '', '   ', 'NaN', '1799.', '.50',
      '1234567890', '₹', '1 799', '12.345', 'Rs 100',
    ];
    for (const v of corpus) {
      expect(`${v} → ${importedRupeesToPaise(v)}`).toBe(`${v} → ${rupeesToPaise(v)}`);
    }
    for (const v of [0, 1799, 1799.5, 19.99, Number.NaN, Infinity, -5]) {
      expect(`${v} → ${importedRupeesToPaise(v)}`).toBe(`${v} → ${rupeesToPaise(v)}`);
    }
    for (const v of [null, undefined, {}, [], true]) {
      expect(importedRupeesToPaise(v)).toBe(rupeesToPaise(v));
    }
  });

  it('refuses a third decimal rather than rounding it', () => {
    // ₹450.555 is a typo or the wrong units. Turning it into ₹450.56 hides
    // which, and the seller finds out from a buyer.
    expect(importedRupeesToPaise('450.555')).toBeNull();
    expect(importedRupeesToPaise('450.55')).toBe(45055);
  });

  it('never multiplies a decimal by a hundred', () => {
    // The two values that prove it: in this repository's own Node, 19.99 * 100
    // is 1998.9999999999998 and 8.20 * 100 is 819.9999999999999, and both
    // truncate to a paisa less than the seller asked for.
    expect(importedRupeesToPaise('19.99')).toBe(1999);
    expect(importedRupeesToPaise('8.20')).toBe(820);
    expect(importedRupeesToPaise('8.2')).toBe(820);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE BOUND — refused whole, never trimmed', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('refuses a file over the bound instead of importing the first part of it', async () => {
    const sc = await seller('oversized');
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => row({ title: `Item ${i}` }));

    await expect(startImport(db, sc.ctx, { filename: 'big.csv', rows }))
      .rejects.toMatchObject({ code: 'too_many_rows' });

    // AND NOTHING WAS STORED. A partial import that reported a refusal would be
    // the worst of both — a refusal message over a half-loaded file.
    expect(await myImports(db, sc.principal)).toHaveLength(0);
  });

  it('says in words that the bound refuses rather than truncates', () => {
    expect(IMPORT_ROW_BOUND_NOTE).toMatch(/refused whole rather than trimmed/i);
  });

  it('refuses an empty file, and a payload that is not rows at all', async () => {
    const sc = await seller('empty-file');
    await expect(startImport(db, sc.ctx, { filename: 'empty.csv', rows: [] }))
      .rejects.toMatchObject({ code: 'no_rows' });
    await expect(startImport(db, sc.ctx, { rows: 'title,price' as any }))
      .rejects.toMatchObject({ code: 'bad_rows' });
    await expect(startImport(db, sc.ctx, { rows: ['not an object'] as any }))
      .rejects.toMatchObject({ code: 'bad_rows' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE RAW ROW IS EVIDENCE', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('stores the row exactly as uploaded and never normalises it in place', async () => {
    const sc = await seller('verbatim');
    const messy = {
      '  Product Name ': '  Karate-Gi 170CM White  ',
      'PRICE (INR)': ' ₹1,799.00 ',
      'Category': 'karate-gi',
      'Notes': 'a column nothing reads',
    };
    const imp = await startImport(db, sc.ctx, { filename: 'messy.csv', rows: [messy] });

    const before = (await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId)))[0];
    expect(before.raw).toEqual(messy);

    await validateImport(db, sc.ctx, imp.importId);

    const after = (await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId)))[0];
    // UNCHANGED, key for key and character for character. When a seller says
    // "I typed 1,799 and it listed at ₹17.99" the only thing that can settle it
    // is what they uploaded, and normalising over the top destroys the only
    // copy of it.
    //
    // Asserted as value-identity over the same key SET rather than by comparing
    // serialised text: `raw` is a jsonb column and Postgres does not preserve
    // the key order of a jsonb object. That is a fact about the storage type,
    // not a change to the row — the untrimmed header "  Product Name " and its
    // untrimmed value are both still there, which is the property that matters.
    expect(after.raw).toEqual(messy);
    expect(Object.keys(after.raw).sort()).toEqual(Object.keys(messy).sort());
    expect(after.raw['  Product Name ']).toBe('  Karate-Gi 170CM White  ');
    // The meaning went somewhere else entirely.
    expect(after.resolved.priceMinor).toBe(179900);
    expect(after.resolved.title).toBe('Karate-Gi 170CM White');
    expect(after.status).toBe('valid');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('VALIDATION — what it refuses, and whose words it refuses in', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a PROHIBITED category fails the row with the policy’s own reason', async () => {
    const sc = await seller('prohibited-cat');
    // The federation prohibits a category. Nothing in this test file decides
    // that; the taxonomy ships with nothing prohibited, and this is MMAKF's act.
    const weapons = await categoryBySlug(db, 'weapons');
    await db.update(s.marketplaceCategories)
      .set({ policy: 'prohibited', policyReason: 'Not permitted in this jurisdiction.' })
      .where(eq(s.marketplaceCategories.id, weapons.id));

    const imp = await startImport(db, sc.ctx, {
      filename: 'w.csv', rows: [row({ title: 'Training bo staff', category: 'weapons' })],
    });
    const result = await validateImport(db, sc.ctx, imp.importId);
    expect(result.errorCount).toBe(1);
    expect(result.validCount).toBe(0);

    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    // THE POLICY ENGINE'S OWN SENTENCE, carried through verbatim. A bulk path
    // with its own wording is a bulk path where the seller and the federation
    // office are reading two different rules.
    expect(r.errors.join(' ')).toMatch(/prohibited on this marketplace/i);
    expect(r.errors.join(' ')).toMatch(/Not permitted in this jurisdiction/);

    // Put it back so the rest of the suite sees the taxonomy as adopted.
    await db.update(s.marketplaceCategories)
      .set({ policy: 'requires_review', policyReason: null })
      .where(eq(s.marketplaceCategories.id, weapons.id));
  });

  it('policy is inherited — a prohibited PARENT fails a row filed under its child', async () => {
    // The brief's own bypass: a seller evading a prohibition by picking a
    // different category. The import path must not be the way round it.
    const sc = await seller('inherited-prohibition');
    const parent = await categoryBySlug(db, 'protective-equipment');
    await db.update(s.marketplaceCategories).set({ policy: 'prohibited', policyReason: 'Under review.' })
      .where(eq(s.marketplaceCategories.id, parent.id));

    const imp = await startImport(db, sc.ctx, {
      filename: 'h.csv', rows: [row({ title: 'Headguard', category: 'headgear' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toMatch(/protective-equipment/);

    await db.update(s.marketplaceCategories).set({ policy: 'requires_review', policyReason: null })
      .where(eq(s.marketplaceCategories.id, parent.id));
  });

  it('a brand the seller holds no VERIFIED authorisation for fails the row', async () => {
    const sc = await seller('unauthorised-brand');
    const [brand] = await db.insert(s.brands).values({
      slug: 'import-protected-brand', name: 'Import Protected Brand',
      status: 'restricted', requiresAuthorisation: true,
    }).returning();

    const imp = await startImport(db, sc.ctx, {
      filename: 'b.csv', rows: [row({ brand: 'Import Protected Brand' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    let [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toMatch(/verified authorisation/i);

    // A CLAIM IS NOT AN AUTHORISATION. Claiming it changes nothing.
    await db.insert(s.brandAuthorisations).values({
      brandId: brand.id, sellerId: sc.sellerId, relationship: 'distributor', status: 'claimed',
    });
    const again = await startImport(db, sc.ctx, {
      filename: 'b2.csv', rows: [row({ title: 'Second attempt', brand: 'Import Protected Brand' })],
    });
    await validateImport(db, sc.ctx, again.importId);
    [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, again.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toMatch(/verified authorisation/i);
  });

  it('a brand that is not in the register is an error, not a silently blank field', async () => {
    // Dropping it would list the item with no brand at all — which is exactly
    // how "Adidas" ends up in a title while every authorisation check that
    // hangs off the brand column sees nothing.
    const sc = await seller('unknown-brand');
    const imp = await startImport(db, sc.ctx, {
      filename: 'u.csv', rows: [row({ brand: 'A Brand Nobody Registered' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toMatch(/not in the federation brand register/i);
  });

  it('a category that requires a safety classification refuses a row without one', async () => {
    const sc = await seller('unsafe-row');
    const imp = await startImport(db, sc.ctx, {
      filename: 'g.csv', rows: [row({ title: 'Sparring gloves', category: 'gloves' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors.join(' ')).toMatch(/safety classification/i);
  });

  it('an UNSTATED minimum age is not a statement that the item suits everyone', async () => {
    const sc = await seller('ageless');
    const imp = await startImport(db, sc.ctx, {
      filename: 'hg.csv',
      rows: [row({ title: 'Head guard', category: 'headgear', safety_classification: 'WKF approved' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.errors.join(' ')).toMatch(/minimum age/i);

    // Stated, and it passes.
    const ok = await startImport(db, sc.ctx, {
      filename: 'hg2.csv',
      rows: [row({
        title: 'Head guard youth', category: 'headgear',
        safety_classification: 'WKF approved', age_min_years: '8',
      })],
    });
    const result = await validateImport(db, sc.ctx, ok.importId);
    expect(result.validCount).toBe(1);
  });

  it('refuses a price that is not one, and a bad price does not stop the other rows', async () => {
    const sc = await seller('mixed-prices');
    const imp = await startImport(db, sc.ctx, {
      filename: 'p.csv',
      rows: [
        row({ title: 'Good one', price: '1799.50' }),
        row({ title: 'Third decimal', price: '450.555' }),
        row({ title: 'Words', price: 'call us' }),
        row({ title: 'Missing', price: '' }),
      ],
    });
    const result = await validateImport(db, sc.ctx, imp.importId);
    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(3);

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId))
      .orderBy(asc(s.productImportRows.rowNo));
    expect(rows[0].resolved.priceMinor).toBe(179950);
    // EVERY row is checked. A validator that threw on the first fault would
    // report one problem in a file with three, four times over.
    expect(rows.map((r: any) => r.status)).toEqual(['valid', 'invalid', 'invalid', 'invalid']);
  });

  it('an unknown category slug names itself in the refusal', async () => {
    const sc = await seller('bad-slug');
    const imp = await startImport(db, sc.ctx, {
      filename: 'c.csv', rows: [row({ category: 'nunchaku-and-such' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.errors.join(' ')).toMatch(/nunchaku-and-such/);
  });

  it('a category with no public-section mapping is refused rather than guessed at', async () => {
    // `listings.category` is NOT NULL and is the axis the public shop filters
    // on. Guessing 'equipment' would file somebody's books under equipment for
    // ever, on a decision this code made and nobody recorded.
    const sc = await seller('unmapped');
    await db.insert(s.marketplaceCategories).values({
      slug: 'unmapped-thing', name: 'Unmapped thing', path: 'unmapped-thing',
      depth: 0, legacyCategory: null, policy: 'requires_review',
    });
    const imp = await startImport(db, sc.ctx, {
      filename: 'x.csv', rows: [row({ category: 'unmapped-thing' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
    expect(r.errors).toContain(LEGACY_AXIS_UNMAPPED);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DUPLICATES — the seller’s own catalogue, and the file itself', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('matches an existing listing by sellerSku first, then by normalised title', async () => {
    const sc = await seller('dupes');
    const existing = await createListing(db, sc.ctx, {
      title: 'Karate-Gi 170cm (White)', category: 'uniform', priceMinor: 179900,
    });
    await addVariant(db, sc.ctx, existing.listingId, {
      label: 'Standard', priceMinor: 179900, sellerSku: 'GI-170-W',
    });

    const imp = await startImport(db, sc.ctx, {
      filename: 'd.csv',
      rows: [
        row({ title: 'Something else entirely', sku: 'GI-170-W' }),
        row({ title: 'karate gi 170cm white' }),
        row({ title: 'A genuinely new product', sku: 'GI-190-W' }),
      ],
    });
    const result = await validateImport(db, sc.ctx, imp.importId);
    expect(result.duplicateCount).toBe(2);
    expect(result.validCount).toBe(1);

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId))
      .orderBy(asc(s.productImportRows.rowNo));
    expect(rows[0].status).toBe('duplicate');
    expect(rows[0].resolved.duplicateOf.matchedOn).toBe('sellerSku');
    expect(rows[0].duplicateOfListingId).toBe(existing.listingId);
    expect(rows[1].status).toBe('duplicate');
    expect(rows[1].resolved.duplicateOf.matchedOn).toBe('title');
    expect(rows[2].status).toBe('valid');
  });

  it('catches a SKU repeated inside the same file', async () => {
    // Without this the second row reaches the (seller_id, seller_sku) unique
    // index at submit time and fails with a database error the seller cannot
    // read — on row 900, after 899 drafts already exist.
    const sc = await seller('self-dupes');
    const imp = await startImport(db, sc.ctx, {
      filename: 'sd.csv',
      rows: [
        row({ title: 'First', sku: 'SAME-SKU' }),
        row({ title: 'Second', sku: 'SAME-SKU' }),
      ],
    });
    const result = await validateImport(db, sc.ctx, imp.importId);
    expect(result.validCount).toBe(1);
    expect(result.duplicateCount).toBe(1);

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId))
      .orderBy(asc(s.productImportRows.rowNo));
    expect(rows[1].resolved.duplicateOf.rowNo).toBe(1);
  });

  it('a duplicate that is ALSO invalid is reported as invalid', async () => {
    // The faults are what the seller has to fix; 'duplicate' reads as "nothing
    // to do here" and would hide them.
    const sc = await seller('both-wrong');
    const existing = await createListing(db, sc.ctx, {
      title: 'A repeated title', category: 'equipment', priceMinor: 100000,
    });
    expect(existing.status).toBe('draft');
    const imp = await startImport(db, sc.ctx, {
      filename: 'bw.csv', rows: [row({ title: 'A repeated title', price: 'nonsense' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('invalid');
  });

  it('normalisedTitle folds punctuation and case, and nothing else', () => {
    expect(normalisedTitle('Karate-Gi 170cm (White)')).toBe('karate gi 170cm white');
    expect(normalisedTitle('karate gi 170cm white')).toBe('karate gi 170cm white');
    // Two genuinely different products stay different.
    expect(normalisedTitle('Belt, black')).not.toBe(normalisedTitle('Belt, brown'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SUBMISSION — drafts, and only drafts', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('creates DRAFT listings that nothing has approved or published', async () => {
    const sc = await seller('submitter');
    const imp = await startImport(db, sc.ctx, {
      filename: 's.csv',
      rows: [
        row({ title: 'Gi one', sku: 'S-1', price: '1799' }),
        row({ title: 'Gi two', sku: 'S-2', price: '2499.50', variant: '190cm', weight_grams: '1400' }),
      ],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const out = await submitImport(db, sc.ctx, imp.importId);
    expect(out.createdDrafts).toBe(2);
    expect(out.skipped).toBe(0);

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId))
      .orderBy(asc(s.productImportRows.rowNo));
    const listingIds = rows.map((r: any) => r.listingId);
    expect(listingIds.every((id: number) => Number.isInteger(id))).toBe(true);

    const listings = await db.select().from(s.listings)
      .where(eq(s.listings.sellerId, sc.sellerId));
    // THE WHOLE POINT. Not approved, not submitted, not published — draft, with
    // no approved content hash, which is two independent reasons the public
    // predicate cannot see them.
    expect(listings.every((l: any) => l.status === 'draft')).toBe(true);
    expect(listings.every((l: any) => l.approvedContentHash === null)).toBe(true);

    // One variant each, priced in integer paise from the grammar.
    const variants = await db.select().from(s.listingVariants)
      .where(eq(s.listingVariants.sellerId, sc.sellerId))
      .orderBy(asc(s.listingVariants.id));
    expect(variants).toHaveLength(2);
    expect(variants[1].priceMinor).toBe(249950);
    expect(variants[1].label).toBe('190cm');
    expect(variants[1].weightGrams).toBe(1400);
    expect(variants[0].sellerSku).toBe('S-1');
    // An unlabelled row takes the product's own title rather than an invented
    // "Standard": with one variant there is nothing to choose between.
    expect(variants[0].label).toBe('Gi one');
  });

  it('the import itself never says "published", because nothing was', async () => {
    const sc = await seller('never-published');
    const imp = await startImport(db, sc.ctx, { filename: 'np.csv', rows: [row({ sku: 'NP-1' })] });
    await validateImport(db, sc.ctx, imp.importId);
    await submitImport(db, sc.ctx, imp.importId);

    const [record] = await db.select().from(s.productImports)
      .where(eq(s.productImports.id, imp.importId));
    // 'published' and 'partially_published' exist in the enum and are not used.
    // A status column reading 'published' over a shelf of unreviewed drafts is
    // a lie an operator would quote back to somebody.
    expect(record.status).toBe('submitted');
    expect(record.publishedCount).toBe(0);
    expect(String(record.report.publishedNote)).toMatch(/Nothing in this import was published/i);
  });

  it('records an invalid row as SKIPPED with its reason — never drops it', async () => {
    const sc = await seller('partial');
    const imp = await startImport(db, sc.ctx, {
      filename: 'pp.csv',
      rows: [
        row({ title: 'Fine', sku: 'P-OK' }),
        row({ title: 'Broken', price: 'ask us' }),
      ],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const out = await submitImport(db, sc.ctx, imp.importId);
    expect(out.createdDrafts).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.skippedReasons[0].rowNo).toBe(2);

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId))
      .orderBy(asc(s.productImportRows.rowNo));
    // STILL THERE, with its raw payload and its findings. A dropped row is a
    // product the seller believes they imported.
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe('skipped');
    expect(rows[1].raw).toBeTruthy();
    expect(rows[1].listingId).toBeNull();
  });

  it('refuses to submit an import that has not been validated', async () => {
    const sc = await seller('unvalidated');
    const imp = await startImport(db, sc.ctx, { filename: 'nv.csv', rows: [row({ sku: 'NV-1' })] });
    await expect(submitImport(db, sc.ctx, imp.importId))
      .rejects.toMatchObject({ code: 'not_validated' });
    // And nothing was created by the attempt.
    const listings = await db.select().from(s.listings).where(eq(s.listings.sellerId, sc.sellerId));
    expect(listings).toHaveLength(0);
  });

  it('refuses to submit the same import twice', async () => {
    const sc = await seller('twice');
    const imp = await startImport(db, sc.ctx, { filename: 't.csv', rows: [row({ sku: 'T-1' })] });
    await validateImport(db, sc.ctx, imp.importId);
    await submitImport(db, sc.ctx, imp.importId);
    await expect(submitImport(db, sc.ctx, imp.importId))
      .rejects.toMatchObject({ code: 'already_submitted' });
    const listings = await db.select().from(s.listings).where(eq(s.listings.sellerId, sc.sellerId));
    expect(listings).toHaveLength(1);
  });

  it('refuses to re-validate a submitted import', async () => {
    const sc = await seller('revalidate');
    const imp = await startImport(db, sc.ctx, { filename: 'rv.csv', rows: [row({ sku: 'RV-1' })] });
    await validateImport(db, sc.ctx, imp.importId);
    await submitImport(db, sc.ctx, imp.importId);
    await expect(validateImport(db, sc.ctx, imp.importId))
      .rejects.toMatchObject({ code: 'already_submitted' });
  });

  it('the drafts carry the product detail the policy engine checked', async () => {
    const sc = await seller('detail-carrier');
    const imp = await startImport(db, sc.ctx, {
      filename: 'dc.csv',
      rows: [row({
        title: 'Certified shin guards', category: 'shin-protection', sku: 'SG-1',
        safety_classification: 'WKF approved', certification: 'CE EN 13277',
        country_of_origin: 'India', materials: 'EVA foam',
      })],
    });
    const result = await validateImport(db, sc.ctx, imp.importId);
    expect(result.validCount).toBe(1);
    await submitImport(db, sc.ctx, imp.importId);

    const [listing] = await db.select().from(s.listings).where(eq(s.listings.sellerId, sc.sellerId));
    const shin = await categoryBySlug(db, 'shin-protection');
    expect(listing.categoryId).toBe(shin.id);
    expect(listing.safetyClassification).toBe('WKF approved');
    expect(listing.certification).toBe('CE EN 13277');
    // The claim a reviewer must see is ON the listing, not only in the import
    // row — otherwise the reviewer approves an item whose safety claim lives in
    // a table they have never opened.
    expect(listing.category).toBe('equipment');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('STOCK IS NOT IMPORTED, AND SAYS SO (§70)', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('warns by name about a stock column rather than silently ignoring it', async () => {
    // Stock is received into a named LOCATION with a movement behind it. An
    // import has no location to name, and picking one would invent a fact about
    // where physical goods are. So the column is reported, never applied.
    const sc = await seller('stocked');
    const imp = await startImport(db, sc.ctx, {
      filename: 'st.csv', rows: [row({ sku: 'ST-1', quantity: '25' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('valid');
    expect(r.resolved.warnings.join(' ')).toMatch(/25/);
    expect(r.resolved.warnings.join(' ')).toMatch(/Stock is not imported/i);

    await submitImport(db, sc.ctx, imp.importId);
    const [listing] = await db.select().from(s.listings).where(eq(s.listings.sellerId, sc.sellerId));
    // AND IT REALLY IS NOT APPLIED. A page that said "imported" over a product
    // that then read as in stock would be the fake feature §70 forbids.
    expect(listing.stockQty).toBe(0);
  });

  it('the documented template has no stock column at all', () => {
    // The absent control, not a disabled one.
    expect(IMPORT_TEMPLATE_COLUMNS.some((c) => /stock|qty|quantity/i.test(c.header))).toBe(false);
    expect(IMPORT_STOCK_NOT_TAKEN).toMatch(/not imported/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SELLER ISOLATION — “not yours” and “does not exist” are one answer', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('one seller cannot read, validate, submit or cancel another’s import', async () => {
    const owner = await seller('import-owner');
    const other = await seller('import-interloper');
    const imp = await startImport(db, owner.ctx, { filename: 'o.csv', rows: [row({ sku: 'O-1' })] });

    for (const act of [
      () => importPreview(db, other.principal, imp.importId),
      () => validateImport(db, other.ctx, imp.importId),
      () => submitImport(db, other.ctx, imp.importId),
      () => cancelImport(db, other.ctx, imp.importId, 'taking it'),
    ]) {
      await expect(act()).rejects.toMatchObject({ code: 'not_your_import' });
    }

    // An id that was never issued gives the SAME code and the SAME sentence.
    // Distinguishing them tells an attacker which small integers are real.
    const missing = await importPreview(db, other.principal, 999_999).catch((e: any) => e);
    const theirs = await importPreview(db, other.principal, imp.importId).catch((e: any) => e);
    expect(missing.code).toBe(theirs.code);
    expect(missing.message).toBe(theirs.message);

    // And it does not appear in their list.
    const mine = await myImports(db, other.principal);
    expect(mine.every((i: any) => i.id !== imp.importId)).toBe(true);
  });

  it('the interloper’s failed attempts left the owner’s import untouched', async () => {
    const owner = await seller('untouched');
    const other = await seller('untouched-other');
    const imp = await startImport(db, owner.ctx, { filename: 'ut.csv', rows: [row({ sku: 'UT-1' })] });
    await expect(validateImport(db, other.ctx, imp.importId)).rejects.toThrow();

    const [record] = await db.select().from(s.productImports).where(eq(s.productImports.id, imp.importId));
    expect(record.status).toBe('uploaded');
    const [r] = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    expect(r.status).toBe('pending');
  });

  it('duplicate detection cannot be used to probe another seller’s SKUs', async () => {
    // The duplicate query is filtered on the seller resolved from the session.
    // If it were not, uploading a file of guessed SKUs would report which of
    // them exist anywhere on the marketplace.
    const a = await seller('sku-holder');
    const b = await seller('sku-prober');
    const l = await createListing(db, a.ctx, { title: 'A private product', category: 'equipment', priceMinor: 100000 });
    await addVariant(db, a.ctx, l.listingId, { label: 'Standard', priceMinor: 100000, sellerSku: 'SECRET-SKU' });

    const imp = await startImport(db, b.ctx, {
      filename: 'probe.csv', rows: [row({ title: 'Probe', sku: 'SECRET-SKU' })],
    });
    const result = await validateImport(db, b.ctx, imp.importId);
    expect(result.duplicateCount).toBe(0);
    expect(result.validCount).toBe(1);
  });

  it('the federation view is scope-checked, and a seller cannot reach it', async () => {
    const sc = await seller('federation-view');
    await startImport(db, sc.ctx, { filename: 'fv.csv', rows: [row({ sku: 'FV-1' })] });
    expect(await importsForSeller(db, national(), sc.sellerId)).toHaveLength(1);
    await expect(importsForSeller(db, sc.principal, sc.sellerId)).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CANCELLING — a status transition, with a reason, deleting nothing', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('requires a reason', async () => {
    const sc = await seller('unexplained');
    const imp = await startImport(db, sc.ctx, { filename: 'ux.csv', rows: [row({ sku: 'UX-1' })] });
    await expect(cancelImport(db, sc.ctx, imp.importId, '   '))
      .rejects.toMatchObject({ code: 'reason_required' });
  });

  it('keeps every row, with its raw payload and its findings', async () => {
    const sc = await seller('canceller');
    const imp = await startImport(db, sc.ctx, {
      filename: 'cx.csv', rows: [row({ sku: 'CX-1' }), row({ title: 'Bad', price: 'x' })],
    });
    await validateImport(db, sc.ctx, imp.importId);
    await cancelImport(db, sc.ctx, imp.importId, 'Wrong price list — re-exporting.');

    const [record] = await db.select().from(s.productImports).where(eq(s.productImports.id, imp.importId));
    expect(record.status).toBe('cancelled');
    expect(record.failureReason).toBe('Wrong price list — re-exporting.');

    const rows = await db.select().from(s.productImportRows)
      .where(eq(s.productImportRows.importId, imp.importId));
    // NOTHING IS DELETED. A cancelled import is the evidence for "I uploaded
    // that file and nothing appeared".
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.raw)).toBe(true);

    await expect(submitImport(db, sc.ctx, imp.importId))
      .rejects.toMatchObject({ code: 'import_cancelled' });
    await expect(cancelImport(db, sc.ctx, imp.importId, 'again'))
      .rejects.toMatchObject({ code: 'already_cancelled' });
  });

  it('refuses to cancel an import that has already made drafts, and says why', async () => {
    // Cancelling would not un-create them; it would only make the record
    // disagree with the catalogue.
    const sc = await seller('too-late');
    const imp = await startImport(db, sc.ctx, { filename: 'tl.csv', rows: [row({ sku: 'TL-1' })] });
    await validateImport(db, sc.ctx, imp.importId);
    await submitImport(db, sc.ctx, imp.importId);

    const err = await cancelImport(db, sc.ctx, imp.importId, 'changed my mind').catch((e: any) => e);
    expect(err.code).toBe('already_submitted');
    expect(err.message).toMatch(/would not remove them/i);

    const listings = await db.select().from(s.listings).where(eq(s.listings.sellerId, sc.sellerId));
    expect(listings).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE PREVIEW — per-row faults, before anything is created', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('reports counts AND the rows, so a seller knows WHICH row is wrong', async () => {
    const sc = await seller('previewer');
    const imp = await startImport(db, sc.ctx, {
      filename: 'pv.csv',
      rows: [row({ title: 'Good', sku: 'PV-1' }), row({ title: 'Bad', price: 'later' })],
    });
    await validateImport(db, sc.ctx, imp.importId);

    const preview = await importPreview(db, sc.principal, imp.importId);
    expect(preview.status).toBe('preview');
    expect(preview.validCount).toBe(1);
    expect(preview.errorCount).toBe(1);
    expect(preview.byStatus.valid).toBe(1);
    expect(preview.byStatus.invalid).toBe(1);
    // "412 rows, 38 errors" tells a seller they have a problem and not which
    // rows have it, so they open the spreadsheet and guess.
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[1].errors.length).toBeGreaterThan(0);
    expect(preview.stockNote).toBe(IMPORT_STOCK_NOT_TAKEN);
  });

  it('an unapproved seller cannot start an import at all', async () => {
    const r = await registerAccount(db, { email: `waiting-${++seq}@example.in`, password: PW });
    const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
    await applyToSell(db, ctxOf(principal), { tradingName: 'Waiting Supplies', stateUnitId: JH });
    await expect(startImport(db, ctxOf(principal), { filename: 'w.csv', rows: [row()] }))
      .rejects.toMatchObject({ code: 'seller_not_approved' });
  });

  it('an account with no seller record is refused before anything is read', async () => {
    const r = await registerAccount(db, { email: `nobody-${++seq}@example.in`, password: PW });
    const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
    await expect(startImport(db, ctxOf(principal), { filename: 'n.csv', rows: [row()] }))
      .rejects.toMatchObject({ code: 'not_a_seller' });
  });
});
