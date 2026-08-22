// The first hop: a completed application becomes a quotation, with nobody typing.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS HAPPENING INSTEAD
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/applications.ts already derives an institution, a lead, a training
// request, an owner, a score and a review task from one wizard submission. Then
// it stops. To get a quotation, an administrator opened /admin/quotes and typed
// in the participant count, the batch count, the campus count, the sessions per
// week and the duration — every one of which the school had ALREADY TYPED, into
// the form the administrator was reading. That is the "copying data between
// systems" the federation asked to be rid of, surviving in the single step
// where the copying involves money.
//
// This module removes the typing. It removes nothing else: it does not decide
// what anything costs (src/db/fees.ts does), it does not decide who is told
// (the workflow definition in src/db/automations.ts does), and it never
// approves anything.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ANSWER TODAY IS "THERE IS NO PRICE", AND THAT IS NOT A FAILURE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF HAS PUBLISHED NO FEE FRAMEWORK. `activeFramework()` returns null and
// will keep returning null until the federation decides its fees. So every
// application processed today takes the manual path: the application moves to
// `awaiting_quotation`, a task goes to the training office, the school is told a
// quotation is being prepared, and NO NUMBER IS SHOWN ANYWHERE.
//
// Not zero. Zero reads as FREE, and a school that reads ₹0 on a federation
// letterhead has been told something the federation never said. Every field
// this module could put a number in — `totalMinor` on the record it writes, the
// figure on the timeline, the values in the message — is absent rather than
// zeroed, and the check constraint in migration 0040 refuses the row that tries.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROPERTY THAT MATTERS: PUBLISHING FEES CHANGES NO CODE
// ─────────────────────────────────────────────────────────────────────────────
//
// The moment somebody calls `createFramework()`, `addRule()` and
// `publishFramework()` — an act of administration, not a deploy — the very next
// application to arrive takes the priced path instead, with no edit to this
// file, to the workflow definition, or to anything else. That is not an
// aspiration in a comment: `tests/auto-quote.test.ts` runs the whole flow with
// no framework, asserts the manual path, publishes a framework mid-test, runs
// it again and asserts a real figure. Nothing between the two runs is a code
// change.
//
// The mechanism is simply that NOTHING HERE KNOWS WHAT A FEE IS. This module
// maps an application onto `FeeInputs` and asks the engine. The engine reads the
// published framework out of the database. There is no branch on "do we have
// fees yet" that a future edit could get wrong — there is one branch on what the
// engine returned, and the engine returns "no figure" honestly.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY IS A UNIQUE INDEX, NOT A CHECK
// ─────────────────────────────────────────────────────────────────────────────
//
// `application_quotations_application_uk` permits one row per application. The
// quotation is issued and that row is inserted inside ONE transaction, so a
// second caller — a workflow retry, a re-fired trigger, two workers racing — is
// refused by the index and its entire transaction rolls back, taking the quote,
// the quote version, the quote lines and the allocated QUO reference with it.
//
// A SELECT-then-INSERT would be a race both callers pass, and what they would
// both go on to produce is a second quotation, with a second reference number,
// sent to the same school. The read at the top of `autoQuoteApplication()` is a
// courtesy that avoids the work; the index is the guarantee.

import { and, eq } from 'drizzle-orm';
import * as o from './operations.schema';
import * as e from './engagement.schema';
import * as s from './schema';
import {
  activeFramework, computeFee, issueQuote, isFeeError,
  type Computation, type FeeInputs,
} from './fees';
import type { AuditContext } from './federation';
import { federationToday } from './orders';
import { isUniqueViolation } from './pgerror';
import type { Principal } from '@/lib/rbac';

type DB = any;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class AutoQuoteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AutoQuoteError';
    this.code = code;
  }
}

/** Identity by SHAPE, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isAutoQuoteError(err: unknown): err is AutoQuoteError {
  return !!err && typeof err === 'object' && (err as any).name === 'AutoQuoteError'
    && typeof (err as any).code === 'string';
}

// ─── Who the federation is when it quotes automatically ─────────────────────

/**
 * The principal the automatic quotation is issued as.
 *
 * TRAINING_OPERATIONS, NOT FEDERATION_ADMIN, and the difference is the point.
 * `systemIntakePrincipal()` in applications.ts is a FEDERATION_ADMIN because
 * creating institutions and leads demands 'engagement:write'; it also happens to
 * hold 'quote:approve'. Issuing quotations under it would have given the machine
 * the authority to approve the quotations it had just issued — and the one
 * control the federation has over its own pricing is that those are two people.
 *
 * TRAINING_OPERATIONS holds 'quote:issue' and DOES NOT hold 'quote:approve'
 * (src/lib/rbac.ts calls that "the one separation in this file that exists to
 * stop a single person discounting unobserved"). So a quotation this module
 * issues under a rule marked `requiresApproval` lands in 'awaiting_approval' and
 * the automation cannot move it — which is the automation working, not failing.
 *
 * `userId: null` is a second, independent lock: `approveQuoteVersion()` refuses
 * an approver it cannot show to be a different person from the issuer, and a
 * principal with no user id can never be shown to be anybody.
 *
 * Constructed here and never derived from a request. No header, cookie or body
 * field can cause a caller to be treated as this.
 */
export function autoQuotePrincipal(): Principal {
  return {
    userId: null,
    label: 'system:auto-quote',
    bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
  };
}

export function autoQuoteContext(requestId?: string | null): AuditContext {
  return {
    principal: autoQuotePrincipal(),
    requestId: requestId ?? null,
    reason: 'Automatic quotation from a completed institutional application.',
    authority: 'MMAKF application intake',
  };
}

// ─── When is an application ready to be priced? ─────────────────────────────

export interface RequirementsCheck {
  complete: boolean;
  /** Why not, in words, for the timeline and the task. Empty when complete. */
  missing: string[];
}

/**
 * Has the applicant finished saying what they need?
 *
 * THE ANSWER IS SUBMISSION, and that is not a shortcut. `validateSubmission()`
 * is what decides an application may leave 'draft' at all, and step 7 of the
 * wizard — "Describe what you need" — is one of the seven fields it insists on.
 * There is no later moment in src/db/applications.ts at which more requirements
 * arrive: `reviewApplication()` records a human's decision, not the school's
 * answers. So "requirements-complete" is exactly "submitted", and inventing a
 * stricter gate here would mean an application the wizard accepted sat forever
 * in a state the wizard cannot reach.
 *
 * IN PARTICULAR THIS DOES NOT DEMAND A PARTICIPANT COUNT. It is tempting: a
 * count is what per-participant rules multiply by, and without one the engine
 * can price very little. But an application with no count is the one that MOST
 * needs a human to prepare a quotation, and gating on it would mean the school
 * least served by the automation is also the one nobody is told about. A missing
 * count is reported to the engine as a missing input — `computeFee()` skips the
 * rules that needed it and says so — and the manual path picks it up.
 *
 * `missing` is therefore advisory, and is carried into the task so the training
 * office knows what to ask for before it can quote by hand.
 */
export function requirementsComplete(app: {
  status?: string | null;
  requirements?: string | null;
  participantCount?: number | null;
  frequencyPerWeek?: number | null;
  durationWeeks?: number | null;
  mode?: string | null;
}): RequirementsCheck {
  if (!app.status || app.status === 'draft') {
    return { complete: false, missing: ['the application has not been submitted'] };
  }

  const missing: string[] = [];
  if (!app.requirements?.trim()) missing.push('what the institution is asking for');
  if (app.participantCount == null) missing.push('how many participants');
  if (app.frequencyPerWeek == null) missing.push('how many sessions a week');
  if (app.durationWeeks == null) missing.push('how many weeks');
  if (!app.mode) missing.push('where it would be delivered');

  return { complete: true, missing };
}

/**
 * Statuses in which the FEDERATION HAS ALREADY FINISHED with this application.
 *
 * A person read it and said no; or the institution withdrew it; or it lapsed.
 * Every one of those is a HUMAN DECISION, and an automation that prices the
 * application afterwards does not merely waste a quotation — the workflow's
 * later steps move the application back into 'awaiting_quotation' or 'quoted'
 * and send the school a message about a quotation for something the federation
 * has declined.
 *
 * THIS IS REACHABLE TODAY, and not only by a caller nobody has written yet. A
 * workflow run that fails at any step is retried by `sweepWorkflowRetries()`
 * hours or days later, from the context it was dispatched with; the application
 * it names can have been declined in between, and the resumed run knows nothing
 * about it. The guard therefore lives HERE, in code, rather than in the workflow
 * definition — a retried run re-reads the definition VERSION it started under,
 * so a corrected definition would not protect the runs already in flight.
 */
export const CLOSED_APPLICATION_STATUSES = ['declined', 'withdrawn', 'expired'] as const;

/**
 * Statuses at or beyond the quotation itself.
 *
 * An application already carrying a quotation — one a person prepared by hand,
 * most likely, since that is what happens today — must not have a second one
 * issued underneath it. `issueQuote()` re-versions the quote for the same
 * request and SUPERSEDES the live version, so the automation would replace the
 * figure the school is holding with a different one, and the school would find
 * out from a status page. Two quotations for one application is precisely what
 * the unique index exists to prevent; this is the same guarantee for the
 * quotations that index never saw.
 */
export const QUOTED_APPLICATION_STATUSES = ['quoted', 'proposed', 'approved', 'contracted'] as const;

/**
 * May the automation still decide this application's quotation?
 *
 * Separate from `requirementsComplete()` because it answers a different
 * question. That one asks whether the APPLICANT has finished; this asks whether
 * the FEDERATION has. An application can be complete and closed at once, and
 * the second fact outranks the first.
 */
export function quotationApplicability(status: string | null | undefined): {
  applicable: boolean;
  reason: string;
} {
  const value = String(status ?? '');
  if ((CLOSED_APPLICATION_STATUSES as readonly string[]).includes(value)) {
    return {
      applicable: false,
      reason:
        `Application is ${value}. The federation has finished with it, so no quotation is prepared ` +
        'automatically — reopening a decision a person took is not something an automation may do.',
    };
  }
  if ((QUOTED_APPLICATION_STATUSES as readonly string[]).includes(value)) {
    return {
      applicable: false,
      reason:
        `Application is ${value} and already carries a quotation. A second automatic quotation would ` +
        'supersede the one the institution is holding, which is a thing only a person may decide to do.',
    };
  }
  return { applicable: true, reason: '' };
}

// ─── The application, as the fee engine sees it ─────────────────────────────

/**
 * Map the application onto FeeInputs. THE WIZARD ALREADY COLLECTED ALL OF THIS.
 *
 * Every key below is a column on `institution_applications`, filled in by the
 * school. Nothing is asked for twice and nothing is guessed: a value the
 * applicant did not give is left OUT of the object rather than defaulted, so a
 * rule that needed it is skipped and says so, instead of being priced against a
 * number nobody supplied.
 *
 * `sessions` IS DERIVED, and it is the only derivation here. A per-session rule
 * multiplies by the TOTAL number of sessions, and the wizard asks for sessions
 * per week and the number of weeks separately. Multiplying them is arithmetic
 * the applicant would have done themselves; it is done only when BOTH are
 * present, because `sessionsPerWeek` alone against a per-session rule would
 * multiply a unit price by 2 instead of by 48 and print the answer as money.
 * (src/db/applications.ts `individualFeePreview()` faces the same question with
 * only half the data and correctly refuses to guess.)
 *
 * The extra keys past the engine's known ones — age bands, the outcomes the
 * school asked for, the facilities it has — are there because `FeeInputs` is
 * open-ended by design and a rule's `conditions` may match on any of them. They
 * are the school's own answers, passed through unchanged.
 */
export function feeInputsForApplication(
  app: Record<string, any>,
  resolved: { serviceCode?: string | null; stateCode?: string | null; districtCode?: string | null } = {}
): FeeInputs {
  const inputs: FeeInputs = { audience: app.audience };

  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    inputs[key] = value;
  };

  put('serviceCode', resolved.serviceCode);
  put('stateCode', resolved.stateCode);
  put('districtCode', resolved.districtCode);

  put('mode', app.mode);
  put('participants', app.participantCount);
  put('batches', app.batchCount);
  put('campuses', app.campusCount);
  put('instructors', app.instructorsRequired);
  put('weeks', app.durationWeeks);
  put('sessionsPerWeek', app.frequencyPerWeek);

  // The only derivation. See the note above.
  if (app.frequencyPerWeek != null && app.durationWeeks != null) {
    put('sessions', app.frequencyPerWeek * app.durationWeeks);
  }

  put('population', app.populationCount);
  put('ageBands', Array.isArray(app.ageBands) ? app.ageBands : undefined);
  put('stateName', app.stateName);
  put('city', app.city);

  // Booleans are passed only when the applicant actually answered. `false` is an
  // answer; `null` — the wizard step they skipped — is not, and a rule reading
  // `wantsGrading: false` against somebody who never said would be pricing a
  // decision nobody made.
  for (const [key, value] of Object.entries({
    wantsAssessment: app.wantsAssessment,
    wantsGrading: app.wantsGrading,
    wantsCertification: app.wantsCertification,
    wantsCompetition: app.wantsCompetition,
  })) {
    if (typeof value === 'boolean') inputs[key] = value;
  }

  const infra = (app.infrastructure ?? null) as Record<string, unknown> | null;
  if (infra && typeof infra === 'object') {
    for (const key of ['hasHall', 'hasMats', 'hasChangingRooms']) {
      if (typeof infra[key] === 'boolean') inputs[key] = infra[key];
    }
  }

  return inputs;
}

// ─── The decision ───────────────────────────────────────────────────────────

/**
 * 'not_applicable' IS NEVER STORED, and the database enum has no value for it.
 *
 * It means the automation looked and wrote nothing — no quotation, no claim
 * row, no status change. Not writing is what makes it correct: the day an
 * administrator reopens the application, the automation may still price it, and
 * a row saying "we decided not to" would be an idempotency claim over a
 * decision that was never taken.
 */
export type AutoQuoteOutcome = 'quoted' | 'awaiting_approval' | 'manual_quote_required' | 'not_applicable';

export interface AutoQuoteResult {
  applicationId: number;
  applicationRef: string;
  outcome: AutoQuoteOutcome;
  /** True when an earlier run already decided this. Nothing was written. */
  duplicate: boolean;
  /** The sentence a human reads. Never empty. */
  reason: string;
  /** What the training office still has to find out, on the manual path. */
  missing: string[];
  inputs: FeeInputs;

  frameworkId: number | null;
  frameworkCode: string | null;

  quoteId: number | null;
  quoteRef: string | null;
  quoteVersionId: number | null;
  quoteVersion: number | null;
  currency: string | null;
  /**
   * Integer paise, and NULL WHENEVER THERE IS NO PUBLISHED PRICE.
   *
   * Never 0 as a stand-in. Every consumer — the timeline, the message, the admin
   * screen — must render "no figure" from null and must never render a number it
   * did not receive.
   */
  totalMinor: number | null;
}

interface AutoQuoteOptions {
  now?: Date;
  /** The date the framework is asked for. Defaults to today. */
  asAt?: string;
}

/**
 * Price a completed application, or record honestly that nothing priced it.
 *
 * Reads first (the framework and the arithmetic are read-only), then writes
 * once, atomically. Returns rather than throws for "no framework" and "no rule
 * matched" — those are ANSWERS, and the caller has somewhere to put them.
 * Throws only for the things a caller got wrong: no such application, or an
 * application still in draft.
 */
export async function autoQuoteApplication(
  db: DB,
  ctx: AuditContext,
  applicationId: number,
  opts: AutoQuoteOptions = {}
): Promise<AutoQuoteResult> {
  const now = opts.now ?? new Date();
  // THE FEDERATION'S OWN CALENDAR, not UTC's. A framework published effective
  // 1 September is in force from midnight in India, and `toISOString()` would
  // still be saying 31 August until 05:30 IST — so an application submitted at
  // breakfast on the first day of a new framework would be told, untruthfully,
  // that MMAKF has not published a fee for it, and would be sent to a human who
  // now has to explain the gap. Same function the orders, entitlement and
  // webhook paths date by.
  const asAt = opts.asAt ?? federationToday(now);

  const [app] = await db.select().from(o.institutionApplications)
    .where(eq(o.institutionApplications.id, applicationId)).limit(1);
  if (!app) throw new AutoQuoteError('not_found', `No application ${applicationId}.`);

  // The courtesy read, FIRST. The unique index below is the actual guarantee;
  // this only avoids doing the work twice in the ordinary, uncontended case.
  //
  // Ahead of both guards below, deliberately. A decision already taken is a
  // fact, and a replay must be handed that fact back whatever the application's
  // status has become since — an application this automation quoted in March is
  // 'quoted' by June, and a replay must not then be told it is too late.
  const existing = await loadDecision(db, applicationId);
  if (existing) return { ...existing, duplicate: true };

  const readiness = requirementsComplete(app);
  if (!readiness.complete) {
    // A draft is the applicant's unfinished business. Quoting one would price a
    // form they are still filling in, and send it to them.
    throw new AutoQuoteError(
      'requirements_incomplete',
      `Application ${app.ref} is ${app.status} — ${readiness.missing.join('; ')}.`
    );
  }

  // ── Has the FEDERATION finished with it? ──
  //
  // Returns rather than throws, and writes NOTHING. A declined application is
  // not a fault for the retry sweep to hammer at; it is an answer. Every branch
  // of the workflow is guarded on an outcome none of them match, so the task,
  // the message and the status change are all skipped rather than suppressed
  // one at a time.
  const applicability = quotationApplicability(app.status);
  if (!applicability.applicable) {
    return {
      applicationId,
      applicationRef: app.ref,
      outcome: 'not_applicable',
      duplicate: false,
      reason: applicability.reason,
      missing: [],
      // EMPTY, because nothing was priced and nothing was asked. A populated
      // FeeInputs here would read as though the engine had been consulted.
      inputs: {},
      frameworkId: null, frameworkCode: null,
      quoteId: null, quoteRef: null, quoteVersionId: null, quoteVersion: null,
      currency: null,
      totalMinor: null,
    };
  }

  const inputs = feeInputsForApplication(app, await resolveCodes(db, app));

  // ── Read: what does the federation's published framework say? ──
  const framework = await activeFramework(db, asAt);

  let computation: Computation | null = null;
  let manualReason: string | null = null;

  if (!framework) {
    // TODAY'S ANSWER, and it is a true one. Note what is NOT here: no fallback
    // framework, no benchmark borrowed from another federation, no "typical"
    // figure. The federation has not said, so neither does this.
    manualReason =
      'MMAKF has not published a fee framework, so there is no rule to price this application against. ' +
      'The training office prepares this quotation by hand.';
  } else {
    try {
      computation = await computeFee(db, framework.id, inputs);
      if (computation.requiresManualQuote) {
        manualReason = computation.manualReason
          ?? 'No published fee rule covers this combination of requirements.';
        computation = null;
      }
    } catch (err: any) {
      // A rule the engine cannot apply — a multiplier with no factor, a quantity
      // past exact arithmetic — must not produce a number. Saying a person has to
      // quote it is the only safe reading of a broken rule, and the engine's own
      // words are kept so whoever fixes the rule can find it.
      manualReason =
        `The published fee rules could not be applied to this application: ${
          isFeeError(err) ? err.message : String(err?.message ?? err)
        } The training office prepares this quotation by hand.`;
      computation = null;
    }
  }

  // ── Write: once, atomically, and refused outright if it has happened before ──
  try {
    if (!computation) {
      const [row] = await db.insert(o.applicationQuotations).values({
        applicationId,
        outcome: 'manual_quote_required',
        reason: manualReason!,
        inputs: inputs as any,
        frameworkId: framework?.id ?? null,
        frameworkCode: framework?.code ?? null,
        decidedAt: now,
      }).returning();

      return {
        applicationId,
        applicationRef: app.ref,
        outcome: 'manual_quote_required',
        duplicate: false,
        reason: row.reason,
        missing: readiness.missing,
        inputs,
        frameworkId: framework?.id ?? null,
        frameworkCode: framework?.code ?? null,
        quoteId: null, quoteRef: null, quoteVersionId: null, quoteVersion: null,
        currency: null,
        totalMinor: null,     // NOT ZERO. See the header.
      };
    }

    // The priced path. Quotation first, claim row last, one transaction: the
    // check constraint cannot be deferred, so the row cannot be claimed empty —
    // and a loser of the race takes its own quotation down with it on rollback.
    const priced = computation;
    return await db.transaction(async (tx: DB) => {
      const issued = await issueQuote(tx, ctx, {
        requestId: app.requestId ?? null,
        institutionId: app.institutionId ?? null,
        frameworkId: priced.frameworkId,
        inputs,
      });

      // The version issueQuote just wrote, named by (quote, version) rather than
      // by "the newest": a quote that already had versions is re-versioned, and
      // "newest" would be right by luck on a path where luck is not needed.
      const [qv] = await tx.select({ id: e.quoteVersions.id, status: e.quoteVersions.status })
        .from(e.quoteVersions)
        .where(and(
          eq(e.quoteVersions.quoteId, issued.quoteId),
          eq(e.quoteVersions.version, issued.version)
        ))
        .limit(1);
      if (!qv) {
        throw new AutoQuoteError(
          'quote_version_missing',
          `Quotation ${issued.ref} version ${issued.version} was issued and cannot be read back.`
        );
      }

      const outcome: AutoQuoteOutcome = priced.needsApproval ? 'awaiting_approval' : 'quoted';
      const reason = priced.needsApproval
        ? `Priced under ${priced.frameworkCode}. A rule that fired requires approval, so the quotation is not issued ` +
          'until a person who did not prepare it approves it.'
        : `Priced under ${priced.frameworkCode} from the requirements the institution submitted.`;

      const [row] = await tx.insert(o.applicationQuotations).values({
        applicationId,
        outcome,
        reason,
        inputs: inputs as any,
        frameworkId: priced.frameworkId,
        frameworkCode: priced.frameworkCode,
        quoteId: issued.quoteId,
        quoteVersionId: qv.id,
        quoteVersion: issued.version,
        currency: priced.currency,
        totalMinor: priced.totalMinor,
        decidedAt: now,
      }).returning();

      return {
        applicationId,
        applicationRef: app.ref,
        outcome,
        duplicate: false,
        reason: row.reason,
        missing: readiness.missing,
        inputs,
        frameworkId: priced.frameworkId,
        frameworkCode: priced.frameworkCode,
        quoteId: issued.quoteId,
        quoteRef: issued.ref,
        quoteVersionId: qv.id,
        quoteVersion: issued.version,
        currency: priced.currency,
        totalMinor: priced.totalMinor,
      };
    });
  } catch (err) {
    // The index fired. Somebody else got here first and their decision stands —
    // which is the success case for a retry, not a failure.
    if (isUniqueViolation(err)) {
      const settled = await loadDecision(db, applicationId);
      if (settled) return { ...settled, duplicate: true };
    }
    throw err;
  }
}

// ─── Reading it back ────────────────────────────────────────────────────────

/**
 * What the automation decided about this application, if it has decided.
 *
 * Null means it has not run — which is a different fact from "it ran and found
 * no price", and the two must never render as the same sentence.
 */
export async function quotationDecision(
  db: DB,
  applicationId: number
): Promise<AutoQuoteResult | null> {
  return loadDecision(db, applicationId);
}

async function loadDecision(db: DB, applicationId: number): Promise<AutoQuoteResult | null> {
  const [row] = await db.select().from(o.applicationQuotations)
    .where(eq(o.applicationQuotations.applicationId, applicationId)).limit(1);
  if (!row) return null;

  const [app] = await db.select({ ref: o.institutionApplications.ref })
    .from(o.institutionApplications)
    .where(eq(o.institutionApplications.id, applicationId)).limit(1);

  let quoteRef: string | null = null;
  if (row.quoteId != null) {
    const [q] = await db.select({ ref: e.quotes.ref }).from(e.quotes)
      .where(eq(e.quotes.id, row.quoteId)).limit(1);
    quoteRef = q?.ref ?? null;
  }

  return {
    applicationId,
    applicationRef: app?.ref ?? '',
    outcome: row.outcome as AutoQuoteOutcome,
    duplicate: false,
    reason: row.reason,
    missing: [],
    inputs: (row.inputs ?? {}) as FeeInputs,
    frameworkId: row.frameworkId ?? null,
    frameworkCode: row.frameworkCode ?? null,
    quoteId: row.quoteId ?? null,
    quoteRef,
    quoteVersionId: row.quoteVersionId ?? null,
    quoteVersion: row.quoteVersion ?? null,
    currency: row.currency ?? null,
    totalMinor: row.totalMinor ?? null,
  };
}

// ─── Codes the rules may match on ───────────────────────────────────────────

/**
 * Resolve the identifiers a rule's `conditions` can name.
 *
 * The wizard stores unit IDs and a free-text state name; a fee rule is written
 * by a finance officer who thinks in CODES ('MMAKF-ST-JH'), not in surrogate
 * keys. Resolving here means the rule author never has to know a row id.
 *
 * Every one is optional and a miss yields null, which leaves the key out of
 * FeeInputs entirely — so a state-specific rule simply does not match rather
 * than matching everybody.
 */
async function resolveCodes(db: DB, app: Record<string, any>) {
  const out: { serviceCode?: string | null; stateCode?: string | null; districtCode?: string | null } = {};

  if (app.serviceId != null) {
    const [svc] = await db.select({ code: e.services.code }).from(e.services)
      .where(eq(e.services.id, app.serviceId)).limit(1);
    out.serviceCode = svc?.code ?? null;
  }
  if (app.stateUnitId != null) {
    const [unit] = await db.select({ code: s.stateUnits.code }).from(s.stateUnits)
      .where(eq(s.stateUnits.id, app.stateUnitId)).limit(1);
    out.stateCode = unit?.code ?? null;
  }
  if (app.districtUnitId != null) {
    const [unit] = await db.select({ code: s.districtUnits.code }).from(s.districtUnits)
      .where(eq(s.districtUnits.id, app.districtUnitId)).limit(1);
    out.districtCode = unit?.code ?? null;
  }

  return out;
}
