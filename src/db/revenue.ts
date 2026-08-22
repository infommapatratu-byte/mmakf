// Revenue classification — what the federation earned, and what it earned it FROM.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE RULE THIS MODULE IS THE REPORTING HALF OF
// ═══════════════════════════════════════════════════════════════════════════
//
// A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT. They pay for
// TRAINING. src/data/proposed-fees.ts deleted MEM-JUNIOR and MEM-ATHLETE so the
// commercial engine lost the ABILITY to generate them.
//
// That correction survives in the rulebook and dies in the report if a student's
// training payment is counted under MEMBERSHIP REVENUE. The federation reads the
// numbers, not the source tree. A "student membership revenue" line on a finance
// page re-creates the category in the only place that matters commercially, and
// the next fee framework gets drafted against it.
//
// So there is no such category HERE, and it is not merely absent — it is
// unrepresentable. `RevenueCategory` is a closed union with no student
// membership in it, and no code path can widen it. STUDENT TRAINING APPEARS
// UNDER `training`. A membership figure on this page is coaches, officials,
// examiners and clubs, and nothing else.
//
// ═══════════════════════════════════════════════════════════════════════════
// AND THE ONE THING THAT IS *NOT* SUPPRESSED
// ═══════════════════════════════════════════════════════════════════════════
//
// Rule 3: HISTORICAL RECORDS ARE NEVER REWRITTEN. If a ledger entry genuinely
// records a student membership charge taken before the rule changed, that money
// was received and the accounts must add up. Hiding it would falsify the ledger
// exactly as surely as editing it would.
//
// It therefore appears — on its OWN line, `historical_withdrawn`, whose label
// says THE RULE CHANGED rather than naming a category that still exists:
//
//     "Student membership — charge withdrawn 17 August 2026"
//
// A reader learns two things at once: that the money is in the accounts, and
// that nothing can produce more of it. What they cannot do is read it as a
// live product line, because it is not filed under one.
//
// ═══════════════════════════════════════════════════════════════════════════
// EVERY FIGURE DERIVES FROM A LEDGER ENTRY JOINED TO WHAT IT WAS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Not from a category typed onto an invoice, which drifts the moment somebody
// re-labels a product. Not from `orders.notes`. The chain is:
//
//   ledger_entries (credit, account like 'income.%')
//     └─ order_line_id  ──▶ order_lines
//                             ├─ seller_id        ──▶ a marketplace sale
//                             ├─ variant_id       ──▶ the shop
//                             ├─ ref_type/ref_id  ──▶ quotation | booking | entry
//                             └─ fee_code         ──▶ fee_catalogue_entries
//                                                     entitlement_terms
//
// and at the end of each branch is a record the FEDERATION wrote — a service's
// category, an institution's kind, an event's kind, a fee catalogue entry's
// audience. Never a string match on a fee code, which would be this module
// setting the federation's taxonomy by regular expression.
//
// `ledger_entries.order_line_id` is new (migration 0044). Before it, a ledger
// entry could be joined to the ORDER but not to the LINE, so an order carrying
// a gi and a grading fee could not be split at all. Rows written before it exists
// carry NULL and are resolved by matching the account suffix back to the order's
// lines — which is exact when the order has one line of that kind and AMBIGUOUS
// when it has several. Ambiguous is reported as ambiguous. It is not guessed.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE REFUSES TO DO
// ═══════════════════════════════════════════════════════════════════════════
//
// It never invents an amount, and it never invents a category. Where the join
// runs out — a fee code no catalogue entry covers, a quotation whose rules name
// no service, a booking kind the twelve categories have no term for — the money
// lands on `unattributed` WITH THE REASON, and the reason names the vocabulary
// value that could not be mapped. A treasurer then knows which record to fix.
// Silently folding it into 'other' would make the gap invisible, and a figure
// nobody can defend is worse than a figure that is missing.
//
// Today every figure is zero, because no payment has ever been captured. That
// is a real measurement of an empty system, not a placeholder — financeState()
// below counts the things that would have to exist first, so the page can say
// which one is missing rather than showing zeros with no explanation.

import { and, eq, gte, inArray, like, lte, ne, sql } from 'drizzle-orm';
import * as s from './schema';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { federationToday } from './orders';
import { STUDENT_MEMBERSHIP_CATEGORIES } from './student-rule';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

// ─── The vocabulary ─────────────────────────────────────────────────────────

/**
 * What was SOLD. Twelve categories, and a closed union on purpose.
 *
 * There is no 'student_membership' and no 'other'. The first is the rule; the
 * second is the discipline that keeps the first honest — an 'other' bucket is
 * where a misclassification goes to stop being noticed, so unmappable money
 * goes to `unattributed` with a reason instead, which is a defect report rather
 * than a category.
 */
export type RevenueCategory =
  | 'training'
  | 'grading'
  | 'competition'
  | 'membership'
  | 'affiliation'
  | 'course'
  | 'facility'
  | 'event'
  | 'merchandise'
  | 'marketplace'
  | 'corporate'
  | 'school';

/** The historical line. NOT a category — see the header. */
export const HISTORICAL_WITHDRAWN = 'historical_withdrawn' as const;
/** Money the join could not attribute. NOT a category either. */
export const UNATTRIBUTED = 'unattributed' as const;

export type RevenueKey =
  | RevenueCategory
  | typeof HISTORICAL_WITHDRAWN
  | typeof UNATTRIBUTED;

export interface RevenueCategoryMeta {
  key: RevenueKey;
  label: string;
  /** What was actually sold to produce money on this line. */
  sells: string;
}

/**
 * The twelve, in the order a treasurer reads them: what the federation
 * DELIVERS first, then what it ADMINISTERS, then what it SELLS.
 */
export const REVENUE_CATEGORIES: readonly RevenueCategoryMeta[] = [
  {
    key: 'training',
    label: 'Training',
    sells:
      'Training delivered to people who train — classes, personal coaching, ' +
      'programmes. A STUDENT’S PAYMENTS APPEAR HERE. They are never membership: ' +
      'a student pays for training and for nothing else.',
  },
  {
    key: 'school',
    label: 'School programmes',
    sells: 'Training contracted by a school or university, quoted and invoiced to the institution.',
  },
  {
    key: 'corporate',
    label: 'Corporate and government programmes',
    sells: 'Training contracted by a company, government body or NGO.',
  },
  {
    key: 'grading',
    label: 'Grading',
    sells: 'Examination fees — kyu and Dan gradings, and the assessments that carry them.',
  },
  {
    key: 'competition',
    label: 'Competition',
    sells: 'Entries to championships, trials and leagues.',
  },
  {
    key: 'event',
    label: 'Events',
    sells: 'Seminars, camps and courses run as events rather than as competition.',
  },
  {
    key: 'course',
    label: 'Academy courses',
    sells: 'Enrolments in the education academy — coaching, refereeing and technical courses.',
  },
  {
    key: 'membership',
    label: 'Membership',
    sells:
      'Coaches, instructors, officials, examiners and clubs — people and bodies that ACT ' +
      'for the federation. No student appears on this line; there is no student membership.',
  },
  {
    key: 'affiliation',
    label: 'Affiliation',
    sells: 'Dojo, club and unit affiliation and renewal.',
  },
  {
    key: 'facility',
    label: 'Facility hire',
    sells: 'Hire of a venue or a dojo floor, without training attached.',
  },
  {
    key: 'merchandise',
    label: 'Merchandise',
    sells: 'Goods the federation sells from its own shop — gi, belts, protectors, badges.',
  },
  {
    key: 'marketplace',
    label: 'Marketplace',
    sells:
      'Goods sold by a third-party seller through the federation’s marketplace. ' +
      'The gross is the seller’s sale; the federation’s share is a commission and is settled separately.',
  },
];

/**
 * The two lines that are not categories, with the wording that keeps them from
 * being read as ones.
 *
 * The historical label says the RULE CHANGED. "Student membership revenue"
 * would imply the category still exists and merely happens to be empty this
 * quarter, which is exactly the reading the federation's correction forbids.
 */
export const NON_CATEGORY_LINES: readonly RevenueCategoryMeta[] = [
  {
    key: HISTORICAL_WITHDRAWN,
    label: 'Student membership — charge withdrawn 17 August 2026',
    sells:
      'A charge taken BEFORE the federation withdrew student membership. The ledger is not ' +
      'rewritten, so it stays in the accounts and is shown here rather than folded into ' +
      'membership. Nothing in the system can produce another: the rules that priced it were ' +
      'deleted, not disabled.',
  },
  {
    key: UNATTRIBUTED,
    label: 'Not attributable',
    sells:
      'Money whose ledger entry could not be joined to a record saying what it was for. ' +
      'Each carries the reason. This line is a defect report, not a category — a figure ' +
      'here means a record needs correcting, and it must not be reported as revenue from ' +
      'anything until it is.',
  },
];

const LABELS: Record<RevenueKey, string> = Object.fromEntries(
  [...REVENUE_CATEGORIES, ...NON_CATEGORY_LINES].map((c) => [c.key, c.label])
) as Record<RevenueKey, string>;

export const labelFor = (key: RevenueKey): string => LABELS[key] ?? key;

/**
 * A guarantee written as code rather than as a comment.
 *
 * Called by tests/revenue.test.ts and by nothing else. If a future edit adds a
 * student membership category back — under any of the names it has been known
 * by — this throws, and it throws at the point somebody would otherwise be
 * congratulating themselves on a tidy taxonomy.
 */
export function assertNoStudentMembershipCategory(): void {
  const banned = /student|junior|athlete[_ -]?member|pupil|learner|trainee[_ -]?member/i;
  for (const c of REVENUE_CATEGORIES) {
    if (banned.test(c.key) || banned.test(c.label)) {
      throw new Error(
        `Revenue category "${c.key}" reads as a student membership. A student pays for ` +
        'TRAINING; there is no student membership to report. Student payments belong under ' +
        '"training". See src/data/proposed-fees.ts.'
      );
    }
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class RevenueError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RevenueError';
    this.code = code;
  }
}

/** Identity by shape, not `instanceof` — the convention this codebase uses. */
export function isRevenueError(err: unknown): err is RevenueError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'RevenueError';
}

// ─── Ledger vocabulary ──────────────────────────────────────────────────────

/**
 * `postLedger()` in src/db/orders.ts writes one credit per order line, to
 * `income.<order_line_kind>`, plus one debit to `income.refunds` when a refund
 * completes. Those two strings are the whole contract this module reads, and
 * they are named here rather than spelled out at three call sites.
 */
const INCOME_PREFIX = 'income.';
const REFUND_ACCOUNT = 'income.refunds';

/** `income.membership` → `membership`. Null for anything that is not income. */
export function kindFromAccount(account: string): string | null {
  if (!account.startsWith(INCOME_PREFIX)) return null;
  if (account === REFUND_ACCOUNT) return null;
  return account.slice(INCOME_PREFIX.length) || null;
}

// ─── Attribution ────────────────────────────────────────────────────────────

export interface LineAttribution {
  orderLineId: number;
  key: RevenueKey;
  /** Which record decided it, in words a treasurer can check against the screen. */
  basis: string;
  /**
   * The TABLE the decision came from, so a reader can tell a strong derivation
   * from a weak one at a glance: a service's own category is a stronger answer
   * than the order line's kind, and both are stronger than nothing.
   */
  derivedFrom:
    | 'order_lines.seller_id'
    | 'product_variants'
    | 'services'
    | 'institutions'
    | 'bookings'
    | 'competition_events'
    | 'entitlement_terms'
    | 'fee_catalogue_entries'
    | 'order_lines.kind'
    | 'none';
  /**
   * WHERE ONE LINE PAID FOR SEVERAL THINGS.
   *
   * A quotation is a single order line and can price training, equipment and
   * assessment at once. `key` above is then the largest share — what the line
   * mostly was — and this is the full breakdown, with the quotation's own line
   * amounts as weights. revenueReport() splits the money by it, so a school
   * contract that was 80% training and 20% assessment appears as both.
   *
   * Absent, or a single element, whenever the line paid for one thing. Weights
   * are relative and only their ratios are used.
   */
  split?: Array<{ key: RevenueKey; weight: number }>;
}

/** The order-line columns attribution reads. Nothing else is consulted. */
export interface AttributableLine {
  id: number;
  orderId: number;
  kind: string;
  feeCode: string | null;
  refType: string | null;
  refId: number | null;
  sellerId: number | null;
  variantId: number | null;
  totalPaise: number;
  description: string;
}

/**
 * The audiences that mean "this person receives training from the federation".
 *
 * A membership charge against one of these is a STUDENT MEMBERSHIP, which the
 * federation withdrew. It cannot be created any more; where a historical record
 * carries one it goes to the historical line.
 *
 * `member` and `any` are deliberately absent. They are ambiguous, and reading
 * an ambiguous audience as "student" would move a coach's fee onto a line that
 * says the rule changed — a quieter error than the one this list prevents, but
 * an error in the accounts all the same.
 */
const STUDENT_AUDIENCES = new Set(['athlete', 'junior']);

// The same question asked of the membership register's own vocabulary lives in
// src/db/student-rule.ts and is IMPORTED rather than restated. It used to be a
// private copy here, and a private copy was how this file came to report that an
// athlete membership "cannot be created any more" while configureTerm() would
// still record one and renew() would still issue it. The set that decides the
// refusal and the set that writes the caption have to be the same object.

/** Institution kinds that make a training programme a SCHOOL programme. */
const SCHOOL_KINDS = new Set(['school', 'university']);
/** …and a CORPORATE one. */
const CORPORATE_KINDS = new Set(['corporate', 'government', 'ngo']);

/**
 * `services.category` → a revenue category, for the audience-independent cases.
 * 'training' is absent because it is the one that depends on WHO bought it.
 */
const CATEGORY_BY_SERVICE: Record<string, RevenueCategory | undefined> = {
  education: 'course',
  competition: 'competition',
  grading: 'grading',
  event: 'event',
};

/** `event_kind` → competition or event. A seminar is not a championship. */
const CATEGORY_BY_EVENT_KIND: Record<string, RevenueCategory | undefined> = {
  national_championship: 'competition',
  open_national: 'competition',
  state_championship: 'competition',
  district_championship: 'competition',
  selection_trial: 'competition',
  seminar: 'event',
  camp: 'event',
  grading: 'grading',
  technical_course: 'course',
  referee_course: 'course',
};

/** `booking_kind` → a revenue category. */
const CATEGORY_BY_BOOKING_KIND: Record<string, RevenueCategory | undefined> = {
  class: 'training',
  personal_coaching: 'training',
  institutional_session: 'training',
  seminar: 'event',
  assessment: 'grading',
};

/** `fee_service_category` → a revenue category, where the two vocabularies agree. */
const CATEGORY_BY_FEE_CATEGORY: Record<string, RevenueCategory | undefined> = {
  membership: 'membership',
  affiliation: 'affiliation',
  grading: 'grading',
  competition: 'competition',
  education: 'course',
  training: 'training',
};

/**
 * The last resort: the order line's own kind.
 *
 * Weakest of the derivations and deliberately incomplete. 'other', 'donation'
 * and 'certificate' are absent — 'other' says nothing at all, a donation is not
 * revenue from a service, and a certificate fee is a document charge that none
 * of the twelve covers. Each falls through to `unattributed` with its reason.
 */
const CATEGORY_BY_LINE_KIND: Record<string, RevenueCategory | undefined> = {
  product: 'merchandise',
  // A STUDENT'S OWN TRAINING (order_line_kind 'training', migration 0045). It
  // maps here and nowhere near membership, which is the whole federation rule
  // expressed as one line of a lookup table: a student buys training, and the
  // report says training.
  training: 'training',
  membership: 'membership',
  affiliation: 'affiliation',
  event_entry: 'competition',
  grading: 'grading',
  course: 'course',
  program: 'training',
};

/** refTypes that name a facility hire rather than a delivery. */
const FACILITY_REF_TYPES = new Set(['venue', 'facility', 'venue_hire', 'facility_hire']);

const unique = <T>(xs: T[]): T[] => Array.from(new Set(xs));

/**
 * Attribute a batch of order lines to revenue categories.
 *
 * BATCHED, not per-line, because a year of ledger entries is thousands of rows
 * and a per-line resolver would issue a query per join hop per row. Every
 * lookup below is one `IN (...)` per table.
 *
 * No authority check here: this is a pure resolver over rows the caller has
 * already been permitted to read. `revenueReport()` is the gate.
 */
export async function attributeLines(
  db: DB,
  lines: AttributableLine[]
): Promise<Map<number, LineAttribution>> {
  const out = new Map<number, LineAttribution>();
  if (!lines.length) return out;

  // ── Load every referenced record, one query per table ─────────────────────

  const feeCodes = unique(lines.map((l) => l.feeCode).filter((c): c is string => Boolean(c)));

  const catalogueByCode = new Map<string, any>();
  const termsByCode = new Map<string, any>();
  if (feeCodes.length) {
    for (const row of await db.select().from(s.feeCatalogueEntries)
      .where(inArray(s.feeCatalogueEntries.code, feeCodes))) {
      catalogueByCode.set(row.code, row);
    }
    for (const row of await db.select().from(s.entitlementTerms)
      .where(inArray(s.entitlementTerms.feeCode, feeCodes))) {
      termsByCode.set(row.feeCode, row);
    }
  }

  const refIds = (types: string[]) =>
    unique(
      lines
        .filter((l) => l.refType && types.includes(l.refType) && Number.isInteger(l.refId))
        .map((l) => l.refId as number)
    );

  // Quotations — the institutional training path. The order line is 'other'
  // and says nothing; the quotation says everything.
  const quoteVersionIds = refIds(['quote_version']);
  const quoteVersionById = new Map<number, any>();
  const institutionByQuoteVersion = new Map<number, any>();
  const serviceCategoriesByQuoteVersion = new Map<number, Map<string, number>>();
  if (quoteVersionIds.length) {
    const versions = await db.select().from(s.quoteVersions)
      .where(inArray(s.quoteVersions.id, quoteVersionIds));
    for (const v of versions) quoteVersionById.set(v.id, v);

    const quoteIds = unique(versions.map((v: any) => v.quoteId)) as number[];
    const quotes = quoteIds.length
      ? await db.select().from(s.quotes).where(inArray(s.quotes.id, quoteIds))
      : [];
    const quoteById = new Map<number, any>(quotes.map((q: any) => [q.id, q]));

    const institutionIds = unique(
      quotes.map((q: any) => q.institutionId).filter((i: any) => Number.isInteger(i))
    ) as number[];
    const institutions = institutionIds.length
      ? await db.select().from(s.institutions).where(inArray(s.institutions.id, institutionIds))
      : [];
    const institutionById = new Map<number, any>(institutions.map((i: any) => [i.id, i]));

    for (const v of versions) {
      const q = quoteById.get(v.quoteId);
      const inst = q?.institutionId != null ? institutionById.get(q.institutionId) : null;
      if (inst) institutionByQuoteVersion.set(v.id, inst);
    }

    // What the quotation actually priced, by weight. A quotation is one order
    // line but can span several services, and splitting it by the amounts its
    // own lines carry is the only reading that keeps the parts summing to the
    // whole. `sourceKind` is checked so a hardship concession — a negative line
    // that priced no service — does not become a negative weight.
    const qLines = await db.select().from(s.quoteLines)
      .where(inArray(s.quoteLines.quoteVersionId, quoteVersionIds));
    const ruleIds = unique(
      qLines.map((l: any) => l.ruleId).filter((i: any) => Number.isInteger(i))
    ) as number[];
    const rules = ruleIds.length
      ? await db.select().from(s.feeRules).where(inArray(s.feeRules.id, ruleIds))
      : [];
    const ruleById = new Map<number, any>(rules.map((r: any) => [r.id, r]));
    const serviceIds = unique(
      rules.map((r: any) => r.serviceId).filter((i: any) => Number.isInteger(i))
    ) as number[];
    const servicesRows = serviceIds.length
      ? await db.select().from(s.services).where(inArray(s.services.id, serviceIds))
      : [];
    const serviceById = new Map<number, any>(servicesRows.map((x: any) => [x.id, x]));

    for (const l of qLines) {
      if (l.sourceKind && l.sourceKind !== 'fee_rule') continue;
      if (!Number.isInteger(l.amountMinor) || l.amountMinor <= 0) continue;
      const rule = l.ruleId != null ? ruleById.get(l.ruleId) : null;
      const svc = rule?.serviceId != null ? serviceById.get(rule.serviceId) : null;
      if (!svc) continue;
      let byCat = serviceCategoriesByQuoteVersion.get(l.quoteVersionId);
      if (!byCat) {
        byCat = new Map<string, number>();
        serviceCategoriesByQuoteVersion.set(l.quoteVersionId, byCat);
      }
      byCat.set(svc.category, (byCat.get(svc.category) ?? 0) + l.amountMinor);
    }
  }

  // Bookings.
  const bookingIds = refIds(['booking']);
  const bookingById = new Map<number, any>();
  const institutionByBooking = new Map<number, any>();
  if (bookingIds.length) {
    const rows = await db.select().from(s.bookings).where(inArray(s.bookings.id, bookingIds));
    for (const b of rows) bookingById.set(b.id, b);
    const instIds = unique(
      rows.map((b: any) => b.institutionId).filter((i: any) => Number.isInteger(i))
    ) as number[];
    if (instIds.length) {
      for (const i of await db.select().from(s.institutions)
        .where(inArray(s.institutions.id, instIds))) {
        institutionByBooking.set(i.id, i);
      }
    }
  }

  // Competition entries.
  const entryIds = refIds(['event_entry', 'entry']);
  const eventByEntry = new Map<number, any>();
  if (entryIds.length) {
    const entries = await db.select().from(s.eventEntries)
      .where(inArray(s.eventEntries.id, entryIds));
    const eventIds = unique(entries.map((e: any) => e.eventId)) as number[];
    const events = eventIds.length
      ? await db.select().from(s.competitionEvents).where(inArray(s.competitionEvents.id, eventIds))
      : [];
    const eventById = new Map<number, any>(events.map((e: any) => [e.id, e]));
    for (const e of entries) {
      const ev = eventById.get(e.eventId);
      if (ev) eventByEntry.set(e.id, ev);
    }
  }

  // ── Decide, one line at a time, in order of the strongest available record ──

  for (const line of lines) {
    out.set(line.id, decideLine(line, {
      catalogueByCode,
      termsByCode,
      quoteVersionById,
      institutionByQuoteVersion,
      serviceCategoriesByQuoteVersion,
      bookingById,
      institutionByBooking,
      eventByEntry,
    }));
  }

  return out;
}

interface AttributionRecords {
  catalogueByCode: Map<string, any>;
  termsByCode: Map<string, any>;
  quoteVersionById: Map<number, any>;
  institutionByQuoteVersion: Map<number, any>;
  serviceCategoriesByQuoteVersion: Map<number, Map<string, number>>;
  bookingById: Map<number, any>;
  institutionByBooking: Map<number, any>;
  eventByEntry: Map<number, any>;
}

/** Training, narrowed by WHO bought it. This is where school and corporate come from. */
function trainingFor(institution: any | null): { key: RevenueCategory; who: string } {
  if (!institution) return { key: 'training', who: 'no institution — training sold to a person' };
  if (SCHOOL_KINDS.has(institution.kind)) {
    return { key: 'school', who: `${institution.name} is recorded as a ${institution.kind}` };
  }
  if (CORPORATE_KINDS.has(institution.kind)) {
    return { key: 'corporate', who: `${institution.name} is recorded as ${institution.kind}` };
  }
  return { key: 'training', who: `${institution.name} is recorded as ${institution.kind}` };
}

function decideLine(line: AttributableLine, r: AttributionRecords): LineAttribution {
  const at = (
    key: RevenueKey,
    basis: string,
    derivedFrom: LineAttribution['derivedFrom'],
    split?: Array<{ key: RevenueKey; weight: number }>
  ): LineAttribution => ({ orderLineId: line.id, key, basis, derivedFrom, split });

  // 1. A marketplace sale, before anything else. The seller sold it; the
  //    federation ran the stall. Reading it as merchandise would report another
  //    business's turnover as the federation's own.
  if (Number.isInteger(line.sellerId)) {
    return at(
      'marketplace',
      'The line belongs to a third-party seller order. The gross is the seller’s sale; the federation’s commission is settled separately.',
      'order_lines.seller_id'
    );
  }

  // 2. A facility hire, where a refType says so. No flow produces one yet —
  //    the category exists because the federation hires floors, and a category
  //    added later is a category nobody backfills.
  if (line.refType && FACILITY_REF_TYPES.has(line.refType)) {
    return at('facility', `The line references a ${line.refType}, which is hire and not delivery.`, 'order_lines.kind');
  }

  // 3. The shop.
  if (Number.isInteger(line.variantId)) {
    return at('merchandise', 'The line names a product variant from the federation’s own catalogue.', 'product_variants');
  }

  // 4. A quotation. The order line is 'other' and says nothing useful; the
  //    quotation names the services and the buyer.
  if (line.refType === 'quote_version' && Number.isInteger(line.refId)) {
    const version = r.quoteVersionById.get(line.refId as number);
    if (!version) {
      return at(
        UNATTRIBUTED,
        `The line references quotation version ${line.refId}, which no longer exists. Nothing says what was sold.`,
        'none'
      );
    }
    const institution = r.institutionByQuoteVersion.get(version.id) ?? null;
    const byCat = r.serviceCategoriesByQuoteVersion.get(version.id);
    if (!byCat || byCat.size === 0) {
      return at(
        UNATTRIBUTED,
        'The quotation’s priced rules name no service, so there is no record of what was sold. ' +
        'Set a service on the fee rules in the framework and this figure attributes itself.',
        'none'
      );
    }
    // What the quotation priced, by the amounts it carries itself. A service
    // category this vocabulary has no term for becomes `unattributed` for ITS
    // SHARE ONLY — the training in the same contract is still training, and
    // discarding the whole contract because one component is unmapped would
    // lose more truth than it protects.
    const training = trainingFor(institution);
    const ranked = [...byCat.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const split: Array<{ key: RevenueKey; weight: number; category: string }> =
      ranked.map(([category, weight]) => ({
        key: category === 'training'
          ? (training.key as RevenueKey)
          : (CATEGORY_BY_SERVICE[category] ?? UNATTRIBUTED),
        weight,
        category,
      }));

    const unmapped = split.filter((p) => p.key === UNATTRIBUTED).map((p) => p.category);
    const [topCategory] = ranked[0];
    const others = ranked.slice(1).map(([c]) => c);
    const mixed = others.length
      ? ` The quotation also priced ${others.join(', ')}; the figure is split between them by the quotation’s own line amounts.`
      : '';
    const unmappedNote = unmapped.length
      ? ` The share priced as ${unmapped.join(', ')} is reported as not attributable: none of the twelve revenue ` +
        'categories covers it, and the federation has to say where it belongs rather than this report guessing.'
      : '';

    const collapsed = split.map(({ key, weight }) => ({ key, weight }));
    const top = collapsed[0].key;

    if (topCategory === 'training') {
      return at(
        top,
        `The quotation priced training and ${training.who}.${mixed}${unmappedNote}`,
        institution ? 'institutions' : 'services',
        collapsed
      );
    }
    if (top !== UNATTRIBUTED) {
      return at(top, `The quotation priced a service recorded as ${topCategory}.${mixed}${unmappedNote}`, 'services', collapsed);
    }
    return at(
      UNATTRIBUTED,
      `The quotation priced a service recorded as "${topCategory}", which none of the twelve revenue categories covers. ` +
      `The service’s category or this vocabulary needs a decision — not a guess.${mixed}`,
      'none',
      collapsed
    );
  }

  // 5. A booking.
  if (line.refType === 'booking' && Number.isInteger(line.refId)) {
    const booking = r.bookingById.get(line.refId as number);
    if (!booking) {
      return at(UNATTRIBUTED, `The line references booking ${line.refId}, which no longer exists.`, 'none');
    }
    const mapped = CATEGORY_BY_BOOKING_KIND[booking.kind];
    if (mapped === 'training') {
      const institution = booking.institutionId != null
        ? r.institutionByBooking.get(booking.institutionId) ?? null
        : null;
      const t = trainingFor(institution);
      return at(t.key, `A ${booking.kind} booking, and ${t.who}.`, institution ? 'institutions' : 'bookings');
    }
    if (mapped) return at(mapped, `The booking is recorded as a ${booking.kind}.`, 'bookings');
    return at(
      UNATTRIBUTED,
      `The booking is recorded as "${booking.kind}", which none of the twelve revenue categories covers.`,
      'none'
    );
  }

  // 6. A competition entry — championship or seminar, and the EVENT decides.
  if ((line.refType === 'event_entry' || line.refType === 'entry') && Number.isInteger(line.refId)) {
    const event = r.eventByEntry.get(line.refId as number);
    if (event) {
      const mapped = CATEGORY_BY_EVENT_KIND[event.kind];
      if (mapped) return at(mapped, `Entry to ${event.title}, recorded as a ${event.kind}.`, 'competition_events');
      return at(
        UNATTRIBUTED,
        `Entry to ${event.title}, recorded as "${event.kind}", which none of the twelve revenue categories covers.`,
        'none'
      );
    }
    // Falls through to the fee code and the line kind below.
  }

  // 7. A published fee. The federation's own catalogue says what it is FOR and
  //    WHO it is charged to, and both are needed: 'membership' plus an audience
  //    of 'athlete' is the withdrawn student charge, not membership revenue.
  if (line.feeCode) {
    const term = r.termsByCode.get(line.feeCode);
    const entry = r.catalogueByCode.get(line.feeCode);

    // The strongest statement available about a membership's audience is what
    // the federation recorded the fee ENTITLES the payer to.
    if (term?.subject === 'membership' && term.membershipCategory) {
      if (STUDENT_MEMBERSHIP_CATEGORIES.has(term.membershipCategory)) {
        return at(
          HISTORICAL_WITHDRAWN,
          `Fee ${line.feeCode} was recorded as issuing an ${term.membershipCategory} membership — a student membership, ` +
          'withdrawn on 17 August 2026. The charge stays in the accounts; nothing can create another.',
          'entitlement_terms'
        );
      }
      return at(
        'membership',
        `Fee ${line.feeCode} issues a ${term.membershipCategory} membership — a person or body that acts for the federation.`,
        'entitlement_terms'
      );
    }

    if (entry) {
      if (entry.category === 'membership' && STUDENT_AUDIENCES.has(entry.audience)) {
        return at(
          HISTORICAL_WITHDRAWN,
          `Catalogue entry ${entry.code} charges a membership to a ${entry.audience} — a student membership, ` +
          'withdrawn on 17 August 2026. It is shown because the ledger is not rewritten.',
          'fee_catalogue_entries'
        );
      }
      if (entry.category === 'training') {
        // A training fee charged to a student IS training revenue. This is the
        // reporting half of the federation's rule, and it is the single most
        // important line in this file.
        return at(
          'training',
          `Catalogue entry ${entry.code} is a training charge to a ${entry.audience}. Training, never membership.`,
          'fee_catalogue_entries'
        );
      }
      const mapped = CATEGORY_BY_FEE_CATEGORY[entry.category];
      if (mapped) {
        return at(mapped, `Catalogue entry ${entry.code} is recorded as ${entry.category}.`, 'fee_catalogue_entries');
      }
      return at(
        UNATTRIBUTED,
        `Catalogue entry ${entry.code} is recorded as "${entry.category}", which none of the twelve revenue categories covers. ` +
        '(“documents” is chargeable and is not one of the twelve — the federation has to say where it belongs.)',
        'none'
      );
    }
  }

  // 8. The order line's own kind — the weakest answer, and it is still a record
  //    the server wrote rather than a label a human typed.
  const byKind = CATEGORY_BY_LINE_KIND[line.kind];
  if (byKind) {
    return at(
      byKind,
      `No catalogue entry covers this line, so it is attributed by its kind: ${line.kind}.` +
      (line.kind === 'membership'
        ? ' No audience is recorded, so it is NOT reported as a student charge — that would need a record saying so.'
        : ''),
      'order_lines.kind'
    );
  }

  return at(
    UNATTRIBUTED,
    `A "${line.kind}" line with no variant, quotation, booking, entry or published fee behind it. ` +
    'Nothing in the records says what was sold.',
    'none'
  );
}

// ─── Allocation ─────────────────────────────────────────────────────────────

/**
 * Split `total` across `weights`, in whole paise, losing nothing.
 *
 * Used twice: to split a refund across the lines of the order it reverses, and
 * to split a quotation that priced several services. Both are ALLOCATIONS of a
 * real figure, not invented amounts — which is why the post-condition matters
 * more than the method: the parts sum to the whole, exactly, every time.
 *
 * Largest remainder, ties broken by index so the result is deterministic and a
 * report re-run produces the same figures. Naive rounding would leave a paisa
 * unaccounted for on most splits, and a finance page whose lines do not add up
 * to its total is a finance page nobody believes twice.
 *
 * A zero or negative weight sum allocates NOTHING. The caller reports the
 * residue rather than this function spreading money evenly over records that
 * did not earn it.
 */
export function allocate(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? Math.floor(w) : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return new Array(n).fill(0);

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(Math.round(total));

  const exact = safe.map((w) => (magnitude * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = magnitude - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  for (let k = 0; k < order.length && remainder > 0; k++) {
    floors[order[k].i] += 1;
    remainder -= 1;
  }
  return floors.map((v) => v * sign);
}

// ─── The state of the system, measured ──────────────────────────────────────

export interface FinanceState {
  /** Published fee frameworks. Zero means nothing can be priced at all. */
  publishedFrameworks: number;
  /** Active rows in the legacy fee schedule — the other way a line gets a price. */
  publishedFees: number;
  /** Payments this system marked `captured` after checking the provider's record. */
  capturedPayments: number;
  /** Orders that reached `paid`. */
  paidOrders: number;
  /** Rows in the double-entry ledger, of any account. */
  ledgerEntries: number;
}

/**
 * What exists, counted. Every number is a query.
 *
 * This is what lets a page of zeros say WHY it is zero. "No revenue yet" is a
 * statement about the world that could equally mean the report is broken; "no
 * fee framework has been published, so nothing can be priced, and no payment
 * has ever been captured" is a statement somebody can act on.
 */
export async function financeState(db: DB, principal: Principal | null): Promise<FinanceState> {
  assertCanAnywhere(principal, 'finance:read');

  const count = async (table: any, where?: any): Promise<number> => {
    const q = db.select({ c: sql<number>`count(*)::int` }).from(table);
    const rows = where ? await q.where(where) : await q;
    return Number(rows[0]?.c ?? 0);
  };

  return {
    publishedFrameworks: await count(s.feeFrameworks, eq(s.feeFrameworks.status, 'published')),
    publishedFees: await count(s.feeSchedule, eq(s.feeSchedule.active, true)),
    capturedPayments: await count(s.payments, eq(s.payments.status, 'captured')),
    paidOrders: await count(s.orders, inArray(s.orders.status, ['paid', 'fulfilled', 'partially_refunded', 'refunded'])),
    ledgerEntries: await count(s.ledgerEntries),
  };
}

/**
 * The sentences a page of zeros is entitled to print, derived from the counts.
 *
 * Ordered by what has to happen FIRST. An administrator reading this should be
 * able to start at the top and stop at the first line that is still true.
 */
export function whatWouldPopulateIt(state: FinanceState): string[] {
  const out: string[] = [];
  if (state.publishedFrameworks === 0) {
    out.push(
      'No fee framework is published. Until the federation publishes one, every price path ends at ' +
      '“the federation has not published a fee for this” — so nothing can be quoted, invoiced or charged.'
    );
  }
  if (state.publishedFees === 0) {
    out.push('The fee schedule holds no active row, so no membership, entry or grading fee can be charged either.');
  }
  if (state.capturedPayments === 0) {
    out.push('No payment has ever been captured. A payment counts only once this system has checked the provider’s own record.');
  } else if (state.paidOrders === 0) {
    out.push('Payments were captured but no order reached “paid”, which is money taken with nothing recorded against it — that needs a human.');
  }
  if (state.ledgerEntries === 0) {
    out.push('The ledger holds no entry. Every figure on this page is a sum over it, so every figure is zero.');
  }
  if (out.length === 0) {
    out.push('The ledger holds entries but none falls in the period selected.');
  }
  return out;
}

// ─── The report ─────────────────────────────────────────────────────────────

export interface RevenueLine {
  key: RevenueKey;
  label: string;
  /** Income credited to this category in the period. */
  grossPaise: number;
  /** Refunds debited against it, allocated across the order's lines. */
  refundedPaise: number;
  netPaise: number;
  /** Ledger entries counted into it. */
  entries: number;
  /** Distinct orders. */
  orders: number;
}

export interface UnattributedReason {
  reason: string;
  count: number;
  amountPaise: number;
}

export interface RevenueReport {
  from: string;
  to: string;
  lines: RevenueLine[];
  totals: {
    grossPaise: number;
    refundedPaise: number;
    netPaise: number;
    entries: number;
    orders: number;
  };
  /** True when the ledger produced nothing at all for this period. */
  empty: boolean;
  /** Measured, from financeState(). Only worth printing when `empty`. */
  state: FinanceState;
  whyEmpty: string[];
  /** Why money landed on `unattributed`, grouped. Each is a record to fix. */
  unattributedReasons: UnattributedReason[];
  /**
   * Refunds this period that could not be allocated to any income line —
   * because the order they reverse has no income entry in the ledger at all.
   * Subtracted from the total and shown, never silently dropped.
   */
  unallocatedRefundsPaise: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today in the federation's own timezone — a report dated by UTC is a day wrong
 * every evening.
 *
 * THE SAME FUNCTION THAT DATES A LEDGER ROW, and it has to be. This module used
 * its own copy while postLedger() wrote `occurred_on` from
 * `new Date().toISOString()` — the UTC date — so the period this report sums
 * BETWEEN was computed in Asia/Kolkata and the dates it summed ACROSS were not.
 * A capture at 02:00 IST on 1 April was stamped 31 March and fell in the
 * previous financial year, and the page said so in a comment congratulating
 * itself on avoiding exactly that. One definition now, in src/db/orders.ts,
 * beside the write.
 */
export const todayInIndia = (now: Date = new Date()): string => federationToday(now);

/** The financial year containing `on`, Indian convention: 1 April to 31 March. */
export function financialYear(on: string): { from: string; to: string; label: string } {
  const year = Number(on.slice(0, 4));
  const month = Number(on.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return {
    from: `${start}-04-01`,
    to: `${start + 1}-03-31`,
    label: `${start}–${String(start + 1).slice(2)}`,
  };
}

/**
 * Revenue by what was sold, over a period.
 *
 * GATED ON finance:read. Turnover by category is the federation's commercial
 * position: it says which programmes carry the organisation and what a rival
 * would have to beat. No institution role holds this action — see the Finance
 * block in src/lib/surface.ts.
 */
export async function revenueReport(
  db: DB,
  principal: Principal | null,
  period: { from: string; to: string }
): Promise<RevenueReport> {
  assertCanAnywhere(principal, 'finance:read');

  const from = String(period?.from ?? '');
  const to = String(period?.to ?? '');
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new RevenueError('bad_period', 'A revenue period is two ISO dates, YYYY-MM-DD.');
  }
  if (from > to) {
    throw new RevenueError('bad_period', 'The period starts after it ends.');
  }

  const state = await financeState(db, principal);

  // ── The income credits in the period ──────────────────────────────────────
  //
  // `income.%` and not `income.refunds`: the refund account is a DEBIT to
  // income and is handled below, against the order it reverses. Counting it
  // here as though it were a sale would show a refund as revenue.
  const credits = await db.select().from(s.ledgerEntries).where(and(
    like(s.ledgerEntries.account, `${INCOME_PREFIX}%`),
    ne(s.ledgerEntries.account, REFUND_ACCOUNT),
    eq(s.ledgerEntries.direction, 'credit'),
    gte(s.ledgerEntries.occurredOn, from),
    lte(s.ledgerEntries.occurredOn, to)
  ));

  // ── The refunds in the period ─────────────────────────────────────────────
  //
  // Deliberately NOT filtered to orders that sold in the period. A refund of a
  // March sale issued in April reduces April's net, which is what a refund is.
  const refundDebits = await db.select().from(s.ledgerEntries).where(and(
    eq(s.ledgerEntries.account, REFUND_ACCOUNT),
    eq(s.ledgerEntries.direction, 'debit'),
    gte(s.ledgerEntries.occurredOn, from),
    lte(s.ledgerEntries.occurredOn, to)
  ));

  // A refund is allocated across the ORDER'S income entries, which may sit
  // outside the period — so those are loaded too, and are used only as weights.
  const refundOrderIds = unique(
    refundDebits.map((e: any) => e.orderId).filter((i: any) => Number.isInteger(i))
  ) as number[];
  const weightCredits = refundOrderIds.length
    ? await db.select().from(s.ledgerEntries).where(and(
        like(s.ledgerEntries.account, `${INCOME_PREFIX}%`),
        ne(s.ledgerEntries.account, REFUND_ACCOUNT),
        eq(s.ledgerEntries.direction, 'credit'),
        inArray(s.ledgerEntries.orderId, refundOrderIds)
      ))
    : [];

  // ── Resolve every entry to an order line, then to a category ──────────────

  const allEntries = [...credits, ...weightCredits];
  const orderIds = unique(
    allEntries.map((e: any) => e.orderId).filter((i: any) => Number.isInteger(i))
  ) as number[];

  const lineRows: AttributableLine[] = orderIds.length
    ? (await db.select({
        id: s.orderLines.id,
        orderId: s.orderLines.orderId,
        kind: s.orderLines.kind,
        feeCode: s.orderLines.feeCode,
        refType: s.orderLines.refType,
        refId: s.orderLines.refId,
        sellerId: s.orderLines.sellerId,
        variantId: s.orderLines.variantId,
        totalPaise: s.orderLines.totalPaise,
        description: s.orderLines.description,
      }).from(s.orderLines).where(inArray(s.orderLines.orderId, orderIds)))
    : [];

  const attribution = await attributeLines(db, lineRows);
  const lineById = new Map<number, AttributableLine>(lineRows.map((l) => [l.id, l]));
  const linesByOrder = new Map<number, AttributableLine[]>();
  for (const l of lineRows) {
    const list = linesByOrder.get(l.orderId) ?? [];
    list.push(l);
    linesByOrder.set(l.orderId, list);
  }

  /**
   * The entry → line join, and the honest answer where it cannot be made.
   *
   * `order_line_id` is set by postLedger() from migration 0044 onward. An older
   * row has NULL, and the only thing left to go on is the account suffix, which
   * names the LINE KIND. That identifies the line exactly when the order has one
   * line of that kind and not otherwise — so "not otherwise" returns null and
   * the money is reported as unattributable rather than assigned to whichever
   * line happened to sort first.
   */
  const lineForEntry = (entry: any): { line: AttributableLine | null; why: string } => {
    if (Number.isInteger(entry.orderLineId)) {
      const line = lineById.get(entry.orderLineId) ?? null;
      if (line) return { line, why: '' };
      return { line: null, why: 'The ledger entry names an order line that no longer exists.' };
    }
    const kind = kindFromAccount(entry.account);
    const candidates = (linesByOrder.get(entry.orderId) ?? []).filter((l) => l.kind === kind);
    if (candidates.length === 1) return { line: candidates[0], why: '' };
    if (candidates.length === 0) {
      return {
        line: null,
        why: `A ledger entry on ${entry.account} whose order has no line of that kind. Nothing says what it was for.`,
      };
    }
    return {
      line: null,
      why:
        `A ledger entry written before line-level attribution existed, on an order with ${candidates.length} ` +
        `“${kind}” lines. Which one it belongs to is not recorded, and picking one would be a guess.`,
    };
  };

  // ── Sum ───────────────────────────────────────────────────────────────────

  const gross = new Map<RevenueKey, number>();
  const refunded = new Map<RevenueKey, number>();
  const entryCount = new Map<RevenueKey, number>();
  const ordersByKey = new Map<RevenueKey, Set<number>>();
  const reasons = new Map<string, { count: number; amountPaise: number }>();

  const add = (map: Map<RevenueKey, number>, key: RevenueKey, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);

  const noteOrder = (key: RevenueKey, orderId: number | null) => {
    if (!Number.isInteger(orderId)) return;
    const set = ordersByKey.get(key) ?? new Set<number>();
    set.add(orderId as number);
    ordersByKey.set(key, set);
  };

  const noteReason = (reason: string, amountPaise: number) => {
    const prev = reasons.get(reason) ?? { count: 0, amountPaise: 0 };
    reasons.set(reason, { count: prev.count + 1, amountPaise: prev.amountPaise + amountPaise });
  };

  /**
   * The categories one ledger entry belongs to, with relative weights.
   *
   * One element for almost every entry. Several only where the order line paid
   * for a mixed quotation — see LineAttribution.split.
   */
  const partsFor = (entry: any): Array<{ key: RevenueKey; weight: number; reason?: string }> => {
    const { line, why } = lineForEntry(entry);
    if (!line) return [{ key: UNATTRIBUTED, weight: 1, reason: why }];
    const a = attribution.get(line.id);
    if (!a) return [{ key: UNATTRIBUTED, weight: 1, reason: 'The order line could not be attributed.' }];
    const split = a.split && a.split.length > 1 ? a.split : [{ key: a.key, weight: 1 }];
    return split.map((p) => ({
      key: p.key,
      weight: p.weight,
      reason: p.key === UNATTRIBUTED ? a.basis : undefined,
    }));
  };

  /** The same parts, with a real figure allocated across them and nothing lost. */
  const splitAmount = (entry: any, amount: number) => {
    const parts = partsFor(entry);
    const shares = parts.length === 1 ? [amount] : allocate(amount, parts.map((p) => p.weight));
    return parts.map((p, i) => ({ ...p, amount: shares[i] ?? 0 }));
  };

  for (const entry of credits) {
    const parts = splitAmount(entry, entry.amountPaise);
    for (const part of parts) {
      add(gross, part.key, part.amount);
      // An entry counts against a category when it PUT MONEY THERE. One entry
      // can reach two lines — a mixed quotation does — and both should show it;
      // but a share that rounds to nothing has contributed no entry to that
      // line, and counting it would make the entry column disagree with the
      // figure printed beside it. A single-part entry always counts, so a
      // genuine nought still shows the row was reached and read.
      if (part.amount !== 0 || parts.length === 1) {
        entryCount.set(part.key, (entryCount.get(part.key) ?? 0) + 1);
      }
      noteOrder(part.key, entry.orderId);
      if (part.reason) noteReason(part.reason, part.amount);
    }
  }

  // Refunds, allocated across the order's income entries by their amounts.
  const creditsByOrder = new Map<number, any[]>();
  for (const e of weightCredits) {
    const list = creditsByOrder.get(e.orderId) ?? [];
    list.push(e);
    creditsByOrder.set(e.orderId, list);
  }

  let unallocatedRefundsPaise = 0;
  for (const debit of refundDebits) {
    const orderCredits = creditsByOrder.get(debit.orderId) ?? [];
    if (!orderCredits.length) {
      // Money went back out against an order that never posted income. That is
      // a real hole in the accounts, not a rounding question.
      unallocatedRefundsPaise += debit.amountPaise;
      continue;
    }
    const shares = allocate(debit.amountPaise, orderCredits.map((e: any) => e.amountPaise));
    orderCredits.forEach((e: any, i: number) => {
      if (!shares[i]) return;
      // Twice-allocated, and it still sums exactly: the refund across the
      // order's income entries, then each entry's share across the categories
      // that entry belongs to. allocate() loses nothing at either hop.
      for (const part of splitAmount(e, shares[i])) {
        if (!part.amount) continue;
        add(refunded, part.key, part.amount);
        noteOrder(part.key, debit.orderId);
      }
    });
  }

  // ── Assemble, in the published order, keeping every category visible ──────

  const keys: RevenueKey[] = [
    ...REVENUE_CATEGORIES.map((c) => c.key),
    ...NON_CATEGORY_LINES.map((c) => c.key),
  ];

  const lines: RevenueLine[] = keys.map((key) => {
    const g = gross.get(key) ?? 0;
    const rf = refunded.get(key) ?? 0;
    return {
      key,
      label: labelFor(key),
      grossPaise: g,
      refundedPaise: rf,
      netPaise: g - rf,
      entries: entryCount.get(key) ?? 0,
      orders: ordersByKey.get(key)?.size ?? 0,
    };
  });

  const totalGross = lines.reduce((a, l) => a + l.grossPaise, 0);
  const totalRefunded = lines.reduce((a, l) => a + l.refundedPaise, 0) + unallocatedRefundsPaise;
  const allOrders = new Set<number>();
  for (const set of ordersByKey.values()) for (const id of set) allOrders.add(id);

  return {
    from,
    to,
    lines,
    totals: {
      grossPaise: totalGross,
      refundedPaise: totalRefunded,
      netPaise: totalGross - totalRefunded,
      // THE NUMBER OF LEDGER ROWS READ, not the sum of the per-line counts.
      // Summing those double-counts an entry that a mixed quotation splits
      // across two categories, and this figure is printed on the page as
      // "N ledger entries" — a count of rows a reader could go and look at.
      entries: credits.length,
      orders: allOrders.size,
    },
    empty: credits.length === 0 && refundDebits.length === 0,
    state,
    whyEmpty: whatWouldPopulateIt(state),
    unattributedReasons: [...reasons.entries()]
      .map(([reason, v]) => ({ reason, count: v.count, amountPaise: v.amountPaise }))
      .sort((a, b) => b.amountPaise - a.amountPaise || a.reason.localeCompare(b.reason)),
    unallocatedRefundsPaise,
  };
}

// ─── The historical line, itemised ──────────────────────────────────────────

export interface HistoricalCharge {
  ledgerEntryId: number;
  orderId: number | null;
  orderLineId: number;
  occurredOn: string;
  amountPaise: number;
  description: string;
  feeCode: string | null;
  /** Why it is on the historical line and not on membership. */
  basis: string;
}

/**
 * Every ledger entry on the withdrawn student-membership line, one by one.
 *
 * Exists so the summary figure can be OPENED. A single number labelled
 * "withdrawn charge" invites the question "which ones?", and a finance officer
 * who cannot answer it will eventually be told to make the number go away —
 * which, done in the ledger, is the falsification rule 3 forbids.
 *
 * Returns [] today, and will keep returning [] unless a historical record
 * genuinely carries such a charge. Nothing in the system can create one.
 */
export async function historicalWithdrawnCharges(
  db: DB,
  principal: Principal | null,
  period: { from: string; to: string }
): Promise<HistoricalCharge[]> {
  assertCanAnywhere(principal, 'finance:read');

  const from = String(period?.from ?? '');
  const to = String(period?.to ?? '');
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new RevenueError('bad_period', 'A revenue period is two ISO dates, YYYY-MM-DD.');
  }

  if (from > to) throw new RevenueError('bad_period', 'The period starts after it ends.');

  // EVERY income credit in the period, and not only `income.membership`.
  //
  // The account carries the ORDER LINE'S KIND, and a withdrawn student
  // membership is not obliged to have been billed on a line called 'membership'
  // — a historical charge whose fee code the register records as issuing an
  // athlete membership counts on the withdrawn line whatever kind the line
  // carried. Narrowing to `income.membership` here while revenueReport()
  // narrowed to nothing meant the summary could show a figure that this
  // function could not itemise: the page then printed an amount on the
  // withdrawn line with an empty list under it, which is the one state the
  // section exists to prevent. A number nobody can open is a number somebody is
  // eventually told to delete, and deleting it in the ledger is the
  // falsification rule 3 forbids.
  const credits = await db.select().from(s.ledgerEntries).where(and(
    like(s.ledgerEntries.account, `${INCOME_PREFIX}%`),
    ne(s.ledgerEntries.account, REFUND_ACCOUNT),
    eq(s.ledgerEntries.direction, 'credit'),
    gte(s.ledgerEntries.occurredOn, from),
    lte(s.ledgerEntries.occurredOn, to)
  ));
  if (!credits.length) return [];

  const orderIds = unique(
    credits.map((e: any) => e.orderId).filter((i: any) => Number.isInteger(i))
  ) as number[];
  const lineRows: AttributableLine[] = orderIds.length
    ? (await db.select({
        id: s.orderLines.id,
        orderId: s.orderLines.orderId,
        kind: s.orderLines.kind,
        feeCode: s.orderLines.feeCode,
        refType: s.orderLines.refType,
        refId: s.orderLines.refId,
        sellerId: s.orderLines.sellerId,
        variantId: s.orderLines.variantId,
        totalPaise: s.orderLines.totalPaise,
        description: s.orderLines.description,
      }).from(s.orderLines).where(inArray(s.orderLines.orderId, orderIds)))
    : [];

  const attribution = await attributeLines(db, lineRows);
  const byId = new Map<number, AttributableLine>(lineRows.map((l) => [l.id, l]));
  const byOrder = new Map<number, AttributableLine[]>();
  for (const l of lineRows) {
    const list = byOrder.get(l.orderId) ?? [];
    list.push(l);
    byOrder.set(l.orderId, list);
  }

  const out: HistoricalCharge[] = [];
  for (const e of credits) {
    let line: AttributableLine | null = null;
    if (Number.isInteger(e.orderLineId)) line = byId.get(e.orderLineId) ?? null;
    else {
      // The same fallback revenueReport() uses, and the same refusal to guess:
      // a pre-0044 row is matched by the kind its account names, and only when
      // that identifies exactly one line of the order.
      const kind = kindFromAccount(e.account);
      const candidates = (byOrder.get(e.orderId) ?? []).filter((l) => l.kind === kind);
      if (candidates.length === 1) line = candidates[0];
    }
    if (!line) continue;
    const a = attribution.get(line.id);
    if (a?.key !== HISTORICAL_WITHDRAWN) continue;
    out.push({
      ledgerEntryId: e.id,
      orderId: e.orderId ?? null,
      orderLineId: line.id,
      occurredOn: e.occurredOn,
      amountPaise: e.amountPaise,
      description: e.description,
      feeCode: line.feeCode,
      basis: a.basis,
    });
  }
  return out.sort((x, y) => (x.occurredOn < y.occurredOn ? 1 : -1));
}
