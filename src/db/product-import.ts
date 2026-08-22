// Bulk product import — a staging pipeline, and deliberately not a shortcut.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE INSTRUCTION THIS MODULE EXISTS TO KEEP
// ═════════════════════════════════════════════════════════════════════════════
//
//     "NEVER DIRECTLY IMPORT INTO PRODUCTION CATALOGUE."
//
// It is quoted in src/db/catalogue.schema.ts above `product_imports`, and it is
// the only reason those two tables exist rather than a loop that inserts
// listings. Five hundred rows of a spreadsheet are five hundred unreviewed
// claims — about certification, about age suitability, about who authorised the
// brand on the label — and the difference between "staged" and "live" is the
// difference between a queue a human works through and a marketplace that
// published whatever a seller uploaded at 2am.
//
// So a row lands in `product_import_rows`, it is validated THERE, and a listing
// is created only when the seller submits the import — as a DRAFT, which then
// goes through exactly the same two gates as a hand-typed listing. Nothing in
// this file approves anything, publishes anything, or writes a status the
// public predicate can see.
//
// THE ALTERNATIVE THAT LOOKS EQUIVALENT AND IS NOT: writing the listings
// straight away and marking them pending. That puts hundreds of unexamined rows
// into the very table `publicListingPredicate()` reads from, and leaves the
// whole marketplace one forgotten predicate — one `or` in the wrong place
// during a future refactor — away from publishing them. Staging rows in a table
// the shop has never heard of cannot fail that way.
//
// ═════════════════════════════════════════════════════════════════════════════
// FIVE ACTS, NOT ONE
// ═════════════════════════════════════════════════════════════════════════════
//
//   startImport()     the file arrives. Rows are stored VERBATIM.
//   validateImport()  meaning is checked. `raw` is never touched.
//   importPreview()   the seller reads what will happen before it happens.
//   submitImport()    drafts are created, and only drafts.
//   cancelImport()    the import stops, with a reason. Nothing is deleted.
//
// They are separate exported functions and separate audit rows because they are
// separate decisions by a person. A single `import()` that parsed, validated
// and created in one call would give the seller no moment at which to read the
// errors — and a seller who cannot see the errors submits anyway.
//
// WHY `raw` IS NEVER NORMALISED IN PLACE. When a seller says "I typed 1,799 and
// it listed at ₹17.99", the only thing that can settle it is the bytes they
// uploaded. Normalising over the top loses the evidence and leaves the argument
// unresolvable, so validation writes `resolved` alongside and `raw` stays as it
// arrived, for as long as the import row exists.

import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, allocateFederationId, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError, createListing } from '@/db/marketplace';
import { addVariant, checkListingAgainstPolicy } from '@/db/catalogue';
import { ownSellerRecord } from '@/db/seller-orders';

type DB = any;

// ─── Bounds and the things this module refuses to decide ────────────────────

/**
 * The largest file this pipeline will accept, in rows.
 *
 * WHY A BOUND EXISTS AT ALL. Every row costs a `product_import_rows` insert, a
 * category-ancestry walk, a duplicate query and — on submit — a listing, a
 * variant, a content hash and two audit rows. Unbounded, one paste of a
 * hundred-thousand-line export from another marketplace holds a connection for
 * minutes, and it does it on the same pool the checkout path uses. The seller
 * gets a timeout; a buyer somewhere else gets a failed payment.
 *
 * WHAT HAPPENS AT THE BOUND, WHICH MATTERS MORE THAN THE NUMBER: the import is
 * REFUSED, whole, with the count it saw and the count it accepts. It is not
 * truncated. A truncating import reports "imported everything" about the first
 * two thousand rows of a three-thousand-row file, and the eight hundredth
 * missing product is discovered by a buyer who cannot find it — months later,
 * with no record that anything was dropped. Refusing costs the seller one
 * split of a spreadsheet. Truncating costs them a catalogue they believe is
 * complete and is not.
 *
 * This is an ENGINEERING bound, not a federation decision: it says what this
 * server can do in one request, not what MMAKF permits a seller to sell. If
 * MMAKF ever publishes a catalogue-size rule it belongs somewhere a seller can
 * be shown it, not here.
 */
export const MAX_IMPORT_ROWS = 2000;

export const IMPORT_ROW_BOUND_NOTE =
  `A single import carries at most ${MAX_IMPORT_ROWS} rows. A larger file is refused ` +
  'whole rather than trimmed to fit — an import that silently kept the first ' +
  `${MAX_IMPORT_ROWS} rows would report success over the products it dropped, and nobody ` +
  'would find out until a buyer went looking for one of them.';

/**
 * Stock is NOT imported, and this is the sentence that says so.
 *
 * §70, the rule against a fake feature. A `stock` or `quantity` column in a
 * seller's spreadsheet is the most natural thing in the world to expect this
 * pipeline to honour, and it cannot: stock in this system is not a number on a
 * product, it is a quantity RECEIVED INTO A NAMED LOCATION with a movement in
 * the ledger behind it (src/db/inventory.ts). An import has no location to
 * name, and picking one — "their first warehouse" — would invent a fact about
 * where physical goods are.
 *
 * So the column is not quietly dropped. Every row that carries one is warned
 * about it by name, the seller is told on the page, and the template this
 * pipeline documents has no stock column in it at all. Seeing "imported" and
 * then finding every product out of stock is the outcome this prevents.
 */
export const IMPORT_STOCK_NOT_TAKEN =
  'Stock is not imported. Stock in this system is received into a named location ' +
  'with a movement recorded against it, and an import has no location to name. ' +
  'Any stock column in your file is read and reported, never applied — receive ' +
  'stock against each product after the drafts are created.';

/**
 * A category MMAKF has added to the taxonomy without saying which of the four
 * public axes it rolls up to.
 *
 * `listings.category` is the coarse enum the public shop filters on and it is
 * NOT NULL, so a listing cannot be created without one. `marketplace_categories
 * .legacyCategory` is where that mapping lives and it is nullable. When it is
 * null there is no honest answer available to this module: guessing 'equipment'
 * would file somebody's books under equipment for ever, on a decision this file
 * made and nobody recorded.
 */
export const LEGACY_AXIS_UNMAPPED =
  'This category has not been mapped to one of the federation\'s four public ' +
  'sections (uniform, accessories, equipment, merch), so an import cannot decide ' +
  'which section the item belongs in. Ask the federation office to map the ' +
  'category, or file these rows under one that is mapped.';

// ─── The price grammar ──────────────────────────────────────────────────────

/**
 * Rupees, as a seller types them into a spreadsheet cell, to integer paise.
 *
 * ─── WHY A SECOND COPY OF THIS EXISTS, AND WHAT KEEPS IT HONEST ─────────────
 *
 * `rupeesToPaise()` in src/pages/api/marketplace/[...action].ts is the one
 * rupee→paise conversion in the seller surface, and it stays that way for
 * everything a form posts. It cannot serve here: this conversion does not
 * happen when a request arrives, it happens later, inside validateImport(),
 * against rows already stored in the database — and a `src/db` module importing
 * an API route would be a cycle through every module that route imports.
 *
 * So the GRAMMAR is reproduced, exactly, with the same discipline
 * src/db/shipping.ts applies to its copy of applyFactor():
 *
 *   IT MUST STAY IDENTICAL, character for character in behaviour.
 *   tests/marketplace-import.test.ts asserts it agrees with the route's
 *   rupeesToPaise() across a corpus of prices, typos and hostile inputs, so a
 *   drift between the two is a failing test rather than a shop full of items
 *   priced a paisa away from what the seller asked for.
 *
 * ─── AND WHY IT NEVER MULTIPLIES BY A HUNDRED ───────────────────────────────
 *
 * Because `19.99 * 100` is 1998.9999999999998 in this repository's own Node,
 * and `8.20 * 100` is 819.9999999999999, and both truncate to a paisa less than
 * the seller asked for. The rupees and the paise are taken out of the decimal
 * text as DIGITS and read once as a single integer, so no arithmetic is ever
 * performed on a fractional value and the result is exact for every input this
 * accepts.
 *
 * IT REFUSES RATHER THAN ROUNDS. `450.555` is not a price in India — it is a
 * typo, or a machine sending the wrong units — and turning it into ₹450.56
 * hides which. Returns null; the row is marked invalid and the seller is shown
 * the cell.
 */
export function importedRupeesToPaise(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  const text = String(value).trim().replace(/[₹\s,]/g, '');
  if (text === '') return null;

  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;

  // '450' and '50' are joined as TEXT and read as one integer. Nothing scales
  // anything, so there is no rounding rule here to disagree with the route's.
  return Number(m[1] + (m[2] ?? '').padEnd(2, '0'));
}

// ─── The file's column vocabulary ───────────────────────────────────────────

/**
 * What a column may be called.
 *
 * A seller exporting from their own system does not produce this repository's
 * field names — they produce "Product Name", "PRICE (INR)", "Item Code". A
 * pipeline that accepted only exact names would be technically correct and
 * would be used by nobody, so headers are matched after being reduced to
 * letters and digits only.
 *
 * THE ALIAS LIST IS DELIBERATELY SHORT AND DELIBERATELY DULL. Every alias is a
 * guess about what a seller meant, and a wrong guess writes the wrong value
 * into a real price. 'mrp' is NOT an alias of price for exactly that reason: a
 * maximum retail price is a different figure from a selling price and treating
 * them as one would silently list stock at the wrong number.
 */
const COLUMNS = {
  title: ['title', 'name', 'productname', 'producttitle', 'itemname'],
  description: ['description', 'productdescription', 'details', 'longdescription'],
  category: ['category', 'categoryslug', 'marketplacecategory'],
  price: ['price', 'priceinr', 'pricerupees', 'sellingprice', 'rate'],
  sellerSku: ['sku', 'sellersku', 'yoursku', 'itemcode', 'productcode'],
  brand: ['brand', 'brandname', 'make'],
  variantLabel: ['variant', 'variantlabel', 'variantname'],
  weightGrams: ['weightgrams', 'weightg', 'weight'],
  gtin: ['gtin', 'ean', 'upc'],
  barcode: ['barcode'],
  certification: ['certification', 'certifications', 'certificate'],
  ageMinYears: ['ageminyears', 'minimumage', 'minage', 'agemin'],
  safetyClassification: ['safetyclassification', 'safetyclass', 'safetyrating'],
  countryOfOrigin: ['countryoforigin', 'origin', 'country'],
  materials: ['materials', 'material', 'fabric'],
  imageUrl: ['imageurl', 'image', 'photo', 'photourl', 'imagelink'],
  /** Read ONLY so it can be reported as not imported. See IMPORT_STOCK_NOT_TAKEN. */
  stock: ['stock', 'stockqty', 'quantity', 'qty', 'availablequantity', 'inventory'],
} as const;

export type ImportField = keyof typeof COLUMNS;

/**
 * The columns this pipeline documents, in the order the template lists them.
 * The page renders this; there is one list and not a second copy in markup.
 */
export const IMPORT_TEMPLATE_COLUMNS: { field: ImportField; header: string; required: boolean; note: string }[] = [
  { field: 'title', header: 'title', required: true, note: 'What the buyer reads. Required.' },
  { field: 'category', header: 'category', required: true, note: 'A category slug from the federation taxonomy, e.g. karate-gi.' },
  { field: 'price', header: 'price', required: true, note: 'Rupees. Digits and at most two decimals — 1799 or 1799.50.' },
  { field: 'sellerSku', header: 'sku', required: false, note: 'Your own code for the item. Used to recognise a product you already list.' },
  { field: 'variantLabel', header: 'variant', required: false, note: 'The size or option. One variant is created per row.' },
  { field: 'description', header: 'description', required: false, note: 'Free text.' },
  { field: 'brand', header: 'brand', required: false, note: 'Must already be in the federation brand register, and you must be authorised for it where it is restricted.' },
  { field: 'weightGrams', header: 'weight_grams', required: false, note: 'Whole grams. Used to quote carriage by weight.' },
  { field: 'gtin', header: 'gtin', required: false, note: 'EAN or UPC, if the product carries one.' },
  { field: 'certification', header: 'certification', required: false, note: 'Required by some categories. Stated as it appears on the certificate.' },
  { field: 'ageMinYears', header: 'age_min_years', required: false, note: 'Required by some categories. An unstated age is not a statement that the item suits everyone.' },
  { field: 'safetyClassification', header: 'safety_classification', required: false, note: 'Required by protective equipment.' },
  { field: 'countryOfOrigin', header: 'country_of_origin', required: false, note: 'Free text.' },
  { field: 'materials', header: 'materials', required: false, note: 'Free text.' },
  { field: 'imageUrl', header: 'image_url', required: false, note: 'One image URL. A listing may carry more; add them after the drafts exist.' },
];

const normaliseHeader = (h: unknown): string =>
  String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The value of one logical field in one raw row.
 *
 * FIRST MATCHING ALIAS WINS, in the order written above, and a row carrying two
 * spellings of the same field keeps both in `raw` — so if the choice was wrong
 * the evidence is still there to argue from.
 */
function pick(raw: Record<string, unknown>, field: ImportField): string {
  const aliases: readonly string[] = COLUMNS[field];
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = normaliseHeader(k);
    if (!index.has(key)) index.set(key, v);
  }
  for (const alias of aliases) {
    const v = index.get(alias);
    if (v === null || v === undefined) continue;
    const text = String(v).trim();
    if (text !== '') return text;
  }
  return '';
}

/**
 * A title reduced to the thing two listings would have to share to be the same
 * product: letters, digits and single spaces.
 *
 * "Karate-Gi 170cm (White)" and "karate gi 170cm white" are one product typed
 * twice, and a duplicate check that could not see that would let a seller list
 * the same gi eleven times by re-uploading a corrected file.
 */
export function normalisedTitle(title: unknown): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const optInt = (text: string): number | null => {
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

// ─── Stage 1: the file arrives ──────────────────────────────────────────────

export interface StartImportInput {
  filename?: string | null;
  /** Already-parsed objects — see the note on why the server does not parse CSV. */
  rows: Record<string, unknown>[];
}

/**
 * Take delivery of a file's rows. Store them, and decide nothing.
 *
 * ROWS ARRIVE ALREADY PARSED, as objects. The CSV itself is turned into rows in
 * the seller's browser and posted as JSON, and this module never sees a comma.
 * Two reasons, and the second is the one that matters:
 *
 *   · no dependency. A CSV parser worth trusting handles quoted commas,
 *     embedded newlines, BOMs and four encodings; a hand-rolled one on the
 *     server handles the first of those and mangles a product description
 *     containing a comma into two columns, in a place nobody would look.
 *   · the server's job here is to validate MEANING, not FORMAT. Whether a price
 *     is a price, whether a category exists, whether this seller may sell this
 *     brand — those are federation questions and they are answered here. Where
 *     the cell boundaries were is a question about a text file, and answering
 *     it in the same module would mix a parsing bug up with a policy one.
 *
 * NOTHING IS VALIDATED HERE, ON PURPOSE. The rows land as they arrived and the
 * import sits at 'uploaded'. Validation is a separate act because it is a
 * separate audit row and because a seller must be able to see that their file
 * was received even when every row in it is wrong.
 */
export async function startImport(db: DB, ctx: AuditContext, input: StartImportInput) {
  const seller = await ownSellerRecord(db, ctx.principal);
  if (seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `A seller must be approved by MMAKF before listing anything, in bulk or one at a time. This account is ${seller.status}.`
    );
  }

  const rows = Array.isArray(input?.rows) ? input.rows : null;
  if (!rows) {
    throw new MarketplaceError('bad_rows', 'An import needs a list of rows. Nothing has been recorded.');
  }
  if (!rows.length) {
    throw new MarketplaceError(
      'no_rows',
      'That file produced no rows. Check it has a header line and at least one product under it.'
    );
  }
  // THE BOUND. Refused whole — see MAX_IMPORT_ROWS for why this is not a trim.
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new MarketplaceError(
      'too_many_rows',
      `That file has ${rows.length} rows and one import carries at most ${MAX_IMPORT_ROWS}. ` +
      'It has been refused rather than trimmed to fit: an import that kept the first ' +
      `${MAX_IMPORT_ROWS} rows would tell you it succeeded and say nothing about the products it dropped. ` +
      'Split the file and upload it in parts.'
    );
  }
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new MarketplaceError('bad_rows', 'Every row must be an object of column name to cell value.');
    }
  }

  const ref = await allocateFederationId(db, 'IMP');
  const filename = String(input?.filename ?? '').trim() || null;

  const [imp] = await db.insert(s.productImports).values({
    sellerId: seller.id,
    ref,
    filename,
    // NO storageKey. The bytes of the file are not stored anywhere: object
    // storage is not configured on this deployment (see src/lib/uploads.ts) and
    // recording a key for a file nobody kept would be a pointer to nothing.
    status: 'uploaded',
    rowCount: rows.length,
    uploadedByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.productImports.id });

  // One insert for the whole file rather than one per row. Chunked because a
  // single statement with two thousand rows of jsonb parameters is where a
  // driver's parameter limit is discovered in production.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(s.productImportRows).values(
      rows.slice(i, i + CHUNK).map((raw, j) => ({
        importId: imp.id,
        rowNo: i + j + 1,
        // VERBATIM. Not trimmed, not lower-cased, not re-keyed. See the header
        // of this file for the argument this evidence has to settle.
        raw: raw as any,
        status: 'pending' as const,
      }))
    );
  }

  await writeAudit(db, ctx, {
    entityType: 'product_import', entityId: imp.id, action: 'create',
    newValue: { ref, sellerId: seller.id, filename, rowCount: rows.length },
  });

  return { importId: imp.id, ref, rowCount: rows.length, status: 'uploaded' as const };
}

// ─── Stage 2: validation ────────────────────────────────────────────────────

export interface RowResolution {
  title: string;
  description: string | null;
  categorySlug: string;
  categoryId: number | null;
  legacyCategory: string | null;
  /** INTEGER PAISE, from the grammar above. Never rupees, never a float. */
  priceMinor: number | null;
  sellerSku: string | null;
  brandName: string | null;
  brandId: number | null;
  variantLabel: string;
  weightGrams: number | null;
  gtin: string | null;
  barcode: string | null;
  certification: string | null;
  ageMinYears: number | null;
  safetyClassification: string | null;
  countryOfOrigin: string | null;
  materials: string | null;
  imageUrl: string | null;
  /** Things the seller must be told that do not stop the row. */
  warnings: string[];
  /** Policy notes a REVIEWER must satisfy themselves about after the draft exists. */
  reviewerMustConfirm: string[];
  duplicateOf: { listingId: number | null; rowNo: number | null; matchedOn: string } | null;
}

/**
 * Read every row's meaning, and write down what it turned out to be.
 *
 * ─── WHAT IS CHECKED, AND WHY IN THIS ORDER ─────────────────────────────────
 *
 *   1. required fields — a row with no title is not a product;
 *   2. the price grammar — the same rule the rest of the surface uses;
 *   3. the category, resolved by slug against the governed taxonomy;
 *   4. duplicates, against this seller's existing listings AND against earlier
 *      rows of this same file;
 *   5. PRODUCT POLICY, through checkListingAgainstPolicy() in src/db/catalogue.
 *
 * Step 5 is a CALL and not a re-implementation, and that is the single most
 * important line in this module. The policy engine walks the category ancestry
 * and takes the strictest value, unions the requirement flags, reads the
 * seller's own restricted categories, checks the brand register and checks for
 * a verified, unexpired brand authorisation. A bulk path with its own copy of
 * four of those five checks is a bulk path that becomes the way to get a
 * prohibited item onto the marketplace — and it would be the LAST place anybody
 * looked, because the single-listing path would still be correct.
 *
 * EVERY ROW IS CHECKED EVEN AFTER ONE FAILS, and every fault on a row is
 * collected rather than the first being thrown. A seller told one fault at a
 * time re-uploads five times and gives up on the fourth.
 *
 * `raw` IS NOT WRITTEN. Only `resolved`, `errors` and `status`.
 */
export async function validateImport(db: DB, ctx: AuditContext, importId: number) {
  const { seller, imp } = await ownImport(db, ctx.principal, importId);

  if (imp.status === 'submitted' || imp.status === 'published' || imp.status === 'partially_published') {
    throw new MarketplaceError(
      'already_submitted',
      'This import has already been submitted, so re-validating it would describe a file that has ' +
      'already become drafts. Start a new import if the file has changed.'
    );
  }
  if (imp.status === 'cancelled') {
    throw new MarketplaceError('import_cancelled', 'This import was cancelled. Start a new one.');
  }

  // Visible while it runs. If this throws halfway the import is left saying
  // 'validating', which is the truth — better a stuck import somebody can see
  // than one that quietly reports the counts from the last run.
  await db.update(s.productImports).set({ status: 'validating' }).where(eq(s.productImports.id, importId));

  const rows = await db.select().from(s.productImportRows)
    .where(eq(s.productImportRows.importId, importId))
    .orderBy(asc(s.productImportRows.rowNo));

  // ── Everything the whole file is checked against, read ONCE ──────────────
  //
  // Not once per row. Two thousand rows against a per-row category lookup is
  // two thousand round trips on a connection the checkout path shares.
  const categories = await db.select().from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.active, true));
  const bySlug = new Map<string, any>();
  for (const c of categories) bySlug.set(String(c.slug).toLowerCase(), c);

  const brands = await db.select().from(s.brands);
  const brandByName = new Map<string, any>();
  for (const b of brands) {
    brandByName.set(String(b.name).toLowerCase().trim(), b);
    brandByName.set(String(b.slug).toLowerCase().trim(), b);
  }

  // The seller's OWN listings, for duplicate detection. Filtered in SQL on the
  // seller resolved from the session; there is no sellerId parameter anywhere
  // near this, and a seller cannot be told whether another seller's SKU exists.
  const mine = await db.select({
    id: s.listings.id, ref: s.listings.ref, title: s.listings.title, status: s.listings.status,
  }).from(s.listings).where(eq(s.listings.sellerId, seller.id));

  const myTitles = new Map<string, any>();
  for (const l of mine) {
    const key = normalisedTitle(l.title);
    if (key && !myTitles.has(key)) myTitles.set(key, l);
  }

  const myVariants = await db.select({
    sellerSku: s.listingVariants.sellerSku, listingId: s.listingVariants.listingId,
  }).from(s.listingVariants).where(and(
    eq(s.listingVariants.sellerId, seller.id),
    ne(s.listingVariants.status, 'discontinued'),
  ));
  const mySkus = new Map<string, number>();
  for (const v of myVariants) {
    const key = String(v.sellerSku ?? '').trim().toLowerCase();
    if (key) mySkus.set(key, v.listingId);
  }

  // Rows already seen in THIS file. A file that lists the same SKU twice would
  // otherwise hit the (seller_id, seller_sku) unique index at submit time and
  // fail with a database error the seller cannot read — and it would fail on
  // row 900, after 899 drafts had been created.
  const seenSkus = new Map<string, number>();
  const seenTitles = new Map<string, number>();

  let validCount = 0, errorCount = 0, duplicateCount = 0;

  for (const row of rows) {
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const errors: string[] = [];
    const warnings: string[] = [];

    const title = pick(raw, 'title');
    const categorySlug = pick(raw, 'category');
    const priceText = pick(raw, 'price');
    const sellerSku = pick(raw, 'sellerSku');
    const brandName = pick(raw, 'brand');
    const stockText = pick(raw, 'stock');

    if (!title) errors.push('No title. A row with nothing in the title column is not a product.');
    if (!categorySlug) errors.push('No category. Name one of the federation taxonomy slugs.');

    // ── Price ────────────────────────────────────────────────────────────
    let priceMinor: number | null = null;
    if (!priceText) {
      errors.push('No price.');
    } else {
      priceMinor = importedRupeesToPaise(priceText);
      if (priceMinor === null) {
        errors.push(
          `"${priceText}" is not a price. Give rupees as digits with at most two decimals — ` +
          '1799 or 1799.50. It is refused rather than rounded, because a third decimal is a ' +
          'typo or the wrong units and rounding it hides which.'
        );
      }
    }

    // ── Category ─────────────────────────────────────────────────────────
    const category = categorySlug ? bySlug.get(categorySlug.toLowerCase()) ?? null : null;
    if (categorySlug && !category) {
      errors.push(
        `There is no active category with the slug "${categorySlug}". The taxonomy is governed by ` +
        'the federation; the slugs it currently carries are listed on the import page.'
      );
    }
    if (category && !category.legacyCategory) {
      errors.push(LEGACY_AXIS_UNMAPPED);
    }

    // ── Brand ────────────────────────────────────────────────────────────
    //
    // An unrecognised brand NAME is an error rather than a shrug. Dropping it
    // would list the item with no brand at all — which is precisely how a
    // seller gets "Adidas" into a title while the brand column, and every
    // authorisation check that hangs off it, sees nothing.
    let brand: any = null;
    if (brandName) {
      brand = brandByName.get(brandName.toLowerCase()) ?? null;
      if (!brand) {
        errors.push(
          `"${brandName}" is not in the federation brand register, so no authorisation could be ` +
          'checked against it. Ask the federation office to add the brand before importing these rows.'
        );
      }
    }

    // ── Numbers that are not money ───────────────────────────────────────
    const weightText = pick(raw, 'weightGrams');
    const weightGrams = optInt(weightText);
    if (weightText && weightGrams === null) {
      errors.push(`"${weightText}" is not a weight in whole grams.`);
    }
    const ageText = pick(raw, 'ageMinYears');
    const ageMinYears = optInt(ageText);
    if (ageText && ageMinYears === null) {
      errors.push(`"${ageText}" is not a minimum age in whole years.`);
    }

    // ── Stock, read only to be refused ───────────────────────────────────
    if (stockText) {
      warnings.push(
        `This row carries a stock figure of "${stockText}" and it will not be applied. ` + IMPORT_STOCK_NOT_TAKEN
      );
    }

    // ── Duplicates ───────────────────────────────────────────────────────
    //
    // SKU FIRST. A seller's own code is a deliberate identity; a title is a
    // description that two genuinely different products can share ("Belt,
    // black"). Matching on the title first would fold two real products into
    // one and the seller would lose a listing they meant to have.
    let duplicateOf: RowResolution['duplicateOf'] = null;
    const skuKey = sellerSku.toLowerCase();
    const titleKey = normalisedTitle(title);

    if (skuKey && mySkus.has(skuKey)) {
      duplicateOf = { listingId: mySkus.get(skuKey)!, rowNo: null, matchedOn: 'sellerSku' };
    } else if (skuKey && seenSkus.has(skuKey)) {
      duplicateOf = { listingId: null, rowNo: seenSkus.get(skuKey)!, matchedOn: 'sellerSku (earlier row of this file)' };
    } else if (titleKey && myTitles.has(titleKey)) {
      duplicateOf = { listingId: myTitles.get(titleKey).id, rowNo: null, matchedOn: 'title' };
    } else if (titleKey && seenTitles.has(titleKey)) {
      duplicateOf = { listingId: null, rowNo: seenTitles.get(titleKey)!, matchedOn: 'title (earlier row of this file)' };
    }
    if (skuKey && !seenSkus.has(skuKey)) seenSkus.set(skuKey, row.rowNo);
    if (titleKey && !seenTitles.has(titleKey)) seenTitles.set(titleKey, row.rowNo);

    // ── PRODUCT POLICY. The federation's own engine, called, not copied ──
    let reviewerMustConfirm: string[] = [];
    if (category) {
      const gate = await checkListingAgainstPolicy(db, {
        sellerId: seller.id,
        categoryId: category.id,
        brandId: brand?.id ?? null,
        certification: pick(raw, 'certification') || null,
        ageMinYears,
        safetyClassification: pick(raw, 'safetyClassification') || null,
      });
      // The policy's OWN sentences, verbatim. A prohibited category and a brand
      // this seller holds no verified authorisation for both arrive here, and
      // both are the reason the row fails — rewritten wording would be the
      // seller and the federation office reading two different rules.
      for (const b of gate.blocking) errors.push(b);
      reviewerMustConfirm = gate.reviewerMustConfirm;
    }

    const resolved: RowResolution = {
      title,
      description: pick(raw, 'description') || null,
      categorySlug,
      categoryId: category?.id ?? null,
      legacyCategory: category?.legacyCategory ?? null,
      priceMinor,
      sellerSku: sellerSku || null,
      brandName: brandName || null,
      brandId: brand?.id ?? null,
      // One row is one variant, and with nothing to choose between there is
      // nothing for a label to distinguish — so an unlabelled row takes the
      // product's own title rather than an invented "Standard".
      variantLabel: pick(raw, 'variantLabel') || title,
      weightGrams,
      gtin: pick(raw, 'gtin') || null,
      barcode: pick(raw, 'barcode') || null,
      certification: pick(raw, 'certification') || null,
      ageMinYears,
      safetyClassification: pick(raw, 'safetyClassification') || null,
      countryOfOrigin: pick(raw, 'countryOfOrigin') || null,
      materials: pick(raw, 'materials') || null,
      imageUrl: pick(raw, 'imageUrl') || null,
      warnings,
      reviewerMustConfirm,
      duplicateOf,
    };

    // A row that is BOTH invalid and a duplicate is reported as invalid: the
    // faults are what the seller has to fix, and 'duplicate' would hide them
    // behind a status that reads as "nothing to do here".
    const status = errors.length ? 'invalid' : (duplicateOf ? 'duplicate' : 'valid');
    if (status === 'invalid') errorCount++;
    else if (status === 'duplicate') duplicateCount++;
    else validCount++;

    await db.update(s.productImportRows).set({
      resolved: resolved as any,
      errors: (errors.length ? errors : null) as any,
      status,
      duplicateOfListingId: duplicateOf?.listingId ?? null,
    }).where(eq(s.productImportRows.id, row.id));
  }

  const report = {
    validatedAt: new Date().toISOString(),
    rowCount: rows.length,
    validCount, errorCount, duplicateCount,
    stockNote: IMPORT_STOCK_NOT_TAKEN,
  };

  await db.update(s.productImports).set({
    status: 'preview', validCount, errorCount, duplicateCount, report: report as any,
  }).where(eq(s.productImports.id, importId));

  await writeAudit(db, ctx, {
    entityType: 'product_import', entityId: importId, action: 'update',
    oldValue: { status: imp.status },
    newValue: { status: 'preview', validCount, errorCount, duplicateCount },
  });

  return { importId, status: 'preview' as const, rowCount: rows.length, validCount, errorCount, duplicateCount };
}

// ─── Stage 3: the preview ───────────────────────────────────────────────────

/**
 * What this import would do, read before it does it.
 *
 * A READ. No ctx, no audit, no writes — and no sellerId parameter: the import
 * is resolved through `ownImport()`, which filters on the seller resolved from
 * the caller's own session.
 *
 * IT RETURNS THE ROWS, NOT ONLY THE COUNTS. "412 rows, 38 errors" tells a
 * seller they have a problem and not which rows have it, so they open the
 * spreadsheet and guess. Per-row faults are the whole point of a preview.
 */
export async function importPreview(db: DB, principal: Principal, importId: number, limit = 500) {
  const { imp } = await ownImport(db, principal, importId);

  const rows = await db.select().from(s.productImportRows)
    .where(eq(s.productImportRows.importId, importId))
    .orderBy(asc(s.productImportRows.rowNo))
    .limit(limit + 1);

  const counts = await db.select({
    status: s.productImportRows.status,
    n: sql<number>`count(*)::int`,
  }).from(s.productImportRows)
    .where(eq(s.productImportRows.importId, importId))
    .groupBy(s.productImportRows.status);

  const byStatus: Record<string, number> = {};
  for (const c of counts) byStatus[String(c.status)] = c.n;

  return {
    importId: imp.id,
    ref: imp.ref,
    filename: imp.filename,
    status: imp.status,
    uploadedAt: imp.uploadedAt,
    submittedAt: imp.submittedAt,
    rowCount: imp.rowCount,
    validCount: imp.validCount,
    errorCount: imp.errorCount,
    duplicateCount: imp.duplicateCount,
    failureReason: imp.failureReason,
    byStatus,
    // Truncation of the DISPLAY is reported. Truncation of the IMPORT never
    // happens — see MAX_IMPORT_ROWS.
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    stockNote: IMPORT_STOCK_NOT_TAKEN,
    boundNote: IMPORT_ROW_BOUND_NOTE,
  };
}

/** Every import the caller has run. No identifier of anybody else's. */
export async function myImports(db: DB, principal: Principal, limit = 25) {
  const seller = await ownSellerRecord(db, principal);
  return db.select().from(s.productImports)
    .where(eq(s.productImports.sellerId, seller.id))
    .orderBy(desc(s.productImports.uploadedAt))
    .limit(limit);
}

// ─── Stage 4: submission ────────────────────────────────────────────────────

/**
 * Turn the valid rows into DRAFT listings, and stop.
 *
 * ─── WHAT THIS FUNCTION DOES NOT DO, WHICH IS THE POINT OF IT ───────────────
 *
 * It does not approve. It does not publish. It does not submit the listings to
 * the review queue on the seller's behalf — `submitListing()` is the seller's
 * own act for one item at a time, and a bulk path that submitted five hundred
 * items would put five hundred rows in front of a reviewer who has no way to
 * tell which of them the seller had actually finished writing.
 *
 * Every listing it creates is a DRAFT, with `approvedContentHash` null, invisible
 * to `publicListingPredicate()` on two independent conditions. The seller then
 * does with them exactly what they do with a listing they typed by hand.
 *
 * ─── WHY THE IMPORT NEVER REACHES 'published' ───────────────────────────────
 *
 * `product_import_status` offers 'published' and 'partially_published' and this
 * function uses NEITHER. Nothing here publishes anything, and a status column
 * saying 'published' over a shelf of unreviewed drafts is a lie that would be
 * read by an operator, quoted in a support reply and eventually believed. The
 * import's terminal status is 'submitted'; `publishedCount` stays 0 because no
 * row of this import has been published. If MMAKF later adds a path that
 * genuinely publishes, those two values are waiting, still meaning what they say.
 *
 * ─── AND WHY A FAILING ROW DOES NOT ABORT THE REST ──────────────────────────
 *
 * Each row is its own listing, its own federation reference and its own audit
 * row. One transaction across two thousand of them holds locks on the listing
 * table for the length of the import; and if row 1,900 fails, rolling back
 * discards 1,899 correct products because of one bad cell. So a row that throws
 * is recorded as skipped WITH ITS REASON and the loop continues — and because
 * every skip is written down, "it imported everything" is never something this
 * function can report while quietly having imported less.
 */
export async function submitImport(db: DB, ctx: AuditContext, importId: number) {
  const { seller, imp } = await ownImport(db, ctx.principal, importId);

  if (seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `A seller that is ${seller.status} cannot create listings. The import is untouched.`
    );
  }
  if (imp.status === 'submitted' || imp.status === 'published' || imp.status === 'partially_published') {
    throw new MarketplaceError(
      'already_submitted',
      'This import has already been submitted. Submitting it twice would create a second draft of ' +
      'every product in it. The drafts it created are in your products list.'
    );
  }
  if (imp.status === 'cancelled') {
    throw new MarketplaceError('import_cancelled', 'This import was cancelled and cannot be submitted.');
  }
  if (imp.status !== 'preview') {
    throw new MarketplaceError(
      'not_validated',
      'This import has not been validated, so nothing is known about what is in it. Validate it and ' +
      'read the preview first — that is the step where a prohibited category or an unauthorised brand ' +
      'is caught, and skipping it is what "never import directly into the catalogue" means.'
    );
  }

  const rows = await db.select().from(s.productImportRows)
    .where(eq(s.productImportRows.importId, importId))
    .orderBy(asc(s.productImportRows.rowNo));

  let created = 0, skipped = 0;
  const skippedReasons: { rowNo: number; reason: string }[] = [];

  for (const row of rows) {
    const resolved = (row.resolved ?? null) as RowResolution | null;

    // NOT DROPPED. Every row this import does not turn into a product is
    // written back as 'skipped' with the reason it was skipped, so the file the
    // seller uploaded and the products they got can always be reconciled.
    if (row.status !== 'valid' || !resolved || resolved.priceMinor === null || !resolved.legacyCategory) {
      const reason = row.status === 'duplicate'
        ? 'Already listed by you — skipped so the same product is not listed twice.'
        : (Array.isArray(row.errors) && row.errors.length
          ? String((row.errors as string[])[0])
          : 'Not valid at validation.');
      await db.update(s.productImportRows).set({ status: 'skipped' })
        .where(eq(s.productImportRows.id, row.id));
      skipped++;
      skippedReasons.push({ rowNo: row.rowNo, reason });
      continue;
    }

    try {
      const listing = await createListing(db, ctx, {
        title: resolved.title,
        description: resolved.description,
        category: resolved.legacyCategory as any,
        priceMinor: resolved.priceMinor,
        // NO stockQty. See IMPORT_STOCK_NOT_TAKEN.
        media: resolved.imageUrl
          ? [{ url: resolved.imageUrl, alt: resolved.title, sortOrder: 0 }]
          : [],
      });

      // ── The product-detail block, then the variant. IN THIS ORDER ────────
      //
      // Every column written here feeds the listing's CONTENT HASH through the
      // v2 detail block (see listingContentHash() in src/db/marketplace.ts), and
      // createListing() computed a hash before they existed. Writing them and
      // stopping would leave a listing whose stored hash does not describe its
      // own contents — harmless while it is a draft, and a listing that silently
      // drops out of public view the first time anything recomputes the hash
      // after approval.
      //
      // addVariant() calls refreshListingFromVariants(), which re-reads the
      // listing row, rebuilds the detail block from these very columns and
      // rewrites contentHash. So the detail is written FIRST and the variant
      // SECOND, and the hash that ends up stored is a hash of everything that
      // is actually there.
      await db.update(s.listings).set({
        categoryId: resolved.categoryId,
        brandId: resolved.brandId,
        certification: resolved.certification,
        ageMinYears: resolved.ageMinYears,
        safetyClassification: resolved.safetyClassification,
        countryOfOrigin: resolved.countryOfOrigin,
        materials: resolved.materials,
        gtin: resolved.gtin,
      }).where(eq(s.listings.id, listing.listingId));

      const variant = await addVariant(db, ctx, listing.listingId, {
        label: resolved.variantLabel,
        priceMinor: resolved.priceMinor,
        sellerSku: resolved.sellerSku,
        gtin: resolved.gtin,
        barcode: resolved.barcode,
        weightGrams: resolved.weightGrams,
      });

      await db.update(s.productImportRows).set({
        status: 'created',
        listingId: listing.listingId,
        variantId: variant.variantId,
      }).where(eq(s.productImportRows.id, row.id));
      created++;
    } catch (err: any) {
      // The module's own sentence, kept. A unique SKU collision, a price the
      // listing module refuses, a seller suspended between validation and
      // submission — each has a message written for the person who hit it.
      const reason = err?.name === 'MarketplaceError'
        ? String(err.message)
        : 'This row could not be turned into a draft. The fault has been logged for the federation office.';
      if (err?.name !== 'MarketplaceError') console.error('[product-import] row failed', row.rowNo, err);

      const existing = Array.isArray(row.errors) ? (row.errors as string[]) : [];
      await db.update(s.productImportRows).set({
        status: 'skipped',
        errors: [...existing, reason] as any,
      }).where(eq(s.productImportRows.id, row.id));
      skipped++;
      skippedReasons.push({ rowNo: row.rowNo, reason });
    }
  }

  const report = {
    ...((imp.report ?? {}) as Record<string, unknown>),
    submittedAt: new Date().toISOString(),
    createdDrafts: created,
    skipped,
    skippedReasons: skippedReasons.slice(0, 200),
    // Said in the record itself, not only in a comment, because this row is
    // what an operator reads six months from now.
    publishedNote:
      'Nothing in this import was published. Each row became a DRAFT listing and goes through the ' +
      'ordinary moderation queue exactly as a hand-typed one does.',
  };

  await db.update(s.productImports).set({
    status: 'submitted',
    // Stays 0. Nothing has been published — see the note above this function.
    publishedCount: 0,
    submittedAt: new Date(),
    completedAt: new Date(),
    report: report as any,
  }).where(eq(s.productImports.id, importId));

  await writeAudit(db, ctx, {
    entityType: 'product_import', entityId: importId, action: 'create',
    oldValue: { status: imp.status },
    newValue: { status: 'submitted', createdDrafts: created, skipped },
  });

  return { importId, status: 'submitted' as const, createdDrafts: created, skipped, skippedReasons };
}

// ─── Stage 5: cancelling ────────────────────────────────────────────────────

/**
 * Stop an import, with a reason.
 *
 * A STATUS TRANSITION. The import row and every one of its rows stay exactly
 * where they are — §8, nothing is deleted — because a cancelled import is the
 * evidence for "I uploaded that file and it never appeared", and deleting it
 * destroys the only record that the upload happened at all.
 *
 * AN ALREADY-SUBMITTED IMPORT CANNOT BE CANCELLED, and the refusal says why:
 * the drafts exist, they are real listings the seller owns, and marking their
 * origin 'cancelled' would not un-create them. It would only make the record
 * disagree with the catalogue. Withdrawing a draft is `listing/withdraw`, one
 * item at a time, which is the act that actually does something.
 */
export async function cancelImport(db: DB, ctx: AuditContext, importId: number, reason: string) {
  const { imp } = await ownImport(db, ctx.principal, importId);

  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError(
      'reason_required',
      'Say why this import is being stopped. The file and its rows are kept either way, and the ' +
      'reason is what makes the record readable later.'
    );
  }
  if (imp.status === 'cancelled') {
    throw new MarketplaceError('already_cancelled', 'This import was already cancelled.');
  }
  if (imp.status === 'submitted' || imp.status === 'published' || imp.status === 'partially_published') {
    throw new MarketplaceError(
      'already_submitted',
      'This import has already created draft listings, and cancelling it here would not remove them — ' +
      'it would only make this record disagree with your catalogue. Withdraw the drafts you do not ' +
      'want from your products list; each one is a separate act with its own reason.'
    );
  }

  await db.update(s.productImports).set({
    status: 'cancelled',
    failureReason: String(reason).trim(),
    completedAt: new Date(),
  }).where(eq(s.productImports.id, importId));

  // The ROWS are not touched. They keep their raw payload and their validation
  // findings, which is what makes a cancelled import worth having kept.
  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'product_import', entityId: importId, action: 'update',
    oldValue: { status: imp.status }, newValue: { status: 'cancelled' },
  });

  return { importId, status: 'cancelled' as const };
}

// ─── Ownership, and the federation's view ───────────────────────────────────

/**
 * The caller's own import, or a refusal that says nothing about anybody else's.
 *
 * THE SELLER ID IS IN THE WHERE CLAUSE. An import belonging to another seller
 * does not come back as "forbidden" — it simply does not match, and the message
 * is identical to the one for an id that was never issued. Distinguishing the
 * two tells an attacker which ids are real, and an import id is a small integer.
 */
async function ownImport(db: DB, principal: Principal, importId: number) {
  const seller = await ownSellerRecord(db, principal);
  const imp = (await db.select().from(s.productImports).where(and(
    eq(s.productImports.id, importId),
    eq(s.productImports.sellerId, seller.id),
  )).limit(1))[0];
  if (!imp) throw new MarketplaceError('not_your_import', 'No such import on your seller account.');
  return { seller, imp };
}

/**
 * The federation's view of one seller's imports, for the admin console.
 *
 * SCOPE-CHECKED, and it takes a sellerId because looking at somebody else's
 * shop is the whole act — the same shape as `zonesForSeller()` in
 * src/db/shipping.ts. A reviewer who finds forty near-identical drafts in the
 * queue needs to be able to see that they came from one file.
 */
export async function importsForSeller(db: DB, principal: Principal, sellerId: number, limit = 50) {
  assertCan(principal, 'marketplace:read', {});
  return db.select().from(s.productImports)
    .where(eq(s.productImports.sellerId, sellerId))
    .orderBy(desc(s.productImports.uploadedAt))
    .limit(limit);
}
