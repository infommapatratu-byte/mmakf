// The draw engine.
//
// A DRAW MUST BE REPRODUCIBLE. Given the same entries and the same recorded
// seed, regenerating must produce a byte-identical bracket. That is not a
// nicety: when a coach alleges the draw was rigged, the federation's only
// defence is to re-run it in front of them from the stored record and get the
// same bracket back. A draw nobody can reproduce is a draw nobody can defend.
//
// Three things make that true here:
//
//  1. `randomSeed` — a recorded string. Every random decision comes from it.
//  2. `seedInput` — the exact ordered entry list the bracket was built from, so
//     the draw can be recomputed from the record ALONE, without re-querying
//     entries that may since have been withdrawn or corrected.
//  3. `algorithmVersion` — placement logic changes over the years; a 2026 draw
//     must stay reproducible under the 2026 algorithm. A stored version that is
//     not the current one means "cannot be reproduced by this build", and
//     `verifyDrawReproducible()` says so rather than pretending.
//  4. A DIGEST of `seedInput` in the audit spine. The record a draw is
//     recomputed from is itself a record, and a forger who rewrote it would
//     otherwise make a rigged bracket verify perfectly.
//
// AND THE TRAP THAT MAKES ALL OF IT WORTHLESS IF MISSED: a competition writes
// to the same rows the draw did. Winners are recorded, and each one fills the
// slot the draw wired it to. Reporting those as departures would make every
// event that has actually been run report "not reproducible" — at exactly the
// moment somebody asks. Results and draw are therefore separated in the answer:
// `differences` is what changed about the DRAW, `resultsSince` is what the
// competition did.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not decide how many pools
// a category runs, how many athletes qualify from each, or what a standings
// tie-break is worth. Those are competition regulations — MMAKF's to set, not
// this file's to invent. An unsupplied rule is refused with a message naming
// what is missing, never approximated.

import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan, type Principal } from '@/lib/rbac';

type DB = any;

export class DrawError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DrawError';
    this.code = code;
  }
}

/**
 * Bump ONLY when placement changes. Draws record the version they were made
 * under; an old draw stays reproducible under its own version, and this build
 * must refuse to claim it reproduced one it cannot.
 */
export const ALGORITHM_VERSION = 'mmakf-draw-1';

type AnyFormat = (typeof s.drawFormat.enumValues)[number];

export type DrawableFormat = 'single_elimination' | 'round_robin' | 'pool_then_elimination';

const IMPLEMENTED: readonly DrawableFormat[] = ['single_elimination', 'round_robin', 'pool_then_elimination'];

/**
 * The entry statuses a draw is built from.
 *
 * This is the plain reading of `entry_status`: these three mean "accepted and
 * present". It is NOT a judgement about whether an unpaid entry may compete —
 * `fee_pending` is excluded because such an entry has not been confirmed, not
 * because this module has an opinion about fees.
 */
export const DRAWABLE_ENTRY_STATUSES = ['confirmed', 'checked_in', 'weighed_in'] as const;

/**
 * Bouts whose state means the bracket has left the draw's hands.
 *
 * `called` and `paused` are in the list because athletes are already at the mat
 * in the first and a bout is under way in the second. `walkover` is in it
 * because a no-show awarded to the opponent is a RESULT — the engine's own byes
 * are excluded separately, by the shape of the bout rather than by a win method
 * a caller could supply. Excluding a status from this list is a decision to
 * allow a redraw over it, so the list is deliberately wide: fail closed.
 */
const CONTESTED_MATCH_STATUSES = [
  'called', 'in_progress', 'paused', 'completed', 'walkover', 'disqualification', 'under_protest',
] as const;

/**
 * Key-sorted JSON, for digesting a record that has been through jsonb.
 *
 * Postgres does NOT preserve object key order in jsonb, so a digest taken over
 * `JSON.stringify(value)` at write time and recomputed over the value read back
 * would differ for reasons that have nothing to do with tampering — which is
 * the worst possible failure for an integrity check, because it cries wolf.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * The digest recorded in the audit spine when a draw is generated.
 *
 * `seedInput` is what the draw is recomputed FROM, so a forger who rewrites it
 * to match a bracket they have edited would otherwise make the rigged draw
 * verify perfectly. The digest lives in a different table, written by the audit
 * spine, so the forgery now has to succeed in two places at once.
 */
export function seedInputDigest(seedInput: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(seedInput), 'utf8').digest('hex');
}

// ─── Deterministic randomness ───────────────────────────────────────────────

/**
 * `Math.random()` is unusable here, and not by a small margin: it cannot be
 * seeded, its algorithm is implementation-defined, and V8 is explicitly free to
 * change it between releases. A bracket drawn from it can never be recomputed —
 * not by us, not by an auditor, not by the coach who wants to watch it done
 * again. Every random decision below therefore comes from xorshift128
 * (Marsaglia 2003) over a SHA-256 of the recorded seed string: small, well
 * known, and pure integer arithmetic, so it yields the same stream on every
 * platform and every Node version.
 *
 * It is NOT cryptographically strong and must never be used for tokens. For a
 * draw that is the right trade: the seed is published with the bracket anyway,
 * so unpredictability after the fact is not the property being bought —
 * reproducibility is.
 */
export function createRng(seed: string) {
  const h = crypto.createHash('sha256').update(seed, 'utf8').digest();
  let x = h.readUInt32BE(0), y = h.readUInt32BE(4), z = h.readUInt32BE(8), w = h.readUInt32BE(12);
  // xorshift can never leave the all-zero state, so it must never enter it.
  if ((x | y | z | w) === 0) w = 0x9e3779b9;

  function nextUint32(): number {
    const t = (x ^ (x << 11)) >>> 0;
    x = y; y = z; z = w;
    // >>> 0 after every step: JS bitwise operators produce SIGNED 32-bit
    // results, and letting a negative intermediate through changes the stream —
    // silently, and only for some seeds, which is the worst way to lose
    // reproducibility.
    w = (w ^ (w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return w;
  }

  return {
    nextUint32,
    /** Uniform in [0, bound). Rejection-sampled: `% bound` alone biases low values. */
    nextInt(bound: number): number {
      if (bound <= 1) return 0;
      const limit = Math.floor(0x100000000 / bound) * bound;
      let r = nextUint32();
      while (r >= limit) r = nextUint32();
      return r % bound;
    },
  };
}

/** Fisher-Yates, descending, drawing from the seeded stream only. */
function shuffle<T>(items: T[], rng: ReturnType<typeof createRng>): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Bracket mathematics ────────────────────────────────────────────────────

/** Smallest power of two at or above n. Computed by doubling: no float log2. */
function bracketSizeFor(n: number): number {
  let b = 1;
  while (b < n) b *= 2;
  return b;
}

/**
 * Seed numbers in slot order for a bracket of `size`.
 *
 * Built by the standard recursive expansion: each seed s in a bracket of n
 * becomes the pair (s, 2n+1-s) in the bracket of 2n. Two properties follow, and
 * both are load-bearing:
 *   · seed k always meets seed size+1-k in round one, so when the bracket is
 *     larger than the field the byes fall on the TOP seeds automatically —
 *     nothing has to place them by hand;
 *   · the top two seeds can only meet in the final.
 */
function standardOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const seed of order) next.push(seed, n + 1 - seed);
    order = next;
  }
  return order;
}

/** Round label from the number of competitors still in it. */
function roundName(inRound: number): string {
  if (inRound === 2) return 'F';
  if (inRound === 4) return 'SF';
  if (inRound === 8) return 'QF';
  return `R${inRound}`;
}

function poolLabelFor(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `P${i + 1}`;
}

/**
 * Round-robin pairings by the circle method: the first competitor stays put and
 * the rest rotate. Every pair meets exactly once, and the pairing is a pure
 * function of the ordered list — no randomness beyond the shuffle that produced
 * that list.
 */
function circleRounds<T>(items: T[]): T[][][] {
  const padded: (T | null)[] = [...items];
  if (padded.length % 2 === 1) padded.push(null);   // an odd field sits one out each round
  const n = padded.length;
  const fixed = padded[0];
  let rest = padded.slice(1);

  const rounds: T[][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const arrangement = [fixed, ...rest];
    const pairs: T[][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arrangement[i], b = arrangement[n - 1 - i];
      if (a != null && b != null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    rest = [rest[rest.length - 1], ...rest.slice(0, -1)];
  }
  return rounds;
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface PlanEntry {
  entryId: number;
  entryNo: string;
  seed: number | null;
}

/**
 * Pool structure. There is no default: how many pools a category runs and how
 * many athletes qualify from each are competition regulations MMAKF sets. This
 * module refuses rather than choosing for them.
 */
export interface PoolConfig {
  poolCount: number;
  advancePerPool: number;
}

export interface PlannedMatch {
  /** 1-based position in the draw. Stable, and what `advancesToIndex` refers to. */
  index: number;
  round: string;
  roundOrder: number;
  poolLabel: string | null;
  /** Entry numbers, not row ids: a plan must compare equal across databases. */
  red: string | null;
  blue: string | null;
  /** For an elimination stage fed by pools: which pool place fills this slot ('A1'). */
  redSource: string | null;
  blueSource: string | null;
  winner: string | null;
  status: 'scheduled' | 'walkover';
  winMethod: string | null;
  bye: boolean;
  byeReason: string | null;
  advancesToIndex: number | null;
  advancesToSlot: 'red' | 'blue' | null;
}

export interface DrawPlan {
  algorithmVersion: string;
  format: DrawableFormat;
  randomSeed: string;
  entryCount: number;
  bracketSize: number | null;
  roundsCount: number;
  pools: PoolConfig | null;
  /** The ordered entry list after seeding and shuffling — position 1 is seed 1. */
  order: Array<{ position: number; entryId: number; entryNo: string; seed: number | null }>;
  matches: PlannedMatch[];
  /** Anything an official would otherwise have to work out for themselves. */
  notes: string[];
}

/**
 * The canonical input order.
 *
 * Sorting must be TOTAL and platform-independent, so it compares entry numbers
 * with `<` rather than `localeCompare` — the latter depends on the host's ICU
 * data, which would make the same seed produce different draws on different
 * machines. That failure stays invisible until someone tries to reproduce a
 * draw on another box, which is exactly when it matters most.
 */
export function canonicalOrder(entries: PlanEntry[]): PlanEntry[] {
  const byNo = (a: PlanEntry, b: PlanEntry) => (a.entryNo < b.entryNo ? -1 : a.entryNo > b.entryNo ? 1 : 0);
  const seeded = entries.filter((e) => e.seed != null)
    .sort((a, b) => (a.seed! - b.seed!) || byNo(a, b));
  const unseeded = entries.filter((e) => e.seed == null).sort(byNo);
  return [...seeded, ...unseeded];
}

interface Slot { entryNo: string | null; source: string | null }

/**
 * Build an elimination bracket over `slots`, already in slot order.
 *
 * Every match records where its winner goes (`advancesToIndex` / slot), so
 * progression is data. A scorer never works out the next bout by hand, and the
 * bracket can be redrawn from the stored matches alone.
 */
function buildElimination(opts: {
  slots: Slot[];
  startIndex: number;
  startRoundOrder: number;
  notes: string[];
}): { matches: PlannedMatch[]; rounds: number } {
  const size = opts.slots.length;
  const rounds: PlannedMatch[][] = [];
  let index = opts.startIndex;
  let roundOrder = opts.startRoundOrder;

  for (let inRound = size; inRound >= 2; inRound /= 2) {
    const row: PlannedMatch[] = [];
    for (let i = 0; i < inRound / 2; i++) {
      row.push({
        index: index++,
        round: roundName(inRound),
        roundOrder,
        poolLabel: null,
        red: null, blue: null,
        redSource: null, blueSource: null,
        winner: null,
        status: 'scheduled',
        winMethod: null,
        bye: false,
        byeReason: null,
        advancesToIndex: null,
        advancesToSlot: null,
      });
    }
    rounds.push(row);
    roundOrder++;
  }

  // Round one is filled from the slots; consecutive slots are opponents.
  rounds[0].forEach((m, i) => {
    m.red = opts.slots[2 * i].entryNo;
    m.redSource = opts.slots[2 * i].source;
    m.blue = opts.slots[2 * i + 1].entryNo;
    m.blueSource = opts.slots[2 * i + 1].source;
  });

  // Wiring: match i of a round feeds match floor(i/2) of the next, red for even.
  for (let r = 0; r < rounds.length - 1; r++) {
    rounds[r].forEach((m, i) => {
      const target = rounds[r + 1][Math.floor(i / 2)];
      m.advancesToIndex = target.index;
      m.advancesToSlot = i % 2 === 0 ? 'red' : 'blue';
    });
  }

  // Byes. Only round one can hold one: a later round's empty slot is waiting on
  // a match that exists, which is not the same thing at all.
  const byeSeats: string[] = [];
  const flat = rounds.flat();
  for (const m of rounds[0]) {
    const redFilled = m.red ?? m.redSource;
    const blueFilled = m.blue ?? m.blueSource;
    if (redFilled && blueFilled) continue;
    if (!redFilled && !blueFilled) {
      // Unreachable for a bracket that is the SMALLEST power of two at or above
      // the field, so arriving here means the field was miscounted. Fail closed.
      throw new DrawError('empty_match', 'A bracket position was left with no competitor on either side.');
    }
    const side: 'red' | 'blue' = redFilled ? 'red' : 'blue';
    const entryNo = side === 'red' ? m.red : m.blue;
    const source = side === 'red' ? m.redSource : m.blueSource;

    m.bye = true;
    m.byeReason = `No opponent: the field fills ${size} bracket positions and this one had none facing it.`;

    if (m.advancesToIndex != null) {
      const target = flat.find((t) => t.index === m.advancesToIndex)!;
      if (m.advancesToSlot === 'red') { target.red = entryNo; target.redSource = source; }
      else { target.blue = entryNo; target.blueSource = source; }
    }

    if (entryNo) {
      // A known competitor with no opponent has already won this bout.
      m.winner = entryNo;
      m.status = 'walkover';
      m.winMethod = 'bye';
      byeSeats.push(entryNo);
    } else {
      // A pool qualifier not yet known: the bye is real, but who benefits is not
      // decided until the pools finish, so nothing is declared a winner here.
      byeSeats.push(source!);
    }
  }
  if (byeSeats.length) {
    opts.notes.push(
      `${byeSeats.length} bye(s) to the top of the draw (${byeSeats.join(', ')}): ` +
      `this field fills a bracket of ${size} positions.`
    );
  }

  return { matches: flat, rounds: rounds.length };
}

/**
 * Compute a draw. PURE — no database, no clock, no ambient randomness.
 *
 * This is what makes reproducibility testable and auditable: the same entries
 * and the same seed give the same object, every time, on any machine.
 */
export function planDraw(input: {
  entries: PlanEntry[];
  format: AnyFormat;
  seed: string;
  pools?: PoolConfig | null;
}): DrawPlan {
  if (!IMPLEMENTED.includes(input.format as DrawableFormat)) {
    throw new DrawError(
      'format_not_implemented',
      `The draw engine does not implement the "${input.format}" format. ` +
      `Implemented formats are: ${IMPLEMENTED.join(', ')}. ` +
      'Approximating it with another format would produce a bracket the regulations do not describe.'
    );
  }
  const format = input.format as DrawableFormat;
  if (!input.seed) throw new DrawError('seed_required', 'A draw needs a recorded seed to be reproducible.');

  const entries = canonicalOrder(input.entries);
  if (entries.length < 2) {
    throw new DrawError('insufficient_entries', `A draw needs at least two entries; ${entries.length} were supplied.`);
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.entryNo)) throw new DrawError('duplicate_entry', `Entry ${e.entryNo} appears twice in the draw input.`);
    seen.add(e.entryNo);
  }

  const notes: string[] = [];
  const rng = createRng(input.seed);

  // Seeded entries hold their standard bracket positions; everyone else is
  // drawn. The shuffle consumes the seeded stream ONCE, over the unseeded tail
  // only.
  const seededCount = entries.filter((e) => e.seed != null).length;
  const placed = [
    ...entries.slice(0, seededCount),
    ...shuffle(entries.slice(seededCount), rng),
  ];
  if (seededCount === 0) {
    notes.push('No entry in this category carries a seed; every position was drawn at random from the recorded seed.');
  } else {
    const seedValues = entries.slice(0, seededCount).map((e) => e.seed!);
    notes.push(
      `${seededCount} seeded entr(y/ies) placed at the standard bracket positions for ranks ` +
      `1..${seededCount}; the remaining ${placed.length - seededCount} were drawn.`
    );
    // Seed NUMBERS are compacted to bracket RANKS in ascending order. With
    // seeds 3 and 7 and nothing else, honouring the literal numbers would put
    // both in the same half — seat 3 and seat 7 of an eight-position bracket
    // face each other in round one — which is the opposite of what seeding is
    // for. The engine does not know why a number was skipped, so it places by
    // rank and SAYS it did; reading the bracket as though seed 3 sat in seat 3
    // is then impossible.
    const dense = seedValues.every((v, i) => v === i + 1);
    if (!dense) {
      notes.push(
        `Seed numbers [${seedValues.join(', ')}] are not a run of 1..${seededCount}; they were placed by ` +
        `rank in ascending order (${seedValues.map((v, i) => `seed ${v} → rank ${i + 1}`).join(', ')}). ` +
        'The engine cannot know why a number was skipped, so it does not treat the gap as an empty seat.'
      );
    }
    if (new Set(seedValues).size !== seedValues.length) {
      // Not refused: a duplicate seed is an entry-data problem and the draw is
      // still deterministic (ties break on entry number). But it must be visible
      // rather than silently resolved.
      notes.push('WARNING: two or more entries carry the same seed. Positions were ordered by entry number to break the tie.');
    }
  }

  const order = placed.map((e, i) => ({ position: i + 1, entryId: e.entryId, entryNo: e.entryNo, seed: e.seed }));

  if (format === 'single_elimination') {
    const size = bracketSizeFor(placed.length);
    const slots: Slot[] = standardOrder(size).map((seatSeed) => ({
      entryNo: seatSeed <= placed.length ? placed[seatSeed - 1].entryNo : null,
      source: null,
    }));
    const built = buildElimination({ slots, startIndex: 1, startRoundOrder: 1, notes });
    return {
      algorithmVersion: ALGORITHM_VERSION,
      format,
      randomSeed: input.seed,
      entryCount: placed.length,
      bracketSize: size,
      roundsCount: built.rounds,
      pools: null,
      order,
      matches: built.matches,
      notes,
    };
  }

  if (format === 'round_robin') {
    const rounds = circleRounds(placed);
    const matches: PlannedMatch[] = [];
    let index = 1;
    rounds.forEach((pairs, r) => {
      for (const pair of pairs) {
        matches.push({
          index: index++,
          round: `RR${r + 1}`,
          roundOrder: r + 1,
          poolLabel: null,
          red: pair[0].entryNo, blue: pair[1].entryNo,
          redSource: null, blueSource: null,
          winner: null, status: 'scheduled', winMethod: null,
          bye: false, byeReason: null,
          // No wiring, deliberately: a round robin has no progression to wire.
          // Placings come from standings, and how MMAKF breaks a standings tie
          // is regulation, not something this module may decide.
          advancesToIndex: null, advancesToSlot: null,
        });
      }
    });
    notes.push(
      'Round robin: every entry meets every other once. Final placings come from the standings, ' +
      'which this module does not compute — the tie-break rules are the federation’s to set.'
    );
    return {
      algorithmVersion: ALGORITHM_VERSION,
      format,
      randomSeed: input.seed,
      entryCount: placed.length,
      bracketSize: null,
      roundsCount: rounds.length,
      pools: null,
      order,
      matches,
      notes,
    };
  }

  // ── pool_then_elimination ──
  const pools = input.pools;
  if (!pools || !Number.isInteger(pools.poolCount) || !Number.isInteger(pools.advancePerPool)
      || pools.poolCount < 1 || pools.advancePerPool < 1) {
    throw new DrawError(
      'pool_config_required',
      'A pool draw needs the number of pools and how many advance from each. ' +
      'Those are competition regulations the federation sets; the draw engine will not choose them.'
    );
  }
  if (pools.poolCount > placed.length) {
    throw new DrawError(
      'pool_config_invalid',
      `${pools.poolCount} pools were asked for but only ${placed.length} entries are in the draw.`
    );
  }

  // Serpentine distribution: 1st, 2nd, 3rd … across the pools then back again,
  // so seeded entries are spread rather than stacked in one pool.
  const buckets: PlanEntry[][] = Array.from({ length: pools.poolCount }, () => []);
  placed.forEach((e, i) => {
    const cycle = i % (2 * pools.poolCount);
    const p = cycle < pools.poolCount ? cycle : 2 * pools.poolCount - 1 - cycle;
    buckets[p].push(e);
  });
  buckets.forEach((b, i) => {
    if (b.length < 2) {
      throw new DrawError('pool_too_small', `Pool ${poolLabelFor(i)} would hold ${b.length} entr(y/ies); a pool needs at least two.`);
    }
    if (b.length < pools.advancePerPool) {
      throw new DrawError('pool_too_small', `Pool ${poolLabelFor(i)} holds ${b.length} entries but ${pools.advancePerPool} are set to advance from it.`);
    }
  });

  const matches: PlannedMatch[] = [];
  let index = 1;
  let poolRounds = 0;
  buckets.forEach((bucket, p) => {
    const label = poolLabelFor(p);
    const rounds = circleRounds(bucket);
    poolRounds = Math.max(poolRounds, rounds.length);
    rounds.forEach((pairs, r) => {
      for (const pair of pairs) {
        matches.push({
          index: index++,
          round: 'pool',
          roundOrder: r + 1,
          poolLabel: label,
          red: pair[0].entryNo, blue: pair[1].entryNo,
          redSource: null, blueSource: null,
          winner: null, status: 'scheduled', winMethod: null,
          bye: false, byeReason: null,
          advancesToIndex: null, advancesToSlot: null,
        });
      }
    });
  });

  // Qualifier seeding: all pool winners first, then all runners-up, and so on.
  // With the standard bracket order this keeps A1 and B1 apart and pairs across
  // pools where the numbers allow. Where they do not — an odd pool count with
  // byes — a same-pool first-round meeting can survive, so it is REPORTED below
  // rather than quietly resolved by a swap rule nobody approved.
  const qualifierLabels: string[] = [];
  for (let rank = 1; rank <= pools.advancePerPool; rank++) {
    for (let p = 0; p < pools.poolCount; p++) qualifierLabels.push(`${poolLabelFor(p)}${rank}`);
  }
  if (qualifierLabels.length < 2) {
    throw new DrawError('pool_config_invalid', 'A pool draw must send at least two qualifiers to the elimination stage.');
  }

  const size = bracketSizeFor(qualifierLabels.length);
  const slots: Slot[] = standardOrder(size).map((seatSeed) => ({
    entryNo: null,
    source: seatSeed <= qualifierLabels.length ? qualifierLabels[seatSeed - 1] : null,
  }));
  const built = buildElimination({ slots, startIndex: index, startRoundOrder: poolRounds + 1, notes });
  matches.push(...built.matches);

  const samePool = built.matches
    .filter((m) => m.roundOrder === poolRounds + 1 && m.redSource && m.blueSource)
    .filter((m) => m.redSource!.slice(0, -1) === m.blueSource!.slice(0, -1));
  if (samePool.length) {
    notes.push(
      `WARNING: ${samePool.length} first-round elimination bout(s) pair qualifiers from the same pool ` +
      `(${samePool.map((m) => `${m.redSource} v ${m.blueSource}`).join(', ')}). ` +
      'Avoiding this needs a swap rule the federation has not set, so the draw reports it instead of applying one.'
    );
  }
  notes.push(
    `Pool stage: ${pools.poolCount} pool(s), ${pools.advancePerPool} advancing from each ` +
    `into a ${size}-position bracket. Elimination slots are filled from pool standings, which this module does not compute.`
  );

  return {
    algorithmVersion: ALGORITHM_VERSION,
    format,
    randomSeed: input.seed,
    entryCount: placed.length,
    bracketSize: size,
    roundsCount: poolRounds + built.rounds,
    pools,
    order,
    matches,
    notes,
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function loadCategoryAndEvent(db: DB, categoryId: number) {
  const category = (await db.select().from(s.eventCategories)
    .where(eq(s.eventCategories.id, categoryId)).limit(1))[0];
  if (!category) throw new DrawError('unknown_category', 'Unknown category');
  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, category.eventId)).limit(1))[0];
  if (!event) throw new DrawError('unknown_event', 'Unknown event');
  return { category, event };
}

/**
 * Where a draw sits in the federation hierarchy, for `can()`.
 *
 * A NATIONAL event carries neither a state nor a district, so only a national
 * binding contains it — a state administrator cannot reach a national bracket
 * by knowing its id. That falls out of `scopeContains()` in the RBAC module; it
 * is not re-decided here, and no caller may narrow it.
 */
function eventScope(event: any) {
  return { stateUnitId: event.stateUnitId, districtUnitId: event.districtUnitId };
}

/**
 * Match numbers carry the draw id.
 *
 * `matches_no_uk` is unique on (eventId, matchNo), and a superseding draw
 * re-creates the same rounds for the same category. Without the draw
 * discriminator the second generation collides on the first match it writes —
 * and since the superseded draw's matches are never deleted, that collision is
 * guaranteed rather than theoretical.
 */
function matchNoFor(categoryCode: string, drawId: number, index: number): string {
  return `${categoryCode}-D${drawId}-${String(index).padStart(3, '0')}`;
}

/**
 * Generate a draw for a category.
 *
 * Generation is NOT publication (see `publishDraw`). An unpublished draw can be
 * regenerated freely; a PUBLISHED one is superseded, with a reason, and the
 * original and its matches stay on the record.
 */
export async function generateDraw(
  db: DB,
  ctx: AuditContext,
  input: {
    categoryId: number;
    format?: AnyFormat | null;
    seed?: string | null;
    pools?: PoolConfig | null;
    reason?: string | null;
  },
  now: Date = new Date()
) {
  const { category, event } = await loadCategoryAndEvent(db, input.categoryId);
  assertCan(ctx.principal, 'competition:write', eventScope(event));

  const reason = input.reason?.trim() || null;
  const generationNotes: string[] = [];

  // OFFICIAL RECORDS LOCK. Once the event's results are finalised the bracket
  // is part of a closed record: the placings were declared against THIS draw,
  // and re-shaping it afterwards would leave finalised results describing a
  // competition that no longer exists on the record.
  if (event.resultsFinalisedAt) {
    throw new DrawError(
      'results_finalised',
      `Results for event ${event.code} were finalised on ${new Date(event.resultsFinalisedAt).toISOString()}. ` +
      'A draw cannot be generated against a closed record; a correction supersedes the RESULT, with authority and reason.'
    );
  }

  // The format is configuration. The category's own setting is the federation's
  // decision; a caller may override it, but an override is a decision about
  // competition structure and is recorded as one — with a reason, and named in
  // the draw's own record — rather than passing as though the federation had
  // set it. If neither exists the draw is refused: guessing a format would put
  // an unapproved competition structure into an official bracket.
  const configured = (category.drawFormat ?? null) as AnyFormat | null;
  const requested = (input.format ?? null) as AnyFormat | null;
  const format = requested ?? configured;
  if (!format) {
    throw new DrawError(
      'format_not_set',
      `No draw format is set for category ${category.code}. The federation must set the format for this category before a draw can be made.`
    );
  }
  const formatSource: 'category_configuration' | 'caller_override' | 'caller_supplied_none_configured' =
    requested == null || requested === configured
      ? 'category_configuration'
      : configured == null ? 'caller_supplied_none_configured' : 'caller_override';

  if (formatSource === 'caller_override' && !reason) {
    throw new DrawError(
      'format_override_reason_required',
      `Category ${category.code} is configured for "${configured}" but "${requested}" was asked for. ` +
      'Drawing a category under a format the federation did not set for it requires a recorded reason.'
    );
  }
  if (formatSource === 'caller_override') {
    generationNotes.push(
      `FORMAT OVERRIDE: the federation configured "${configured}" for category ${category.code}; ` +
      `this draw was made as "${requested}" on the recorded authority of ${ctx.principal.label}.`
    );
  }
  if (formatSource === 'caller_supplied_none_configured') {
    generationNotes.push(
      `The federation has set NO draw format for category ${category.code}; "${requested}" was supplied by ` +
      `${ctx.principal.label} at generation. It is not a configured category format and must not be read as one.`
    );
  }

  if (input.seed !== undefined && input.seed !== null && !input.seed.trim()) {
    throw new DrawError('seed_required', 'A blank seed cannot be recorded; supply a seed or let one be generated.');
  }

  // The draw this one would replace, if any. The newest row is the current one,
  // because every regeneration supersedes the row before it.
  const existing = await db.select().from(s.draws)
    .where(eq(s.draws.categoryId, input.categoryId))
    .orderBy(asc(s.draws.id));
  const previous = existing[existing.length - 1];

  if (previous) {
    if (previous.publishedAt && !reason) {
      throw new DrawError(
        'reason_required',
        'This draw has been published. Regenerating a published draw requires a recorded reason; the published draw is superseded, never replaced.'
      );
    }

    const live = await db.select({
      id: s.matches.id,
      matchNo: s.matches.matchNo,
      status: s.matches.status,
      redEntryId: s.matches.redEntryId,
      blueEntryId: s.matches.blueEntryId,
    }).from(s.matches)
      .where(and(
        eq(s.matches.drawId, previous.id),
        inArray(s.matches.status, [...CONTESTED_MATCH_STATUSES])
      ));

    // A bye written by THIS engine is a walkover in a bout that never had two
    // sides, so it is recognised by that shape rather than by `winMethod`,
    // which a caller recording a real walkover may set to whatever it likes —
    // including 'bye'. A walkover between two assigned competitors is a no-show
    // RESULT, and it does block the redraw.
    const contested = live.filter(
      (m: any) => !(m.status === 'walkover' && (m.redEntryId == null || m.blueEntryId == null))
    );

    // Scoring can be recorded while the bout's own status still says
    // 'scheduled', so the status list alone is not enough: the append-only log
    // is the record of truth about whether anyone has competed. The engine's
    // own bye rows are the one action in it that is not a contest.
    const scored = await db.select({ matchNo: s.matches.matchNo })
      .from(s.matchEvents)
      .innerJoin(s.matches, eq(s.matchEvents.matchId, s.matches.id))
      .where(and(eq(s.matches.drawId, previous.id), ne(s.matchEvents.action, 'bye')));

    if (contested.length || scored.length) {
      const bouts = [...new Set([
        ...contested.map((m: any) => m.matchNo),
        ...scored.map((m: any) => m.matchNo),
      ])];
      throw new DrawError(
        'draw_in_progress',
        `${bouts.length} bout(s) in the current draw have already been contested (${bouts.join(', ')}). ` +
        'A draw cannot be regenerated over results; correct the results instead.'
      );
    }
  }

  // EVERY entry in the category, not only the drawable ones. The bracket has to
  // account for an absence: "why is my athlete not in this draw?" is answered
  // from the draw's own record, and an entry the query never saw is one the
  // record cannot explain.
  const rows = await db.select({
    id: s.eventEntries.id,
    entryNo: s.eventEntries.entryNo,
    seed: s.eventEntries.seed,
    status: s.eventEntries.status,
  }).from(s.eventEntries).where(eq(s.eventEntries.categoryId, input.categoryId));

  const drawableStatuses: readonly string[] = DRAWABLE_ENTRY_STATUSES;
  const drawable = rows.filter((r: any) => drawableStatuses.includes(r.status));
  const excluded = rows.filter((r: any) => !drawableStatuses.includes(r.status));

  const entries: PlanEntry[] = drawable.map((r: any) => ({ entryId: r.id, entryNo: r.entryNo, seed: r.seed ?? null }));
  const seed = input.seed?.trim() || crypto.randomBytes(16).toString('hex');

  const plan = planDraw({ entries, format, seed, pools: input.pools ?? null });

  generationNotes.push(
    `Entries drawn: ${plan.entryCount} of the ${rows.length} entries in this category — those whose status at ` +
    `generation was ${DRAWABLE_ENTRY_STATUSES.join(', ')}.`
  );
  if (excluded.length) {
    const byStatus = new Map<string, number>();
    for (const r of excluded as any[]) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    generationNotes.push(
      `${excluded.length} entr(y/ies) in this category were not drawn: ` +
      `${[...byStatus].map(([st, n]) => `${n} ${st}`).join(', ')}. ` +
      'Whether an entry in one of those states may compete is decided when the entry is accepted, not here.'
    );
  }

  // `maxEntries` is the federation's OWN configuration for this category. The
  // draw does not enforce it — whether an over-cap entry may compete is decided
  // when the entry is accepted, not when the bracket is built — but a bracket
  // that quietly exceeds the federation's stated cap is exactly the thing an
  // official must be told about rather than discover at the mat.
  if (category.maxEntries != null && plan.entryCount > category.maxEntries) {
    generationNotes.push(
      `WARNING: ${plan.entryCount} entries were drawn but category ${category.code} is configured for a ` +
      `maximum of ${category.maxEntries}. The draw does not refuse them — entry acceptance is not decided here — ` +
      'but the bracket exceeds the configured cap and the discrepancy is on the record.'
    );
  }

  // Generation facts belong beside the planner's own notes: one list, so an
  // official reads the whole account of this draw in one place.
  plan.notes.push(...generationNotes);

  // Everything the planner needs to run again WITHOUT re-reading entries that
  // may since have changed. This is what "reproducible from the record alone"
  // means in practice.
  const seedInput = {
    algorithmVersion: plan.algorithmVersion,
    format: plan.format,
    formatSource,
    formatConfiguredForCategory: configured,
    pools: plan.pools,
    entryStatusesIncluded: [...DRAWABLE_ENTRY_STATUSES],
    entries: canonicalOrder(entries),
    notes: plan.notes,
  };

  const [draw] = await db.insert(s.draws).values({
    categoryId: input.categoryId,
    format: plan.format,
    roundsCount: plan.roundsCount,
    entryCount: plan.entryCount,
    randomSeed: plan.randomSeed,
    seedInput,
    algorithmVersion: plan.algorithmVersion,
    generatedAt: now,
    generatedByUserId: ctx.principal.userId ?? null,
    supersedesDrawId: previous?.id ?? null,
    regenerationReason: previous ? reason : null,
  }).returning();

  const idByEntryNo = new Map<string, number>(plan.order.map((o) => [o.entryNo, o.entryId]));
  const inserted = await db.insert(s.matches).values(plan.matches.map((m) => ({
    drawId: draw.id,
    categoryId: category.id,
    eventId: event.id,
    matchNo: matchNoFor(category.code, draw.id, m.index),
    round: m.round,
    roundOrder: m.roundOrder,
    poolLabel: m.poolLabel,
    redEntryId: m.red ? idByEntryNo.get(m.red) ?? null : null,
    blueEntryId: m.blue ? idByEntryNo.get(m.blue) ?? null : null,
    status: m.status,
    winnerEntryId: m.winner ? idByEntryNo.get(m.winner) ?? null : null,
    winMethod: m.winMethod,
    createdAt: now,
    updatedAt: now,
  }))).returning({ id: s.matches.id, matchNo: s.matches.matchNo });

  const matchIdByNo = new Map<string, number>(inserted.map((r: any) => [r.matchNo, r.id]));
  const idOf = (i: number) => matchIdByNo.get(matchNoFor(category.code, draw.id, i))!;

  for (const m of plan.matches) {
    if (m.advancesToIndex == null) continue;
    await db.update(s.matches).set({
      advancesToMatchId: idOf(m.advancesToIndex),
      advancesToSlot: m.advancesToSlot,
    }).where(eq(s.matches.id, idOf(m.index)));
  }

  // A bye is a result with a cause. `matches` has nowhere to write the cause, so
  // it goes in the append-only match log where every other match fact lives — an
  // official can then read WHY the bout was awarded, not merely that it was.
  for (const m of plan.matches) {
    if (!m.bye || !m.winner) continue;
    await db.insert(s.matchEvents).values({
      matchId: idOf(m.index),
      sequence: 1,
      side: m.red === m.winner ? 'red' : 'blue',
      action: 'bye',
      points: 0,
      note: m.byeReason,
      at: now,
    });
  }

  // The entry's position in the CURRENT draw. It is a CACHE of the plan, so it
  // is cleared for the whole category first: an entry that was in the previous
  // bracket but is not in this one — withdrawn since, or moved — would
  // otherwise keep a position in a draw that has been superseded, and a
  // position that points at a bracket nobody is running is worse than none.
  // Superseded draws keep their own positions in their stored seedInput and
  // their own matches, which is where that history belongs.
  await db.update(s.eventEntries)
    .set({ drawPosition: null, updatedAt: now })
    .where(and(
      eq(s.eventEntries.categoryId, input.categoryId),
      isNotNull(s.eventEntries.drawPosition)
    ));
  for (const o of plan.order) {
    await db.update(s.eventEntries)
      .set({ drawPosition: o.position, updatedAt: now })
      .where(eq(s.eventEntries.id, o.entryId));
  }

  await writeAudit(db, { ...ctx, reason: reason ?? ctx.reason ?? null }, {
    entityType: 'draw',
    entityId: draw.id,
    action: 'create',
    oldValue: previous
      ? { supersededDrawId: previous.id, wasPublished: Boolean(previous.publishedAt) }
      : undefined,
    newValue: {
      categoryId: input.categoryId,
      format: plan.format,
      formatSource,
      formatConfiguredForCategory: configured,
      entryCount: plan.entryCount,
      roundsCount: plan.roundsCount,
      randomSeed: plan.randomSeed,
      algorithmVersion: plan.algorithmVersion,
      matchCount: plan.matches.length,
      entryStatusesIncluded: [...DRAWABLE_ENTRY_STATUSES],
      // The tamper-evidence anchor. `seedInput` is what the draw is recomputed
      // FROM, so rewriting it to fit an edited bracket would make a rigged draw
      // verify perfectly — unless the digest of it also lives somewhere the
      // forger has to reach separately. It lives here.
      seedInputDigest: seedInputDigest(seedInput),
    },
  });

  return { draw, plan, matchIdByNo };
}

/**
 * Publish a draw.
 *
 * Separate from generation on purpose: generation is a technical act,
 * publication is the moment the bracket becomes the one the competition runs
 * to. After it, regeneration needs a reason and supersedes rather than
 * replaces.
 */
export async function publishDraw(db: DB, ctx: AuditContext, drawId: number, now: Date = new Date()) {
  const draw = (await db.select().from(s.draws).where(eq(s.draws.id, drawId)).limit(1))[0];
  if (!draw) throw new DrawError('unknown_draw', 'Unknown draw');

  const { event } = await loadCategoryAndEvent(db, draw.categoryId);
  assertCan(ctx.principal, 'competition:write', eventScope(event));

  if (draw.publishedAt) throw new DrawError('already_published', 'This draw is already published.');

  const successor = (await db.select({ id: s.draws.id }).from(s.draws)
    .where(eq(s.draws.supersedesDrawId, drawId)).limit(1))[0];
  if (successor) {
    throw new DrawError('superseded', `This draw has been superseded by draw ${successor.id} and cannot be published.`);
  }

  const [row] = await db.update(s.draws)
    .set({ publishedAt: now, publishedByUserId: ctx.principal.userId ?? null })
    .where(eq(s.draws.id, drawId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'draw',
    entityId: drawId,
    action: 'finalize',
    oldValue: { publishedAt: null },
    newValue: {
      publishedAt: now.toISOString(),
      randomSeed: draw.randomSeed,
      algorithmVersion: draw.algorithmVersion,
    },
  });

  return row;
}

// ─── Reading back, and proving reproducibility ──────────────────────────────

export interface NormalisedMatch {
  index: number;
  round: string;
  roundOrder: number;
  poolLabel: string | null;
  red: string | null;
  blue: string | null;
  winner: string | null;
  status: string;
  advancesToIndex: number | null;
  advancesToSlot: string | null;
}

function normalisePlan(plan: DrawPlan): NormalisedMatch[] {
  return plan.matches.map((m) => ({
    index: m.index,
    round: m.round,
    roundOrder: m.roundOrder,
    poolLabel: m.poolLabel,
    red: m.red,
    blue: m.blue,
    winner: m.winner,
    status: m.status,
    advancesToIndex: m.advancesToIndex,
    advancesToSlot: m.advancesToSlot,
  }));
}

/**
 * The stored bracket, in the same shape a plan takes.
 *
 * Row ids and match numbers differ between two generations of the same draw;
 * the BRACKET does not. Comparing this shape is what "identical draw" means.
 *
 * WHO MAY SEE IT. A PUBLISHED draw is public: it is posted at the venue and
 * every competitor is entitled to it, so no binding is required. An
 * UNPUBLISHED one is not public — advance knowledge of a bracket nobody has
 * published is precisely what a rigging allegation is built on — so it is
 * readable only by the authority that could have made it. `viewer` defaults to
 * nobody, which means an unpublished draw fails closed for a caller that has
 * not thought about who is asking.
 */
export async function readDraw(
  db: DB,
  drawId: number,
  viewer: Principal | null = null
): Promise<{ draw: any; matches: NormalisedMatch[] }> {
  const draw = (await db.select().from(s.draws).where(eq(s.draws.id, drawId)).limit(1))[0];
  if (!draw) throw new DrawError('unknown_draw', 'Unknown draw');

  if (!draw.publishedAt) {
    const { event } = await loadCategoryAndEvent(db, draw.categoryId);
    assertCan(viewer, 'competition:write', eventScope(event));
  }

  const rows = await db.select().from(s.matches)
    .where(eq(s.matches.drawId, drawId)).orderBy(asc(s.matches.id));

  // Entry numbers are resolved by the ids the bracket actually references, NOT
  // by the draw's category. An entry moved to another category after the draw
  // would otherwise read back as an empty slot, and a sound historical draw
  // would look as though someone had emptied a bout.
  const referenced = new Set<number>();
  for (const r of rows as any[]) {
    for (const v of [r.redEntryId, r.blueEntryId, r.winnerEntryId]) if (v != null) referenced.add(v);
  }
  const entryRows = referenced.size
    ? await db.select({ id: s.eventEntries.id, entryNo: s.eventEntries.entryNo })
        .from(s.eventEntries).where(inArray(s.eventEntries.id, [...referenced]))
    : [];
  const noById = new Map<number, string>(entryRows.map((r: any) => [r.id, r.entryNo]));

  const indexById = new Map<number, number>(rows.map((r: any) => [r.id, Number(String(r.matchNo).split('-').pop())]));

  const matches: NormalisedMatch[] = rows.map((r: any) => ({
    index: indexById.get(r.id)!,
    round: r.round,
    roundOrder: r.roundOrder,
    poolLabel: r.poolLabel ?? null,
    red: r.redEntryId == null ? null : noById.get(r.redEntryId) ?? null,
    blue: r.blueEntryId == null ? null : noById.get(r.blueEntryId) ?? null,
    winner: r.winnerEntryId == null ? null : noById.get(r.winnerEntryId) ?? null,
    status: r.status,
    advancesToIndex: r.advancesToMatchId == null ? null : indexById.get(r.advancesToMatchId) ?? null,
    advancesToSlot: r.advancesToSlot ?? null,
  }));
  matches.sort((a, b) => a.index - b.index);

  return { draw, matches };
}

export interface ReproductionResult {
  reproducible: boolean;
  algorithmVersion: string;
  currentAlgorithmVersion: string;
  /** Departures from the draw AS IT WAS MADE. Every line here is a defect. */
  differences: string[];
  /**
   * Changes the COMPETITION made: a slot the draw left open now filled by
   * progression, a winner recorded on a bout that was drawn blank. These are
   * not draw defects, and listing them as differences would make every event
   * that has actually been run report as unreproducible — which is exactly when
   * someone asks.
   */
  resultsSince: string[];
  /**
   * Does `seedInput` still match the digest the audit spine recorded when the
   * draw was generated? `null` when no digest was recorded, which this build
   * always does — so `null` on a current-version draw means the audit record is
   * missing, and that is reported as a difference rather than passed over.
   */
  recordIntact: boolean | null;
  recomputed: NormalisedMatch[] | null;
}

/**
 * Re-run the draw from its own record and compare.
 *
 * This is the function that answers the accusation. It re-reads NOTHING from
 * the entry table: the ordered entry list, the seed, the format and the pool
 * structure all come from the stored draw, so a later withdrawal cannot change
 * the answer.
 *
 * TWO KINDS OF CHANGE, and conflating them is the trap. A finished competition
 * has winners recorded and later-round slots filled by progression — none of
 * which the draw decided. Those go in `resultsSince`. Only a departure from
 * what the draw itself fixed — the bracket shape, the wiring, the round-one
 * placement, and the byes the draw awarded — is a difference.
 *
 * It fails closed. A draw stamped with a different algorithm version reports
 * NOT reproducible by this build, rather than being re-planned under today's
 * rules and declared to match.
 */
export async function verifyDrawReproducible(
  db: DB,
  drawId: number,
  viewer: Principal | null = null
): Promise<ReproductionResult> {
  const { draw, matches } = await readDraw(db, drawId, viewer);
  const base = {
    algorithmVersion: draw.algorithmVersion,
    currentAlgorithmVersion: ALGORITHM_VERSION,
    resultsSince: [] as string[],
    recordIntact: null as boolean | null,
  };

  if (draw.algorithmVersion !== ALGORITHM_VERSION) {
    return {
      ...base, reproducible: false, recomputed: null,
      differences: [
        `This draw was generated by algorithm ${draw.algorithmVersion}; this build implements ${ALGORITHM_VERSION}. ` +
        'It cannot be reproduced here, and this build will not claim otherwise.',
      ],
    };
  }

  const stored = draw.seedInput as any;
  if (!stored?.entries || !draw.randomSeed) {
    return {
      ...base, reproducible: false, recomputed: null,
      differences: ['The draw record does not carry the seed and entry list needed to recompute it.'],
    };
  }

  const differences: string[] = [];
  const resultsSince: string[] = [];

  // Is the record we are about to recompute from the record that was made?
  // Recomputing from a forged `seedInput` would reproduce a forged bracket
  // perfectly, so the digest written to the audit spine at generation is
  // checked first — a forger has to reach two tables, not one.
  const generation = await db.select().from(s.auditEvents)
    .where(and(
      eq(s.auditEvents.entityType, 'draw'),
      eq(s.auditEvents.entityId, String(drawId)),
      eq(s.auditEvents.action, 'create')
    ))
    .orderBy(desc(s.auditEvents.id)).limit(1);
  const recordedDigest = (generation[0]?.newValue as any)?.seedInputDigest ?? null;
  let recordIntact: boolean | null = null;
  if (recordedDigest) {
    recordIntact = seedInputDigest(stored) === recordedDigest;
    if (!recordIntact) {
      differences.push(
        'The stored seed input no longer matches the digest recorded in the audit spine when this draw was ' +
        'generated. The record this draw would be recomputed from has been altered since generation.'
      );
    }
  } else {
    differences.push(
      `No generation audit record carrying a seed-input digest was found for draw ${drawId}. The draw record ` +
      'cannot be attested against the audit spine, so this build does not certify it.'
    );
  }

  let recomputed: NormalisedMatch[];
  try {
    recomputed = normalisePlan(planDraw({
      entries: stored.entries,
      format: stored.format ?? draw.format,
      seed: draw.randomSeed,
      pools: stored.pools ?? null,
    }));
  } catch (err: any) {
    return {
      ...base, recordIntact, resultsSince, reproducible: false, recomputed: null,
      differences: [...differences, `Recomputation failed: ${err?.message ?? String(err)}`],
    };
  }

  if (recomputed.length !== matches.length) {
    differences.push(`Stored draw has ${matches.length} bout(s); recomputation produced ${recomputed.length}.`);
  }
  const recomputedIndexes = new Set(recomputed.map((r) => r.index));
  for (const m of matches) {
    if (!recomputedIndexes.has(m.index)) {
      differences.push(`Bout ${m.index} is in the stored draw but is not produced by recomputation.`);
    }
  }

  for (const r of recomputed) {
    const found = matches.find((m) => m.index === r.index);
    if (!found) { differences.push(`Bout ${r.index} is missing from the stored draw.`); continue; }

    // Shape and wiring: fixed by the draw, and nothing that happens on the mat
    // may move them.
    for (const key of ['round', 'roundOrder', 'poolLabel', 'advancesToIndex', 'advancesToSlot'] as const) {
      if (found[key] !== r[key]) {
        differences.push(`Bout ${r.index}: stored ${key}=${JSON.stringify(found[key])}, recomputed ${JSON.stringify(r[key])}.`);
      }
    }

    for (const side of ['red', 'blue'] as const) {
      if (r[side] == null) {
        // The draw left this slot to be filled by the winner of an earlier
        // bout. An occupant is therefore a result, not a discrepancy.
        if (found[side] != null) {
          resultsSince.push(`Bout ${r.index}: the ${side} slot, left open by the draw, now holds ${found[side]} — filled by progression.`);
        }
        continue;
      }
      if (found[side] !== r[side]) {
        differences.push(`Bout ${r.index}: stored ${side}=${JSON.stringify(found[side])}, recomputed ${JSON.stringify(r[side])}.`);
      }
    }

    if (r.winner != null) {
      // The draw awarded this bout itself — a bye. Losing or moving it is a
      // change to the draw, not a result.
      if (found.winner !== r.winner) {
        differences.push(
          `Bout ${r.index}: the draw awarded this bout to ${r.winner} as a bye; the record shows ` +
          `${JSON.stringify(found.winner)} (status ${found.status}).`
        );
      }
    } else if (found.winner != null) {
      resultsSince.push(`Bout ${r.index}: a result has been recorded — winner ${found.winner}, status ${found.status}.`);
    }
  }

  return {
    algorithmVersion: draw.algorithmVersion,
    currentAlgorithmVersion: ALGORITHM_VERSION,
    recordIntact,
    reproducible: differences.length === 0,
    differences,
    resultsSince,
    recomputed,
  };
}
