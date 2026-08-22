// The training product, the training plan, and the entitlement that decides
// access (migration 0045).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE
// ─────────────────────────────────────────────────────────────────────────────
//
// A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT. They pay for
// TRAINING. There is no student subscription, no junior membership, no
// registration fee, no platform fee and no account fee anywhere in this module.
//
// ACCESS IS DECIDED BY A VALID TRAINING ENTITLEMENT AND BY NOTHING ELSE.
// `trainingAccess()` is the one function every surface calls, and it contains no
// membership check whatsoever. This file does not import src/db/membership.ts,
// does not read `s.memberships`, and has no code path that could be made to.
// tests/training-products.test.ts asserts both facts — the behavioural one (a
// person with no membership at all trains; a person with an immaculate
// membership and no entitlement does not) and the static one (the source text
// of this file contains no reference to the membership register). A comment is
// not an enforcement mechanism; those two tests are.
//
// Membership remains a real and separate domain in src/db/membership.ts, for
// coaches, officials, examiners and clubs. Nothing here contradicts it. The two
// simply never meet.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A STUDENT ACTUALLY BUYS, IN THREE OBJECTS
// ─────────────────────────────────────────────────────────────────────────────
//
//   TRAINING PRODUCT      the thing on offer: a discipline, a programme, an age
//                         group, a skill level, at a club, at a location, with a
//                         coach category, a frequency, a duration, a capacity
//                         and a validity. It carries NO PRICE.
//   TRAINING PLAN         what a person committed to. The commercial object.
//   TRAINING ENTITLEMENT  the right to train, for an explicit period, bought
//                         with an identified payment at an identified PRICE
//                         VERSION. A recurring plan produces the next one as a
//                         TRAINING RENEWAL.
//
// NOT ONE OF THESE IS A SUBSCRIPTION, and none of them is called one. The
// federation was explicit, and the reason is not vocabulary policing: a person
// has to be able to read their own invoice and know what they bought. "MMAKF
// subscription" tells them nothing, and reads as the membership fee the
// federation withdrew.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIVE PROPERTIES THIS FILE IS BUILT AROUND
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. NO AMOUNT IS EVER INVENTED. MMAKF has published no fee framework, so
//    `activeFramework()` returns null and `priceTrainingProduct()` returns
//    `{ priced: false }` with a sentence saying the federation has not published
//    a fee for this. Never 0 — zero reads as FREE, which is the most expensive
//    misunderstanding available here — and never a figure borrowed from another
//    federation. `grantTraining()` refuses in the same direction: with no
//    published framework there is no price version to record, so the row is
//    written BLOCKED with the reason and grants nothing.
//
// 2. THE SERVER CALCULATES. Nothing in this module accepts a price, a discount,
//    a tax or a total from a caller. `defineTrainingProduct()` refuses an input
//    object that carries any money-shaped key at all, by name, so a future
//    caller who tries to put a price on a product gets an error rather than a
//    column that quietly appears. What a client may send is a product id, a
//    club, a start date and a quantity.
//
// 3. HISTORICAL RECORDS ARE NEVER REWRITTEN. `discipline`, `programme`, the
//    period and the price version are COPIED onto the entitlement at grant time.
//    A product edited in 2027 cannot re-describe what somebody bought in 2026,
//    and a framework published in 2027 cannot re-price it. A transfer does not
//    edit `club_id` either: it sets `serviced_by_club_id`, and the club the
//    training was bought at stays on the record for ever.
//
// 4. IDEMPOTENT AT EVERY HOP. One entitlement per paid order line, enforced by
//    `training_entitlements_order_line_uk` — a unique index, not a
//    SELECT-then-INSERT. A retried workflow, a replayed webhook and a
//    double-clicked button all produce one row. A renewal is claimed the same
//    way, through `training_entitlements_renewal_chain_uk`, so two renewal runs
//    cannot both extend the same term.
//
// 5. EXPIRY DELETES NOTHING, AND HAPPENS AT THE MOMENT IT HAPPENS. There is no
//    delete path in this file. There is also no `active` boolean to fall out of
//    date and no nightly sweep to expire anything: `trainingAccess()` compares
//    the request's own instant against `valid_from` / `valid_until` IN SQL, so
//    an entitlement stops opening the door the moment it lapses rather than at
//    the next cron run. A lapsed entitlement keeps its row, its dates, its
//    payment and its price version, and the attendance, grades and certificates
//    that hang off `persons` are untouched. THE RECORD OF HAVING TRAINED
//    OUTLIVES THE RIGHT TO TRAIN.
//
// ─────────────────────────────────────────────────────────────────────────────
// A NOTE ON THE OTHER ENTITLEMENT ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/entitlements.ts turns a captured payment into a membership, a cleared
// entry or a confirmed booking, and src/db/activation.ts turns one into an
// INSTITUTIONAL training programme. Neither of them can express what a student
// buys: `entitlements` has no person, no club, no discipline and no price
// version, and its subject vocabulary has no term for training.
//
// So `activateTrainingForOrder()` is the training equivalent and is called
// alongside them, not instead of them. A 'training' order line is reported by
// `entitlements.activateForOrder()` as `not_entitling` — which is that module's
// deliberate way of saying "this system issued nothing here", visible rather
// than mistaken for coverage. It is this module that issues it.

import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from './schema';
// The quotation→order link. Not re-exported from schema.ts (see the note there
// on what that file is the entry point for), so it is imported directly,
// exactly as src/db/activation.ts imports operations.schema.
import * as qo from './quote-orders.schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { assertCan, assertCanAnywhere, canAnywhere, type Principal } from '@/lib/rbac';
import { publish } from '@/lib/domain-events';
import { activeFramework, computeFee, formatINR, type FeeInputs } from './fees';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class TrainingProductError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TrainingProductError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isTrainingProductError(err: unknown): err is TrainingProductError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'TrainingProductError';
}

// ─── Time ───────────────────────────────────────────────────────────────────

const isoDate = (v: Date | string | null | undefined): string | null =>
  !v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const todayIso = (at?: Date | string | null): string => isoDate(at ?? new Date())!;

/**
 * The day BEFORE the anniversary, with the month-end clamp.
 *
 * A twelve-month term starting 1 January ends 31 December, not 1 January the
 * following year — one day of overlap is one day of double cover, and every
 * renewal issued from the previous term's end compounds it. The clamp is the
 * other half: JavaScript rolls 31 January plus one month into 3 March, so a
 * student who paid on the 31st would get two extra days a year that nobody
 * would notice and nobody could explain.
 *
 * Shared logic with `termEndsOn()` in src/db/entitlements.ts, and deliberately
 * NOT imported from it: importing that module here would put the membership
 * engine's import graph inside the file that must provably not consult it. The
 * arithmetic is eight lines; the guarantee is the whole point of this module.
 */
export function trainingTermEndsOn(from: string, months: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);   // clamp back into the intended month
  d.setUTCDate(d.getUTCDate() - 1);              // the day BEFORE the anniversary
  return d.toISOString().slice(0, 10);
}

/** N whole days from `from`, inclusive of the first day. 1 day = same day. */
export function daysEndOn(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export type TrainingPeriod = (typeof s.trainingPeriod.enumValues)[number];
export type TrainingPlanStatus = (typeof s.trainingPlanStatus.enumValues)[number];
export type TrainingRenewalMode = (typeof s.trainingRenewalMode.enumValues)[number];

export const TRAINING_PERIODS: readonly TrainingPeriod[] = s.trainingPeriod.enumValues;

/**
 * The four periods whose length is arithmetic rather than policy.
 *
 * A month is a month; the federation does not have to publish that. Everything
 * NOT in this table — per_session, camp, course, intensive,
 * custom_institutional — has a length only MMAKF can state, and the product
 * must carry `validity_days` for it. There is no default and there will not be
 * one: a camp that quietly ran for thirty days because a constant said so would
 * be federation policy set by this file.
 */
const PERIOD_MONTHS: Partial<Record<TrainingPeriod, number>> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  annual: 12,
};

/** Periods whose length MMAKF must state per product, as `validityDays`. */
export const PERIODS_REQUIRING_VALIDITY_DAYS: readonly TrainingPeriod[] =
  TRAINING_PERIODS.filter((p) => !(p in PERIOD_MONTHS));

/**
 * Free-text taxonomy, compared safely.
 *
 * `discipline` is text because MMAKF has published no closed list of them, and
 * an enum invented here would be this system writing the federation's taxonomy.
 * But an access check that compares "Shotokan " to "shotokan" and denies a
 * student their class is a defect with a very human cost, so every write and
 * every comparison goes through this one function.
 */
export function normaliseDiscipline(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ─── The period a product sells ─────────────────────────────────────────────

export type ValidityOutcome =
  | { ok: true; validFrom: string; validUntil: string; basis: string }
  | { ok: false; reason: string };

/**
 * BOTH DATES, or a refusal naming exactly what the federation has not stated.
 *
 * There is no third branch. No default, no fallback, no "a month seems right".
 * An entitlement with no end date is not a period, and the whole commercial
 * object here is "training, for the period paid for".
 */
export function productValidity(
  product: { period: TrainingPeriod; validityDays: number | null; code?: string },
  from: string
): ValidityOutcome {
  const start = isoDate(from);
  if (!start) return { ok: false, reason: 'No start date was supplied for the training period.' };

  const months = PERIOD_MONTHS[product.period];
  if (months != null) {
    return {
      ok: true,
      validFrom: start,
      validUntil: trainingTermEndsOn(start, months),
      basis: `${product.period} — ${months} whole month${months === 1 ? '' : 's'} from ${start}`,
    };
  }

  const days = product.validityDays;
  if (!Number.isInteger(days) || (days as number) < 1) {
    return {
      ok: false,
      reason:
        `Training product ${product.code ?? '(unnamed)'} is sold as '${product.period}', whose length only the ` +
        'federation can state, and it records no validity in days. This system will not choose one: a course that ' +
        'quietly ran for a month because a default said so would be MMAKF policy set by a constant. ' +
        'Record validityDays on the product.',
    };
  }

  return {
    ok: true,
    validFrom: start,
    validUntil: daysEndOn(start, days as number),
    basis: `${product.period} — ${days} day${days === 1 ? '' : 's'} from ${start}`,
  };
}

// ─── Authoring a product ────────────────────────────────────────────────────

export interface TrainingProductInput {
  code: string;
  slug: string;
  title: string;
  discipline: string;
  programme: string;
  period: TrainingPeriod;
  feeCode: string;
  serviceId?: number | null;
  ageGroupLabel?: string | null;
  ageMinYears?: number | null;
  ageMaxYears?: number | null;
  skillLevel?: string | null;
  clubId?: number | null;
  venueId?: number | null;
  coachCategory?: string | null;
  sessionsPerPeriod?: number | null;
  sessionDurationMinutes?: number | null;
  validityDays?: number | null;
  capacity?: number | null;
  summary?: string | null;
  description?: string | null;
  notes?: string | null;
  sortOrder?: number;
}

/**
 * Every key this module refuses outright, and refuses BY NAME.
 *
 * A training product has no price and never will: the amount lives in a
 * versioned, immutable `fee_frameworks` row and is reached through `fee_code`.
 * The type above already has no money field, but a type is a compile-time
 * promise and this function is reachable from an HTTP handler with a parsed JSON
 * body. So the object is checked at run time too, and an input carrying any of
 * these is REFUSED rather than silently dropped — a caller who sent a price
 * believes it was applied, and a silent drop would let them keep believing it.
 */
const FORBIDDEN_PRODUCT_KEYS = [
  'price', 'priceMinor', 'pricePaise', 'amount', 'amountMinor', 'amountPaise',
  'fee', 'feeMinor', 'feeAmount', 'cost', 'costMinor', 'total', 'totalMinor',
  'totalPaise', 'unitPrice', 'unitPricePaise', 'monthlyFee', 'discount',
  'discountMinor', 'tax', 'taxMinor', 'taxPaise', 'mrp',
];

function refuseMoneyKeys(input: Record<string, unknown>, where: string) {
  const found = FORBIDDEN_PRODUCT_KEYS.filter((k) =>
    Object.prototype.hasOwnProperty.call(input, k));
  if (found.length) {
    throw new TrainingProductError(
      'price_on_product',
      `${where} was given ${found.join(', ')}. A training product carries no amount — not a price, not a ` +
      '"from" figure, not an indicative range. The amount belongs to a versioned fee framework and is reached ' +
      'through feeCode, which is the only reason a 2027 price change cannot rewrite a 2026 invoice.'
    );
  }
}

/**
 * Record a product the federation may offer. DRAFT — it sells nothing yet.
 *
 * Gated on 'program:write': a training product IS the configured thing a client
 * receives, which is exactly what that action was minted for. Deliberately NOT
 * 'feeframework:write' — whoever describes a class must not thereby be able to
 * change what every class in the country costs — and deliberately not
 * 'engagement:write', which is the lead and client pipeline.
 */
export async function defineTrainingProduct(
  db: DB,
  ctx: AuditContext,
  input: TrainingProductInput
) {
  assertCan(ctx.principal, 'program:write', {});
  refuseMoneyKeys(input as unknown as Record<string, unknown>, 'defineTrainingProduct()');

  const code = String(input.code ?? '').trim();
  const slug = String(input.slug ?? '').trim();
  const title = String(input.title ?? '').trim();
  const discipline = normaliseDiscipline(input.discipline);
  const programme = String(input.programme ?? '').trim();
  const feeCode = String(input.feeCode ?? '').trim();

  if (!code || !slug || !title) {
    throw new TrainingProductError('incomplete', 'A training product needs a code, a slug and a title.');
  }
  if (!discipline || !programme) {
    throw new TrainingProductError(
      'incomplete',
      'A training product must say which discipline and which programme it belongs to. ' +
      'A student reading their own invoice has to be able to tell what they bought.'
    );
  }
  if (!TRAINING_PERIODS.includes(input.period)) {
    throw new TrainingProductError(
      'bad_period',
      `Unknown training period ${JSON.stringify(input.period)}. The federation's list is: ${TRAINING_PERIODS.join(', ')}. ` +
      'None of them is a subscription, deliberately.'
    );
  }
  if (!feeCode) {
    throw new TrainingProductError(
      'fee_code_required',
      'A training product must name the fee code the fee engine prices it by. It carries no amount of its own, ' +
      'so without a fee code nothing could ever price it and it could be published looking configured.'
    );
  }

  // The validity rule, checked at authoring time rather than at the till. A camp
  // with no stated length is a product that can be sold and cannot be delivered,
  // and discovering that when a parent has already paid is the expensive order.
  const probe = productValidity(
    { period: input.period, validityDays: input.validityDays ?? null, code },
    todayIso()
  );
  if (!probe.ok) throw new TrainingProductError('validity_not_stated', probe.reason);
  if (PERIOD_MONTHS[input.period] != null && input.validityDays != null) {
    throw new TrainingProductError(
      'validity_conflicts_with_period',
      `Product ${code} is sold as '${input.period}', whose length is arithmetic — ${PERIOD_MONTHS[input.period]} ` +
      'whole months — and it also states a validity in days. Two lengths for one period is an ambiguity somebody ' +
      'would eventually resolve in the federation\'s favour or the student\'s, and neither is this system\'s to choose.'
    );
  }

  const min = input.ageMinYears ?? null;
  const max = input.ageMaxYears ?? null;
  if (min != null && max != null && max < min) {
    throw new TrainingProductError('bad_age_band', `Age band ${min}–${max} runs backwards.`);
  }
  for (const [name, v] of [
    ['sessionsPerPeriod', input.sessionsPerPeriod], ['sessionDurationMinutes', input.sessionDurationMinutes],
    ['capacity', input.capacity], ['validityDays', input.validityDays],
  ] as const) {
    if (v != null && (!Number.isInteger(v) || v < 1)) {
      throw new TrainingProductError('bad_number', `${name} must be a whole number of at least 1, or absent.`);
    }
  }

  const [row] = await db.insert(s.trainingProducts).values({
    code, slug, title, discipline, programme,
    serviceId: input.serviceId ?? null,
    ageGroupLabel: input.ageGroupLabel ?? null,
    ageMinYears: min,
    ageMaxYears: max,
    skillLevel: input.skillLevel ?? null,
    clubId: input.clubId ?? null,
    venueId: input.venueId ?? null,
    coachCategory: input.coachCategory ?? null,
    period: input.period,
    sessionsPerPeriod: input.sessionsPerPeriod ?? null,
    sessionDurationMinutes: input.sessionDurationMinutes ?? null,
    validityDays: input.validityDays ?? null,
    capacity: input.capacity ?? null,
    feeCode,
    status: 'draft',
    summary: input.summary ?? null,
    description: input.description ?? null,
    notes: input.notes ?? null,
    sortOrder: input.sortOrder ?? 100,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'training_product', entityId: row.id, action: 'create',
    newValue: { code, discipline, programme, period: input.period, feeCode },
  });
  return row;
}

/**
 * Put a product on offer.
 *
 * A SEPARATE ACTION from writing one — 'program:publish' — for the reason
 * src/db/fees.ts gives about publishing a framework: the person who drafts what
 * the federation offers and the person who decides it may be offered can be two
 * people, and under one action they could not be.
 *
 * IT DOES NOT REQUIRE A PUBLISHED FEE FRAMEWORK, deliberately. Describing what
 * MMAKF teaches is not the same act as pricing it, and blocking the description
 * on the price would leave the federation unable to say what it offers until it
 * has decided what to charge. What it cannot do is SELL: `grantTraining()`
 * refuses without a price version, so a published product with no framework
 * behind it shows a student what is on offer and "the federation has not
 * published a fee for this" beside it — which is true.
 */
export async function publishTrainingProduct(db: DB, ctx: AuditContext, productId: number) {
  assertCan(ctx.principal, 'program:publish', {});
  const product = await productById(db, productId);
  if (product.status === 'published') {
    throw new TrainingProductError('already_published', `Product ${product.code} is already published.`);
  }
  if (product.status === 'withdrawn') {
    throw new TrainingProductError(
      'withdrawn',
      `Product ${product.code} was withdrawn. Define a new product rather than reviving this one — the entitlements ` +
      'sold under it name it by id, and a withdrawn product coming back with different terms would re-describe them.'
    );
  }

  // The fee code must be something the catalogue knows about. A product naming a
  // code no fee entry carries can never be priced, and would sit published,
  // unsellable, looking configured — the exact failure `FEE_NOT_CONFIGURED`
  // exists to make visible elsewhere.
  const [entry] = await db.select({ code: s.feeCatalogueEntries.code })
    .from(s.feeCatalogueEntries)
    .where(eq(s.feeCatalogueEntries.code, product.feeCode)).limit(1);
  if (!entry) {
    throw new TrainingProductError(
      'fee_code_unknown',
      `Product ${product.code} prices by fee code '${product.feeCode}', which is not in the fee catalogue. ` +
      'Add the chargeable service first — a product whose fee code nothing recognises can never be priced, ' +
      'and publishing it would put something unsellable in front of a parent.'
    );
  }

  const [row] = await db.update(s.trainingProducts)
    .set({
      status: 'published',
      publishedAt: new Date(),
      publishedByUserId: ctx.principal.userId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(s.trainingProducts.id, productId), eq(s.trainingProducts.status, 'draft')))
    .returning();
  if (!row) throw new TrainingProductError('already_decided', 'This product was published by somebody else a moment ago.');

  await writeAudit(db, ctx, {
    entityType: 'training_product', entityId: productId, action: 'approve',
    oldValue: { status: 'draft' }, newValue: { status: 'published', feeCode: product.feeCode },
  });
  return row;
}

/**
 * Stop offering a product. IT DOES NOT TOUCH THE ENTITLEMENTS SOLD UNDER IT.
 *
 * Everyone who bought it keeps training until their period ends. A withdrawal
 * that revoked live entitlements would be the federation taking back something
 * a parent has already paid for, which is a refund decision and belongs to a
 * human with `revokeTraining()` and a reason.
 */
export async function withdrawTrainingProduct(
  db: DB, ctx: AuditContext, productId: number, reason: string
) {
  assertCan(ctx.principal, 'program:publish', {});
  const why = String(reason ?? '').trim();
  if (why.length < 4) {
    throw new TrainingProductError('reason_required', 'A withdrawal must say why. Somebody will ask in a year.');
  }
  const product = await productById(db, productId);
  const [row] = await db.update(s.trainingProducts)
    .set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnReason: why, updatedAt: new Date() })
    .where(eq(s.trainingProducts.id, productId))
    .returning();

  await writeAudit(db, { ...ctx, reason: why }, {
    entityType: 'training_product', entityId: productId, action: 'revoke',
    oldValue: { status: product.status }, newValue: { status: 'withdrawn' },
  });
  return row;
}

async function productById(db: DB, productId: number) {
  const [row] = await db.select().from(s.trainingProducts)
    .where(eq(s.trainingProducts.id, productId)).limit(1);
  if (!row) throw new TrainingProductError('unknown_product', 'No such training product.');
  return row;
}

/** Products a student may actually be sold. Draft and withdrawn are excluded. */
export async function publishedProducts(
  db: DB,
  filter: { discipline?: string | null; clubId?: number | null; period?: TrainingPeriod | null } = {}
) {
  const where: any[] = [eq(s.trainingProducts.status, 'published')];
  if (filter.discipline) where.push(eq(s.trainingProducts.discipline, normaliseDiscipline(filter.discipline)));
  if (filter.clubId != null) {
    // A federation-wide product (null club) is offered AT every club, so it is
    // included rather than filtered out. Excluding it would make a club's list
    // of what it can sell shorter than the truth.
    where.push(or(eq(s.trainingProducts.clubId, filter.clubId), isNull(s.trainingProducts.clubId)));
  }
  if (filter.period) where.push(eq(s.trainingProducts.period, filter.period));
  return db.select().from(s.trainingProducts).where(and(...where))
    .orderBy(asc(s.trainingProducts.sortOrder), asc(s.trainingProducts.id));
}

// ─── What it costs — asked of the fee engine, never of this table ───────────

export type TrainingPrice =
  | {
      priced: true;
      frameworkId: number;
      frameworkCode: string;
      frameworkVersion: number;
      totalMinor: number;
      currency: string;
      formatted: string;
      computation: Awaited<ReturnType<typeof computeFee>>;
    }
  | { priced: false; reason: string; computation?: Awaited<ReturnType<typeof computeFee>> };

/**
 * What this product costs, today, according to the published framework.
 *
 * THE ONLY HONEST ANSWER TODAY IS "THE FEDERATION HAS NOT PUBLISHED A FEE FOR
 * THIS", and this function gives it. It never returns 0 — zero reads as free —
 * and it never borrows a benchmark from another federation. `priced: false` is
 * a discriminated union member with NO amount field on it at all, so a caller
 * cannot render an unpriced result as a number even by accident.
 *
 * The server computes. `inputs` may carry counts and selections; it may not
 * carry a price, and `computeFee()` would refuse a reduction that had not come
 * from src/db/discounts.ts even if it did.
 */
export async function priceTrainingProduct(
  db: DB,
  productId: number,
  inputs: FeeInputs = {},
  at?: Date | string | null
): Promise<TrainingPrice> {
  const product = await productById(db, productId);
  const asAt = todayIso(at);

  const framework = await activeFramework(db, asAt);
  if (!framework) {
    return {
      priced: false,
      reason:
        'The federation has not published a fee framework, so there is no amount to show for ' +
        `${product.title}. This is not zero and it is not free — it is a price MMAKF has not yet set. ` +
        'The federation office prepares a figure on request.',
    };
  }

  const computation = await computeFee(db, framework.id, {
    ...inputs,
    // The server supplies the two facts that decide which rule fires. A client
    // that sent a different fee code would be choosing its own price.
    serviceCode: product.feeCode,
    discipline: product.discipline,
    trainingPeriod: product.period,
  });

  if (computation.requiresManualQuote) {
    return {
      priced: false,
      reason: computation.manualReason ??
        'No published fee rule covers this combination of requirements. The federation office prepares a quotation for it.',
      computation,
    };
  }

  return {
    priced: true,
    frameworkId: framework.id,
    frameworkCode: framework.code,
    frameworkVersion: framework.version,
    totalMinor: computation.totalMinor,
    currency: computation.currency,
    formatted: formatINR(computation.totalMinor),
    computation,
  };
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface TrainingPlanInput {
  personId: number;
  productId: number;
  clubId?: number | null;
  startsOn: string;
  renewalMode?: TrainingRenewalMode;
  notes?: string | null;
}

/**
 * Open a training plan — what this person committed to.
 *
 * NO MONEY MOVES HERE and no entitlement is created. A plan is the agreement;
 * the entitlement is what a verified payment turns it into. Keeping the two
 * apart is what lets a club enrol a student on Monday and take the payment on
 * Friday without either inventing an entitlement with no payment behind it or
 * pretending the agreement did not exist for four days.
 *
 * `renewing` records an INTENTION, not a mandate. Nothing in this system takes
 * money without a fresh server-verified capture, so a renewing plan produces a
 * renewal notice and an invitation to pay — never a charge.
 */
export async function openTrainingPlan(db: DB, ctx: AuditContext, input: TrainingPlanInput) {
  assertCan(ctx.principal, 'program:write', {});
  refuseMoneyKeys(input as unknown as Record<string, unknown>, 'openTrainingPlan()');

  const product = await productById(db, input.productId);
  if (product.status !== 'published') {
    throw new TrainingProductError(
      'product_not_published',
      `Training product ${product.code} is ${product.status}. Only a published product may be sold — ` +
      'a draft is something the federation is still deciding about.'
    );
  }
  const startsOn = isoDate(input.startsOn);
  if (!startsOn) throw new TrainingProductError('bad_start', 'A plan must state the day training starts.');

  // The club the plan is trained at must be one the product is offered at. A
  // club-specific product sold at another club is a timetable that does not
  // exist, discovered by a child standing outside a locked hall.
  const clubId = input.clubId ?? product.clubId ?? null;
  if (product.clubId != null && clubId !== product.clubId) {
    throw new TrainingProductError(
      'club_mismatch',
      `Product ${product.code} is offered at one club only, and this plan names a different one.`
    );
  }

  const ref = await allocateFederationId(db, 'TPL', new Date().getUTCFullYear());
  try {
    const [row] = await db.insert(s.trainingPlans).values({
      ref,
      personId: input.personId,
      productId: product.id,
      clubId,
      status: 'proposed',
      period: product.period,
      renewalMode: input.renewalMode ?? 'one_off',
      startsOn,
      openedByUserId: ctx.principal.userId ?? null,
      notes: input.notes ?? null,
    }).returning();

    await writeAudit(db, ctx, {
      entityType: 'training_plan', entityId: row.id, action: 'create',
      newValue: { ref, personId: input.personId, product: product.code, clubId, period: product.period },
    });
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // `training_plans_live_uk`. Not a race to swallow: a second live plan for
    // the same person, product and club is somebody opening a duplicate, and
    // continuing would give them two invoices for one class.
    throw new TrainingProductError(
      'plan_already_live',
      'This person already holds a live plan for that product at that club. ' +
      'Renew the existing plan rather than opening a second one — two plans is two invoices for one class.'
    );
  }
}

// ─── Payment becomes the right to train ─────────────────────────────────────

export interface TrainingActivationOutcome {
  orderLineId: number;
  entitlementId: number | null;
  status: 'active' | 'blocked' | 'replayed' | 'not_training';
  validFrom: string | null;
  validUntil: string | null;
  reason: string | null;
}

export interface TrainingActivationReport {
  orderId: number;
  paymentId: number;
  granted: number;
  blocked: number;
  replayed: number;
  outcomes: TrainingActivationOutcome[];
}

/**
 * Turn a paid order's training lines into rights to train.
 *
 * THE GATE IS A PAYMENT ROW THIS SYSTEM MARKED `captured`, and there is no
 * parameter that substitutes for it. `confirmPayment()` only sets that status
 * after checking the provider's own record for status, amount and currency, so a
 * browser posting "payment succeeded" reaches nothing here. `payment_id` is NOT
 * NULL in the schema, so no future caller can invent one either.
 *
 * A training line is one of:
 *   refType 'training_plan'    → the plan names the person, product and club
 *   refType 'training_product' → a one-off purchase with no standing plan
 *
 * Anything else on the order is somebody else's job and is reported as
 * `not_training` rather than skipped in silence.
 */
export async function activateTrainingForOrder(
  db: DB,
  ctx: AuditContext | null,
  orderId: number,
  opts: { now?: Date } = {}
): Promise<TrainingActivationReport> {
  const now = opts.now ?? new Date();

  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1);
  if (!order) throw new TrainingProductError('unknown_order', 'Unknown order.');

  const [payment] = await db.select().from(s.payments)
    .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')))
    .orderBy(desc(s.payments.id)).limit(1);
  if (!payment) {
    throw new TrainingProductError(
      'no_verified_payment',
      `Order ${order.orderNo} has no payment this system has verified as captured. A right to train is created ` +
      'only from a server-verified capture — a browser reporting success is a claim, not a fact.'
    );
  }
  if (order.status !== 'paid' && order.status !== 'fulfilled') {
    throw new TrainingProductError(
      'order_not_paid',
      `Order ${order.orderNo} carries a captured payment but its status is '${order.status}'. ` +
      'That is an incomplete confirmation, and it needs a human rather than an entitlement.'
    );
  }

  const [invoice] = await db.select({ id: s.invoices.id }).from(s.invoices)
    .where(eq(s.invoices.orderId, order.id)).limit(1);
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));

  const activationCtx = systemTrainingContext(ctx);
  const priceVersion = await priceVersionFor(db, order, payment, now);
  const outcomes: TrainingActivationOutcome[] = [];

  for (const line of lines) {
    if (line.kind !== 'training') {
      outcomes.push({
        orderLineId: line.id, entitlementId: null, status: 'not_training',
        validFrom: null, validUntil: null,
        reason: `A ${line.kind} line is not training; src/db/entitlements.ts decides what it entitles.`,
      });
      continue;
    }
    outcomes.push(await grantOneLine(db, activationCtx, {
      order, line, payment, invoiceId: invoice?.id ?? null, priceVersion, now,
    }));
  }

  return {
    orderId: order.id,
    paymentId: payment.id,
    granted: outcomes.filter((o) => o.status === 'active').length,
    blocked: outcomes.filter((o) => o.status === 'blocked').length,
    replayed: outcomes.filter((o) => o.status === 'replayed').length,
    outcomes,
  };
}

/**
 * The authority a grant is performed under.
 *
 * A webhook arrives at three in the morning with no human behind it, and the
 * write it causes is a right to train. This principal is CONSTRUCTED HERE and is
 * never derived from a request — no header, cookie, body field or webhook
 * payload can cause a caller to be treated as the system. Same device and same
 * reasoning as `systemEntitlementPrincipal()` in src/db/entitlements.ts.
 */
export function systemTrainingPrincipal(): Principal {
  return {
    userId: null,
    label: 'system:training-activation',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };
}

export function systemTrainingContext(from?: AuditContext | null): AuditContext {
  return {
    principal: systemTrainingPrincipal(),
    ip: from?.ip ?? null,
    requestId: from?.requestId ?? null,
    reason: 'Training granted from a server-verified payment capture.',
    authority: from?.authority ?? 'MMAKF training service',
  };
}

interface PriceVersion {
  frameworkId: number | null;
  frameworkCode: string | null;
  frameworkVersion: number | null;
  quoteVersionId: number | null;
  reason: string | null;
}

/**
 * WHICH RULEBOOK EDITION THIS CHARGE WAS MADE UNDER.
 *
 * Two sources, in this order and for this reason:
 *
 *  1. THE QUOTATION THE ORDER CAME FROM. Where an accepted quote produced this
 *     order, the framework it was computed against is the one the customer
 *     agreed to, and it beats anything read from today's calendar. A quotation
 *     accepted in March and paid in April must not silently acquire April's
 *     framework — that is a different price, agreed by nobody.
 *
 *  2. THE FRAMEWORK IN FORCE ON THE DAY THE MONEY WAS TAKEN. Not today: a
 *     reconcile sweep three days later must not re-version what was bought.
 *
 * AND THERE IS NO THIRD. Where neither exists the grant is BLOCKED with the
 * reason, because an entitlement whose price version nobody can name is a charge
 * the federation cannot defend, and that is the entire property this column set
 * was added for.
 */
async function priceVersionFor(db: DB, order: any, payment: any, now: Date): Promise<PriceVersion> {
  const none = (reason: string): PriceVersion => ({
    frameworkId: null, frameworkCode: null, frameworkVersion: null, quoteVersionId: null, reason,
  });

  const [link] = await db.select({ quoteVersionId: qo.quotePaymentLinks.quoteVersionId })
    .from(qo.quotePaymentLinks)
    .where(eq(qo.quotePaymentLinks.orderId, order.id)).limit(1);

  if (link?.quoteVersionId) {
    const [qv] = await db.select({
      id: s.quoteVersions.id,
      frameworkId: s.quoteVersions.frameworkId,
      frameworkCode: s.quoteVersions.frameworkCode,
    }).from(s.quoteVersions).where(eq(s.quoteVersions.id, link.quoteVersionId)).limit(1);
    if (qv?.frameworkId) {
      const [fw] = await db.select({ version: s.feeFrameworks.version })
        .from(s.feeFrameworks).where(eq(s.feeFrameworks.id, qv.frameworkId)).limit(1);
      return {
        frameworkId: qv.frameworkId,
        frameworkCode: qv.frameworkCode,
        frameworkVersion: fw?.version ?? null,
        quoteVersionId: qv.id,
        reason: null,
      };
    }
  }

  const paidOn = isoDate(payment.capturedAt ?? payment.createdAt ?? now)!;
  const framework = await activeFramework(db, paidOn);
  if (!framework) {
    return none(
      `MMAKF has published no fee framework in force on ${paidOn}, so there is no price version to record against ` +
      'this payment. A right to train whose rulebook edition nobody can name is a charge the federation cannot ' +
      'defend years later, so nothing was granted. The money stays taken and this row is the finance desk\'s ' +
      'record of it — refund it, or publish the framework and re-run the activation.'
    );
  }
  return {
    frameworkId: framework.id,
    frameworkCode: framework.code,
    frameworkVersion: framework.version,
    quoteVersionId: null,
    reason: null,
  };
}

interface GrantContext {
  order: any;
  line: any;
  payment: any;
  invoiceId: number | null;
  priceVersion: PriceVersion;
  now: Date;
}

/**
 * One line, one entitlement, claimed by a unique index.
 *
 * The row is INSERTED FIRST and everything else follows, so a replayed webhook
 * loses the race on `training_entitlements_order_line_uk` and rolls its whole
 * transaction back rather than granting a second term. A check-then-insert could
 * not do this: two confirmations arriving in the same millisecond both read "no
 * entitlement yet".
 */
async function grantOneLine(db: DB, ctx: AuditContext, c: GrantContext): Promise<TrainingActivationOutcome> {
  try {
    return await db.transaction(async (tx: DB) => grantInTx(tx, ctx, c));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [existing] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.orderLineId, c.line.id)).limit(1);
    if (existing) {
      // WHAT THE ROW ACTUALLY IS, not what losing a race feels like. This
      // previously answered 'replayed' whatever it found, so a line whose row
      // said BLOCKED — money taken, nothing granted — was reported back as
      // "already granted, nothing issued twice". A reconcile sweep reading that
      // would tick the payment off as done, and the student who paid would be
      // ticked off with it.
      const wasBlocked = existing.status === 'blocked';
      return {
        orderLineId: c.line.id,
        entitlementId: existing.id,
        status: wasBlocked ? 'blocked' : 'replayed',
        validFrom: isoDate(existing.validFrom),
        validUntil: isoDate(existing.validUntil),
        reason: wasBlocked
          ? (existing.reason ?? 'This payment granted nothing and the reason was not recorded.')
          : 'This line was already granted; nothing was issued a second time.',
      };
    }
    throw err;
  }
}

async function grantInTx(tx: DB, ctx: AuditContext, c: GrantContext): Promise<TrainingActivationOutcome> {
  const { line, order, payment, priceVersion } = c;

  // ── Resolve what was bought ──
  let plan: any = null;
  let product: any = null;

  if (line.refType === 'training_plan' && line.refId != null) {
    [plan] = await tx.select().from(s.trainingPlans).where(eq(s.trainingPlans.id, line.refId)).limit(1);
    if (plan) {
      [product] = await tx.select().from(s.trainingProducts)
        .where(eq(s.trainingProducts.id, plan.productId)).limit(1);
    }
  } else if (line.refType === 'training_product' && line.refId != null) {
    [product] = await tx.select().from(s.trainingProducts)
      .where(eq(s.trainingProducts.id, line.refId)).limit(1);
  }

  if (!product) {
    // NOT an exception. Money was taken and this system cannot say what for;
    // that is a fact the finance desk has to be able to find, and an exception
    // thrown out of a webhook loses it.
    return blocked(tx, ctx, c, null, null,
      `Order line ${line.id} is billed as training but names no training product this system can find ` +
      `(refType '${line.refType ?? 'none'}', refId ${line.refId ?? 'none'}). Nothing was granted.`);
  }

  const personId = plan?.personId ?? order.personId ?? null;
  if (personId == null) {
    return blocked(tx, ctx, c, product, plan,
      'The order names no person and the line carries no plan, so there is nobody to grant training to. ' +
      'A right to train belongs to a named individual; granting it to an order would make it unenforceable at the door.');
  }

  // ── The period ──
  //
  // FIRST TERM: from the plan's own start date where there is one — that is the
  // day the club and the student agreed training begins — and from the day the
  // money was taken otherwise. A reconcile sweep three days later must not
  // shorten what was bought.
  const paidOn = isoDate(payment.capturedAt ?? payment.createdAt ?? c.now)!;

  // EVERY TERM AFTER IT: the day after the last one ends.
  //
  // Now that the payment path calls this function (see activate() in
  // src/db/orders.ts), the SECOND month a family pays for arrives here and not
  // through renewTraining(). Dating it from `plan.starts_on` would have handed
  // the child a term beginning on the day they first joined — a second term
  // overlapping the first almost entirely, and a month paid for and never
  // delivered. So the rule renewTraining() states is applied here too: the new
  // term begins THE DAY AFTER the last one ends, or on the day the money was
  // taken where the last one had already lapsed, so there is never a gap the
  // student paid for and never a day of double cover.
  //
  // The chain is recorded rather than implied, so a person's training reads as
  // a sequence of terms with their own dates and their own price versions, and
  // `training_entitlements_renewal_chain_uk` stops two payments both claiming the
  // same predecessor — a retried webhook extends the term once.
  //
  // Matched on the PLAN where the line names one, because that is the standing
  // arrangement being continued; on the PERSON AND PRODUCT otherwise, because a
  // one-off second purchase of the same classes is the same act without the
  // paperwork. The LATEST live term wins, so a new purchase can never land on
  // top of one somebody is already using.
  const [previousTerm] = await tx.select().from(s.trainingEntitlements)
    .where(and(
      eq(s.trainingEntitlements.personId, personId),
      eq(s.trainingEntitlements.status, 'active'),
      plan
        ? eq(s.trainingEntitlements.planId, plan.id)
        : eq(s.trainingEntitlements.productId, product.id),
    ))
    .orderBy(desc(s.trainingEntitlements.validUntil))
    .limit(1);

  const previousEnd = previousTerm ? isoDate(previousTerm.validUntil) : null;
  const startsOn = previousEnd
    ? (previousEnd >= paidOn ? dayAfter(previousEnd) : paidOn)
    : (isoDate(plan?.startsOn) ?? paidOn);

  const validity = productValidity(product, startsOn);
  if (!validity.ok) {
    return blocked(tx, ctx, c, product, plan, validity.reason);
  }

  // ── The price version ──
  if (priceVersion.frameworkId == null) {
    return blocked(tx, ctx, c, product, plan, priceVersion.reason ?? 'No price version could be established.');
  }

  // ── A ROW MAY ALREADY BE SITTING ON THIS LINE, AND IT MAY BE A BLOCKED ONE ──
  //
  // `training_entitlements_order_line_uk` is unique on order_line_id and is not
  // partial, so the BLOCKED row this function writes when it cannot establish a
  // price version occupies the same slot a grant would. The consequence was
  // that a block became permanent: today MMAKF has published no framework, so
  // EVERY training payment blocks, and re-running the activation after the
  // framework is finally published — the cure priceVersionFor()'s own message
  // tells the finance desk to apply — collided with the blocked row and
  // reported "already granted". The money stayed taken, the student stayed off
  // the mat, and the only remaining remedy was a refund.
  //
  // So a blocked row is RESOLVED IN PLACE. That is not rewriting history: the
  // payment, the invoice and the ledger are untouched and unreadable from here,
  // and this row is not an accounting record — it is this system's own note of
  // what it had issued so far, which was nothing. The update is CLAIMED
  // (`status = 'blocked'` repeated in the WHERE) so two sweeps running together
  // cannot both grant, the original refusal is kept in `detail` rather than
  // discarded, and the audit trail carries both states.
  const [prior] = await tx.select({
    id: s.trainingEntitlements.id,
    status: s.trainingEntitlements.status,
    reason: s.trainingEntitlements.reason,
  }).from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.orderLineId, line.id)).limit(1);

  const values = {
    planId: plan?.id ?? null,
    personId,
    productId: product.id,
    // FROZEN COPIES. A product edited in 2027 must not re-describe this purchase.
    discipline: product.discipline,
    programme: product.programme,
    clubId: plan?.clubId ?? product.clubId ?? null,
    servicedByClubId: null,
    venueId: product.venueId ?? null,
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    status: 'active',
    orderId: order.id,
    orderLineId: line.id,
    paymentId: payment.id,
    invoiceId: c.invoiceId,
    priceFrameworkId: priceVersion.frameworkId,
    priceFrameworkCode: priceVersion.frameworkCode,
    priceFrameworkVersion: priceVersion.frameworkVersion,
    quoteVersionId: priceVersion.quoteVersionId,
    // The amount the LINE was charged, copied from the order. Not recomputed:
    // the order is the authority for what was taken, and recomputing here would
    // make a 2027 framework able to re-state a 2026 receipt.
    amountPaidMinor: line.totalPaise,
    currency: order.currency ?? 'INR',
    renewedFromEntitlementId: previousTerm?.id ?? null,
    renewalSequence: (previousTerm?.renewalSequence ?? 0) + 1,
    grantedBy: ctx.principal.label,
    detail: {
      basis: validity.basis,
      paidOn,
      feeCode: product.feeCode,
      priceVersionSource: priceVersion.quoteVersionId ? 'accepted_quotation' : 'framework_in_force_on_payment_date',
      ...(previousTerm ? { renewedFrom: previousTerm.id, previousTermEnded: previousEnd } : {}),
      ...(prior?.status === 'blocked'
        ? { resolvedFromBlocked: prior.reason ?? null, resolvedAt: new Date().toISOString() }
        : {}),
    },
  };

  let row: any;
  if (prior?.status === 'blocked') {
    [row] = await tx.update(s.trainingEntitlements)
      // `reason` returns to null because the row no longer refuses anything —
      // `training_entitlements_reason_ck` only demands one of a row that is not
      // active — and the sentence it held is preserved in `detail` above.
      .set({ ...values, reason: null, grantedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(s.trainingEntitlements.id, prior.id),
        eq(s.trainingEntitlements.status, 'blocked'),
      ))
      .returning();
    if (!row) {
      // Another sweep resolved it a moment ago. It is granted; it is not
      // granted twice.
      const [now] = await tx.select().from(s.trainingEntitlements)
        .where(eq(s.trainingEntitlements.id, prior.id)).limit(1);
      return {
        orderLineId: line.id,
        entitlementId: prior.id,
        status: 'replayed',
        validFrom: isoDate(now?.validFrom),
        validUntil: isoDate(now?.validUntil),
        reason: 'This line was granted by another run a moment ago; nothing was issued a second time.',
      };
    }
  } else {
    [row] = await tx.insert(s.trainingEntitlements).values(values).returning();
  }

  if (plan) {
    await tx.update(s.trainingPlans)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(s.trainingPlans.id, plan.id), eq(s.trainingPlans.status, 'proposed')));
  }

  const resolved = prior?.status === 'blocked';
  await writeAudit(tx, ctx, {
    entityType: 'training_entitlement', entityId: row.id,
    action: resolved ? 'update' : 'create',
    oldValue: resolved ? { status: 'blocked', reason: prior?.reason ?? null } : undefined,
    newValue: {
      personId, product: product.code, validFrom: validity.validFrom, validUntil: validity.validUntil,
      priceFramework: priceVersion.frameworkCode, priceFrameworkVersion: priceVersion.frameworkVersion,
      amountPaidMinor: line.totalPaise,
    },
  });

  await publish(tx, {
    eventType: 'TRAINING_ENTITLEMENT_GRANTED',
    entityType: 'training_entitlement',
    entityId: row.id,
    payload: {
      personId,
      entitlementId: row.id,
      productId: product.id,
      productCode: product.code,
      discipline: product.discipline,
      programme: product.programme,
      clubId: row.clubId,
      validFrom: validity.validFrom,
      validUntil: validity.validUntil,
      priceFrameworkCode: priceVersion.frameworkCode,
      priceFrameworkVersion: priceVersion.frameworkVersion,
    },
    actor: ctx.principal,
    // The order LINE, not the order: an order with two training lines is two
    // grants and must be two events on the feed.
    correlationId: `training-granted:${line.id}`,
  });

  return {
    orderLineId: line.id,
    entitlementId: row.id,
    status: 'active',
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    reason: resolved
      ? `A payment that had been blocked is now granted. What was missing: ${prior?.reason ?? 'not recorded'}`
      : null,
  };
}

/** Record that money arrived and nothing could be granted, with the reason. */
async function blocked(
  tx: DB, ctx: AuditContext, c: GrantContext,
  product: any, plan: any, reason: string
): Promise<TrainingActivationOutcome> {
  // ALREADY BLOCKED, AND STILL BLOCKED. A second sweep with the blocker still
  // in place must report the same fact, not fail on the unique index and be
  // rescued into the wrong answer by the caller's catch. THE FIRST REASON IS
  // KEPT: it is the record of what was true when the money arrived, and a later
  // run rephrasing it would quietly restate history.
  const [already] = await tx.select().from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.orderLineId, c.line.id)).limit(1);
  if (already) {
    return {
      orderLineId: c.line.id,
      entitlementId: already.id,
      status: already.status === 'blocked' ? 'blocked' : 'replayed',
      validFrom: isoDate(already.validFrom),
      validUntil: isoDate(already.validUntil),
      reason: already.status === 'blocked' ? (already.reason ?? reason) : null,
    };
  }

  const [row] = await tx.insert(s.trainingEntitlements).values({
    planId: plan?.id ?? null,
    // NULL RATHER THAN A PLACEHOLDER. A blocked row records that money arrived
    // and nothing was granted; where this system genuinely cannot say who or
    // what for, the honest column value is null. '(unresolved)' would read as
    // data on every report that ever joined it, and the CHECK constraint keeps
    // these nulls out of every ACTIVE row anyway.
    personId: plan?.personId ?? c.order.personId ?? null,
    productId: product?.id ?? null,
    discipline: product?.discipline ?? null,
    programme: product?.programme ?? null,
    clubId: plan?.clubId ?? product?.clubId ?? null,
    validFrom: null,
    validUntil: null,
    status: 'blocked',
    orderId: c.order.id,
    orderLineId: c.line.id,
    paymentId: c.payment.id,
    invoiceId: c.invoiceId,
    amountPaidMinor: c.line.totalPaise,
    currency: c.order.currency ?? 'INR',
    grantedBy: ctx.principal.label,
    reason,
    detail: { refType: c.line.refType ?? null, refId: c.line.refId ?? null },
  }).returning();

  await writeAudit(tx, { ...ctx, reason }, {
    entityType: 'training_entitlement', entityId: row.id, action: 'reject',
    newValue: { status: 'blocked', orderLineId: c.line.id, amountPaidMinor: c.line.totalPaise },
  });

  return {
    orderLineId: c.line.id,
    entitlementId: row.id,
    status: 'blocked',
    validFrom: null,
    validUntil: null,
    reason,
  };
}

/**
 * Paid training that granted nothing. The finance desk's queue.
 *
 * Money was taken and the student got nothing, which is the one state this whole
 * design exists to make impossible to lose. It is a `finance:read` question
 * because the answer is "refund these", not "fix these classes".
 */
export async function blockedTraining(db: DB, principal: Principal, limit = 100) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select({
    id: s.trainingEntitlements.id,
    personId: s.trainingEntitlements.personId,
    productId: s.trainingEntitlements.productId,
    orderId: s.trainingEntitlements.orderId,
    orderLineId: s.trainingEntitlements.orderLineId,
    paymentId: s.trainingEntitlements.paymentId,
    amountPaidMinor: s.trainingEntitlements.amountPaidMinor,
    reason: s.trainingEntitlements.reason,
    createdAt: s.trainingEntitlements.createdAt,
  })
    .from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.status, 'blocked'))
    .orderBy(desc(s.trainingEntitlements.id))
    .limit(limit);
}

// ─── THE ACCESS DECISION ────────────────────────────────────────────────────

export interface TrainingAccessQuery {
  personId: number;
  /** Narrow to one club. Omitted asks "may they train anywhere at all". */
  clubId?: number | null;
  productId?: number | null;
  discipline?: string | null;
  /** The instant to decide as at. Defaults to now — this call's own now. */
  at?: Date | string | null;
}

export interface TrainingAccessGrant {
  entitlementId: number;
  productId: number;
  discipline: string;
  programme: string;
  /** Where it is delivered — `serviced_by_club_id` if a transfer moved it. */
  clubId: number | null;
  /** Where it was bought. Never rewritten, even by a transfer. */
  purchasedAtClubId: number | null;
  validFrom: string;
  validUntil: string;
  daysRemaining: number;
}

export interface TrainingAccessDecision {
  allowed: boolean;
  /** In words, for the surface that has to explain a refusal to a parent. */
  reason: string;
  grants: TrainingAccessGrant[];
  checkedAt: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE FUNCTION EVERY SURFACE CALLS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MAY THIS PERSON TRAIN? Decided by their training entitlements and by nothing
 * else. There is NO MEMBERSHIP CHECK in this function, in its helpers, or
 * anywhere in this file. A student in good standing on the mat has a valid
 * entitlement; whether the federation's register lists them as a member is a
 * question about coaches, officials and clubs, and it is not asked here.
 *
 * THE COMPARISON HAPPENS IN SQL, AT THE MOMENT OF THE REQUEST. There is no
 * `active` boolean to fall out of date and no sweep to expire anything, so an
 * entitlement stops opening the door the moment it lapses — not at the next
 * cron run, not when somebody notices. `valid_until` is the inclusive last day,
 * so the right to train ends when that day does.
 *
 * A REFUSAL IS EXPLAINED. `reason` is a sentence a club can read to a parent,
 * because "access denied" at a dojo door is a child who has been turned away
 * and an adult who needs to know why.
 */
export async function trainingAccess(
  db: DB,
  q: TrainingAccessQuery
): Promise<TrainingAccessDecision> {
  const at = todayIso(q.at);

  const where: any[] = [
    eq(s.trainingEntitlements.personId, q.personId),
    // 'active' only. A revoked entitlement grants nothing and a blocked one
    // never granted anything — and both keep their rows, which is why the
    // status filter is here rather than the rows being gone.
    eq(s.trainingEntitlements.status, 'active'),
    // `lte`/`gte` against the DATE columns, evaluated by Postgres on this
    // request. Not a stored flag, not a nightly sweep: the right to train ends
    // when `valid_until` ends, at the moment somebody asks.
    lte(s.trainingEntitlements.validFrom, at),
    gte(s.trainingEntitlements.validUntil, at),
  ];
  if (q.productId != null) where.push(eq(s.trainingEntitlements.productId, q.productId));
  if (q.discipline) {
    where.push(eq(s.trainingEntitlements.discipline, normaliseDiscipline(q.discipline)));
  }
  if (q.clubId != null) {
    // WHERE IT IS DELIVERED, not where it was bought. A transfer sets
    // `serviced_by_club_id` and leaves `club_id` alone, so the coalesce is what
    // makes a transferred student able to train at their new club without the
    // record of the old purchase being edited.
    where.push(sql`coalesce(${s.trainingEntitlements.servicedByClubId}, ${s.trainingEntitlements.clubId}) = ${q.clubId}`);
  }

  const rows = await db.select({
    id: s.trainingEntitlements.id,
    productId: s.trainingEntitlements.productId,
    discipline: s.trainingEntitlements.discipline,
    programme: s.trainingEntitlements.programme,
    clubId: s.trainingEntitlements.clubId,
    servicedByClubId: s.trainingEntitlements.servicedByClubId,
    validFrom: s.trainingEntitlements.validFrom,
    validUntil: s.trainingEntitlements.validUntil,
  })
    .from(s.trainingEntitlements)
    .where(and(...where))
    .orderBy(asc(s.trainingEntitlements.validUntil));

  const grants: TrainingAccessGrant[] = rows.map((r: any) => ({
    entitlementId: r.id,
    productId: r.productId,
    discipline: r.discipline,
    programme: r.programme,
    clubId: r.servicedByClubId ?? r.clubId ?? null,
    purchasedAtClubId: r.clubId ?? null,
    validFrom: isoDate(r.validFrom)!,
    validUntil: isoDate(r.validUntil)!,
    daysRemaining: daysBetween(at, isoDate(r.validUntil)!),
  }));

  if (grants.length) {
    const last = grants[grants.length - 1];
    return {
      allowed: true,
      reason: `A valid training entitlement covers ${at}${
        last ? `, running to ${last.validUntil}` : ''}.`,
      grants,
      checkedAt: at,
    };
  }

  return {
    allowed: false,
    reason: await explainRefusal(db, q, at),
    grants: [],
    checkedAt: at,
  };
}

/**
 * Why not — from the record, and never from a membership.
 *
 * Four different refusals, because they need four different actions from the
 * person on the desk: renew, wait, contact the office, or buy. Collapsing them
 * into "no valid entitlement" would be accurate and useless.
 */
async function explainRefusal(db: DB, q: TrainingAccessQuery, at: string): Promise<string> {
  const rows = await db.select({
    status: s.trainingEntitlements.status,
    validFrom: s.trainingEntitlements.validFrom,
    validUntil: s.trainingEntitlements.validUntil,
    reason: s.trainingEntitlements.reason,
  })
    .from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.personId, q.personId))
    .orderBy(desc(s.trainingEntitlements.id))
    .limit(20);

  if (!rows.length) {
    return 'This person holds no training entitlement. Training is bought as a training plan; ' +
      'there is no membership fee for being a student and none is being asked for here.';
  }

  const expired = rows.find((r: any) => r.status === 'active' && isoDate(r.validUntil)! < at);
  if (expired) {
    return `The most recent training entitlement ended on ${isoDate(expired.validUntil)}. ` +
      'The record of having trained is kept in full — attendance, grades and certificates are untouched — ' +
      'but the right to train has to be renewed.';
  }

  const future = rows.find((r: any) => r.status === 'active' && isoDate(r.validFrom)! > at);
  if (future) {
    return `Training has been paid for and starts on ${isoDate(future.validFrom)}, which is after ${at}.`;
  }

  const revoked = rows.find((r: any) => r.status === 'revoked');
  if (revoked) {
    return `A training entitlement was revoked: ${revoked.reason ?? 'no reason recorded'}. ` +
      'The record is kept rather than deleted.';
  }

  const blockedRow = rows.find((r: any) => r.status === 'blocked');
  if (blockedRow) {
    return `A payment for training was taken and could not be turned into a right to train: ` +
      `${blockedRow.reason ?? 'no reason recorded'}. The federation office has this on its list.`;
  }

  return 'No training entitlement of this person\'s covers today for what was asked.';
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The refusing form, for a route that should not proceed without access. */
export async function assertTrainingAccess(
  db: DB, q: TrainingAccessQuery
): Promise<TrainingAccessDecision> {
  const decision = await trainingAccess(db, q);
  if (!decision.allowed) throw new TrainingProductError('no_training_entitlement', decision.reason);
  return decision;
}

// ─── Renewal ────────────────────────────────────────────────────────────────

/**
 * A recurring plan's next term — a TRAINING RENEWAL, not a subscription cycle.
 *
 * It is the same act as a first grant and takes the same gate: a new order, a
 * new server-verified capture, a new price version. NOTHING HERE CHARGES
 * ANYBODY. The federation does not hold a mandate and this system has no path
 * that takes money without a fresh capture, so a renewal is something a person
 * pays for, and this function records what that payment bought.
 *
 * THE NEW TERM STARTS THE DAY AFTER THE OLD ONE ENDS, where the old one has not
 * already lapsed. Starting it on the payment date would silently shorten a term
 * somebody renewed early; starting it on the old end date would give a day of
 * double cover that compounds over years.
 *
 * `training_entitlements_renewal_chain_uk` is the claim: two renewal runs on the
 * same term cannot both succeed, so a retried workflow extends it once.
 */
export async function renewTraining(
  db: DB,
  ctx: AuditContext,
  input: { previousEntitlementId: number; orderLineId: number }
) {
  assertCan(ctx.principal, 'program:write', {});

  const [previous] = await db.select().from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.id, input.previousEntitlementId)).limit(1);
  if (!previous) throw new TrainingProductError('unknown_entitlement', 'No such training entitlement.');
  if (previous.status !== 'active') {
    throw new TrainingProductError(
      'not_renewable',
      `That entitlement is ${previous.status}. A revoked or blocked term is not extended — ` +
      'the record of it stays and a new term is granted in its own right.'
    );
  }

  const [line] = await db.select().from(s.orderLines)
    .where(eq(s.orderLines.id, input.orderLineId)).limit(1);
  if (!line) throw new TrainingProductError('unknown_order_line', 'No such order line.');

  // ── THE LINE MUST HAVE PAID FOR THIS TERM ──
  //
  // Without these two checks the function took ANY paid order line and turned
  // it into a month on the mat: a ₹1 donation renewed a ₹1,200 product and
  // wrote `amount_paid_minor = 100` against it, which is both a free term and a
  // falsified record of what somebody paid. A gi, an entry fee and a grading
  // fee did the same. 'program:write' is held by every club administrator in
  // the country, so it was reachable by several thousand people.
  //
  // The gate is the same one grantInTx() applies to a first grant, and it has
  // to be: a renewal is not a lesser act than a first purchase, it is the same
  // act repeated. The line must be BILLED as training and must NAME the thing
  // being renewed.
  if (line.kind !== 'training') {
    throw new TrainingProductError(
      'line_not_training',
      `Order line ${line.id} is billed as '${line.kind}', not as training, so it did not buy a term on the mat. ` +
      'A donation, a gi, an entry fee and a grading fee are all money the federation legitimately took for ' +
      'something else, and renewing from one would give away training nobody paid for.'
    );
  }
  const namesPlan = line.refType === 'training_plan' && previous.planId != null
    && Number(line.refId) === Number(previous.planId);
  const namesProduct = line.refType === 'training_product'
    && Number(line.refId) === Number(previous.productId);
  if (!namesPlan && !namesProduct) {
    throw new TrainingProductError(
      'line_not_for_this_term',
      `Order line ${line.id} (refType '${line.refType ?? 'none'}', refId ${line.refId ?? 'none'}) does not pay for ` +
      `entitlement ${previous.id}, which is plan ${previous.planId ?? 'none'}, product ${previous.productId}. ` +
      'A renewal names what it renews. Recording one payment against a different term would put a figure on ' +
      'the record that nobody was ever charged.'
    );
  }

  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, line.orderId)).limit(1);
  const [payment] = await db.select().from(s.payments)
    .where(and(eq(s.payments.orderId, line.orderId), eq(s.payments.status, 'captured')))
    .orderBy(desc(s.payments.id)).limit(1);
  if (!payment) {
    throw new TrainingProductError(
      'no_verified_payment',
      'A renewal is created only from a server-verified capture. There is no captured payment on that order.'
    );
  }

  // A line that names only a PRODUCT names nobody — a product is offered to the
  // whole country — so the ORDER has to say who it was for. A plan-named line
  // needs no such check: the plan carries the person, and it is the person this
  // term was granted to. Refused when the order names nobody at all, rather
  // than assumed: one family's payment must not renew another family's term.
  if (namesProduct && Number(order?.personId) !== Number(previous.personId)) {
    throw new TrainingProductError(
      'line_not_for_this_person',
      `Order line ${line.id} names a training product but its order is for ` +
      `${order?.personId == null ? 'nobody in particular' : `person ${order.personId}`}, while entitlement ` +
      `${previous.id} belongs to person ${previous.personId}. A right to train belongs to a named individual ` +
      'and is renewed by that individual\'s own payment.'
    );
  }

  const product = await productById(db, previous.productId);
  const paidOn = isoDate(payment.capturedAt ?? payment.createdAt ?? new Date())!;
  const previousEnd = isoDate(previous.validUntil)!;
  // The day after the old term, or today if the old term already ran out —
  // never a start date before the money arrived.
  const startsOn = previousEnd >= paidOn ? dayAfter(previousEnd) : paidOn;

  const validity = productValidity(product, startsOn);
  if (!validity.ok) throw new TrainingProductError('validity_not_stated', validity.reason);

  const priceVersion = await priceVersionFor(db, order ?? { id: line.orderId }, payment, new Date());
  if (priceVersion.frameworkId == null) {
    throw new TrainingProductError('no_price_version', priceVersion.reason!);
  }

  try {
    const [row] = await db.insert(s.trainingEntitlements).values({
      planId: previous.planId,
      personId: previous.personId,
      productId: previous.productId,
      // Frozen afresh from the product AS IT IS NOW, because this is a new
      // purchase of it. The previous term keeps its own copies, unchanged.
      discipline: product.discipline,
      programme: product.programme,
      clubId: previous.servicedByClubId ?? previous.clubId,
      servicedByClubId: null,
      venueId: product.venueId ?? null,
      validFrom: validity.validFrom,
      validUntil: validity.validUntil,
      status: 'active',
      orderId: line.orderId,
      orderLineId: line.id,
      paymentId: payment.id,
      priceFrameworkId: priceVersion.frameworkId,
      priceFrameworkCode: priceVersion.frameworkCode,
      priceFrameworkVersion: priceVersion.frameworkVersion,
      quoteVersionId: priceVersion.quoteVersionId,
      amountPaidMinor: line.totalPaise,
      currency: order?.currency ?? 'INR',
      renewedFromEntitlementId: previous.id,
      renewalSequence: (previous.renewalSequence ?? 1) + 1,
      grantedBy: ctx.principal.label,
      detail: { basis: validity.basis, paidOn, renewedFrom: previous.id },
    }).returning();

    await writeAudit(db, ctx, {
      entityType: 'training_entitlement', entityId: row.id, action: 'create',
      oldValue: { previousEntitlementId: previous.id, previousValidUntil: previousEnd },
      newValue: { validFrom: validity.validFrom, validUntil: validity.validUntil, sequence: row.renewalSequence },
    });

    await publish(db, {
      eventType: 'TRAINING_RENEWED',
      entityType: 'training_entitlement',
      entityId: row.id,
      payload: {
        personId: previous.personId,
        entitlementId: row.id,
        renewedFromEntitlementId: previous.id,
        validFrom: validity.validFrom,
        validUntil: validity.validUntil,
        renewalSequence: row.renewalSequence,
      },
      actor: ctx.principal,
      correlationId: `training-renewed:${line.id}`,
    });

    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new TrainingProductError(
      'already_renewed',
      'That term has already been renewed. One successor per term — a retried renewal extends it once, not twice.'
    );
  }
}

function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─── Revocation ─────────────────────────────────────────────────────────────

/**
 * A refund reverses the right to train. IT DELETES NOTHING.
 *
 * The row keeps its dates, its payment, its price version and its product, and
 * gains a timestamp, the refund that caused it and a reason. A right that merely
 * vanished would be indistinguishable from one that never existed, and the
 * student's attendance, grades and certificates are not touched by any of it —
 * they hang off `persons` and outlive every entitlement.
 */
export async function revokeTraining(
  db: DB,
  ctx: AuditContext,
  input: { entitlementId: number; refundId?: number | null; reason: string }
) {
  assertCan(ctx.principal, 'program:write', {});
  const why = String(input.reason ?? '').trim();
  if (why.length < 4) {
    throw new TrainingProductError(
      'reason_required',
      'Ending somebody\'s right to train must say why. They will ask, and so will an auditor.'
    );
  }

  const [row] = await db.update(s.trainingEntitlements)
    .set({
      status: 'revoked',
      revokedAt: new Date(),
      refundId: input.refundId ?? null,
      reason: why,
      updatedAt: new Date(),
    })
    // Re-asserted in the WHERE so two revocations racing cannot both win.
    .where(and(
      eq(s.trainingEntitlements.id, input.entitlementId),
      eq(s.trainingEntitlements.status, 'active'),
    ))
    .returning();

  if (!row) {
    const [existing] = await db.select({ status: s.trainingEntitlements.status })
      .from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.id, input.entitlementId)).limit(1);
    if (!existing) throw new TrainingProductError('unknown_entitlement', 'No such training entitlement.');
    throw new TrainingProductError(
      'not_active',
      `That entitlement is ${existing.status}, so there is nothing to revoke.`
    );
  }

  await writeAudit(db, { ...ctx, reason: why }, {
    entityType: 'training_entitlement', entityId: row.id, action: 'revoke',
    oldValue: { status: 'active', validUntil: isoDate(row.validUntil) },
    newValue: { status: 'revoked', refundId: input.refundId ?? null },
  });

  await publish(db, {
    eventType: 'TRAINING_ACCESS_ENDED',
    entityType: 'training_entitlement',
    entityId: row.id,
    payload: {
      personId: row.personId,
      entitlementId: row.id,
      productId: row.productId,
      reason: why,
    },
    actor: ctx.principal,
    correlationId: `training-revoked:${row.id}`,
  });

  return row;
}

/**
 * A COMPLETED refund withdraws the right to train it paid for.
 *
 * WITHOUT THIS, A REFUNDED CHILD KEPT TRAINING. entitlements.revokeForRefund()
 * reverses what a payment activated, but it reads `entitlements` and training
 * lives in `training_entitlements` — a table it has never heard of — so the
 * money went back to the family and the term ran on to its end date. This is
 * the sibling call, made from the same place in the refund path, and it is a
 * deliberate mirror of that function rather than a second opinion:
 *
 *   · `completed` AND NOTHING LESS. A requested or processing refund is an
 *     intention, and a child taken off the mat over a refund that then failed
 *     at the gateway is turned away for nothing.
 *   · A PARTIAL REFUND WITHDRAWS NOTHING, and says so in the report. Which
 *     part of a term half a fee buys back is a federation decision nobody has
 *     taken, and the desk can act deliberately with revokeTraining().
 *   · NOTHING IS DELETED. Every revocation goes through revokeTraining(), so
 *     the row keeps its dates, its payment, its price version and its product,
 *     and gains the refund that ended it and the reason.
 *
 * Idempotent because it selects only ACTIVE rows: a second completion of the
 * same refund finds nothing left to revoke and revokes nothing.
 */
export async function revokeTrainingForRefund(
  db: DB,
  ctx: AuditContext | null,
  refundId: number,
  opts: { now?: Date } = {}
) {
  const [refund] = await db.select().from(s.refunds).where(eq(s.refunds.id, refundId)).limit(1);
  if (!refund) throw new TrainingProductError('unknown_refund', 'Unknown refund.');
  if (refund.status !== 'completed') {
    throw new TrainingProductError(
      'refund_not_completed',
      `Refund ${refundId} is '${refund.status}'. A right to train is withdrawn by a refund that actually ` +
      'completed, never by one that was merely requested.'
    );
  }

  const [payment] = await db.select().from(s.payments)
    .where(eq(s.payments.id, refund.paymentId)).limit(1);
  const siblings = await db.select().from(s.refunds)
    .where(eq(s.refunds.paymentId, refund.paymentId));
  const refunded = siblings
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => sum + r.amountPaise, 0);
  const fullyRefunded = Boolean(payment) && refunded >= payment.amountPaise;

  const active = await db.select().from(s.trainingEntitlements).where(and(
    eq(s.trainingEntitlements.paymentId, refund.paymentId),
    eq(s.trainingEntitlements.status, 'active'),
  ));

  const revocationCtx = systemTrainingContext(ctx);
  const outcomes: Array<{ entitlementId: number; status: 'revoked' | 'retained'; reason: string }> = [];

  for (const ent of active) {
    if (!fullyRefunded) {
      outcomes.push({
        entitlementId: ent.id,
        status: 'retained',
        reason:
          'Partially refunded. What part of a term a part refund buys back is a federation decision, ' +
          'so nothing was withdrawn automatically.',
      });
      continue;
    }
    const why = `Refunded: ${refund.reason ?? 'no reason recorded on the refund'}`;
    await revokeTraining(db, { ...revocationCtx, reason: why }, {
      entitlementId: ent.id, refundId: refund.id, reason: why,
    });
    outcomes.push({ entitlementId: ent.id, status: 'revoked', reason: why });
  }

  return {
    refundId: refund.id,
    orderId: refund.orderId,
    fullyRefunded,
    revoked: outcomes.filter((o) => o.status === 'revoked').length,
    outcomes,
  };
}

// ─── The roll, and moving between clubs ─────────────────────────────────────

/**
 * Put a person on a club's roll. A person may be on several.
 *
 * ONE STUDENT IS NOT ONE CLUB FOR EVER. A child trains at their school's club
 * and at a weekend dojo; enrolling at the second must not disturb the first.
 * The partial unique index permits exactly one LIVE row per (person, club) and
 * says nothing about how many clubs.
 */
export async function enrol(
  db: DB,
  ctx: AuditContext,
  input: { personId: number; clubId: number; joinedOn?: string | null; notes?: string | null }
) {
  assertCan(ctx.principal, 'program:write', {});
  const joinedOn = isoDate(input.joinedOn) ?? todayIso();
  try {
    const [row] = await db.insert(s.trainingEnrolments).values({
      personId: input.personId,
      clubId: input.clubId,
      status: 'active',
      joinedOn,
      notes: input.notes ?? null,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'training_enrolment', entityId: row.id, action: 'create',
      newValue: { personId: input.personId, clubId: input.clubId, joinedOn },
    });
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new TrainingProductError(
      'already_enrolled',
      'This person is already on that club\'s roll. Enrolling twice would give one student two places in one hall.'
    );
  }
}

/**
 * Move a student from one club to another.
 *
 * IT MOVES THE ENROLMENT AND KEEPS THE HISTORY, AND IT NEVER DUPLICATES THE
 * PERSON. `person_id` is the same integer on both rows; there is no insert into
 * `persons` anywhere in this file. The old enrolment closes as `transferred`
 * with an end date and a link forward; the new one opens with a link back. Both
 * rows stay for ever, so "which club were they at in 2026" survives — the
 * question a grading panel actually asks — alongside "which club now".
 *
 * LIVE ENTITLEMENTS FOLLOW, WITHOUT BEING REWRITTEN. `serviced_by_club_id` is
 * set to the receiving club and `club_id` — the club the training was BOUGHT at
 * — is left exactly as it was. That is the difference between correcting future
 * delivery and editing an accounting record, and this codebase only does the
 * first. `trainingAccess()` reads `coalesce(serviced_by, club)`, so the student
 * can train at the new club the moment the transfer commits.
 */
export async function transferEnrolment(
  db: DB,
  ctx: AuditContext,
  input: { enrolmentId: number; toClubId: number; effectiveOn?: string | null; reason: string }
) {
  assertCan(ctx.principal, 'program:write', {});
  const why = String(input.reason ?? '').trim();
  if (why.length < 4) {
    throw new TrainingProductError('reason_required', 'A transfer must say why — it changes where a child trains.');
  }

  const [from] = await db.select().from(s.trainingEnrolments)
    .where(eq(s.trainingEnrolments.id, input.enrolmentId)).limit(1);
  if (!from) throw new TrainingProductError('unknown_enrolment', 'No such enrolment.');
  if (from.status !== 'active') {
    throw new TrainingProductError(
      'not_active',
      `That enrolment is ${from.status}. Only a live enrolment can be transferred; a closed one is history.`
    );
  }
  if (from.clubId === input.toClubId) {
    throw new TrainingProductError('same_club', 'The receiving club is the club they are already at.');
  }

  const effectiveOn = isoDate(input.effectiveOn) ?? todayIso();

  return db.transaction(async (tx: DB) => {
    // The CLAIM comes first: `training_enrolments_chain_uk` is unique on
    // `transferred_from_id`, so two administrators transferring the same student
    // at once cannot both open a receiving row.
    let to: any;
    try {
      [to] = await tx.insert(s.trainingEnrolments).values({
        personId: from.personId,        // THE SAME PERSON. Not a copy of them.
        clubId: input.toClubId,
        status: 'active',
        joinedOn: effectiveOn,
        transferredFromId: from.id,
        transferReason: why,
      }).returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new TrainingProductError(
        'transfer_conflict',
        'That enrolment has already been transferred, or the student already holds a live enrolment at the ' +
        'receiving club. Nothing was changed.'
      );
    }

    await tx.update(s.trainingEnrolments)
      .set({
        status: 'transferred',
        endedOn: effectiveOn,
        transferredToId: to.id,
        transferReason: why,
        updatedAt: new Date(),
      })
      .where(eq(s.trainingEnrolments.id, from.id));

    // Live entitlements delivered at the old club now deliver at the new one.
    // `club_id` is untouched — see the header.
    const moved = await tx.update(s.trainingEntitlements)
      .set({ servicedByClubId: input.toClubId, updatedAt: new Date() })
      .where(and(
        eq(s.trainingEntitlements.personId, from.personId),
        eq(s.trainingEntitlements.status, 'active'),
        sql`coalesce(${s.trainingEntitlements.servicedByClubId}, ${s.trainingEntitlements.clubId}) = ${from.clubId}`,
        gte(s.trainingEntitlements.validUntil, effectiveOn),
      ))
      .returning({ id: s.trainingEntitlements.id });

    await writeAudit(tx, { ...ctx, reason: why }, {
      entityType: 'training_enrolment', entityId: from.id, action: 'update',
      oldValue: { clubId: from.clubId, status: 'active' },
      newValue: {
        status: 'transferred', toEnrolmentId: to.id, toClubId: input.toClubId,
        effectiveOn, entitlementsMoved: moved.length, personId: from.personId,
      },
    });

    await publish(tx, {
      eventType: 'TRAINING_ENROLMENT_TRANSFERRED',
      entityType: 'training_enrolment',
      entityId: to.id,
      payload: {
        personId: from.personId,
        fromClubId: from.clubId,
        toClubId: input.toClubId,
        fromEnrolmentId: from.id,
        toEnrolmentId: to.id,
        effectiveOn,
        entitlementsMoved: moved.length,
      },
      actor: ctx.principal,
      correlationId: `training-transfer:${from.id}`,
    });

    return { from: from.id, to: to.id, entitlementsMoved: moved.length, effectiveOn };
  });
}

/** Every club this person trains at — plural, and that is the point. */
export async function clubsForPerson(db: DB, personId: number, opts: { includeClosed?: boolean } = {}) {
  const where: any[] = [eq(s.trainingEnrolments.personId, personId)];
  if (!opts.includeClosed) where.push(eq(s.trainingEnrolments.status, 'active'));
  return db.select().from(s.trainingEnrolments)
    .where(and(...where))
    .orderBy(asc(s.trainingEnrolments.joinedOn), asc(s.trainingEnrolments.id));
}

// ─── The record that outlives the right ─────────────────────────────────────

/**
 * Everything this person has ever bought, expired and current alike.
 *
 * EXPIRY DELETES NOTHING, and this is the query that proves it: a lapsed
 * entitlement is returned with its dates, its payment and the price version it
 * was bought under, years later. The student is not deleted, the account is not
 * deleted, and attendance, grades and certificates were never in this table to
 * begin with — they hang off `persons` and are untouched by anything here.
 */
export async function trainingHistory(db: DB, principal: Principal, personId: number) {
  if (!canAnywhere(principal, 'program:read') && !canAnywhere(principal, 'person:read')) {
    throw new TrainingProductError(
      'forbidden',
      'Reading somebody\'s training history requires program:read or person:read.'
    );
  }
  const at = todayIso();
  const rows = await db.select({
    id: s.trainingEntitlements.id,
    productId: s.trainingEntitlements.productId,
    productCode: s.trainingProducts.code,
    productTitle: s.trainingProducts.title,
    discipline: s.trainingEntitlements.discipline,
    programme: s.trainingEntitlements.programme,
    clubId: s.trainingEntitlements.clubId,
    servicedByClubId: s.trainingEntitlements.servicedByClubId,
    validFrom: s.trainingEntitlements.validFrom,
    validUntil: s.trainingEntitlements.validUntil,
    status: s.trainingEntitlements.status,
    amountPaidMinor: s.trainingEntitlements.amountPaidMinor,
    currency: s.trainingEntitlements.currency,
    priceFrameworkCode: s.trainingEntitlements.priceFrameworkCode,
    priceFrameworkVersion: s.trainingEntitlements.priceFrameworkVersion,
    renewalSequence: s.trainingEntitlements.renewalSequence,
    renewedFromEntitlementId: s.trainingEntitlements.renewedFromEntitlementId,
    reason: s.trainingEntitlements.reason,
    grantedAt: s.trainingEntitlements.grantedAt,
  })
    .from(s.trainingEntitlements)
    .leftJoin(s.trainingProducts, eq(s.trainingProducts.id, s.trainingEntitlements.productId))
    .where(eq(s.trainingEntitlements.personId, personId))
    .orderBy(desc(s.trainingEntitlements.validFrom), desc(s.trainingEntitlements.id));

  return rows.map((r: any) => ({
    ...r,
    validFrom: isoDate(r.validFrom),
    validUntil: isoDate(r.validUntil),
    /** Derived at read time, never stored — a stored flag is a flag that lapses late. */
    current: r.status === 'active'
      && isoDate(r.validFrom) != null && isoDate(r.validFrom)! <= at
      && isoDate(r.validUntil) != null && isoDate(r.validUntil)! >= at,
    /**
     * What they paid, in words — or NULL where no amount was recorded.
     *
     * `formatINR(r.amountPaidMinor ?? 0)` rendered an unrecorded amount as
     * '₹0.00', which reads as FREE on the page a student is shown. An
     * entitlement granted without a figure (a concession, a migration, a grant
     * the office made by hand) is not a purchase for nothing; it is a purchase
     * whose amount this system does not know, and the two must not print the
     * same. Null so a surface says so instead.
     */
    paidFormatted: r.amountPaidMinor == null ? null : formatINR(r.amountPaidMinor),
  }));
}

/**
 * Training about to run out.
 *
 * The window is an ARGUMENT and has no default, for the reason
 * `raiseRenewalNotices()` gives about the same decision: how much notice MMAKF
 * gives is federation policy nobody has set, and a number chosen here would
 * become that policy by accident.
 */
export async function expiringTraining(
  db: DB, principal: Principal, withinDays: number, at?: Date | string | null
) {
  assertCanAnywhere(principal, 'program:read');
  if (!Number.isInteger(withinDays) || withinDays < 0) {
    throw new TrainingProductError(
      'window_required',
      'State the renewal window in whole days. There is no default: a window this system chose would become ' +
      'the federation\'s renewal policy without anybody deciding it.'
    );
  }
  const from = todayIso(at);
  const to = daysEndOn(from, withinDays + 1);

  return db.select({
    entitlementId: s.trainingEntitlements.id,
    personId: s.trainingEntitlements.personId,
    productId: s.trainingEntitlements.productId,
    planId: s.trainingEntitlements.planId,
    clubId: s.trainingEntitlements.clubId,
    validUntil: s.trainingEntitlements.validUntil,
    renewalMode: s.trainingPlans.renewalMode,
  })
    .from(s.trainingEntitlements)
    .leftJoin(s.trainingPlans, eq(s.trainingPlans.id, s.trainingEntitlements.planId))
    .where(and(
      eq(s.trainingEntitlements.status, 'active'),
      gte(s.trainingEntitlements.validUntil, from),
      lte(s.trainingEntitlements.validUntil, to),
    ))
    .orderBy(asc(s.trainingEntitlements.validUntil));
}
