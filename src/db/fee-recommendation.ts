// The recommendation engine — and the wall it is built on the wrong side of.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GOVERNANCE REQUIREMENT, MADE STRUCTURAL
// ─────────────────────────────────────────────────────────────────────────────
//
// The requirement was: this engine must have NO CODE PATH THAT WRITES A FEE
// RULE. That is easy to satisfy with discipline and impossible to keep with it,
// because discipline is a property of whoever edits the file next.
//
// So it is satisfied by construction instead. THIS MODULE TAKES NO DATABASE
// HANDLE. Not an optional one, not a read-only wrapper — none. Every exported
// function here is pure: an array of frozen observations in, a plain object
// out. There is nothing to write with, so there is no path to guard.
//
// The consequences are deliberate and worth stating, because each one is a
// thing somebody will eventually want to "fix":
//
//   · It does not import src/db/schema.ts. It cannot name a table.
//   · It does not import drizzle. It cannot form a statement.
//   · It does not import src/db/fees.ts. addRule() and publishFramework() live
//     there, and an import is the first half of a call. The one function it
//     needs from that file — applyFactor(), for exact factor arithmetic — is
//     re-exported through src/db/benchmarks.ts precisely so this import can
//     stay absent.
//   · It returns an object whose `status` is 'draft' and whose `isMmakfFee` is
//     the literal `false`. Turning a draft into a price means a person opening
//     a draft framework, authoring a rule, and a SECOND person publishing it,
//     through src/db/fees.ts. Nothing here shortens that.
//
// tests/benchmarks.test.ts asserts all of the above against the file's own
// source text, so the separation fails loudly rather than quietly.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE OUTPUT IS MOSTLY PROSE
// ─────────────────────────────────────────────────────────────────────────────
//
// A median with a sample size beside it looks authoritative and says almost
// nothing. The questions an administrator actually has to answer to the
// executive are: which figures went in, which were left out and why, how many
// separate organisations they came from, and how far any of it has been
// checked. A recommendation that cannot answer those is a number somebody will
// quote in a meeting with no way to defend it.
//
// So `refusals` is a first-class part of the result, not an error channel. When
// three of the six WUKF lines are dropped because the supplied list gave no
// period, that fact travels WITH the recommendation.

import {
  applyFactor, PPM,
  normalise, unitLabel, unitKey, formatBenchmarkAmount,
  type BenchmarkObservation, type BenchmarkUnit, type RefusalCode,
} from '@/db/benchmarks';

// ─── The request ────────────────────────────────────────────────────────────

export interface RecommendationRequest {
  /** A benchmark service code. Comparing across services is refused, not averaged. */
  service: string;
  /** ISO 4217. The engine never converts, so this selects rather than translates. */
  currency: string;
  /** Subject AND period. "Per year" alone is not a unit — see benchmarks.ts. */
  unit: BenchmarkUnit;
  /** Optional narrowing, purely descriptive of what was asked. */
  audience?: string;
  /** The market the recommendation is FOR. MMAKF's is India. */
  market?: { country?: string | null; region?: string | null; label?: string };
  /** Recorded on the draft so the answer carries its own date. */
  asAt?: string;
}

// ─── The result ─────────────────────────────────────────────────────────────

export interface Money {
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  /** "USD 60.00" — in its own currency, never a rupee sign. */
  display: string;
}

export interface Contribution {
  benchmarkId: number;
  benchmarkCode: string;
  organisation: string;
  serviceLabel: string;
  audience: string;
  country: string | null;
  /** What the source said, verbatim. */
  amountText: string;
  /** What it is after normalisation, in the same currency. */
  normalised: Money;
  factorPpm: number;
  because: string;
  confidence: string;
  sourceType: string;
  sourceUrl: string | null;
  sourceTitle: string;
  status: string;
}

export interface Refusal {
  benchmarkId: number;
  benchmarkCode: string;
  organisation: string;
  code: RefusalCode | 'service_mismatch' | 'currency_mismatch';
  reason: string;
}

export type RecommendationConfidence = 'insufficient' | 'low' | 'medium' | 'high';

export interface FeeRecommendation {
  /** Discriminant. A consumer that treats this as a price has to ignore it deliberately. */
  kind: 'fee_recommendation_draft';
  /** Literal false, and it is never anything else in any branch of this file. */
  isMmakfFee: false;
  status: 'draft';

  request: RecommendationRequest;
  unit: BenchmarkUnit;
  unitKey: string;
  unitLabel: string;
  currency: string;
  asAt: string | null;

  sampleSize: number;
  organisationCount: number;
  organisations: string[];

  /** Null when the sample is empty. NEVER a fallback figure. */
  median: Money | null;
  low: Money | null;
  high: Money | null;
  /** high ÷ low as parts-per-million, or null. The spread, without a float. */
  spreadPpm: number | null;

  contributions: Contribution[];
  refusals: Refusal[];

  confidence: RecommendationConfidence;
  confidenceReasons: string[];
  reasons: string[];
  cautions: string[];

  approval: {
    required: true;
    approvedByUserId: null;
    approvedAt: null;
    /** What a human has to do next, in words, on the object itself. */
    route: string;
  };
  notice: string;
}

// ─── Arithmetic ─────────────────────────────────────────────────────────────

/**
 * The midpoint of two integer amounts, rounded half up.
 *
 * Expressed as a ×0.5 parts-per-million factor rather than `(a + b) / 2` so it
 * goes through applyFactor() — the single place in this codebase where a factor
 * is applied and a rounding decision is made. A second rounding rule for
 * medians is how one report comes to disagree with another by a cent.
 */
function midpoint(a: number, b: number): number {
  return applyFactor(a + b, PPM / 2);
}

/** The median of a sorted integer array. Even lengths take the midpoint. */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : midpoint(sorted[mid - 1], sorted[mid]);
}

function money(amountMinor: number, currency: string, exponent: number): Money {
  return {
    amountMinor,
    currency,
    currencyExponent: exponent,
    display: formatBenchmarkAmount(amountMinor, currency, exponent),
  };
}

/** high ÷ low in parts-per-million. Integer throughout; null when low is zero. */
function spreadPpm(low: number, high: number): number | null {
  if (low <= 0) return null;
  return Number((BigInt(high) * BigInt(PPM) + BigInt(low) / 2n) / BigInt(low));
}

// ─── Confidence ─────────────────────────────────────────────────────────────

const LADDER: RecommendationConfidence[] = ['insufficient', 'low', 'medium', 'high'];

function stepDown(c: RecommendationConfidence): RecommendationConfidence {
  const i = LADDER.indexOf(c);
  return LADDER[Math.max(0, i - 1)];
}

/**
 * How much weight the sample deserves.
 *
 * The rules are stated here rather than tuned in a caller because they are
 * arguable, and an arguable rule belongs somewhere it can be argued with:
 *
 *  · FEWER THAN THREE OBSERVATIONS IS NOT A MARKET. A median of two is the
 *    mean of two, and a median of one is that one organisation's price.
 *  · ONE ORGANISATION IS NOT A MARKET EITHER, at any sample size. Six figures
 *    from WUKF are one body's price list. This caps the answer at 'low' however
 *    many rows there are, and it is the rule most likely to be quietly removed
 *    by somebody who wants a stronger-sounding result.
 *  · A SPREAD ABOVE THREE TO ONE means the median is sitting in a gap rather
 *    than a cluster, and describing it as typical is a stretch.
 *  · 'high' REQUIRES EVERY FIGURE TO BE VERIFIED — seen at its own source. The
 *    thirteen figures this system ships with are all 'reported', so 'high' is
 *    unreachable from the seed. That is the correct answer, not a gap: nobody
 *    has checked them against the federations that charge them.
 */
function gradeConfidence(
  contributions: Contribution[],
  spread: number | null
): { confidence: RecommendationConfidence; reasons: string[] } {
  const reasons: string[] = [];
  const n = contributions.length;
  const orgs = new Set(contributions.map((c) => c.organisation));

  if (n === 0) {
    return { confidence: 'insufficient', reasons: ['Nothing in the benchmark store matches this question.'] };
  }
  if (n < 3) {
    return {
      confidence: 'insufficient',
      reasons: [`Only ${n} comparable observation${n === 1 ? '' : 's'}. A median needs at least three to mean anything.`],
    };
  }

  let confidence: RecommendationConfidence = 'low';
  reasons.push(`${n} comparable observations from ${orgs.size} organisation${orgs.size === 1 ? '' : 's'}.`);

  if (n >= 5 && orgs.size >= 3) {
    confidence = 'medium';
    reasons.push('Five or more observations spanning at least three organisations.');
  }
  if (n >= 8 && orgs.size >= 4 && contributions.every((c) => c.confidence === 'verified')) {
    confidence = 'high';
    reasons.push('Eight or more observations, four or more organisations, every figure verified at its own source.');
  }

  if (orgs.size === 1) {
    confidence = 'low';
    reasons.push(
      `Every figure comes from ${[...orgs][0]}. One organisation's price list is not a market, however many lines it has, so this cannot rise above low.`
    );
  }

  const unverified = contributions.filter((c) => c.confidence !== 'verified');
  if (unverified.length) {
    if (confidence === 'high') confidence = 'medium';
    reasons.push(
      `${unverified.length} of ${n} figures ${unverified.length === 1 ? 'is' : 'are'} attributed but not verified at its own source.`
    );
  }

  if (spread != null && spread > 3 * PPM) {
    const before = confidence;
    confidence = stepDown(confidence);
    reasons.push(
      `The highest figure is more than three times the lowest, so the median sits in a spread rather than a cluster (${before} → ${confidence}).`
    );
  }

  return { confidence, reasons };
}

// ─── The engine ─────────────────────────────────────────────────────────────

/**
 * Recommend a figure — as a DRAFT, from evidence, with its refusals attached.
 *
 * Takes observations, NOT a database. See the header: that is the whole
 * governance mechanism, and it is the reason this signature looks inconvenient.
 * The caller loads with listBenchmarks() from src/db/benchmarks.ts and passes
 * the result in.
 */
export function recommendFee(
  observations: readonly BenchmarkObservation[],
  request: RecommendationRequest
): FeeRecommendation {
  const contributions: Contribution[] = [];
  const refusals: Refusal[] = [];

  for (const o of observations) {
    // Service first: it is the difference the brief called out by name, and
    // reporting it as a unit problem would be the wrong diagnosis. A monthly
    // training fee is not an annual membership expressed awkwardly.
    if (o.service !== request.service) {
      refusals.push({
        benchmarkId: o.id, benchmarkCode: o.code, organisation: o.organisation,
        code: 'service_mismatch',
        reason: `${o.serviceLabel} is ${o.service}, and the question is about ${request.service}. Different services are different products, not different prices for one.`,
      });
      continue;
    }

    // Currency second. No conversion happens anywhere in this file: that needs
    // a rate carrying the date it was taken, which nothing here holds.
    if (o.currency !== request.currency) {
      refusals.push({
        benchmarkId: o.id, benchmarkCode: o.code, organisation: o.organisation,
        code: 'currency_mismatch',
        reason: `${o.amountText} is in ${o.currency} and the comparison is in ${request.currency}. Converting needs an exchange rate with a timestamp, which this engine does not hold and will not assume.`,
      });
      continue;
    }

    if (request.audience && o.audience !== request.audience) {
      refusals.push({
        benchmarkId: o.id, benchmarkCode: o.code, organisation: o.organisation,
        code: 'service_mismatch',
        reason: `${o.serviceLabel} applies to ${o.audience}, and the question is about ${request.audience}.`,
      });
      continue;
    }

    const n = normalise(o, request.unit);
    if (!n.ok) {
      refusals.push({
        benchmarkId: o.id, benchmarkCode: o.code, organisation: o.organisation,
        code: n.code, reason: n.reason,
      });
      continue;
    }

    contributions.push({
      benchmarkId: o.id,
      benchmarkCode: o.code,
      organisation: o.organisation,
      serviceLabel: o.serviceLabel,
      audience: o.audience,
      country: o.country,
      amountText: o.amountText,
      normalised: money(n.amountMinor, n.currency, n.currencyExponent),
      factorPpm: n.factorPpm,
      because: n.because,
      confidence: o.confidence,
      sourceType: o.sourceType,
      sourceUrl: o.sourceUrl,
      sourceTitle: o.sourceTitle,
      status: o.status,
    });
  }

  const amounts = contributions.map((c) => c.normalised.amountMinor).sort((a, b) => a - b);
  const exponent = contributions[0]?.normalised.currencyExponent ?? 2;

  const low = amounts.length ? money(amounts[0], request.currency, exponent) : null;
  const high = amounts.length ? money(amounts[amounts.length - 1], request.currency, exponent) : null;
  // NO FALLBACK. An empty sample yields null, never zero — zero reads as
  // "free", which is the same mistake computeFee() in fees.ts refuses to make.
  const median = amounts.length ? money(medianOf(amounts), request.currency, exponent) : null;
  const spread = low && high ? spreadPpm(low.amountMinor, high.amountMinor) : null;

  const organisations = [...new Set(contributions.map((c) => c.organisation))].sort();
  const { confidence, reasons: confidenceReasons } = gradeConfidence(contributions, spread);

  // ── The narrative ──
  const reasons: string[] = [];
  if (median && low && high) {
    reasons.push(
      `Median ${median.display} ${unitLabel(request.unit)}, across ${contributions.length} observation${contributions.length === 1 ? '' : 's'} from ${organisations.length} organisation${organisations.length === 1 ? '' : 's'} (${organisations.join(', ')}).`
    );
    reasons.push(`Range ${low.display} to ${high.display}, all in ${request.currency}, none converted.`);
    for (const c of contributions) {
      reasons.push(`${c.organisation} — ${c.serviceLabel}: ${c.because}`);
    }
  } else {
    reasons.push(
      `No observation in the benchmark store answers this question: ${request.service}, ${unitLabel(request.unit)}, in ${request.currency}. ` +
      'There is no figure, and none has been substituted.'
    );
  }

  // ── The cautions ──
  const cautions: string[] = [];
  if (refusals.length) {
    cautions.push(
      `${refusals.length} observation${refusals.length === 1 ? ' was' : 's were'} left out and the reasons are recorded on this draft. Read them before quoting the median.`
    );
  }
  const wantedCountry = request.market?.country ?? null;
  if (contributions.length && wantedCountry && !contributions.some((c) => c.country === wantedCountry)) {
    cautions.push(
      `Not one contributing figure comes from ${wantedCountry}. These are foreign price points, and what a federation charges reflects the incomes, expectations and competing options of its own country before it reflects anything comparable.`
    );
  }
  if (contributions.some((c) => c.status === 'flagged')) {
    cautions.push('At least one contributing figure is flagged for review. It is counted, because dropping evidence somebody merely doubted would curate the sample.');
  }
  cautions.push(
    'These are amounts other organisations were reported to charge. They are not an MMAKF price, and this store holds no MMAKF price to compare them with.'
  );

  return {
    kind: 'fee_recommendation_draft',
    isMmakfFee: false,
    status: 'draft',

    request,
    unit: request.unit,
    unitKey: unitKey(request.unit),
    unitLabel: unitLabel(request.unit),
    currency: request.currency,
    asAt: request.asAt ?? null,

    sampleSize: contributions.length,
    organisationCount: organisations.length,
    organisations,

    median,
    low,
    high,
    spreadPpm: spread,

    contributions,
    refusals,

    confidence,
    confidenceReasons,
    reasons,
    cautions,

    approval: {
      required: true,
      approvedByUserId: null,
      approvedAt: null,
      route:
        'This is a draft for a person to consider. Making it an MMAKF fee means authoring a rule in a DRAFT fee framework and a second person publishing that framework, through src/db/fees.ts. This engine cannot do either, and holds no database handle with which to try.',
    },
    notice:
      'Benchmark evidence about other organisations. Not an MMAKF fee, not a proposal, and not converted to rupees.',
  };
}

/**
 * The same question asked of a frozen snapshot.
 *
 * Exists so "what did we recommend in March, and on what evidence?" is
 * answerable in September against the evidence as it stood, rather than against
 * a benchmark table that has moved since. Identical inputs, identical output —
 * which is testable, and tested.
 */
export function recommendFromSnapshot(
  snapshot: { observations: readonly BenchmarkObservation[]; query?: unknown },
  request: RecommendationRequest
): FeeRecommendation {
  return recommendFee(snapshot.observations, request);
}
