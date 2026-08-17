// Currency and foreign exchange.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RULE THAT MATTERS
// ─────────────────────────────────────────────────────────────────────────────
//
// ONCE A QUOTATION OR AN INVOICE IS ISSUED, THE COMMERCIAL AMOUNT AND THE
// EXCHANGE RATE USED ARE FROZEN ON THAT RECORD. A later FX movement must never
// change what a customer owes.
//
// That single sentence decides the whole shape of this module. It is why
// `stampInvoice()` COPIES a rate onto the invoice row instead of storing a
// foreign key and joining at read time; why it refuses, loudly, to stamp a
// record twice; and why `invoiceRate()` reads the frozen columns and never
// consults fx_rates at all. A pointer into a table whose entire purpose is to
// change is not a record of what was agreed — it is a promise to recompute it
// later, differently.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW A RATE IS STORED, AND WHY IN THAT FORM
// ─────────────────────────────────────────────────────────────────────────────
//
// `ratePpm` is MINOR UNITS OF THE QUOTE CURRENCY PER ONE MINOR UNIT OF THE
// BASE, times 1,000,000.
//
// Per MINOR unit, not per major unit. The two currencies' exponents differ —
// INR has two, JPY none, KWD three — and defining the rate this way puts that
// difference inside the stored number once, at the point somebody records it
// with a source and a date, rather than at every call site that converts an
// amount. Conversion is then exactly one call to applyFactor() from
// src/db/fees.ts, which is the only place in this codebase a factor is applied
// to money, in BigInt, rounded half up.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// It contains no exchange rate, and it will not invent one. `rateAsOf()`
// returns null when nothing has been recorded for a pair and a date;
// `convertAsOf()` throws rather than guessing. There is no "approximately", no
// last-known-good fallback and no interpolation. A federation that bills a
// school in dollars using a rate nobody recorded cannot defend the figure, and
// an amount nobody can defend is worse than a conversation about which rate to
// use.

import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { applyFactor, PPM, formatINR } from '@/db/fees';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan } from '@/lib/rbac';

type DB = any;

export class CurrencyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CurrencyError';
    this.code = code;
  }
}

/** Identified by shape, not by `instanceof` — see src/lib/calendar.ts for why. */
export function isCurrencyError(err: unknown): err is CurrencyError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'CurrencyError';
}

/** The federation's accounting currency. Domestic amounts are paise. */
export const BASE_CURRENCY = 'INR';

/** A rate of exactly 1.0, for the base-equals-quote case. */
export const IDENTITY_PPM = PPM;

/**
 * The largest rate this module will accept.
 *
 * applyFactor() runs in BigInt, so the multiply itself is exact — but the
 * result is handed back as a Number, and a rate beyond this makes a large
 * amount land outside the exactly-representable range. Refusing at the door
 * beats discovering it on a settlement report.
 */
const MAX_RATE_PPM = Number.MAX_SAFE_INTEGER / 1_000_000;

// ─── Minor units ────────────────────────────────────────────────────────────

/**
 * 10^minorUnit — how many minor units make one major unit.
 *
 * Exists so that no caller writes `/ 100`. That constant is right for INR and
 * wrong for JPY (0), KRW (0), KWD (3), BHD (3) and OMR (3), and it is wrong by
 * a factor of a hundred or a thousand, which is the kind of wrong that reaches
 * a customer before it reaches a test.
 */
export function minorUnitScale(minorUnit: number): number {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new CurrencyError(
      'bad_minor_unit',
      `A minor-unit exponent of ${minorUnit} is not an ISO 4217 value. The standard uses 0, 2 or 3.`
    );
  }
  return 10 ** minorUnit;
}

/**
 * Render an amount in its own currency's minor units.
 *
 * INR delegates to formatINR() in the fee engine so the lakh/crore grouping has
 * exactly one implementation. Everything else is grouped in threes, which is
 * what the rest of the world uses; a currency with no minor unit gets no
 * decimal point at all, because "¥1,200.00" is not a thing a yen price says.
 */
export function formatMoney(
  amountMinor: number,
  currency: { code: string; minorUnit: number; symbol?: string | null }
): string {
  if (!Number.isInteger(amountMinor)) {
    throw new CurrencyError('bad_amount', 'Amounts are integer minor units.');
  }
  if (currency.code === BASE_CURRENCY && currency.minorUnit === 2) return formatINR(amountMinor);

  const scale = minorUnitScale(currency.minorUnit);
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / scale);
  const minor = abs % scale;
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency.symbol || `${currency.code} `;
  const fraction = currency.minorUnit === 0 ? '' : `.${String(minor).padStart(currency.minorUnit, '0')}`;
  return `${negative ? '-' : ''}${symbol}${grouped}${fraction}`;
}

// ─── Reading the currency table ─────────────────────────────────────────────

export async function getCurrency(db: DB, code: string) {
  const [row] = await db.select().from(s.currencies)
    .where(eq(s.currencies.code, String(code || '').toUpperCase())).limit(1);
  return row ?? null;
}

/**
 * The currency, or a refusal — never a guess at its minor unit.
 *
 * Everything that converts or formats money goes through here rather than
 * assuming two decimal places, which is the assumption the currencies table
 * exists to remove.
 */
export async function requireCurrency(db: DB, code: string) {
  const row = await getCurrency(db, code);
  if (!row) {
    throw new CurrencyError(
      'unknown_currency',
      `${code} is not in the currency table, so its minor unit is unknown. ` +
      'Nothing here assumes 100 minor units — add the currency with its ISO 4217 exponent first.'
    );
  }
  return row;
}

export async function listCurrencies(db: DB, opts: { activeOnly?: boolean } = {}) {
  const q = db.select().from(s.currencies);
  const rows = opts.activeOnly
    ? await q.where(eq(s.currencies.isActive, true)).orderBy(asc(s.currencies.code))
    : await q.orderBy(asc(s.currencies.code));
  return rows;
}

/**
 * Add a currency, or activate/deactivate one.
 *
 * `finance:write`, not a fee-framework action: which currencies the federation
 * transacts in is a treasury decision, and it is separate from what anything
 * costs. Minor unit is required and never defaulted.
 */
export async function upsertCurrency(
  db: DB, ctx: AuditContext,
  input: {
    code: string; name: string; minorUnit: number;
    numericCode?: string | null; symbol?: string | null;
    isActive?: boolean; source?: string; notes?: string | null;
  }
) {
  assertCan(ctx.principal, 'finance:write', {});
  const code = String(input.code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new CurrencyError('bad_code', 'A currency code is three letters, as ISO 4217 defines it.');
  }
  minorUnitScale(input.minorUnit);   // validates, and refuses a guess

  const existing = await getCurrency(db, code);
  if (existing) {
    await db.update(s.currencies).set({
      name: input.name,
      minorUnit: input.minorUnit,
      numericCode: input.numericCode ?? existing.numericCode,
      symbol: input.symbol ?? existing.symbol,
      isActive: input.isActive ?? existing.isActive,
      notes: input.notes ?? existing.notes,
      updatedAt: new Date(),
    }).where(eq(s.currencies.id, existing.id));
    await writeAudit(db, ctx, {
      entityType: 'currency', entityId: existing.id, action: 'update',
      oldValue: { minorUnit: existing.minorUnit, isActive: existing.isActive },
      newValue: { minorUnit: input.minorUnit, isActive: input.isActive ?? existing.isActive },
    });
    return (await getCurrency(db, code))!;
  }

  const [row] = await db.insert(s.currencies).values({
    code,
    name: input.name,
    minorUnit: input.minorUnit,
    numericCode: input.numericCode ?? null,
    symbol: input.symbol ?? null,
    isActive: input.isActive ?? false,
    source: input.source ?? 'ISO 4217',
    notes: input.notes ?? null,
  }).returning();
  await writeAudit(db, ctx, {
    entityType: 'currency', entityId: row.id, action: 'create',
    newValue: { code, minorUnit: input.minorUnit },
  });
  return row;
}

// ─── Rates ──────────────────────────────────────────────────────────────────

/**
 * A rate, detached from the table it came from.
 *
 * This is the object that gets COPIED onto an invoice. It carries everything
 * needed to defend the figure years later — the pair, the number, who published
 * it, when it was fetched and which day it applied to — so that reconstructing
 * an old invoice needs no join at all. `rateId` is provenance; nothing
 * recomputes from it.
 */
export interface FrozenRate {
  baseCode: string;
  quoteCode: string;
  ratePpm: number;
  source: string;
  sourceRef: string | null;
  retrievedAt: string;
  effectiveOn: string;
  rateId: number | null;
}

/** Convert a same-currency amount without pretending a rate was involved. */
export function identityRate(code: string, onDate: string): FrozenRate {
  return {
    baseCode: code, quoteCode: code, ratePpm: IDENTITY_PPM,
    source: 'identity',
    sourceRef: null,
    retrievedAt: new Date(`${onDate}T00:00:00.000Z`).toISOString(),
    effectiveOn: onDate,
    rateId: null,
  };
}

/**
 * Record a rate somebody published.
 *
 * `source` and `retrievedAt` are mandatory arguments, not optional metadata.
 * An exchange rate without provenance is a number somebody typed, and the first
 * time a school queries an invoice the only useful answer is "the Reserve Bank
 * reference rate for that date, fetched at this time, here is the bulletin".
 *
 * Versioning is per pair and monotonic. A correction is version n+1, never an
 * edit — the invoice that used version n keeps its own copy regardless, and the
 * history has to be able to show what was believed at the time.
 */
export async function recordRate(
  db: DB, ctx: AuditContext,
  input: {
    baseCode: string; quoteCode: string;
    ratePpm: number; rateText?: string | null;
    source: string; sourceRef?: string | null;
    retrievedAt: Date | string;
    effectiveOn: string;
    notes?: string | null;
  }
) {
  assertCan(ctx.principal, 'finance:write', {});
  const baseCode = String(input.baseCode || '').toUpperCase();
  const quoteCode = String(input.quoteCode || '').toUpperCase();

  if (baseCode === quoteCode) {
    throw new CurrencyError(
      'identity_rate',
      'A currency does not have an exchange rate against itself. Use identityRate().'
    );
  }
  // Both sides must be known, so the minor units behind the ppm figure are on
  // record rather than inferred.
  await requireCurrency(db, baseCode);
  await requireCurrency(db, quoteCode);

  if (!Number.isInteger(input.ratePpm) || input.ratePpm <= 0) {
    throw new CurrencyError(
      'bad_rate',
      'A rate is a positive integer in parts-per-million of minor-per-minor. 83.25 INR per USD is 83250000.'
    );
  }
  if (input.ratePpm > MAX_RATE_PPM) {
    throw new CurrencyError('rate_too_large', `A rate above ${MAX_RATE_PPM} ppm cannot be applied exactly.`);
  }
  if (!input.source || !String(input.source).trim()) {
    throw new CurrencyError(
      'no_source',
      'A rate must say who published it. An unattributed rate cannot be defended when the invoice is queried.'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveOn)) {
    throw new CurrencyError('bad_date', 'effectiveOn is a YYYY-MM-DD date.');
  }

  const [{ top }] = await db.select({
    top: sql<number>`COALESCE(MAX(${s.fxRates.version}), 0)`,
  }).from(s.fxRates).where(and(eq(s.fxRates.baseCode, baseCode), eq(s.fxRates.quoteCode, quoteCode)));

  const [row] = await db.insert(s.fxRates).values({
    baseCode, quoteCode,
    version: Number(top) + 1,
    ratePpm: input.ratePpm,
    rateText: input.rateText ?? null,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    retrievedAt: typeof input.retrievedAt === 'string' ? new Date(input.retrievedAt) : input.retrievedAt,
    effectiveOn: input.effectiveOn,
    recordedByUserId: ctx.principal.userId ?? null,
    notes: input.notes ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'fx_rate', entityId: row.id, action: 'create',
    newValue: { pair: `${baseCode}/${quoteCode}`, version: row.version, ratePpm: input.ratePpm, source: input.source },
  });
  return row;
}

/**
 * The rate in force for a pair on a date — or NULL.
 *
 * Null, not a fallback. There is deliberately no "nearest available rate" and
 * no extrapolation: if the treasury has not recorded a rate for the day an
 * invoice is being issued, the honest outcome is that the invoice cannot be
 * issued in that currency yet, and somebody records the rate.
 *
 * Picks the latest `effectiveOn` at or before the date, then the highest
 * version on that day — so a correction issued later supersedes the original
 * for any invoice issued AFTER it, and changes nothing already frozen.
 */
export async function rateAsOf(
  db: DB, baseCode: string, quoteCode: string, onDate: string
): Promise<FrozenRate | null> {
  const base = String(baseCode || '').toUpperCase();
  const quote = String(quoteCode || '').toUpperCase();
  if (base === quote) return identityRate(base, onDate);

  const [row] = await db.select().from(s.fxRates)
    .where(and(
      eq(s.fxRates.baseCode, base),
      eq(s.fxRates.quoteCode, quote),
      lte(s.fxRates.effectiveOn, onDate)
    ))
    .orderBy(desc(s.fxRates.effectiveOn), desc(s.fxRates.version))
    .limit(1);

  if (!row) return null;
  return {
    baseCode: row.baseCode,
    quoteCode: row.quoteCode,
    ratePpm: Number(row.ratePpm),
    source: row.source,
    sourceRef: row.sourceRef ?? null,
    retrievedAt: new Date(row.retrievedAt).toISOString(),
    effectiveOn: String(row.effectiveOn),
    rateId: row.id,
  };
}

/**
 * Apply a frozen rate to an amount.
 *
 * One call to applyFactor(), which is the only place a factor touches money in
 * this codebase: BigInt multiply, half-up rounding, integer minor units in and
 * out. Re-implementing that here — even "just this once, it is only a rate" —
 * is how two rounding behaviours end up in one ledger.
 */
export function applyRate(amountMinor: number, rate: FrozenRate): number {
  if (!Number.isInteger(amountMinor)) {
    throw new CurrencyError('bad_amount', 'Amounts are integer minor units.');
  }
  return applyFactor(amountMinor, rate.ratePpm);
}

/** The converted amount together with the exact rate used, ready to be frozen. */
export interface Conversion {
  amountMinor: number;
  convertedMinor: number;
  rate: FrozenRate;
}

/**
 * Convert as at a date, or refuse.
 *
 * Throws `no_rate` rather than approximating. See the module header: the
 * absence of a rate is a fact about the treasury's records, and papering over
 * it produces an amount nobody can defend.
 */
export async function convertAsOf(
  db: DB,
  input: { amountMinor: number; from: string; to: string; asOf: string }
): Promise<Conversion> {
  const rate = await rateAsOf(db, input.from, input.to, input.asOf);
  if (!rate) {
    throw new CurrencyError(
      'no_rate',
      `No exchange rate has been recorded for ${String(input.from).toUpperCase()}/` +
      `${String(input.to).toUpperCase()} on or before ${input.asOf}. ` +
      'Nothing here estimates one — record the rate, with its source, first.'
    );
  }
  return { amountMinor: input.amountMinor, convertedMinor: applyRate(input.amountMinor, rate), rate };
}

// ─── Freezing a rate onto an issued document ────────────────────────────────

/** What gets written onto an invoice or a quote version, and never changed. */
export interface RateStamp {
  presentmentCurrency: string;
  presentmentMinorUnit: number;
  presentmentTotalMinor: number;
  rate: FrozenRate;
}

/**
 * Work out what to stamp on a document, WITHOUT writing anything.
 *
 * Split from the write for the same reason computeFee() is split from
 * issueQuote(): a surface can show somebody what an invoice would say in
 * dollars without creating a frozen record for every idle click.
 */
export async function prepareStamp(
  db: DB,
  input: { baseTotalMinor: number; baseCurrency?: string; presentmentCurrency: string; asOf: string }
): Promise<RateStamp> {
  const base = (input.baseCurrency ?? BASE_CURRENCY).toUpperCase();
  const presentment = String(input.presentmentCurrency || '').toUpperCase();
  const currency = await requireCurrency(db, presentment);
  const { convertedMinor, rate } = await convertAsOf(db, {
    amountMinor: input.baseTotalMinor, from: base, to: presentment, asOf: input.asOf,
  });
  return {
    presentmentCurrency: presentment,
    presentmentMinorUnit: currency.minorUnit,
    presentmentTotalMinor: convertedMinor,
    rate,
  };
}

/**
 * Freeze a rate onto an issued invoice.
 *
 * REFUSES TO RESTAMP. That is the whole guarantee: an invoice that already
 * carries a rate has told a customer what they owe, and a second stamp — from a
 * retry, a well-meant "refresh the rate" button, or a job that ran twice —
 * would change it. The refusal is an error rather than a silent no-op because
 * an operator who believes they have updated a rate and has not is worse off
 * than one who is told they cannot.
 */
export async function stampInvoice(db: DB, invoiceId: number, stamp: RateStamp) {
  const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
  if (!invoice) throw new CurrencyError('unknown_invoice', 'No such invoice.');
  if (invoice.fxRatePpm != null) {
    throw new CurrencyError(
      'already_frozen',
      `Invoice ${invoice.invoiceNo} was issued at a rate of ${invoice.fxRatePpm} ppm and keeps it. ` +
      'An issued invoice never re-rates — raise a credit note and a new invoice instead.'
    );
  }
  await db.update(s.invoices).set({
    presentmentCurrency: stamp.presentmentCurrency,
    presentmentMinorUnit: stamp.presentmentMinorUnit,
    presentmentTotalMinor: stamp.presentmentTotalMinor,
    fxRatePpm: stamp.rate.ratePpm,
    fxRateId: stamp.rate.rateId,
    fxSource: stamp.rate.source,
    fxRetrievedAt: new Date(stamp.rate.retrievedAt),
    fxEffectiveOn: stamp.rate.effectiveOn,
  }).where(eq(s.invoices.id, invoiceId));
  return (await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1))[0];
}

/**
 * The rate an invoice was issued at, read from the invoice ITSELF.
 *
 * Note what this does not do: it never touches fx_rates. The columns it reads
 * are the frozen copy, so the answer is identical whatever has happened to the
 * rate table since — which is exactly the property tests/tax-currency.test.ts
 * asserts by moving the rate and re-reading.
 */
export async function invoiceRate(db: DB, invoiceId: number): Promise<FrozenRate | null> {
  const [row] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
  if (!row || row.fxRatePpm == null) return null;
  return {
    baseCode: row.baseCurrency,
    quoteCode: row.presentmentCurrency ?? row.baseCurrency,
    ratePpm: Number(row.fxRatePpm),
    source: row.fxSource ?? 'unrecorded',
    sourceRef: null,
    retrievedAt: row.fxRetrievedAt ? new Date(row.fxRetrievedAt).toISOString() : '',
    effectiveOn: row.fxEffectiveOn ? String(row.fxEffectiveOn) : '',
    rateId: row.fxRateId ?? null,
  };
}

/** The same freeze, one step earlier in the story: on an issued quotation. */
export async function stampQuoteVersion(db: DB, quoteVersionId: number, stamp: RateStamp) {
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new CurrencyError('unknown_quote_version', 'No such quote version.');
  if (qv.fxRatePpm != null) {
    throw new CurrencyError(
      'already_frozen',
      'This quote version was issued at a rate and keeps it. Re-quoting produces a NEW version.'
    );
  }
  await db.update(s.quoteVersions).set({
    presentmentCurrency: stamp.presentmentCurrency,
    presentmentMinorUnit: stamp.presentmentMinorUnit,
    presentmentTotalMinor: stamp.presentmentTotalMinor,
    fxRatePpm: stamp.rate.ratePpm,
    fxRateId: stamp.rate.rateId,
    fxSource: stamp.rate.source,
    fxRetrievedAt: new Date(stamp.rate.retrievedAt),
    fxEffectiveOn: stamp.rate.effectiveOn,
  }).where(eq(s.quoteVersions.id, quoteVersionId));
  return (await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1))[0];
}

/**
 * What an administrator sees on the FX screen when nothing is configured.
 *
 * Returned as a sentence rather than left to each surface to phrase, so the
 * empty state says the same true thing everywhere: no rate is recorded, and
 * therefore nothing is being converted.
 */
export async function fxStatus(db: DB) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.fxRates);
  const rates = Number(n);
  return {
    configured: rates > 0,
    rateCount: rates,
    baseCurrency: BASE_CURRENCY,
    notice: rates > 0
      ? null
      : 'No exchange rate has been recorded. Every amount is in Indian rupees, and nothing is being converted.',
  };
}
