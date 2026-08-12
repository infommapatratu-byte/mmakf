// The ranking engine.
//
// ONE REQUIREMENT SHAPES EVERY LINE OF THIS FILE: **every ranking must be
// explainable.** An athlete must be able to see which events contributed, which
// placings, how many points each was worth, which ruleset applied, and why
// anything was left out. A ranking nobody can audit is a ranking nobody should
// trust, and rankings are the thing athletes dispute most.
//
// So `rankingEntries.contributions` does not hold a summary. It holds the whole
// working: every result the engine looked at for that athlete, the rule that
// priced it, and — for anything that did not count — the reason, named.
//
// THE SECOND RULE: **no points value appears in this file.** Not one. Points are
// federation policy, they live in `ranking_rulesets.rules` as approved JSON, and
// an event kind or placing the ruleset does not cover contributes ZERO and says
// "not covered by ruleset". It is never guessed at, never interpolated from a
// neighbouring placing, never defaulted. The same applies to the window, the
// best-N cut and the tie-break: an option the federation has not set is not
// applied, and the working records that it was not set.
//
// Consequently this module fails closed on configuration it does not
// understand. A ruleset carrying a rule this engine cannot implement (`decay`,
// say) is REFUSED rather than silently ignored — publishing a table computed
// under rules the federation approved but the engine skipped would be worse than
// publishing nothing.

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan, assertCanAnywhere } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class RankingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RankingError';
    this.code = code;
  }
}

// ─── The shape of the working ───────────────────────────────────────────────

/** Why a result did or did not feed an athlete's total. Always populated. */
export type ContributionReason =
  | 'counted'
  | 'not covered by ruleset'
  | 'result not final'
  | 'result voided'
  | 'result superseded'
  | 'event cancelled'
  | 'no event date on record'
  | 'after the as-at date'
  | 'outside window'
  | 'beyond best-N';

export interface RankingContribution {
  resultId: number;
  eventId: number;
  eventCode: string;
  eventTitle: string;
  eventKind: string;
  /** The event's lifecycle status at the moment of computation. */
  eventStatus: string;
  /** The date the ranking places this result on, and which column it came from. */
  eventDate: string | null;
  eventDateSource: 'starts_on' | 'ends_on' | 'finalised_at' | 'none';
  categoryId: number;
  categoryCode: string;
  categoryKey: string;
  placing: number;
  medal: string | null;
  resultStatus: string;
  /** Always an integer. Zero whenever the ruleset does not price this result. */
  points: number;
  /** The JSON path in the ruleset that produced `points`, or null if none did. */
  rule: string | null;
  /**
   * Did an approved rule actually price this result?
   *
   * Distinct from `counted` on purpose. A result the ruleset does not cover is
   * still ELIGIBLE — it is a real finalised result inside the window — but it
   * was priced by nothing, so it must not be reported as an event that fed the
   * table, nor feed a tie-break that is meant to separate athletes on the
   * results that produced their points.
   */
  priced: boolean;
  counted: boolean;
  reason: ContributionReason;
  /** Human-readable expansion of `reason` where a bare label is not enough. */
  detail: string;
}

/** How one ruleset option was resolved. `applied: false` means "not set". */
export interface OptionRecord {
  applied: boolean;
  value: unknown;
  source: 'ruleset column' | 'ruleset rules' | 'not set by the ruleset';
  detail: string;
}

export interface RankingWorking {
  rulesetId: number;
  rulesetCode: string;
  rulesetTitle: string;
  categoryKey: string;
  asOf: string;
  computedBy: string;
  /**
   * The approved points table exactly as this computation read it, keyed by the
   * rule path that names it.
   *
   * Snapshotted because `ranking_rulesets.rules` is a live row: it can be edited
   * or the ruleset retired after a table is published, and a published table
   * must stay defensible against a complainant without depending on a row that
   * may since have changed. With this, the whole arithmetic can be re-derived
   * from the entry alone.
   */
  pointsTable: Record<string, Record<string, number>>;
  options: {
    window: OptionRecord;
    bestN: OptionRecord;
    tieBreak: OptionRecord;
  };
  totalPoints: number;
  contributions: RankingContribution[];
  /** The values compared for each configured tie-break step, for this athlete. */
  tieBreakValues: Record<string, number>;
  tieBreakNote: string;
  /** Other athletes holding the identical rank number, because nothing separated them. */
  sharedRankWithPersonIds: number[];
}

// ─── Ruleset parsing ────────────────────────────────────────────────────────

// Keys `rules` may carry. Anything else is a rule this engine does not
// implement, and is refused rather than ignored (see the header).
const RECOGNISED_RULE_KEYS = new Set([
  'points', 'windowMonths', 'bestNResults', 'tieBreak',
  'title', 'description', 'notes',   // inert metadata
]);

const EVENT_KINDS = new Set<string>(s.eventKind.enumValues);
const DISCIPLINES = new Set<string>(s.disciplineKind.enumValues);

/**
 * Tie-break metrics this engine can derive from stored data.
 *
 * This is a VOCABULARY, not a policy: the federation chooses which of these to
 * use and in what order. There is deliberately no default direction — "more
 * golds wins" is a policy statement, so the ruleset must say `desc` itself.
 */
const TIE_BREAK_KEYS = new Set([
  'goldCount', 'silverCount', 'bronzeCount',
  'bestPlacing', 'countedResults', 'mostRecentEventDate',
]);

interface TieBreakStep { key: string; direction: 'asc' | 'desc' }

interface PointsSource {
  /** placing (as a string) → points. Validated whole, before anything is computed. */
  placings: Record<string, number>;
  /** JSON path, so a contribution can name the rule that priced it. */
  path: string;
}

/**
 * Read and validate one event kind's placing → points map, in full.
 *
 * BOTH the keys and the values are checked HERE, when the ruleset is loaded,
 * rather than at the moment some athlete's result happens to look one up.
 *
 * Keys matter as much as values. A ruleset approved as `{"first": 1000}` used to
 * be accepted silently: nothing ever matched the key, so a national champion was
 * told "the ruleset prices national_championship but sets no points for placing
 * 1" — a table computed as if a rule the federation approved did not exist,
 * which is exactly what this engine promises never to do. A placing must be a
 * plain whole number; anything else is refused by name.
 *
 * Validating values eagerly matters for the same reason: a 2.5 sitting at a
 * placing nobody reached this season must not lie in wait to reject next
 * season's table. Whether a ruleset is computable cannot depend on who
 * competed.
 */
function readPlacings(path: string, raw: unknown): Record<string, number> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RankingError('bad_points_table', `${path} must be an object of placing → points.`);
  }
  const out: Record<string, number> = {};
  for (const [placing, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(placing)) {
      throw new RankingError(
        'bad_points_table',
        `${path} is keyed by "${placing}". A placing must be written as a plain whole number ("1", "2", "3"); this engine will not guess which finishing position "${placing}" means, and will not compute a table that ignores a rule the federation approved.`
      );
    }
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      // Points are integers everywhere in this codebase. Rounding a 2.5 the
      // federation wrote would change the table without telling anyone.
      throw new RankingError(
        'non_integer_points',
        `${path}.${placing} is ${JSON.stringify(value)}. Ranking points must be non-negative whole numbers.`
      );
    }
    out[placing] = n;
  }
  return out;
}

/**
 * Build the points lookup from the ruleset.
 *
 * Two layouts are accepted because the schema documents one and the nested form
 * is the clearer one to configure: `rules.points[eventKind][placing]`, and the
 * flat `rules[eventKind][placing]` written in the schema comment. Both name the
 * path they came from so the working can cite it.
 */
function readPoints(rules: Record<string, any>): Record<string, PointsSource> {
  const table: Record<string, PointsSource> = {};

  const nested = rules.points;
  if (nested != null) {
    if (typeof nested !== 'object' || Array.isArray(nested)) {
      throw new RankingError('bad_points_table', 'ruleset rules.points must be an object of event kind → placing → points.');
    }
    for (const [kind, placings] of Object.entries(nested)) {
      if (!EVENT_KINDS.has(kind)) {
        throw new RankingError('unknown_event_kind', `rules.points names "${kind}", which is not a competition event kind.`);
      }
      const path = `rules.points.${kind}`;
      table[kind] = { placings: readPlacings(path, placings), path };
    }
  }

  for (const [kind, placings] of Object.entries(rules)) {
    if (!EVENT_KINDS.has(kind)) continue;
    if (table[kind]) {
      throw new RankingError(
        'ruleset_conflict',
        `The ruleset prices "${kind}" both at rules.${kind} and at rules.points.${kind}. Remove one; the engine will not choose between them.`
      );
    }
    const path = `rules.${kind}`;
    table[kind] = { placings: readPlacings(path, placings), path };
  }

  return table;
}

/**
 * Resolve one option that may be set on a dedicated column or inside `rules`.
 *
 * If both carry it and they disagree, the ruleset is ambiguous and the
 * computation stops. Picking a winner would mean the published table was
 * computed under a rule the federation may not have intended.
 */
function resolveOption(
  name: string,
  column: unknown,
  fromRules: unknown
): { value: any; source: OptionRecord['source'] } {
  const hasColumn = column != null;
  const hasRules = fromRules != null;

  if (hasColumn && hasRules && JSON.stringify(column) !== JSON.stringify(fromRules)) {
    throw new RankingError(
      'ruleset_conflict',
      `The ruleset sets ${name} on its column and again in rules, and the two disagree. Set it in one place.`
    );
  }
  if (hasColumn) return { value: column, source: 'ruleset column' };
  if (hasRules) return { value: fromRules, source: 'ruleset rules' };
  return { value: null, source: 'not set by the ruleset' };
}

function readPositiveInt(name: string, raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new RankingError('bad_option', `${name} must be a positive whole number; the ruleset has ${JSON.stringify(raw)}.`);
  }
  return n;
}

function readTieBreak(raw: unknown): TieBreakStep[] {
  if (!Array.isArray(raw)) {
    throw new RankingError('bad_tie_break', 'tieBreak must be an ordered array of { key, direction } steps.');
  }
  return raw.map((step, i) => {
    if (typeof step === 'string') {
      // Deliberate: a bare key would need this engine to assume a direction,
      // and "more golds wins" is the federation's call, not the engine's.
      throw new RankingError(
        'tie_break_direction_required',
        `tieBreak[${i}] is the bare key "${step}". Each step must state its direction: { "key": "${step}", "direction": "asc" | "desc" }.`
      );
    }
    if (!step || typeof step !== 'object') {
      throw new RankingError('bad_tie_break', `tieBreak[${i}] must be an object of { key, direction }.`);
    }
    const { key, direction } = step as Record<string, unknown>;
    if (typeof key !== 'string' || !TIE_BREAK_KEYS.has(key)) {
      throw new RankingError(
        'unsupported_tie_break',
        `tieBreak[${i}] names "${String(key)}", which this engine cannot derive. Supported: ${[...TIE_BREAK_KEYS].join(', ')}.`
      );
    }
    if (direction !== 'asc' && direction !== 'desc') {
      throw new RankingError(
        'tie_break_direction_required',
        `tieBreak[${i}] ("${key}") must state "direction": "asc" or "desc".`
      );
    }
    return { key, direction };
  });
}

// ─── Dates ──────────────────────────────────────────────────────────────────

function toDateString(d: Date | string): string {
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) throw new RankingError('bad_date', 'Invalid date.');
    return d.toISOString().slice(0, 10);
  }
  const t = String(d).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new RankingError('bad_date', `Expected a YYYY-MM-DD date, got ${JSON.stringify(d)}.`);
  return t;
}

/**
 * Roll a date back N months, clamping to the end of the target month.
 *
 * JS turns 31 March minus one month into 3 March. A rolling window that quietly
 * jumped three days would change who is ranked, so the day is clamped instead.
 */
function minusMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ─── Category keys ──────────────────────────────────────────────────────────

/**
 * The ranking key for an event category: `discipline|gender|ageGroup|weight`.
 *
 * Categories are per-event rows, so "the same category" across two championships
 * can only be recognised by deriving a stable key from the bounds the
 * regulations set. Weight is expressed in GRAMS, matching the column, because a
 * "-61kg" label is presentation and grams are the record. An unset component is
 * `*` — it is not filled in with an assumption.
 */
export function categoryKeyFor(category: {
  discipline: string;
  gender?: string | null;
  ageGroup?: string | null;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
}): string {
  const norm = (v: string | null | undefined) => (v == null || v === '' ? '*' : String(v).trim().toLowerCase());
  const weight = category.maxWeightGrams != null
    ? `max${category.maxWeightGrams}`
    : category.minWeightGrams != null
      ? `min${category.minWeightGrams}`
      : 'open';
  return [norm(category.discipline), norm(category.gender), norm(category.ageGroup), weight].join('|');
}

/**
 * Refuse a category key that is not already in canonical form.
 *
 * The key is the ONLY thing that recognises "the same category" across two
 * championships and across two ranking periods. A caller who asks for
 * `kumite|Male|cadet|max61000` would otherwise get a period stored under that
 * spelling, matching no category row (so an empty table), and — worse — a second
 * ranking table for a category that already has one, breaking the previousRank
 * chain silently. The unvalidated weight component had the same failure mode:
 * `kumite|male|cadet|61kg` computed an empty table rather than saying the token
 * was meaningless.
 *
 * The key is REFUSED rather than quietly rewritten: rewriting would publish a
 * table under a key the caller did not ask for.
 */
function assertCanonicalCategoryKey(key: string): { discipline: string } {
  const parts = key.split('|');
  if (parts.length !== 4) {
    throw new RankingError('bad_category_key', 'A category key is discipline|gender|ageGroup|weight, e.g. kumite|male|cadet|max61000.');
  }
  const [discipline, gender, ageGroup, weight] = parts;
  if (!DISCIPLINES.has(discipline)) {
    throw new RankingError('bad_category_key', `"${discipline}" is not a competition discipline.`);
  }
  if (!/^(open|max\d+|min\d+)$/.test(weight)) {
    throw new RankingError(
      'bad_category_key',
      `"${weight}" is not a weight component. Use "open", or "max<grams>" / "min<grams>" — grams, because grams are what the category record stores and "-61kg" is only a label.`
    );
  }
  const canonical = [discipline, gender, ageGroup]
    .map((v) => (v.trim() === '' ? '*' : v.trim().toLowerCase()))
    .concat(weight)
    .join('|');
  if (canonical !== key) {
    throw new RankingError(
      'bad_category_key',
      `"${key}" is not in canonical form. Two spellings of one category become two ranking tables, so the key must be given exactly as "${canonical}".`
    );
  }
  return { discipline };
}

// ─── Compute ────────────────────────────────────────────────────────────────

export interface ComputeRankingInput {
  rulesetId: number;
  categoryKey: string;
  asOf: Date | string;
  /** Identifies the table. Defaults to the as-at date, so a recompute lands on the same period. */
  label?: string;
}

export interface ComputeRankingResult {
  periodId: number;
  label: string;
  categoryKey: string;
  asOf: string;
  athleteCount: number;
  eventCount: number;
  /**
   * Results the engine could not attribute to a person (team entries with no
   * personId). They are NOT split across team members: how a team medal is
   * shared is federation policy and no ruleset option declares it.
   */
  unattributedResults: number;
  entries: Array<{
    personId: number;
    rank: number;
    points: number;
    previousRank: number | null;
    working: RankingWorking;
  }>;
}

/**
 * Compute a ranking table from FINALISED results only.
 *
 * Provisional results never move a ranking — that is the whole reason results
 * have a status. They still appear in the working, marked "result not final", so
 * an athlete asking "why isn't last weekend in there yet?" gets an answer.
 */
export async function computeRanking(
  db: DB,
  ctx: AuditContext,
  input: ComputeRankingInput,
  now: Date = new Date()
): Promise<ComputeRankingResult> {
  // A ranking spans the whole federation, so there is no state or dojo to scope
  // it against. Passing an empty resource means only a NATIONAL binding
  // satisfies can() — a state administrator cannot compute a national table.
  assertCan(ctx.principal, 'competition:write', {});

  const asOf = toDateString(input.asOf);
  const label = (input.label ?? asOf).trim();
  if (!label) throw new RankingError('bad_label', 'A ranking period needs a label.');

  // ── The ruleset, and the rules it actually declares ──
  const ruleset = (await db.select().from(s.rankingRulesets)
    .where(eq(s.rankingRulesets.id, input.rulesetId)).limit(1))[0];
  if (!ruleset) throw new RankingError('unknown_ruleset', 'Unknown ranking ruleset');

  if (ruleset.status !== 'active' && ruleset.status !== 'approved') {
    throw new RankingError(
      'ruleset_not_in_force',
      `Ruleset ${ruleset.code} is ${ruleset.status}. A ranking may only be computed under a ruleset the federation has approved.`
    );
  }
  if (ruleset.effectiveFrom && asOf < ruleset.effectiveFrom) {
    throw new RankingError('ruleset_not_in_force', `Ruleset ${ruleset.code} takes effect on ${ruleset.effectiveFrom}; the as-at date is ${asOf}.`);
  }
  if (ruleset.effectiveTo && asOf > ruleset.effectiveTo) {
    throw new RankingError('ruleset_not_in_force', `Ruleset ${ruleset.code} ceased to apply on ${ruleset.effectiveTo}; the as-at date is ${asOf}.`);
  }

  const rules = (ruleset.rules ?? {}) as Record<string, any>;
  if (typeof rules !== 'object' || Array.isArray(rules)) {
    throw new RankingError('bad_ruleset', 'ruleset.rules must be a JSON object.');
  }
  for (const key of Object.keys(rules)) {
    if (RECOGNISED_RULE_KEYS.has(key) || EVENT_KINDS.has(key)) continue;
    // Fail closed. Silently ignoring a rule the federation approved would
    // publish a table that is not the table the rules describe.
    throw new RankingError(
      'unsupported_rule',
      `Ruleset ${ruleset.code} declares "${key}", which this engine does not implement. It will not compute a ranking that ignores an approved rule.`
    );
  }
  const points = readPoints(rules);
  // Snapshot, keyed by rule path so a contribution's `rule` resolves inside the
  // entry itself. See RankingWorking.pointsTable: the ruleset row may be edited
  // after publication, and a published table has to stay defensible without it.
  const pointsTable: Record<string, Record<string, number>> = {};
  for (const src of Object.values(points)) pointsTable[src.path] = src.placings;

  // ── Options ──
  const windowOpt = resolveOption('windowMonths', ruleset.windowMonths, rules.windowMonths);
  const windowMonths = windowOpt.value == null ? null : readPositiveInt('windowMonths', windowOpt.value);
  const windowStart = windowMonths == null ? null : minusMonths(asOf, windowMonths);

  const bestNOpt = resolveOption('bestNResults', ruleset.bestNResults, rules.bestNResults);
  const bestN = bestNOpt.value == null ? null : readPositiveInt('bestNResults', bestNOpt.value);

  const tieBreakOpt = resolveOption('tieBreak', ruleset.tieBreak, rules.tieBreak);
  const tieBreak = tieBreakOpt.value == null ? [] : readTieBreak(tieBreakOpt.value);

  const optionRecords: RankingWorking['options'] = {
    window: {
      applied: windowMonths != null,
      value: windowMonths,
      source: windowOpt.source,
      detail: windowMonths == null
        ? 'No rolling window is set by the ruleset, so no result was excluded for age.'
        : `Rolling window of ${windowMonths} months: results dated ${windowStart} to ${asOf} inclusive.`,
    },
    bestN: {
      applied: bestN != null,
      value: bestN,
      source: bestNOpt.source,
      detail: bestN == null
        ? 'No best-N limit is set by the ruleset, so every eligible result counted.'
        : `Only the best ${bestN} eligible results counted towards each athlete's total.`,
    },
    tieBreak: {
      applied: tieBreak.length > 0,
      value: tieBreak.length ? tieBreak : null,
      source: tieBreakOpt.source,
      // Which results a tie-break metric is measured over is as load-bearing as
      // the metric itself, and a complainant is entitled to be told. It is the
      // same set that produced the points being tied on: results the ruleset
      // priced, that survived any best-N limit. Counting a medal from an event
      // the ruleset does not price would let a result worth nothing decide a
      // rank, and the working never said that was happening.
      detail: tieBreak.length === 0
        ? 'No tie-break is set by the ruleset. Athletes on equal points SHARE a rank number rather than being separated by a rule the federation has not approved.'
        : `Ties broken by: ${tieBreak.map((t) => `${t.key} ${t.direction}`).join(', ')}. Each figure is counted over exactly the results that produced this athlete's total — those the ruleset priced, that survived any best-N limit — and nothing else.`,
    },
  };

  // ── Which categories this key covers ──
  const { discipline } = assertCanonicalCategoryKey(input.categoryKey);
  if (ruleset.discipline && ruleset.discipline !== discipline) {
    throw new RankingError(
      'discipline_mismatch',
      `Ruleset ${ruleset.code} applies to ${ruleset.discipline}; the requested category is ${discipline}.`
    );
  }

  // Every result in the discipline is loaded, INCLUDING the ones that will be
  // excluded — the working has to be able to say why each was left out, which is
  // impossible if the query already filtered them away.
  const rows = await db
    .select({
      resultId: s.competitionResults.id,
      personId: s.competitionResults.personId,
      placing: s.competitionResults.placing,
      medal: s.competitionResults.medal,
      resultStatus: s.competitionResults.status,
      finalisedAt: s.competitionResults.finalisedAt,
      supersedesResultId: s.competitionResults.supersedesResultId,
      eventId: s.competitionEvents.id,
      eventCode: s.competitionEvents.code,
      eventTitle: s.competitionEvents.title,
      eventKind: s.competitionEvents.kind,
      eventStatus: s.competitionEvents.status,
      startsOn: s.competitionEvents.startsOn,
      endsOn: s.competitionEvents.endsOn,
      categoryId: s.eventCategories.id,
      categoryCode: s.eventCategories.code,
      discipline: s.eventCategories.discipline,
      gender: s.eventCategories.gender,
      ageGroup: s.eventCategories.ageGroup,
      minWeightGrams: s.eventCategories.minWeightGrams,
      maxWeightGrams: s.eventCategories.maxWeightGrams,
    })
    .from(s.competitionResults)
    .innerJoin(s.eventCategories, eq(s.competitionResults.categoryId, s.eventCategories.id))
    .innerJoin(s.competitionEvents, eq(s.competitionResults.eventId, s.competitionEvents.id))
    .where(eq(s.eventCategories.discipline, discipline as any));

  // A corrected result supersedes another; the superseded row must not also
  // score, or a correction would double-count.
  const superseded = new Set<number>(
    rows.map((r: any) => r.supersedesResultId).filter((id: number | null): id is number => id != null)
  );

  const byPerson = new Map<number, RankingContribution[]>();
  let unattributedResults = 0;

  for (const r of rows) {
    if (categoryKeyFor(r) !== input.categoryKey) continue;

    if (r.personId == null) {
      // Team results carry no person. Splitting a team medal across its members
      // is a policy no ruleset option declares, so the engine refuses to invent
      // a share and reports the count instead.
      unattributedResults++;
      continue;
    }

    const eventDateSource: RankingContribution['eventDateSource'] =
      r.startsOn ? 'starts_on' : r.endsOn ? 'ends_on' : r.finalisedAt ? 'finalised_at' : 'none';
    const eventDate = r.startsOn
      ? toDateString(r.startsOn)
      : r.endsOn
        ? toDateString(r.endsOn)
        : r.finalisedAt
          ? toDateString(r.finalisedAt)
          : null;

    const base = {
      resultId: r.resultId,
      eventId: r.eventId,
      eventCode: r.eventCode,
      eventTitle: r.eventTitle,
      eventKind: r.eventKind,
      eventStatus: r.eventStatus,
      eventDate,
      eventDateSource,
      categoryId: r.categoryId,
      categoryCode: r.categoryCode,
      categoryKey: input.categoryKey,
      placing: r.placing,
      medal: r.medal ?? null,
      resultStatus: r.resultStatus,
    };

    const exclude = (reason: ContributionReason, detail: string): RankingContribution =>
      ({ ...base, points: 0, rule: null, priced: false, counted: false, reason, detail });

    let contribution: RankingContribution | null = null;

    if (r.eventStatus === 'cancelled') {
      // Fail closed: a cancelled event is a competition that did not happen. Its
      // results may still carry `final` from before the cancellation, and a
      // ranking must not be fed by a championship the federation called off.
      // Only `cancelled` is excluded here — it is the one status that says the
      // event did not take place. Which OTHER lifecycle states may feed a
      // ranking is federation policy and no ruleset option declares it, so
      // nothing else is filtered on this column.
      contribution = exclude('event cancelled', `Event ${r.eventCode} was cancelled; a cancelled competition awards no ranking points.`);
    } else if (r.resultStatus === 'voided') {
      contribution = exclude('result voided', 'This result has been voided and carries no ranking points.');
    } else if (superseded.has(r.resultId)) {
      contribution = exclude('result superseded', 'A corrected result supersedes this one; the correction is scored instead.');
    } else if (r.resultStatus !== 'final' && r.resultStatus !== 'corrected') {
      contribution = exclude('result not final', `This result is ${r.resultStatus}. Only finalised results move a ranking.`);
    } else if (eventDate == null) {
      contribution = exclude('no event date on record', 'The event carries no date, so the result cannot be placed in the ranking period.');
    } else if (eventDate > asOf) {
      contribution = exclude('after the as-at date', `The event is dated ${eventDate}, after the as-at date of ${asOf}.`);
    } else if (windowStart != null && eventDate < windowStart) {
      contribution = exclude('outside window', `The event is dated ${eventDate}, before the ${windowMonths}-month window opening on ${windowStart}.`);
    }

    if (!contribution) {
      // Priced from the ruleset, or not priced at all. Never inferred.
      const source = points[r.eventKind];
      // `readPlacings` has already proved every value here is a non-negative
      // integer, so an absent key means the ruleset genuinely does not price
      // this placing — never that it priced it in a form we could not read.
      const value = source ? source.placings[String(r.placing)] : undefined;
      if (value === undefined) {
        contribution = {
          ...base, points: 0, rule: null, priced: false, counted: true,
          reason: 'not covered by ruleset',
          detail: source
            ? `The ruleset prices "${r.eventKind}" but sets no points for placing ${r.placing}.`
            : `The ruleset sets no points for the event kind "${r.eventKind}".`,
        };
      } else {
        contribution = {
          ...base, points: value, rule: `${source!.path}.${r.placing}`, priced: true, counted: true,
          reason: 'counted',
          detail: `${value} points for placing ${r.placing} at a ${r.eventKind.replace(/_/g, ' ')}.`,
        };
      }
    }

    const list = byPerson.get(r.personId) ?? [];
    list.push(contribution);
    byPerson.set(r.personId, list);
  }

  // ── Best-N, per athlete ──
  for (const list of byPerson.values()) {
    const eligible = list.filter((c) => c.counted);
    // Deterministic: points, then most recent, then result id — which is unique,
    // so the order can never depend on how the rows came back from the database.
    eligible.sort((a, b) =>
      b.points - a.points ||
      (b.eventDate ?? '').localeCompare(a.eventDate ?? '') ||
      a.resultId - b.resultId
    );
    if (bestN != null && eligible.length > bestN) {
      for (const c of eligible.slice(bestN)) {
        c.counted = false;
        c.reason = 'beyond best-N';
        // `points` is NOT zeroed: the rule really did price this result, and an
        // athlete is entitled to see what it was worth and that best-N is the
        // only reason it did not count. Only `counted` rows enter the total.
        c.detail = `Worth ${c.points} points, but only the best ${bestN} results count and this ranked ${eligible.indexOf(c) + 1} of ${eligible.length} by points.`;
      }
    }
    // Presentation order for the working: most recent first, stable on id.
    list.sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? '') || a.resultId - b.resultId);
  }

  // ── Totals, tie-break values and ordering ──
  const persons = byPerson.size
    ? await db.select({
        id: s.persons.id,
        federationId: s.persons.federationId,
        stateUnitId: s.persons.stateUnitId,
        dojoId: s.persons.dojoId,
      }).from(s.persons).where(inArray(s.persons.id, [...byPerson.keys()]))
    : [];
  const personById = new Map<number, any>(persons.map((p: any) => [p.id, p]));

  interface Row {
    personId: number;
    federationId: string;
    stateUnitId: number | null;
    dojoId: number | null;
    points: number;
    contributions: RankingContribution[];
    tieBreakValues: Record<string, number>;
    rank: number;
  }

  const table: Row[] = [];
  for (const [personId, contributions] of byPerson) {
    const person = personById.get(personId);
    if (!person) continue;   // FK makes this unreachable; fail closed rather than rank a ghost.
    const counted = contributions.filter((c) => c.counted);
    // Measured over the results that actually produced the total — see the
    // tieBreak option detail, which states this to the athlete in words.
    const scoring = counted.filter((c) => c.priced);
    const tieBreakValues: Record<string, number> = {};
    for (const step of tieBreak) tieBreakValues[step.key] = tieBreakMetric(step.key, scoring);
    table.push({
      personId,
      federationId: person.federationId,
      stateUnitId: person.stateUnitId ?? null,
      dojoId: person.dojoId ?? null,
      points: counted.reduce((n, c) => n + c.points, 0),
      contributions,
      tieBreakValues,
      rank: 0,
    });
  }

  /** Points, then each configured tie-break step in order. 0 == genuinely level. */
  const compareSporting = (a: Row, b: Row): number => {
    if (a.points !== b.points) return b.points - a.points;
    for (const step of tieBreak) {
      const av = a.tieBreakValues[step.key];
      const bv = b.tieBreakValues[step.key];
      if (av !== bv) return step.direction === 'desc' ? bv - av : av - bv;
    }
    return 0;
  };

  // The federation ID is a stabiliser for DISPLAY only. Athletes it separates
  // still share a rank number — see the rank assignment below.
  table.sort((a, b) => compareSporting(a, b) || a.federationId.localeCompare(b.federationId));

  for (let i = 0; i < table.length; i++) {
    table[i].rank = i > 0 && compareSporting(table[i - 1], table[i]) === 0
      ? table[i - 1].rank
      : i + 1;
  }
  const sharing = new Map<number, number[]>();
  for (const row of table) {
    sharing.set(row.rank, [...(sharing.get(row.rank) ?? []), row.personId]);
  }

  // ── Previous ranks, from the last PUBLISHED table for this key ──
  const previousPeriod = (await db.select().from(s.rankingPeriods)
    .where(and(
      eq(s.rankingPeriods.rulesetId, input.rulesetId),
      eq(s.rankingPeriods.categoryKey, input.categoryKey),
      isNotNull(s.rankingPeriods.publishedAt)
    ))
    // `id` breaks a same-timestamp tie, so which table previousRank came from is
    // never decided by row order.
    .orderBy(desc(s.rankingPeriods.publishedAt), desc(s.rankingPeriods.id)).limit(1))[0];

  const previousRanks = new Map<number, number>();
  if (previousPeriod) {
    const prev = await db.select({ personId: s.rankingEntries.personId, rank: s.rankingEntries.rank })
      .from(s.rankingEntries).where(eq(s.rankingEntries.periodId, previousPeriod.id));
    for (const p of prev) previousRanks.set(p.personId, p.rank);
  }

  // ── Persist ──
  // "How many events fed this ranking" — so an event whose kind or placing the
  // ruleset does not price is NOT counted here, even though it appears in every
  // affected athlete's working. It contributed nothing.
  const countedEvents = new Set<number>();
  for (const row of table) {
    for (const c of row.contributions) if (c.counted && c.priced) countedEvents.add(c.eventId);
  }

  let period = (await db.select().from(s.rankingPeriods).where(and(
    eq(s.rankingPeriods.rulesetId, input.rulesetId),
    eq(s.rankingPeriods.label, label),
    eq(s.rankingPeriods.categoryKey, input.categoryKey)
  )).limit(1))[0];

  if (period?.publishedAt) {
    // Requirement: recomputing must not silently replace a published table. A
    // published ranking is a statement the federation has made; superseding it
    // is a deliberate act under a new label, not a side effect of re-running.
    throw new RankingError(
      'already_published',
      `The ranking "${label}" for ${input.categoryKey} was published on ${toDateString(period.publishedAt)}. Recompute under a new label; a published table is not replaced in place.`
    );
  }

  const periodValues = {
    rulesetId: input.rulesetId,
    label,
    categoryKey: input.categoryKey,
    computedAt: now,
    eventCount: countedEvents.size,
    athleteCount: table.length,
  };

  const isRecompute = Boolean(period);
  if (period) {
    // The publishedAt guard is repeated IN THE WRITE, not only in the check
    // above. Between reading the period and rewriting it, another operator can
    // publish this exact table — and the next two statements delete every entry
    // in it. `already_published` must be enforced by the database, not by a
    // decision taken a few milliseconds earlier.
    const [claimed] = await db.update(s.rankingPeriods).set(periodValues)
      .where(and(eq(s.rankingPeriods.id, period.id), isNull(s.rankingPeriods.publishedAt)))
      .returning();
    if (!claimed) {
      throw new RankingError(
        'already_published',
        `The ranking "${label}" for ${input.categoryKey} was published while this computation was running. Recompute under a new label; a published table is not replaced in place.`
      );
    }
    await db.delete(s.rankingEntries).where(eq(s.rankingEntries.periodId, period.id));
  } else {
    try {
      [period] = await db.insert(s.rankingPeriods).values(periodValues).returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new RankingError('period_conflict', 'That ranking period was created concurrently. Re-run the computation.');
    }
  }

  const entries: ComputeRankingResult['entries'] = table.map((row) => {
    const working: RankingWorking = {
      rulesetId: ruleset.id,
      rulesetCode: ruleset.code,
      rulesetTitle: ruleset.title,
      categoryKey: input.categoryKey,
      asOf,
      computedBy: ctx.principal.label,
      pointsTable,
      options: optionRecords,
      totalPoints: row.points,
      contributions: row.contributions,
      tieBreakValues: row.tieBreakValues,
      tieBreakNote: optionRecords.tieBreak.detail,
      sharedRankWithPersonIds: (sharing.get(row.rank) ?? []).filter((id) => id !== row.personId),
    };
    return {
      personId: row.personId,
      rank: row.rank,
      points: row.points,
      previousRank: previousRanks.get(row.personId) ?? null,
      working,
    };
  });

  if (entries.length) {
    // `table` and `entries` are the same rows in the same order — entries is
    // table.map() — so the state/dojo stamp travels with the right athlete.
    await db.insert(s.rankingEntries).values(table.map((row, i) => ({
      periodId: period.id,
      personId: row.personId,
      rank: row.rank,
      points: row.points,
      previousRank: entries[i].previousRank,
      contributions: entries[i].working,
      stateUnitId: row.stateUnitId,
      dojoId: row.dojoId,
    })));
  }

  await writeAudit(db, ctx, {
    entityType: 'ranking_period',
    entityId: period.id,
    action: isRecompute ? 'update' : 'create',
    oldValue: isRecompute ? { athleteCount: period.athleteCount, eventCount: period.eventCount } : undefined,
    newValue: {
      ruleset: ruleset.code, label, categoryKey: input.categoryKey, asOf,
      athleteCount: table.length, eventCount: countedEvents.size, unattributedResults,
    },
  });

  return {
    periodId: period.id,
    label,
    categoryKey: input.categoryKey,
    asOf,
    athleteCount: table.length,
    eventCount: countedEvents.size,
    unattributedResults,
    entries,
  };
}

/**
 * Every tie-break metric is derived from the contributions that produced the
 * athlete's total — priced by the ruleset and inside best-N — and nothing else.
 */
function tieBreakMetric(key: string, counted: RankingContribution[]): number {
  switch (key) {
    case 'goldCount': return counted.filter((c) => c.medal === 'gold').length;
    case 'silverCount': return counted.filter((c) => c.medal === 'silver').length;
    case 'bronzeCount': return counted.filter((c) => c.medal === 'bronze').length;
    case 'countedResults': return counted.length;
    case 'bestPlacing': {
      // No results → the worst possible value, so an athlete with nothing to
      // compare never wins a tie-break by accident.
      const placings = counted.map((c) => c.placing);
      return placings.length ? Math.min(...placings) : Number.MAX_SAFE_INTEGER;
    }
    case 'mostRecentEventDate': {
      const dates = counted.map((c) => (c.eventDate ?? '').replace(/-/g, '')).filter(Boolean).map(Number);
      return dates.length ? Math.max(...dates) : 0;
    }
    default:
      // Unreachable: readTieBreak() refuses unknown keys before this runs.
      throw new RankingError('unsupported_tie_break', `No metric for tie-break key "${key}".`);
  }
}

// ─── Publish ────────────────────────────────────────────────────────────────

/**
 * Publish a computed ranking as the federation's official table.
 *
 * Deliberately separate from computation and separately authorised: computing is
 * arithmetic, publishing is a statement. Once published the table is fixed —
 * `computeRanking` refuses to overwrite it.
 */
export async function publishRanking(
  db: DB,
  ctx: AuditContext,
  periodId: number,
  now: Date = new Date()
) {
  assertCan(ctx.principal, 'result:finalize', {});

  const period = (await db.select().from(s.rankingPeriods)
    .where(eq(s.rankingPeriods.id, periodId)).limit(1))[0];
  if (!period) throw new RankingError('unknown_period', 'Unknown ranking period');
  if (period.publishedAt) {
    throw new RankingError('already_published', `This ranking was published on ${toDateString(period.publishedAt)}.`);
  }

  const [count] = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.rankingEntries).where(eq(s.rankingEntries.periodId, periodId));
  if (Number(count?.n ?? 0) === 0) {
    throw new RankingError('empty_ranking', 'This ranking has no entries. An empty table tells the public nothing and will not be published.');
  }

  // Guarded in the write as well as in the check above: publication is stamped
  // ONCE. An unguarded UPDATE lets a second publisher overwrite publishedAt and
  // publishedByUserId, rewriting the record of who put the table out and when —
  // an official act quietly reattributed.
  const [row] = await db.update(s.rankingPeriods).set({
    publishedAt: now,
    publishedByUserId: ctx.principal.userId ?? null,
  }).where(and(eq(s.rankingPeriods.id, periodId), isNull(s.rankingPeriods.publishedAt))).returning();
  if (!row) {
    throw new RankingError('already_published', 'This ranking was published while this request was in flight; the first publication stands.');
  }

  await writeAudit(db, ctx, {
    entityType: 'ranking_period',
    entityId: periodId,
    action: 'finalize',
    oldValue: { publishedAt: null },
    newValue: { publishedAt: now.toISOString(), label: period.label, categoryKey: period.categoryKey, athletes: Number(count?.n ?? 0) },
  });

  return row;
}

// ─── Explain ────────────────────────────────────────────────────────────────

export interface RankingExplanation {
  periodId: number;
  label: string;
  categoryKey: string;
  published: boolean;
  publishedAt: string | null;
  computedAt: string;
  ruleset: { id: number; code: string; title: string };
  personId: number;
  rank: number;
  points: number;
  previousRank: number | null;
  working: RankingWorking;
}

/**
 * The full working behind one athlete's position.
 *
 * This is the answer to "why am I ranked there?", and it is reconstructed from
 * what was stored at computation — not recomputed. Recomputing to explain would
 * show today's rules against a table published under yesterday's.
 */
export async function explainRanking(
  db: DB,
  ctx: AuditContext,
  input: { personId: number; periodId: number }
): Promise<RankingExplanation> {
  const period = (await db.select().from(s.rankingPeriods)
    .where(eq(s.rankingPeriods.id, input.periodId)).limit(1))[0];
  if (!period) throw new RankingError('unknown_period', 'Unknown ranking period');

  // A published table is public business — any holder of result:read may see the
  // working, including the athlete. An unpublished one is a working document and
  // needs the authority that produced it.
  if (period.publishedAt) assertCanAnywhere(ctx.principal, 'result:read');
  else assertCan(ctx.principal, 'competition:write', {});

  const entry = (await db.select().from(s.rankingEntries).where(and(
    eq(s.rankingEntries.periodId, input.periodId),
    eq(s.rankingEntries.personId, input.personId)
  )).limit(1))[0];
  if (!entry) {
    throw new RankingError('not_ranked', 'This athlete has no entry in that ranking period.');
  }

  const ruleset = (await db.select().from(s.rankingRulesets)
    .where(eq(s.rankingRulesets.id, period.rulesetId)).limit(1))[0];

  return {
    periodId: period.id,
    label: period.label,
    categoryKey: period.categoryKey,
    published: Boolean(period.publishedAt),
    publishedAt: period.publishedAt ? new Date(period.publishedAt).toISOString() : null,
    computedAt: new Date(period.computedAt).toISOString(),
    ruleset: { id: ruleset?.id ?? period.rulesetId, code: ruleset?.code ?? '', title: ruleset?.title ?? '' },
    personId: entry.personId,
    rank: entry.rank,
    points: entry.points,
    previousRank: entry.previousRank ?? null,
    working: entry.contributions as RankingWorking,
  };
}
