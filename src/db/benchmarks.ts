// The benchmark store, and the refusal that makes it worth having.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE HARD PROBLEM IN THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation supplied thirteen figures. Averaging them produces a number.
// The number is meaningless, and the brief said so in as many words: a USD 60
// annual membership and a USD 185 monthly training fee are not comparable.
//
// It is worse than the brief suggests, because there are FOUR independent ways
// two benchmarks can fail to be comparable and only one of them is obvious:
//
//   PERIOD    — a year against a month against a single event.
//   SUBJECT   — a person against a club against a national federation. This is
//               the one a `frequency` column loses. USA Karate's USD 200 club
//               fee and its USD 60 athlete fee are both annual, and their mean
//               of USD 130 describes nothing that exists.
//   SERVICE   — a membership subscription against a training course against a
//               protest deposit.
//   CURRENCY  — USD against GBP against EUR, with no rate and no date.
//
// So `normalise()` converts where a conversion is exact and REFUSES where it is
// not, returning a reason instead of a figure. Every refusal below is a place
// where the alternative was to pick a ratio nobody supplied.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY MONTH→YEAR IS ALLOWED AND YEAR→MONTH IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This asymmetry is not fastidiousness. A recurring monthly fee of USD 185
// genuinely costs USD 2,220 over a year: twelve months are a year by
// definition, the multiplication is exact, and the annual figure is a real
// quantity somebody pays.
//
// An annual membership of USD 60 divided by twelve is USD 5 a month, and NOBODY
// PAYS USD 5 A MONTH. It is an accounting average of a single yearly
// transaction, and putting it on a row headed "monthly fee" beside a genuine
// monthly training price invites precisely the comparison that is wrong. So the
// conversion runs one way and the other direction is a refusal with that
// sentence attached.
//
// Weeks are refused in both directions for a duller reason: a year is not a
// whole number of weeks, so any factor would have to be chosen by us.
//
// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY
// ─────────────────────────────────────────────────────────────────────────────
//
// Nothing here converts to INR, or to anything else. A cross-currency
// comparison needs a rate WITH A TIMESTAMP, kept as a stored fact rather than
// looked up at read time — otherwise a recommendation re-run next month quietly
// changes because a rate moved, and nobody can say whether the evidence or the
// arithmetic was different. That is a separate concern with a separate owner,
// and until it exists a mixed-currency comparison is refused.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere, canAnywhere, type Principal } from '@/lib/rbac';
// applyFactor is the ONLY place a parts-per-million factor is applied in this
// codebase, and month→year is a factor. Re-implementing the multiply here would
// have given the benchmark store its own rounding behaviour, which is how two
// parts of one system come to disagree about a figure.
import { applyFactor, PPM } from '@/db/fees';

/**
 * Re-exported so src/db/fee-recommendation.ts can do exact factor arithmetic
 * WITHOUT importing src/db/fees.ts.
 *
 * That module must not import the fee-authoring module at all: addRule() and
 * publishFramework() live there, and an import is the first half of a call. The
 * one thing the recommendation engine legitimately needs from fees.ts is a
 * multiply, so it comes through here and the authoring functions stay out of
 * its reach entirely.
 */
export { applyFactor, PPM };

type DB = any;

export class BenchmarkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BenchmarkError';
    this.code = code;
  }
}

/** Identified by shape, not `instanceof` — see src/lib/calendar.ts for why. */
export function isBenchmarkError(err: unknown): err is BenchmarkError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'BenchmarkError';
}

// ─── Units ──────────────────────────────────────────────────────────────────

export type BenchmarkPeriod =
  | 'per_year' | 'per_month' | 'per_week' | 'per_session' | 'per_event' | 'one_off' | 'unstated';

export type BenchmarkSubjectKind =
  | 'person' | 'club' | 'team' | 'federation' | 'application' | 'unstated';

/**
 * A unit is a PAIR. "Per year" is not a unit; "per person, per year" is.
 *
 * Keeping the two dimensions apart in the type is what makes the club/athlete
 * mistake a compile-time-shaped problem rather than a judgement someone has to
 * remember to make at the call site.
 */
export interface BenchmarkUnit {
  subject: BenchmarkSubjectKind;
  period: BenchmarkPeriod;
}

export function unitKey(u: BenchmarkUnit): string {
  return `${u.subject}:${u.period}`;
}

export function parseUnit(key: string): BenchmarkUnit {
  const [subject, period] = String(key).split(':');
  return { subject: subject as BenchmarkSubjectKind, period: period as BenchmarkPeriod };
}

const PERIOD_WORDS: Record<BenchmarkPeriod, string> = {
  per_year: 'per year',
  per_month: 'per month',
  per_week: 'per week',
  per_session: 'per session',
  per_event: 'per event',
  one_off: 'once',
  unstated: 'over an unstated period',
};

const SUBJECT_WORDS: Record<BenchmarkSubjectKind, string> = {
  person: 'per person',
  club: 'per club',
  team: 'per team',
  federation: 'per federation',
  application: 'per application',
  unstated: 'per an unstated subject',
};

/** "per person, per year" — for a reader, never a key. */
export function unitLabel(u: BenchmarkUnit): string {
  return `${SUBJECT_WORDS[u.subject] ?? u.subject}, ${PERIOD_WORDS[u.period] ?? u.period}`;
}

/** Periods that recur over time, as opposed to occurring on an occasion. */
const RECURRING: BenchmarkPeriod[] = ['per_year', 'per_month', 'per_week'];
/** Periods that count occasions. There is no rate between these and the above. */
const OCCURRENCE: BenchmarkPeriod[] = ['per_session', 'per_event', 'one_off'];

// ─── The observation ────────────────────────────────────────────────────────

/**
 * A benchmark as the rest of the system sees it: a plain, frozen value.
 *
 * This is the ONLY shape src/db/fee-recommendation.ts accepts. That module
 * takes no database handle at all, and this type is why it does not need one —
 * which is what makes "the recommendation engine cannot write a fee rule" a
 * structural fact rather than a rule somebody has to keep.
 */
export interface BenchmarkObservation {
  id: number;
  code: string;
  organisation: string;
  country: string | null;
  region: string | null;
  service: string;
  serviceLabel: string;
  audience: string;
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  amountText: string;
  frequency: BenchmarkPeriod;
  subject: BenchmarkSubjectKind;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  sourceUrl: string | null;
  sourceTitle: string;
  sourceDate: string | null;
  retrievedAt: string | null;
  sourceType: string;
  confidence: string;
  status: string;
  notes: string | null;
}

const asIso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Map a database row onto the frozen observation the engine consumes. */
export function toObservation(row: any): BenchmarkObservation {
  return Object.freeze({
    id: row.id,
    code: row.code,
    organisation: row.organisation,
    country: row.country ?? null,
    region: row.region ?? null,
    service: row.service,
    serviceLabel: row.serviceLabel ?? row.service_label,
    audience: row.audience,
    amountMinor: Number(row.amountMinor ?? row.amount_minor),
    currency: row.currency,
    currencyExponent: Number(row.currencyExponent ?? row.currency_exponent ?? 2),
    amountText: row.amountText ?? row.amount_text,
    frequency: (row.frequency ?? 'unstated') as BenchmarkPeriod,
    subject: (row.subject ?? 'unstated') as BenchmarkSubjectKind,
    effectiveFrom: row.effectiveFrom ?? row.effective_from ?? null,
    effectiveUntil: row.effectiveUntil ?? row.effective_until ?? null,
    sourceUrl: row.sourceUrl ?? row.source_url ?? null,
    sourceTitle: row.sourceTitle ?? row.source_title,
    sourceDate: row.sourceDate ?? row.source_date ?? null,
    retrievedAt: asIso(row.retrievedAt ?? row.retrieved_at),
    sourceType: row.sourceType ?? row.source_type,
    confidence: row.confidence,
    status: row.status,
    notes: row.notes ?? null,
  });
}

/**
 * The major-unit rendering of an amount, in its OWN currency.
 *
 * "USD 60.00" — never "₹" and never converted. formatINR() in fees.ts is for
 * MMAKF's money; this is somebody else's, and rendering it with a rupee sign is
 * the first step towards it being read as a price MMAKF charges.
 */
export function formatBenchmarkAmount(amountMinor: number, currency: string, exponent = 2): string {
  const negative = amountMinor < 0;
  const abs = Math.abs(Math.round(amountMinor));
  const scale = 10 ** exponent;
  const major = Math.floor(abs / scale);
  const minor = exponent > 0 ? '.' + String(abs % scale).padStart(exponent, '0') : '';
  return `${negative ? '-' : ''}${currency} ${major.toLocaleString('en-GB')}${minor}`;
}

// ─── Normalisation ──────────────────────────────────────────────────────────

export type RefusalCode =
  | 'period_unstated'
  | 'subject_unstated'
  | 'subject_mismatch'
  | 'currency_mismatch'
  | 'no_downward_period_conversion'
  | 'inexact_period_conversion'
  | 'occurrence_and_period'
  | 'service_mismatch'
  | 'not_included';

export interface Normalised {
  ok: true;
  unit: BenchmarkUnit;
  unitKey: string;
  /** In the minor unit of the observation's OWN currency. Never converted. */
  amountMinor: number;
  currency: string;
  currencyExponent: number;
  /** The factor applied, parts-per-million. 1_000_000 means nothing changed. */
  factorPpm: number;
  /** How it was derived, for the "why this figure?" line. */
  because: string;
  observation: BenchmarkObservation;
}

export interface Refused {
  ok: false;
  code: RefusalCode;
  /** A sentence a reader can act on. Never "incompatible units". */
  reason: string;
  unit: BenchmarkUnit;
  observation: BenchmarkObservation;
}

export type NormaliseResult = Normalised | Refused;

/**
 * The period conversion table, as parts-per-million factors.
 *
 * Only ONE entry is a conversion. Everything else in this system's data is an
 * identity or a refusal, and that is the honest shape of the problem rather
 * than a gap waiting to be filled in.
 */
const PERIOD_FACTOR_PPM: Record<string, number> = {
  'per_year:per_year': PPM,
  'per_month:per_month': PPM,
  'per_week:per_week': PPM,
  'per_session:per_session': PPM,
  'per_event:per_event': PPM,
  'one_off:one_off': PPM,
  // Twelve months are a year, exactly, by definition. A recurring monthly fee
  // really does cost twelve times as much over a year.
  'per_month:per_year': 12 * PPM,
};

/**
 * Express one observation in a target unit, or refuse and say why.
 *
 * REFUSING IS THE FEATURE. Every branch that returns `ok: false` is a place
 * where producing a number would have required inventing something the data
 * does not contain — a number of events per year, an exchange rate, a team
 * size, or a decision that a club and a person are the same kind of thing.
 */
export function normalise(observation: BenchmarkObservation, target: BenchmarkUnit): NormaliseResult {
  const refuse = (code: RefusalCode, reason: string): Refused =>
    ({ ok: false, code, reason, unit: target, observation });

  // A row somebody excluded is not evidence. `flagged` deliberately still
  // passes: see the note on benchmarkStatus in benchmarks.schema.ts.
  if (observation.status === 'excluded' || observation.status === 'archived') {
    return refuse('not_included', `${observation.code} is ${observation.status} and is not counted as evidence.`);
  }

  if (observation.frequency === 'unstated') {
    return refuse(
      'period_unstated',
      `${observation.organisation} — ${observation.serviceLabel}: the source gave an amount (${observation.amountText}) and no period. ` +
      'It cannot be expressed per year or per event without deciding which one it is, and the source did not say.'
    );
  }
  if (observation.subject === 'unstated') {
    return refuse(
      'subject_unstated',
      `${observation.organisation} — ${observation.serviceLabel}: the source did not say who the fee is levied on, so it cannot be matched to a per-person or per-club figure.`
    );
  }

  // SUBJECT NEVER CONVERTS. There is no ratio between a club and a person that
  // is not a membership count somebody would have to supply, and no ratio
  // between a team and a person that is not a team size.
  if (observation.subject !== target.subject) {
    return refuse(
      'subject_mismatch',
      `${observation.organisation} — ${observation.serviceLabel} is charged ${SUBJECT_WORDS[observation.subject]}, and the comparison is ${SUBJECT_WORDS[target.subject]}. ` +
      'Converting between the two needs a membership or squad size that no source here supplies.'
    );
  }

  const from = observation.frequency;
  const to = target.period;

  if (to === 'unstated') {
    return refuse('period_unstated', 'A comparison cannot have an unstated period as its target unit.');
  }

  const key = `${from}:${to}`;
  const factorPpm = PERIOD_FACTOR_PPM[key];

  if (factorPpm == null) {
    const crossesFamilies =
      (RECURRING.includes(from) && OCCURRENCE.includes(to)) ||
      (OCCURRENCE.includes(from) && RECURRING.includes(to));

    if (crossesFamilies) {
      return refuse(
        'occurrence_and_period',
        `${observation.organisation} — ${observation.serviceLabel} is charged ${PERIOD_WORDS[from]}, and the comparison is ${PERIOD_WORDS[to]}. ` +
        'Relating an occasion to a length of time needs how many occasions there are in a year, which is not in the data.'
      );
    }
    if (from === 'per_week' || to === 'per_week') {
      return refuse(
        'inexact_period_conversion',
        `${observation.organisation} — ${observation.serviceLabel} is charged ${PERIOD_WORDS[from]}. ` +
        'A year is not a whole number of weeks, so any conversion factor would be one this system chose rather than one the source stated.'
      );
    }
    if (from === 'per_year' && to === 'per_month') {
      return refuse(
        'no_downward_period_conversion',
        `${observation.organisation} — ${observation.serviceLabel} is an annual figure (${observation.amountText}). ` +
        'Dividing it by twelve gives an accounting average, not a monthly price anybody pays, and setting that beside a real monthly fee is the comparison this store exists to prevent. ' +
        'Compare per year instead.'
      );
    }
    // Two occurrence units, e.g. per_session against per_event.
    return refuse(
      'occurrence_and_period',
      `${observation.organisation} — ${observation.serviceLabel} is charged ${PERIOD_WORDS[from]}, and the comparison is ${PERIOD_WORDS[to]}. ` +
      'No stated relationship connects the two.'
    );
  }

  const amountMinor = applyFactor(observation.amountMinor, factorPpm);

  return {
    ok: true,
    unit: target,
    unitKey: unitKey(target),
    amountMinor,
    currency: observation.currency,
    currencyExponent: observation.currencyExponent,
    factorPpm,
    because: factorPpm === PPM
      ? `${observation.amountText} is already ${unitLabel(target)}.`
      : `${observation.amountText} × 12 = ${formatBenchmarkAmount(amountMinor, observation.currency, observation.currencyExponent)} ${unitLabel(target)}. Twelve months are a year exactly.`,
    observation,
  };
}

/**
 * Would these two ever belong in the same average?
 *
 * Used to explain a refusal in terms of a pair rather than a target unit, which
 * is what an administrator asking "why isn't the club fee in there?" wants.
 */
export function comparable(a: BenchmarkObservation, b: BenchmarkObservation): { ok: boolean; reason: string } {
  if (a.service !== b.service) {
    return {
      ok: false,
      reason: `${a.serviceLabel} and ${b.serviceLabel} are different services (${a.service} against ${b.service}). A membership subscription and a training course are not two prices for the same thing.`,
    };
  }
  if (a.currency !== b.currency) {
    return {
      ok: false,
      reason: `${a.currency} and ${b.currency}. Comparing them needs an exchange rate carrying the date it was taken, which this store does not hold.`,
    };
  }
  if (a.subject !== b.subject) {
    return { ok: false, reason: `One is charged ${SUBJECT_WORDS[a.subject]} and the other ${SUBJECT_WORDS[b.subject]}.` };
  }
  if (a.frequency === 'unstated' || b.frequency === 'unstated') {
    return { ok: false, reason: 'One of them has no stated period, and it has not been guessed.' };
  }
  const target: BenchmarkUnit = { subject: a.subject, period: RECURRING.includes(a.frequency) ? 'per_year' : a.frequency };
  const na = normalise(a, target);
  const nb = normalise(b, target);
  if (!na.ok) return { ok: false, reason: na.reason };
  if (!nb.ok) return { ok: false, reason: nb.reason };
  return { ok: true, reason: `Both express as ${unitLabel(target)} in ${a.currency}.` };
}

// ─── Reading the store ──────────────────────────────────────────────────────

export interface BenchmarkFilter {
  service?: string | string[];
  organisation?: string;
  country?: string | null;
  currency?: string;
  subject?: BenchmarkSubjectKind;
  audience?: string;
  /** Defaults to the two statuses that count as evidence. */
  statuses?: string[];
}

/** The statuses that inform a recommendation. `flagged` is in — deliberately. */
export const EVIDENTIAL_STATUSES = ['included', 'flagged'] as const;

/**
 * Load observations.
 *
 * Gated on 'benchmark:read' ANYWHERE rather than against a scope, because a
 * benchmark has no place in the federation hierarchy: it is a fact about
 * somebody outside MMAKF entirely, so there is no state unit whose
 * administrator owns it. Note who does NOT hold the action: every institution
 * role. A client that could read the market evidence behind a quotation is
 * reading MMAKF's pricing preparation, which PART AC puts off limits for the
 * same reason it puts fee rules off limits.
 */
export async function listBenchmarks(
  db: DB, principal: Principal | null | undefined, filter: BenchmarkFilter = {}
): Promise<BenchmarkObservation[]> {
  assertCanAnywhere(principal, 'benchmark:read');

  const where: any[] = [];
  if (filter.service) {
    const services = Array.isArray(filter.service) ? filter.service : [filter.service];
    where.push(inArray(s.feeBenchmarks.service, services));
  }
  if (filter.organisation) where.push(eq(s.feeBenchmarks.organisation, filter.organisation));
  if (filter.currency) where.push(eq(s.feeBenchmarks.currency, filter.currency));
  if (filter.subject) where.push(eq(s.feeBenchmarks.subject, filter.subject as any));
  if (filter.audience) where.push(eq(s.feeBenchmarks.audience, filter.audience));
  if (filter.country !== undefined) {
    where.push(filter.country === null
      ? sql`${s.feeBenchmarks.country} is null`
      : eq(s.feeBenchmarks.country, filter.country));
  }
  const statuses = filter.statuses ?? [...EVIDENTIAL_STATUSES];
  where.push(inArray(s.feeBenchmarks.status, statuses as any));

  const rows = await db.select().from(s.feeBenchmarks)
    .where(where.length === 1 ? where[0] : and(...where))
    .orderBy(asc(s.feeBenchmarks.organisation), asc(s.feeBenchmarks.code));

  return rows.map(toObservation);
}

/** Every source, for the citations panel. */
export async function listBenchmarkSources(db: DB, principal: Principal | null | undefined) {
  assertCanAnywhere(principal, 'benchmark:read');
  return db.select().from(s.feeBenchmarkSources).orderBy(asc(s.feeBenchmarkSources.organisation));
}

/** Can this principal see the benchmark store at all? For nav and dashboards. */
export function canReadBenchmarks(principal: Principal | null | undefined): boolean {
  return canAnywhere(principal, 'benchmark:read');
}

// ─── Writing to the store ───────────────────────────────────────────────────

export interface SourceInput {
  code: string;
  organisation: string;
  title: string;
  url?: string | null;
  publishedOn?: string | null;
  sourceType: string;
  confidence: string;
  notes?: string | null;
}

/**
 * Register a citation.
 *
 * A source claiming to be an `official_publication` MUST carry a URL. That is
 * the one combination the store refuses outright: "I read it on their website"
 * without saying where is not a citation, and it is the shape a fabricated
 * attribution takes.
 */
export async function recordSource(db: DB, ctx: AuditContext, input: SourceInput) {
  assertCanAnywhere(ctx.principal, 'benchmark:write');

  if (!input.code?.trim()) throw new BenchmarkError('bad_code', 'A source needs a stable code.');
  if (!input.organisation?.trim()) throw new BenchmarkError('bad_source', 'A source must name the organisation it describes.');
  if (!input.title?.trim()) throw new BenchmarkError('bad_source', 'A source must have a title saying what it is.');
  if (input.sourceType === 'official_publication' && !input.url?.trim()) {
    throw new BenchmarkError(
      'source_url_required',
      'An official publication must carry the URL it was read at. A first-hand citation nobody can follow is not a citation.'
    );
  }

  const [row] = await db.insert(s.feeBenchmarkSources).values({
    code: input.code.trim(),
    organisation: input.organisation.trim(),
    title: input.title.trim(),
    url: input.url?.trim() || null,
    publishedOn: input.publishedOn ?? null,
    sourceType: input.sourceType as any,
    confidence: input.confidence as any,
    recordedByUserId: ctx.principal.userId ?? null,
    notes: input.notes ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'fee_benchmark_source', entityId: row.id, action: 'create',
    newValue: { code: row.code, organisation: row.organisation, sourceType: row.sourceType },
  });
  return row;
}

export interface BenchmarkInput {
  code: string;
  sourceCode: string;
  organisation: string;
  country?: string | null;
  region?: string | null;
  service: string;
  serviceLabel: string;
  audience: string;
  amountMinor: number;
  currency: string;
  currencyExponent?: number;
  amountText: string;
  frequency: BenchmarkPeriod;
  subject: BenchmarkSubjectKind;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  notes?: string | null;
}

/**
 * Record an observation about another organisation.
 *
 * The provenance is NOT taken from the caller. It is copied off the registered
 * source, so an observation cannot be entered with an attribution that no
 * source register knows about — which is exactly how an invented figure would
 * get in, one field at a time.
 *
 * A benchmark is never entered as 'verified' by this path either. Verification
 * is a claim that a named person saw the figure at the stated source on a
 * stated date, and it belongs on the source record, not on a form field the
 * person filling it in can tick.
 */
export async function recordBenchmark(db: DB, ctx: AuditContext, input: BenchmarkInput) {
  assertCanAnywhere(ctx.principal, 'benchmark:write');

  if (!Number.isInteger(input.amountMinor)) {
    throw new BenchmarkError(
      'bad_amount',
      'Benchmark amounts are integers in the minor unit of their own currency. USD 60 is 6000, not 60.'
    );
  }
  if (input.amountMinor < 0) throw new BenchmarkError('bad_amount', 'A published fee is not negative.');
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new BenchmarkError('bad_currency', 'Currency is an ISO 4217 code, in capitals — USD, GBP, EUR, INR.');
  }
  if (!input.amountText?.trim()) {
    throw new BenchmarkError(
      'amount_text_required',
      'Record the figure exactly as the source stated it. It is what a later reader checks the parsed columns against.'
    );
  }
  if (!input.serviceLabel?.trim()) {
    throw new BenchmarkError('label_required', 'Record the wording the source used, unaltered.');
  }

  const [source] = await db.select().from(s.feeBenchmarkSources)
    .where(eq(s.feeBenchmarkSources.code, input.sourceCode)).limit(1);
  if (!source) {
    throw new BenchmarkError(
      'unknown_source',
      `No registered source '${input.sourceCode}'. A figure about another organisation is not stored without one — an unattributed claim about a third party is a rumour with a database row.`
    );
  }

  const [row] = await db.insert(s.feeBenchmarks).values({
    code: input.code.trim(),
    sourceId: source.id,
    organisation: input.organisation.trim(),
    country: input.country ?? null,
    region: input.region ?? null,
    service: input.service,
    serviceLabel: input.serviceLabel.trim(),
    audience: input.audience,
    amountMinor: input.amountMinor,
    currency: input.currency,
    currencyExponent: input.currencyExponent ?? 2,
    amountText: input.amountText.trim(),
    frequency: input.frequency as any,
    subject: input.subject as any,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveUntil: input.effectiveUntil ?? null,
    // Copied from the source, never accepted from the caller.
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceDate: source.publishedOn,
    retrievedAt: source.retrievedAt,
    sourceType: source.sourceType,
    confidence: source.confidence,
    notes: input.notes ?? null,
    status: 'included',
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'fee_benchmark', entityId: row.id, action: 'create',
    newValue: {
      code: row.code, organisation: row.organisation, service: row.service,
      amountText: row.amountText, sourceCode: input.sourceCode,
    },
  });
  return row;
}

/**
 * Change an observation's standing.
 *
 * A REASON IS REQUIRED for anything other than `included`. Dropping a figure
 * out of the evidence is a judgement about a third party's data, and one
 * somebody may have to defend when the recommendation it shaped is questioned.
 * An unexplained exclusion is indistinguishable from curating the sample.
 */
export async function setBenchmarkStatus(
  db: DB, ctx: AuditContext, benchmarkId: number,
  status: 'included' | 'excluded' | 'flagged' | 'archived',
  reason?: string | null
) {
  assertCanAnywhere(ctx.principal, 'benchmark:write');

  const [before] = await db.select().from(s.feeBenchmarks)
    .where(eq(s.feeBenchmarks.id, benchmarkId)).limit(1);
  if (!before) throw new BenchmarkError('unknown_benchmark', 'No such benchmark.');

  if (status !== 'included' && !reason?.trim()) {
    throw new BenchmarkError(
      'reason_required',
      `Marking ${before.code} as ${status} needs a recorded reason. Evidence that leaves the sample without one cannot be told from evidence that was inconvenient.`
    );
  }

  await db.update(s.feeBenchmarks)
    .set({ status: status as any, statusReason: reason?.trim() || null, updatedAt: new Date() })
    .where(eq(s.feeBenchmarks.id, benchmarkId));

  await writeAudit(db, ctx, {
    entityType: 'fee_benchmark', entityId: benchmarkId, action: 'update',
    oldValue: { status: before.status, statusReason: before.statusReason },
    newValue: { status, statusReason: reason?.trim() || null },
  });
  return { id: benchmarkId, status };
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * Freeze the evidence behind a recommendation.
 *
 * The observations are COPIED IN, not referenced. A reference would be undone
 * by the very edits this exists to survive: exclude two rows in June and the
 * March recommendation would silently re-derive from a different sample, and
 * nobody could say whether the advice had been wrong or the evidence had moved.
 *
 * `recommendation` is whatever src/db/fee-recommendation.ts returned, stored
 * verbatim. It is a DRAFT and this record does not approve it — there is no
 * approval column here, and no path from this table to fee_rules.
 */
export async function takeSnapshot(
  db: DB, ctx: AuditContext,
  input: {
    title: string;
    query: Record<string, unknown>;
    observations: readonly BenchmarkObservation[];
    recommendation?: unknown;
    notes?: string | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'benchmark:write');
  if (!input.title?.trim()) throw new BenchmarkError('bad_title', 'A snapshot needs a title saying what was asked.');

  const code = await allocateFederationId(db, 'BMS');
  const [row] = await db.insert(s.feeBenchmarkSnapshots).values({
    code,
    title: input.title.trim(),
    takenByUserId: ctx.principal.userId ?? null,
    query: input.query ?? {},
    observations: input.observations as unknown as any,
    observationCount: input.observations.length,
    recommendation: (input.recommendation ?? null) as any,
    notes: input.notes ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'fee_benchmark_snapshot', entityId: row.id, action: 'create',
    newValue: { code, observationCount: row.observationCount, query: input.query },
  });
  return row;
}

/** Read a snapshot back, with its observations as observations again. */
export async function readSnapshot(db: DB, principal: Principal | null | undefined, code: string) {
  assertCanAnywhere(principal, 'benchmark:read');
  const [row] = await db.select().from(s.feeBenchmarkSnapshots)
    .where(eq(s.feeBenchmarkSnapshots.code, code)).limit(1);
  if (!row) throw new BenchmarkError('unknown_snapshot', `No snapshot ${code}.`);
  const observations = (row.observations as any[] ?? []).map(toObservation);
  return { ...row, observations };
}

/** Most recent snapshots first, for the evidence register. */
export async function recentSnapshots(db: DB, principal: Principal | null | undefined, limit = 20) {
  assertCanAnywhere(principal, 'benchmark:read');
  return db.select({
    id: s.feeBenchmarkSnapshots.id,
    code: s.feeBenchmarkSnapshots.code,
    title: s.feeBenchmarkSnapshots.title,
    takenAt: s.feeBenchmarkSnapshots.takenAt,
    observationCount: s.feeBenchmarkSnapshots.observationCount,
  }).from(s.feeBenchmarkSnapshots)
    .orderBy(desc(s.feeBenchmarkSnapshots.takenAt))
    .limit(limit);
}
