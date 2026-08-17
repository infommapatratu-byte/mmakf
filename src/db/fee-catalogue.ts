// The fee catalogue, and the sentinel that makes ₹0 unwritable.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS MODULE EXISTS TO REMOVE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF has published no fees. Every surface that wants to show one therefore
// asks a question the database cannot answer, and the shape of the answer
// decides what a visitor is told.
//
// The ordinary shape is `number | null`, and it is a trap. `null` flows into
// `?? 0`, into `Number(x)`, into `total += fee`, into a template that prints
// `₹0.00`. Each of those is one keystroke, none of them is a type error, and
// the result on the page is the single most expensive sentence this system
// could publish: that a national federation's grading examination is free.
// Nobody reviews that line, because nothing about it looks wrong.
//
// So the missing-fee case is NOT a number here. It is a SYMBOL.
//
//   Number(FEE_NOT_CONFIGURED)     TypeError
//   FEE_NOT_CONFIGURED + 0         TypeError
//   `${FEE_NOT_CONFIGURED}`        TypeError
//   fee ?? 0                       does not compile — the union has no number
//
// A symbol is the one JavaScript value that refuses arithmetic and refuses
// string interpolation at RUNTIME, not merely in the type checker. That matters
// because the type checker is absent exactly where this is most dangerous: an
// .astro template, a JSON round-trip, a `any`-typed row from the database.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE COMPILE-TIME HALF
// ─────────────────────────────────────────────────────────────────────────────
//
// feeFor() returns a DISCRIMINATED UNION whose unpriced arm has no
// `amountMinor` property at all. Reading `result.amountMinor` without first
// narrowing is a compile error, not a runtime surprise:
//
//   const fee = await feeFor(db, 'MMAKF-FEE-GRD-DAN');
//   fee.amountMinor                        // error: not on UnpricedFee
//   if (isPriced(fee)) fee.amountMinor     // fine
//   renderFee(fee)                         // always safe, never a figure
//
// Both halves are needed. The union stops the mistake being written; the symbol
// stops it surviving a cast, a template, or an `any`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// It contains no prices. The seed below carries fifty-one SERVICE CODES and not
// one rupee figure, because MMAKF has published none. Seeding a "reasonable"
// starting amount would be this project writing the federation's commercial
// policy for it, which is the one thing forbidden above all others here.

import { and, asc, eq, inArray } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, assertCanAnywhere, type Principal } from '@/lib/rbac';
import {
  activeFramework, computeFee, formatINR, isFeeError,
  type ComputedLine, type FeeInputs,
} from '@/db/fees';

type DB = any;

export class FeeCatalogueError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FeeCatalogueError';
    this.code = code;
  }
}

/** Identified by shape, not `instanceof` — see src/lib/calendar.ts for why. */
export function isFeeCatalogueError(err: unknown): err is FeeCatalogueError {
  return Boolean(err)
    && typeof (err as any).code === 'string'
    && (err as any).name === 'FeeCatalogueError';
}

// ─── The taxonomies, as types ───────────────────────────────────────────────

export type FeeCategory =
  | 'membership' | 'affiliation' | 'grading' | 'competition' | 'education'
  | 'training' | 'documents';

export const FEE_CATEGORIES: readonly FeeCategory[] = [
  'membership', 'affiliation', 'grading', 'competition', 'education',
  'training', 'documents',
];

export type FeeAudience =
  | 'athlete' | 'junior' | 'parent' | 'coach' | 'instructor' | 'referee'
  | 'judge' | 'official' | 'examiner' | 'member' | 'dojo' | 'club' | 'school'
  | 'university' | 'corporate' | 'government' | 'organisation' | 'institution'
  | 'state_unit' | 'district_unit' | 'any';

export type FeeUnit =
  | 'per_person' | 'per_application' | 'per_registration' | 'per_entry'
  | 'per_category' | 'per_team' | 'per_session' | 'per_seat' | 'per_month'
  | 'per_year' | 'per_document' | 'per_card' | 'per_certificate' | 'per_dojo'
  | 'per_club' | 'per_institution' | 'per_campus' | 'per_hour' | 'per_case';

export type FeeFrequency =
  | 'one_time' | 'annual' | 'biennial' | 'triennial' | 'monthly' | 'per_term'
  | 'per_event' | 'per_session' | 'on_request';

export type FeeDisplayPolicy =
  | 'public' | 'request_quote' | 'member_only' | 'institutional' | 'private'
  | 'hidden';

export const FEE_DISPLAY_POLICIES: readonly FeeDisplayPolicy[] = [
  'public', 'request_quote', 'member_only', 'institutional', 'private', 'hidden',
];

/** A catalogue entry as the seed states it. NOTE THE ABSENCE OF AN AMOUNT. */
export interface CatalogueSeedEntry {
  code: string;
  slug: string;
  name: string;
  category: FeeCategory;
  audience: FeeAudience;
  unit: FeeUnit;
  frequency: FeeFrequency;
  displayPolicy: FeeDisplayPolicy;
  description?: string;
}

// ─── The sentinel ───────────────────────────────────────────────────────────

/**
 * "The federation has not published a fee for this."
 *
 * A `unique symbol`, so it is its own type as well as its own value, and so no
 * other module can construct something that compares equal to it.
 *
 * Why a symbol rather than a string constant such as 'NOT_CONFIGURED': a string
 * survives `Number()` as NaN, survives concatenation, and prints itself into a
 * page. A symbol throws a TypeError on every one of those. The requirement here
 * is not "represent the missing case" — it is "make the missing case IMPOSSIBLE
 * to render as a quantity", and only a symbol does that without the type
 * checker's cooperation.
 */
export const FEE_NOT_CONFIGURED: unique symbol = Symbol('MMAKF.FEE_NOT_CONFIGURED');
export type FeeNotConfigured = typeof FEE_NOT_CONFIGURED;

/** Why there is no figure. For operators and audit, never for a visitor. */
export type FeeUnavailableReason =
  /** No catalogue entry carries that code. */
  | 'unknown_service'
  /** The entry exists but the federation has not published it. */
  | 'service_not_published'
  /** No fee framework is in force on the date asked about. */
  | 'no_framework'
  /** A framework is in force; no rule in it covers this request. */
  | 'no_rule'
  /** A rule matched but is incomplete — a multiplier with no factor, say. */
  | 'rule_incomplete'
  /** Rules matched and produced zero or less. Refused; see below. */
  | 'zero_total'
  /** A figure exists, and this viewer may not be shown it. */
  | 'display_restricted'
  /** The federation database is not reachable from this environment. */
  | 'register_unreadable';

/** A fee the federation has actually published, computed from its own rules. */
export interface PricedFee {
  readonly outcome: 'priced';
  readonly serviceCode: string;
  readonly displayPolicy: FeeDisplayPolicy;
  /** INTEGER PAISE. Always > 0 — see the zero_total refusal below. */
  readonly amountMinor: number;
  readonly currency: string;
  /** The framework version that produced it, so the figure is reproducible. */
  readonly frameworkCode: string;
  readonly frameworkVersion: number;
  readonly lines: readonly ComputedLine[];
}

/**
 * No figure, and deliberately NO `amountMinor` PROPERTY AT ALL.
 *
 * That absence is the compile-time half of the guarantee: a caller who reaches
 * for `.amountMinor` on the union gets an error naming this type, before the
 * code ever runs.
 *
 * `[Symbol.toPrimitive]` throws. An object without it coerces to the string
 * "[object Object]" or to NaN, and NaN in an accumulator becomes a total that
 * silently poisons an invoice. Throwing turns every one of those into a loud,
 * located failure instead of a wrong number.
 */
export interface UnpricedFee {
  readonly outcome: FeeNotConfigured;
  readonly serviceCode: string;
  readonly displayPolicy: FeeDisplayPolicy;
  readonly reason: FeeUnavailableReason;
  /** What a surface shows in place of a figure, chosen by the display policy. */
  readonly notice: string;
  /** Operator detail. Never rendered to a visitor. */
  readonly detail: string | null;
  readonly [Symbol.toPrimitive]: (hint: string) => never;
}

export type FeeResult = PricedFee | UnpricedFee;

/**
 * What a surface says instead of a number, chosen by the display policy.
 *
 * The federation's instruction, verbatim: "This fee is set by the federation
 * and is not yet published" or "Request a quotation", chosen by the display
 * policy — never a number. The remaining four policies get their own sentence
 * rather than being folded into one of those two, because "we do not publish
 * this" and "we have not published it yet" are different facts and a visitor
 * deciding whether to trust MMAKF with their child deserves the true one.
 */
export const FEE_NOTICE: Readonly<Record<FeeDisplayPolicy, string>> = Object.freeze({
  public: 'This fee is set by the federation and is not yet published.',
  request_quote: 'Request a quotation.',
  member_only: 'This fee is shown to members who are signed in.',
  institutional: 'Institutional fees are agreed in writing. Request a quotation.',
  private: 'This fee is held by the federation office and is not published.',
  hidden: 'This service is not listed.',
});

/**
 * Who is looking.
 *
 * Not a Principal: most callers of a fee lookup are public pages with no
 * principal at all, and threading rbac through them would put the authoring
 * side of the fee engine in scope on a template. Three levels is what the
 * display policies actually distinguish.
 */
export type FeeViewer = 'public' | 'member' | 'staff';

const VIEWER_RANK: Readonly<Record<FeeViewer, number>> = Object.freeze({
  public: 0, member: 1, staff: 2,
});

/**
 * May THIS viewer be shown a figure for a fee under THIS policy?
 *
 * `request_quote` is the interesting one: even when a rule prices it, the
 * federation's answer to a visitor is a quotation, not a number. Staff see the
 * computed figure because staff are the people preparing that quotation.
 *
 * Fail-closed by construction — an unrecognised policy returns false rather
 * than falling through to the permissive branch.
 */
export function mayShowAmount(policy: FeeDisplayPolicy, viewer: FeeViewer): boolean {
  const rank = VIEWER_RANK[viewer];
  if (rank == null) return false;
  switch (policy) {
    case 'public': return true;
    case 'member_only': return rank >= VIEWER_RANK.member;
    case 'request_quote':
    case 'institutional':
    case 'private':
    case 'hidden':
      return rank >= VIEWER_RANK.staff;
    default: return false;
  }
}

/** Build the unpriced arm. The only place an UnpricedFee is constructed. */
function notConfigured(
  serviceCode: string,
  displayPolicy: FeeDisplayPolicy,
  reason: FeeUnavailableReason,
  detail: string | null = null
): UnpricedFee {
  const value: UnpricedFee = {
    outcome: FEE_NOT_CONFIGURED,
    serviceCode,
    displayPolicy,
    reason,
    notice: FEE_NOTICE[displayPolicy] ?? FEE_NOTICE.request_quote,
    detail,
    [Symbol.toPrimitive](hint: string): never {
      throw new FeeCatalogueError(
        'fee_not_configured',
        `The fee for ${serviceCode} is not configured, and this code tried to use it as a ${hint} ` +
        '(a number, a string, or an arithmetic operand). There is no number here on purpose. ' +
        'Narrow the result with isPriced(), or render it with renderFee().'
      );
    },
  };
  // Frozen so nothing can bolt an `amountMinor` onto it downstream and defeat
  // the whole guarantee with one assignment.
  return Object.freeze(value);
}

/** Narrowing gate. Callers that want the number go through this. */
export function isPriced(result: FeeResult): result is PricedFee {
  return result.outcome === 'priced';
}

/** Narrowing gate for the other arm, by identity against the symbol. */
export function isNotConfigured(result: FeeResult): result is UnpricedFee {
  return result.outcome === FEE_NOT_CONFIGURED;
}

/**
 * The number, or a thrown error — never a fallback.
 *
 * Exists so that server-side code which genuinely cannot proceed without an
 * amount (creating a gateway order, writing a ledger entry) fails loudly rather
 * than reaching for `?? 0`. There is deliberately no `amountMinorOr(result,
 * fallback)`, because the fallback would be the bug.
 */
export function requireAmountMinor(result: FeeResult): number {
  if (isPriced(result)) return result.amountMinor;
  throw new FeeCatalogueError(
    'fee_not_configured',
    `No published fee for ${result.serviceCode} (${result.reason}). ` +
    'Refusing to substitute a figure: zero would read as "free".'
  );
}

/**
 * THE ONE FUNCTION A SURFACE CALLS TO PUT A FEE ON A PAGE.
 *
 * Priced → the federation's own figure, formatted in Indian digit grouping.
 * Unpriced → the sentence its display policy chose. Never "₹0.00", never "—"
 * standing in for a number, never an empty string that a layout fills with
 * whitespace where a price should be.
 *
 * The zero guard is not defensive noise. feeFor() already refuses a computed
 * zero, but renderFee() is exported and a caller can hand it a hand-built
 * PricedFee; the day somebody does, this throws instead of printing ₹0.00.
 */
export function renderFee(result: FeeResult): string {
  if (isNotConfigured(result)) return result.notice;
  if (!Number.isInteger(result.amountMinor) || result.amountMinor <= 0) {
    throw new FeeCatalogueError(
      'zero_amount_render',
      `renderFee() was given ${String(result.amountMinor)} paise for ${result.serviceCode}. ` +
      'A published fee is a positive integer number of paise; zero reads as "free" and is refused.'
    );
  }
  return formatINR(result.amountMinor);
}

// ─── Reading the catalogue ──────────────────────────────────────────────────

/** Display policies a surface with no signed-in viewer may list at all. */
const PUBLICLY_LISTABLE: readonly FeeDisplayPolicy[] = [
  'public', 'request_quote', 'institutional',
];

/**
 * The catalogue as the public site may list it.
 *
 * No principal, on purpose: this is called from templates, and a function that
 * took a Principal would invite one to be invented. Filtering happens in SQL so
 * a `private` entry never reaches the process rendering the page.
 */
export async function publicCatalogue(db: DB, category?: FeeCategory) {
  const conds = [
    eq(s.feeCatalogueEntries.status, 'published'),
    inArray(s.feeCatalogueEntries.displayPolicy, PUBLICLY_LISTABLE as any),
  ];
  if (category) conds.push(eq(s.feeCatalogueEntries.category, category));
  return db.select().from(s.feeCatalogueEntries)
    .where(and(...conds))
    .orderBy(asc(s.feeCatalogueEntries.sortOrder), asc(s.feeCatalogueEntries.code));
}

/** Everything, including private and hidden entries. Gated. */
export async function fullCatalogue(db: DB, principal: Principal) {
  assertCanAnywhere(principal, 'feeframework:read');
  return db.select().from(s.feeCatalogueEntries)
    .orderBy(asc(s.feeCatalogueEntries.sortOrder), asc(s.feeCatalogueEntries.code));
}

/** One entry by code, or null. Ungated: feeFor() applies the display policy. */
export async function catalogueEntry(db: DB, code: string) {
  const [row] = await db.select().from(s.feeCatalogueEntries)
    .where(eq(s.feeCatalogueEntries.code, code)).limit(1);
  return row ?? null;
}

// ─── The lookup ─────────────────────────────────────────────────────────────

export interface FeeForOptions {
  /** ISO date the framework is asked about. Defaults to today. */
  asAt?: string;
  /** Who is being shown the answer. Defaults to the most restrictive. */
  viewer?: FeeViewer;
}

/**
 * What does this service cost?
 *
 * Returns a computed amount WITH ITS FRAMEWORK VERSION, or FEE_NOT_CONFIGURED.
 * Never 0. Never null. Never a default, an "indicative" figure, a "from ₹X" or
 * a range. Eight distinct reasons produce the unpriced arm and every one of
 * them is recorded, because "the federation has not set this yet" and "the
 * database is unreachable" need different actions from an operator and the same
 * sentence to a visitor.
 *
 * ON THE ZERO REFUSAL. A framework whose matched rules total zero or less does
 * NOT produce a priced result. A genuinely free service is a POLICY the
 * federation states, not an outcome that falls out of arithmetic — and the
 * realistic way a total reaches zero is a discount rule matching when its
 * matching base rule did not. Publishing that as "free" is precisely the
 * failure this module exists to prevent, so it is reported as unconfigured and
 * left for somebody to look at.
 */
export async function feeFor(
  db: DB,
  serviceCode: string,
  inputs: FeeInputs = {},
  opts: FeeForOptions = {}
): Promise<FeeResult> {
  const viewer: FeeViewer = opts.viewer ?? 'public';
  const asAt = opts.asAt ?? new Date().toISOString().slice(0, 10);

  // The display policy is needed to phrase EVERY failure below, including the
  // one where the entry does not exist. An unknown code is treated as
  // request_quote rather than public: a caller asking about a service the
  // federation does not list is exactly when a confident public sentence would
  // be wrong.
  let entry: any = null;
  try {
    entry = await catalogueEntry(db, serviceCode);
  } catch (err: any) {
    return notConfigured(serviceCode, 'request_quote', 'register_unreadable',
      String(err?.message ?? err).slice(0, 200));
  }

  if (!entry) {
    return notConfigured(serviceCode, 'request_quote', 'unknown_service',
      'No catalogue entry carries this code.');
  }

  const policy = entry.displayPolicy as FeeDisplayPolicy;

  if (entry.status !== 'published') {
    return notConfigured(serviceCode, policy, 'service_not_published',
      `Catalogue entry is ${entry.status}.`);
  }

  // Checked BEFORE the framework is read, so a figure the viewer may not see is
  // never computed, never logged and never sent — rather than computed and then
  // filtered out of a response body somebody later forgets to filter.
  if (!mayShowAmount(policy, viewer)) {
    return notConfigured(serviceCode, policy, 'display_restricted',
      `Display policy ${policy} does not show a figure to a ${viewer} viewer.`);
  }

  let framework: any = null;
  try {
    framework = await activeFramework(db, asAt);
  } catch (err: any) {
    return notConfigured(serviceCode, policy, 'register_unreadable',
      String(err?.message ?? err).slice(0, 200));
  }
  if (!framework) {
    return notConfigured(serviceCode, policy, 'no_framework',
      `No fee framework is in force on ${asAt}.`);
  }

  let computation: any;
  try {
    // The catalogue code is passed as `serviceCode` so a fee rule can target a
    // catalogue entry by condition — { "serviceCode": "MMAKF-FEE-GRD-DAN" } —
    // which is how an amount is attached to an entry that carries none.
    computation = await computeFee(db, framework.id, { ...inputs, serviceCode });
  } catch (err: any) {
    if (isFeeError(err)) {
      return notConfigured(serviceCode, policy, 'rule_incomplete',
        `${err.code}: ${err.message}`.slice(0, 300));
    }
    return notConfigured(serviceCode, policy, 'register_unreadable',
      String(err?.message ?? err).slice(0, 200));
  }

  if (computation.requiresManualQuote) {
    return notConfigured(serviceCode, policy, 'no_rule',
      computation.manualReason ?? 'No published rule covers this request.');
  }

  if (!Number.isInteger(computation.totalMinor) || computation.totalMinor <= 0) {
    return notConfigured(serviceCode, policy, 'zero_total',
      `Framework ${framework.code} totalled ${String(computation.totalMinor)} paise. ` +
      'A zero or negative total is refused rather than published as "free".');
  }

  return Object.freeze({
    outcome: 'priced' as const,
    serviceCode,
    displayPolicy: policy,
    amountMinor: computation.totalMinor,
    currency: computation.currency,
    frameworkCode: framework.code,
    frameworkVersion: framework.version,
    lines: Object.freeze(computation.lines.slice()) as readonly ComputedLine[],
  });
}

// ─── The seed: fifty-one service codes, and not one amount ──────────────────

/**
 * Every service MMAKF charges for, from the federation's own list.
 *
 * CODES ONLY. Each entry states what the service IS, who it is for, what one
 * unit of it is, how often it recurs and who may be shown the figure. None of
 * them states a figure, because the federation has published none.
 *
 * The display policies here are the CONSERVATIVE reading, not a claim about
 * federation policy: nothing is marked more permissive than its category
 * plainly warrants, and 'public' means "may be shown once MMAKF publishes an
 * amount" rather than "is public today". The office can change any of them; the
 * point of the column is that the decision is recorded somewhere rather than
 * re-made by each page.
 */
export const FEE_CATALOGUE_SEED: readonly CatalogueSeedEntry[] = Object.freeze([
  // ── Membership ────────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-MEM-ATHLETE', slug: 'membership-athlete', name: 'Athlete membership', category: 'membership', audience: 'athlete', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-JUNIOR', slug: 'membership-junior', name: 'Junior athlete membership', category: 'membership', audience: 'junior', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-COACH', slug: 'membership-coach', name: 'Coach membership', category: 'membership', audience: 'coach', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-INSTRUCTOR', slug: 'membership-instructor', name: 'Instructor membership', category: 'membership', audience: 'instructor', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-REFEREE', slug: 'membership-referee', name: 'Referee membership', category: 'membership', audience: 'referee', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-JUDGE', slug: 'membership-judge', name: 'Judge membership', category: 'membership', audience: 'judge', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-OFFICIAL', slug: 'membership-official', name: 'Technical official membership', category: 'membership', audience: 'official', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-EXAMINER', slug: 'membership-examiner', name: 'Examiner membership', category: 'membership', audience: 'examiner', unit: 'per_person', frequency: 'annual', displayPolicy: 'member_only', description: 'Examiner standing is conferred, not bought; the fee is shown to those already appointed.' },
  { code: 'MMAKF-FEE-MEM-DOJO', slug: 'membership-dojo', name: 'Dojo membership', category: 'membership', audience: 'dojo', unit: 'per_dojo', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-CLUB', slug: 'membership-club', name: 'Club membership', category: 'membership', audience: 'club', unit: 'per_club', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-ORGANISATION', slug: 'membership-organisation', name: 'Organisation membership', category: 'membership', audience: 'organisation', unit: 'per_institution', frequency: 'annual', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-MEM-RENEWAL', slug: 'membership-renewal', name: 'Membership renewal', category: 'membership', audience: 'member', unit: 'per_person', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-MEM-REPLACEMENT', slug: 'membership-replacement', name: 'Replacement membership record', category: 'membership', audience: 'member', unit: 'per_application', frequency: 'on_request', displayPolicy: 'public' },

  // ── Affiliation ───────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-AFF-DOJO', slug: 'affiliation-dojo', name: 'Dojo affiliation', category: 'affiliation', audience: 'dojo', unit: 'per_dojo', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-AFF-CLUB', slug: 'affiliation-club', name: 'Club affiliation', category: 'affiliation', audience: 'club', unit: 'per_club', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-AFF-INSTITUTIONAL', slug: 'affiliation-institutional', name: 'Institutional affiliation', category: 'affiliation', audience: 'institution', unit: 'per_institution', frequency: 'annual', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-AFF-RENEWAL', slug: 'affiliation-renewal', name: 'Annual affiliation renewal', category: 'affiliation', audience: 'dojo', unit: 'per_dojo', frequency: 'annual', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-AFF-UNIT', slug: 'affiliation-state-district-unit', name: 'State and district unit affiliation', category: 'affiliation', audience: 'state_unit', unit: 'per_registration', frequency: 'annual', displayPolicy: 'private', description: 'A charge between federation units, settled internally rather than listed.' },

  // ── Grading ───────────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-GRD-KYU', slug: 'grading-kyu', name: 'Kyu grading examination', category: 'grading', audience: 'athlete', unit: 'per_person', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-GRD-DAN', slug: 'grading-dan', name: 'Dan grading examination', category: 'grading', audience: 'athlete', unit: 'per_person', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-GRD-CERTIFICATE', slug: 'grading-certificate', name: 'Grading certificate', category: 'grading', audience: 'member', unit: 'per_certificate', frequency: 'one_time', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-GRD-REISSUE', slug: 'grading-certificate-reissue', name: 'Grading certificate reissue', category: 'grading', audience: 'member', unit: 'per_certificate', frequency: 'on_request', displayPolicy: 'public' },

  // ── Competition ───────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-CMP-ENTRY', slug: 'competition-entry', name: 'Competition entry', category: 'competition', audience: 'athlete', unit: 'per_entry', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-KATA', slug: 'competition-kata', name: 'Kata category entry', category: 'competition', audience: 'athlete', unit: 'per_category', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-KUMITE', slug: 'competition-kumite', name: 'Kumite category entry', category: 'competition', audience: 'athlete', unit: 'per_category', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-ADDITIONAL-CATEGORY', slug: 'competition-additional-category', name: 'Additional category entry', category: 'competition', audience: 'athlete', unit: 'per_category', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-TEAM', slug: 'competition-team', name: 'Team entry', category: 'competition', audience: 'club', unit: 'per_team', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-COACH', slug: 'competition-coach-accreditation', name: 'Coach accreditation', category: 'competition', audience: 'coach', unit: 'per_person', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-OFFICIAL', slug: 'competition-official-accreditation', name: 'Official accreditation', category: 'competition', audience: 'official', unit: 'per_person', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-LATE-ENTRY', slug: 'competition-late-entry', name: 'Late entry', category: 'competition', audience: 'athlete', unit: 'per_entry', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-PROTEST', slug: 'competition-protest', name: 'Protest', category: 'competition', audience: 'coach', unit: 'per_case', frequency: 'per_event', displayPolicy: 'public', description: 'Lodged at the tatami. Published because a protest fee nobody can look up before travelling is a barrier, not a deterrent.' },
  { code: 'MMAKF-FEE-CMP-APPEAL', slug: 'competition-appeal', name: 'Appeal', category: 'competition', audience: 'coach', unit: 'per_case', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-CMP-WITHDRAWAL', slug: 'competition-withdrawal', name: 'Withdrawal', category: 'competition', audience: 'athlete', unit: 'per_entry', frequency: 'per_event', displayPolicy: 'public' },

  // ── Education ─────────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-EDU-COACH', slug: 'education-coach-course', name: 'Coach certification course', category: 'education', audience: 'coach', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-INSTRUCTOR', slug: 'education-instructor-course', name: 'Instructor certification course', category: 'education', audience: 'instructor', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-REFEREE', slug: 'education-referee-course', name: 'Referee course', category: 'education', audience: 'referee', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-JUDGE', slug: 'education-judge-course', name: 'Judge course', category: 'education', audience: 'judge', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-SEMINAR', slug: 'education-seminar', name: 'Seminar', category: 'education', audience: 'member', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-CAMP', slug: 'education-camp', name: 'Training camp', category: 'education', audience: 'athlete', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-EDU-WORKSHOP', slug: 'education-workshop', name: 'Workshop', category: 'education', audience: 'member', unit: 'per_seat', frequency: 'per_event', displayPolicy: 'public' },

  // ── Training ──────────────────────────────────────────────────────────────
  // Quotable, not listed. These are the nine monthly prices the federation had
  // typed into a content file, and the reason they are 'request_quote' is that
  // what somebody pays depends on their circumstances — which is the whole
  // premise of the fee engine.
  { code: 'MMAKF-FEE-TRN-INDIVIDUAL', slug: 'training-individual', name: 'Individual training', category: 'training', audience: 'athlete', unit: 'per_month', frequency: 'monthly', displayPolicy: 'request_quote' },
  { code: 'MMAKF-FEE-TRN-PARENT-CHILD', slug: 'training-parent-child', name: 'Parent and child training', category: 'training', audience: 'parent', unit: 'per_month', frequency: 'monthly', displayPolicy: 'request_quote' },
  { code: 'MMAKF-FEE-TRN-SCHOOL', slug: 'training-school', name: 'School training programme', category: 'training', audience: 'school', unit: 'per_person', frequency: 'per_term', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-TRN-CORPORATE', slug: 'training-corporate', name: 'Corporate training programme', category: 'training', audience: 'corporate', unit: 'per_person', frequency: 'per_term', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-TRN-UNIVERSITY', slug: 'training-university', name: 'University training programme', category: 'training', audience: 'university', unit: 'per_person', frequency: 'per_term', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-TRN-GOVERNMENT', slug: 'training-government', name: 'Government training programme', category: 'training', audience: 'government', unit: 'per_person', frequency: 'per_term', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-TRN-INSTITUTIONAL', slug: 'training-institutional', name: 'Institutional training programme', category: 'training', audience: 'institution', unit: 'per_person', frequency: 'per_term', displayPolicy: 'institutional' },
  { code: 'MMAKF-FEE-TRN-PERSONAL-COACHING', slug: 'training-personal-coaching', name: 'Personal coaching', category: 'training', audience: 'athlete', unit: 'per_hour', frequency: 'per_session', displayPolicy: 'request_quote' },

  // ── Documents ─────────────────────────────────────────────────────────────
  { code: 'MMAKF-FEE-DOC-MEMBERSHIP-CARD', slug: 'documents-membership-card', name: 'Membership card', category: 'documents', audience: 'member', unit: 'per_card', frequency: 'one_time', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-DOC-CERTIFICATE', slug: 'documents-certificate', name: 'Certificate issue', category: 'documents', audience: 'member', unit: 'per_certificate', frequency: 'on_request', displayPolicy: 'public' },
  { code: 'MMAKF-FEE-DOC-REPLACEMENT', slug: 'documents-replacement', name: 'Replacement document', category: 'documents', audience: 'member', unit: 'per_document', frequency: 'on_request', displayPolicy: 'public' },
] as CatalogueSeedEntry[]);

/**
 * Keys a catalogue write is REFUSED for carrying.
 *
 * Belt to the schema's braces. The table has no money column, so an amount
 * could not be stored anyway — but a caller passing `{ amountMinor: 50000 }`
 * has misunderstood the design, and silently discarding it would let that
 * misunderstanding reach production as a fee somebody believes was recorded.
 */
const FORBIDDEN_KEYS = /^(amount|amount_minor|amountminor|price|price_minor|priceminor|paise|minor|fee|feeminor|cost|rate|total)$/i;

function assertCarriesNoAmount(input: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new FeeCatalogueError(
        'catalogue_carries_no_amount',
        `${where} was given "${key}". A catalogue entry names a chargeable service and carries NO AMOUNT — ` +
        'the figure belongs to a rule inside a versioned fee framework, which is what keeps a 2027 price ' +
        'change from rewriting a 2026 invoice. Add a fee rule instead.'
      );
    }
  }
}

/**
 * Put the federation's chargeable services into the register.
 *
 * IDEMPOTENT by unique code, and it does NOT overwrite. Re-running after
 * somebody has edited a display policy in the admin screen must not quietly
 * revert their decision to whatever this file said months earlier — so an
 * existing code is left exactly as it is and counted as skipped.
 */
export async function seedFeeCatalogue(
  db: DB,
  ctx: AuditContext,
  entries: readonly CatalogueSeedEntry[] = FEE_CATALOGUE_SEED
): Promise<{ inserted: number; skipped: number; total: number }> {
  assertCan(ctx.principal, 'feeframework:write', {});

  const codes = entries.map((e) => e.code);
  const existing: any[] = codes.length
    ? await db.select({ code: s.feeCatalogueEntries.code })
        .from(s.feeCatalogueEntries)
        .where(inArray(s.feeCatalogueEntries.code, codes))
    : [];
  const have = new Set(existing.map((r) => r.code));

  const fresh = entries.filter((e) => !have.has(e.code));
  for (const e of fresh) assertCarriesNoAmount(e as any, `seedFeeCatalogue(${e.code})`);

  if (fresh.length) {
    await db.insert(s.feeCatalogueEntries).values(
      fresh.map((e, i) => ({
        code: e.code,
        slug: e.slug,
        name: e.name,
        category: e.category,
        audience: e.audience,
        unit: e.unit,
        frequency: e.frequency,
        displayPolicy: e.displayPolicy,
        // Published means "the federation charges for this", NOT "the amount is
        // known". The amount is a separate publication, and every surface says
        // so until it happens.
        status: 'published' as const,
        description: e.description ?? null,
        sortOrder: (FEE_CATEGORIES.indexOf(e.category) + 1) * 100 + i,
      }))
    );
    await writeAudit(db, ctx, {
      entityType: 'fee_catalogue', action: 'create',
      newValue: { inserted: fresh.length, codes: fresh.map((e) => e.code) },
    });
  }

  return { inserted: fresh.length, skipped: entries.length - fresh.length, total: entries.length };
}

/**
 * Change what a surface may say about one entry.
 *
 * The only mutation this module offers, and it deliberately cannot touch the
 * code, the category or anything resembling a price — a catalogue entry is a
 * stable identity that quotations and invoices refer to, and renaming its code
 * would orphan them.
 */
export async function setDisplayPolicy(
  db: DB, ctx: AuditContext, code: string, policy: FeeDisplayPolicy
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  if (!FEE_DISPLAY_POLICIES.includes(policy)) {
    throw new FeeCatalogueError('bad_display_policy', `${policy} is not a display policy.`);
  }
  const before = await catalogueEntry(db, code);
  if (!before) throw new FeeCatalogueError('unknown_service', `No catalogue entry ${code}.`);

  const [row] = await db.update(s.feeCatalogueEntries)
    .set({ displayPolicy: policy, updatedAt: new Date() })
    .where(eq(s.feeCatalogueEntries.code, code))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'fee_catalogue_entry', entityId: before.id, action: 'update',
    oldValue: { displayPolicy: before.displayPolicy },
    newValue: { displayPolicy: policy },
  });
  return row;
}
