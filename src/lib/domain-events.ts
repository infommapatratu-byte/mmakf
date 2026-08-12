// The domain event spine — the federation's internal data feed.
//
// Every significant state change is appended here ONCE, and consumers read from
// the feed rather than each polling its own tables. That is what lets
// notifications, analytics, the live scoreboard and any future mobile app agree
// with one another instead of each computing its own version of the truth. When
// two surfaces disagree about whether a result is final, the argument is settled
// by the feed, not by whichever query ran most recently.
//
// FOUR PROPERTIES THIS MODULE IS BUILT AROUND:
//
//  1. APPEND-ONLY. There is no update path and no delete path for an event in
//     this file, on purpose. A wrong event is corrected by appending a corrective
//     event, never by rewriting history — a consumer that already acted on the
//     original must be able to see what it acted on.
//
//  2. CLASSIFICATION IS MANDATORY AND FAILS CLOSED. Every event carries a
//     data_class. An event type may not be published BELOW the floor its
//     catalogue entry declares, so a safeguarding event cannot be marked public
//     by a careless caller. Reads are clamped to the caller's clearance; nothing
//     above it is returned, ever.
//
//  3. EACH CONSUMER OWNS ITS OWN CURSOR. A consumer that throws stops at the
//     failing event and does not advance past it, and it cannot stall any other
//     consumer, because no consumer shares state with another.
//
//  4. DELIVERY IS AT-LEAST-ONCE FOR EVENTS THE CURSOR CAN SEE, AND THIS MODULE
//     SAYS WHERE THAT ENDS RATHER THAN PRETENDING IT DOES NOT. The cursor is
//     written after the batch, so a process killed mid-batch re-delivers and
//     handlers must be idempotent. The cursor is an `id` watermark, and `id` is
//     allocated at the START of a publish rather than at its commit, so an event
//     can become visible BELOW a cursor that has already passed it and never be
//     delivered at all. See `consume()` — the gap is named there, with what it
//     would take to close it, because a consumer silently missing one event is
//     the failure this whole module exists to prevent.
//
// WHY PUBLISHING IS NOT AUTHORISATION-GATED, when every other module gates first:
// `publish()` records a fact that an already-authorised mutation has produced.
// The authorisation happened at the mutation. Gating here would let a permission
// gap silently drop an event, and a feed that is missing events is worse than one
// a caller was not entitled to write to — every downstream surface would then be
// quietly wrong, with nothing to show that it was. The gate that matters for the
// feed is on the READ side, and it is `readFeed()`.

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, can, canAnywhere, type Principal } from '@/lib/rbac';
import { isUniqueViolation } from '@/db/pgerror';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class DomainEventError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainEventError';
    this.code = code;
  }
}

// ─── Classification ─────────────────────────────────────────────────────────

/** Derived from the schema enum rather than restated, so the two cannot drift. */
export type Classification = (typeof s.dataClass.enumValues)[number];

/**
 * The sensitivity ladder. Typed as `Record<Classification, number>`, which makes
 * the compiler reject a new data_class value that nobody has placed on the
 * ladder — the alternative is a new classification silently ranking as
 * `undefined` and comparing false against everything, i.e. failing OPEN.
 */
const RANK: Record<Classification, number> = {
  public: 0,
  member: 1,
  official: 2,
  confidential: 3,
  restricted: 4,
  highly_restricted: 5,
};

export const CLASSIFICATIONS = Object.keys(RANK) as Classification[];

/** The most restrictive level there is. Used wherever a default is needed. */
export const MOST_RESTRICTIVE: Classification = 'highly_restricted';

/**
 * Events above this are never given a public projection, whatever their
 * catalogue entry says. A second, independent gate: `publicFields` is a
 * developer's declaration, and this is the check that survives a mistaken one.
 */
const PUBLIC_PROJECTION_CEILING: Classification = 'member';

function atMost(a: Classification, b: Classification): Classification {
  return RANK[a] <= RANK[b] ? a : b;
}

// ─── The event catalogue ────────────────────────────────────────────────────

export interface EventTypeSpec {
  /**
   * The LEAST restrictive classification this event may be published at.
   * Publishing below it is refused. Publishing above it is allowed — a producer
   * may always be more careful than the catalogue requires.
   */
  floor: Classification;
  /**
   * ALLOWLIST of payload PATHS that may reach a public surface.
   *
   * An allowlist, never a denylist: a denylist fails open the day a producer
   * adds a field nobody remembered to exclude, and that field is exactly the one
   * that will turn out to be a date of birth. A path not named here does not
   * appear in the public projection, and a producer using different key names
   * simply gets a smaller projection rather than a leak.
   *
   * THE ALLOWLIST APPLIES AT EVERY DEPTH, not just the top level. Naming a bare
   * key allows it ONLY when its value is a JSON scalar, or an array of scalars.
   * The moment a value is an object — or an array containing objects — its
   * contents have not been declared, and undeclared contents are precisely what
   * leaks: `placings: [{ place, personId, dateOfBirth }]` would have carried a
   * date of birth onto a scoreboard under a one-word allowlist entry.
   *
   * To publish inside a structure, declare the paths: 'placings.place' names
   * `place` on each element of `placings` and nothing else. A structure with no
   * declared paths is WITHHELD, and named in the projection's `withheld` list so
   * the omission is visible rather than silent. Which sub-fields of a result,
   * a draw or a certificate MMAKF publishes is the federation's editorial
   * decision; where it has not made one, this module publishes nothing and says
   * so, rather than guessing on the federation's behalf.
   *
   * Empty means the event has NO public form at all.
   */
  publicFields: readonly string[];
  /** What the event means, one line — this is the feed's documentation. */
  means: string;
}

/**
 * Every event the federation publishes.
 *
 * A union type, so a typo in an event name is a compile error rather than an
 * event nobody is subscribed to. Adding a producer means adding a line here
 * first, which is the point: the feed's vocabulary is reviewed in one place.
 *
 * Floors are set conservatively. Where it is genuinely MMAKF's decision whether
 * something is published — whether a grading calendar is advertised, whether a
 * disciplinary sanction is named — the floor stays internal and the federation
 * can expose the public form deliberately through a surface that says so. An
 * unset editorial policy is not licence to guess.
 */
export const EVENT_TYPES = {
  // People and membership
  PERSON_REGISTERED: {
    floor: 'member', publicFields: [],
    means: 'A person record was created.',
  },
  MEMBERSHIP_CREATED: {
    floor: 'member', publicFields: [],
    means: 'A membership was issued for a person in a category.',
  },
  MEMBERSHIP_RENEWED: {
    floor: 'member', publicFields: [],
    means: 'An existing membership was extended to a new validity period.',
  },
  MEMBERSHIP_REVOKED: {
    floor: 'official', publicFields: [],
    means: 'A membership was revoked, with a recorded reason.',
  },

  // Grading, ranks and certificates
  GRADING_SCHEDULED: {
    floor: 'member', publicFields: [],
    means: 'A grading event was placed on the calendar.',
  },
  GRADING_APPROVED: {
    floor: 'official', publicFields: [],
    means: 'A panel decision was recorded for a candidate.',
  },
  GRADING_LOCKED: {
    floor: 'official', publicFields: [],
    means: 'A grading was locked; its scores and decisions are now immutable.',
  },
  RANK_AWARDED: {
    floor: 'member',
    // The public register already shows holder, grade and provenance; nothing
    // here is wider than that surface.
    publicFields: ['federationId', 'gradeLabel', 'kind', 'awardedOn', 'provenance'],
    means: 'A rank record became active for a person.',
  },
  CERTIFICATE_ISSUED: {
    floor: 'member',
    publicFields: ['certificateNo', 'grade', 'awardedOn', 'issuingAuthority', 'provenance'],
    means: 'A certificate was issued against a recorded pass.',
  },
  CERTIFICATE_REVOKED: {
    floor: 'member',
    // Revocation is deliberately visible: a credential that merely disappeared
    // would be indistinguishable from one that never existed, which is exactly
    // what someone presenting a revoked certificate would prefer.
    //
    // The REASON is deliberately NOT public. It is free text written by an
    // official and can name a disciplinary or safeguarding matter, a third
    // party, or a minor; whether the federation names why a credential was
    // withdrawn is an editorial decision MMAKF has not made, and an allowlist
    // cannot bound what a human typed into a free-text field. The FACT of
    // revocation is what protects the person checking the credential, and that
    // is what travels. When the federation decides, it adds the path here.
    publicFields: ['certificateNo', 'revokedOn'],
    means: 'A certificate was revoked, with a recorded reason.',
  },

  // Competition
  COMPETITION_SANCTIONED: {
    floor: 'member',
    publicFields: ['competitionId', 'code', 'title', 'startsOn', 'venue'],
    means: 'A competition was sanctioned by the federation.',
  },
  ENTRY_CREATED: {
    floor: 'member', publicFields: [],
    means: 'An entry was lodged for a competitor or team in a category.',
  },
  ENTRY_ACCEPTED: {
    floor: 'member', publicFields: [],
    means: 'An entry was accepted after eligibility review.',
  },
  ENTRY_REJECTED: {
    floor: 'member', publicFields: [],
    means: 'An entry was refused, with the eligibility evidence recorded.',
  },
  DRAW_PUBLISHED: {
    floor: 'member',
    // The seed travels with the public form on purpose: a draw nobody can
    // reproduce is a draw nobody can challenge.
    publicFields: ['drawId', 'competitionId', 'categoryId', 'publishedAt', 'randomSeed'],
    means: 'A draw was published and is reproducible from its seed.',
  },
  MATCH_STARTED: {
    floor: 'member',
    publicFields: ['matchId', 'competitionId', 'categoryId', 'round', 'tatami'],
    means: 'A match was started on a tatami.',
  },
  MATCH_COMPLETED: {
    floor: 'member',
    publicFields: ['matchId', 'competitionId', 'categoryId', 'round', 'winnerEntryId', 'scoreAka', 'scoreAo'],
    means: 'A match finished and its outcome was recorded.',
  },
  RESULT_FINALIZED: {
    floor: 'member',
    publicFields: ['competitionId', 'categoryId', 'placings', 'finalizedAt'],
    means: 'A category result was finalised. From this point the record is locked.',
  },
  RESULT_CORRECTED: {
    floor: 'member',
    // A correction supersedes rather than edits, so the public form must name
    // the result it replaces or the change cannot be explained.
    publicFields: ['competitionId', 'categoryId', 'supersedesResultId', 'placings', 'correctedAt'],
    means: 'A finalised result was superseded by a correction, under recorded authority.',
  },
  PROTEST_LODGED: {
    floor: 'official', publicFields: [],
    means: 'A protest was lodged against a match or a decision.',
  },
  PROTEST_DECIDED: {
    floor: 'official', publicFields: [],
    means: 'A protest was decided.',
  },
  RANKING_UPDATED: {
    floor: 'member',
    publicFields: ['rankingPeriodId', 'rulesetId', 'categoryId', 'publishedAt'],
    means: 'A ranking period was recalculated and published.',
  },
  SQUAD_SELECTED: {
    floor: 'official', publicFields: [],
    means: 'A national squad selection was recorded.',
  },

  // Units and affiliation
  AFFILIATION_APPLIED: {
    floor: 'official', publicFields: [],
    means: 'A dojo or unit applied for affiliation.',
  },
  AFFILIATION_CHARTERED: {
    floor: 'member',
    publicFields: ['unitType', 'code', 'name', 'charteredOn'],
    means: 'A unit was chartered or a dojo affiliated.',
  },
  AFFILIATION_LAPSED: {
    floor: 'member',
    publicFields: ['unitType', 'code', 'lapsedOn'],
    means: 'An affiliation or charter lapsed or was withdrawn.',
  },

  // Broadcast, live and education
  LIVE_STARTED: {
    floor: 'member',
    publicFields: ['channel', 'title', 'startedAt', 'watchUrl'],
    means: 'A live broadcast or live class went on air.',
  },
  LIVE_ENDED: {
    floor: 'member',
    publicFields: ['channel', 'title', 'endedAt'],
    means: 'A live broadcast or live class ended.',
  },
  BROADCAST_PUBLISHED: {
    floor: 'member',
    publicFields: ['channel', 'title', 'publishedAt', 'watchUrl'],
    means: 'A recording was published to a channel.',
  },
  COURSE_ENROLLED: {
    floor: 'member', publicFields: [],
    means: 'A person enrolled on a course.',
  },
  LESSON_COMPLETED: {
    floor: 'member', publicFields: [],
    means: 'A person completed a lesson.',
  },
  QUIZ_ATTEMPTED: {
    floor: 'member', publicFields: [],
    means: 'A quiz attempt was recorded.',
  },

  // Governance
  DOCUMENT_PUBLISHED: {
    floor: 'member',
    publicFields: ['code', 'title', 'version', 'effectiveFrom'],
    means: 'A version of an official document was published.',
  },
  DOCUMENT_SUPERSEDED: {
    floor: 'member',
    publicFields: ['code', 'version', 'supersededBy'],
    means: 'A document version was superseded by a later one.',
  },
  MEETING_MINUTES_APPROVED: {
    floor: 'official', publicFields: [],
    means: 'Minutes of a meeting were approved.',
  },
  RESOLUTION_RECORDED: {
    floor: 'official', publicFields: [],
    means: 'A resolution was recorded with its outcome.',
  },

  // Money. Confidential throughout: an order names a person and an amount.
  ORDER_PAID: {
    floor: 'confidential', publicFields: [],
    means: 'An order was marked paid against a verified capture.',
  },
  PAYMENT_FAILED: {
    floor: 'confidential', publicFields: [],
    means: 'A payment attempt failed.',
  },
  REFUND_ISSUED: {
    floor: 'confidential', publicFields: [],
    means: 'A refund was issued against a payment.',
  },
  INVOICE_ISSUED: {
    floor: 'confidential', publicFields: [],
    means: 'An invoice was issued for an order.',
  },
  SETTLEMENT_RECORDED: {
    floor: 'confidential', publicFields: [],
    means: 'A gateway settlement was reconciled to the ledger.',
  },

  // Casework. These are the reason classification exists at all.
  SUPPORT_TICKET_OPENED: {
    floor: 'confidential', publicFields: [],
    means: 'A support ticket was opened.',
  },
  DISCIPLINARY_CASE_OPENED: {
    floor: 'restricted', publicFields: [],
    means: 'A disciplinary case was opened.',
  },
  DISCIPLINARY_DECISION_RECORDED: {
    floor: 'restricted', publicFields: [],
    means: 'A disciplinary case was decided.',
  },
  MEDICAL_RECORD_UPDATED: {
    floor: 'highly_restricted', publicFields: [],
    means: 'A medical record was created or amended.',
  },
  SAFEGUARDING_CASE_OPENED: {
    floor: 'highly_restricted', publicFields: [],
    means: 'A safeguarding concern was received.',
  },
  SAFEGUARDING_CASE_UPDATED: {
    floor: 'highly_restricted', publicFields: [],
    means: 'A safeguarding case changed state.',
  },
} as const satisfies Record<string, EventTypeSpec>;

export type DomainEventType = keyof typeof EVENT_TYPES;

export function isDomainEventType(name: string): name is DomainEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES, name);
}

function specFor(eventType: string): EventTypeSpec | undefined {
  return (EVENT_TYPES as Record<string, EventTypeSpec>)[eventType];
}

/**
 * Catalogue self-check, asserted by the test suite.
 *
 * Returns contradictions rather than throwing at import: a static table either
 * always fails or never does, and a module that refuses to load in production
 * over a developer's typo takes the whole site down. The test is the right place
 * for this to fail.
 */
export function catalogueDefects(): string[] {
  const defects: string[] = [];
  for (const [name, spec] of Object.entries(EVENT_TYPES) as Array<[string, EventTypeSpec]>) {
    if (!(spec.floor in RANK)) {
      defects.push(`${name}: floor '${spec.floor}' is not on the ladder`);
    }
    if (spec.publicFields.length && RANK[spec.floor] > RANK[PUBLIC_PROJECTION_CEILING]) {
      defects.push(
        `${name}: declares public fields but its floor '${spec.floor}' is above '${PUBLIC_PROJECTION_CEILING}'`
      );
    }
    if (new Set(spec.publicFields).size !== spec.publicFields.length) {
      defects.push(`${name}: duplicate keys in publicFields`);
    }
    // A path is what the projector walks; a malformed one would silently match
    // nothing, and a field that silently publishes nothing is indistinguishable
    // from one the federation chose to withhold.
    for (const path of spec.publicFields) {
      if (!path.trim() || path.split('.').some((part) => !part.trim())) {
        defects.push(`${name}: '${path}' is not a usable payload path`);
      }
    }
    // 'placings' AND 'placings.place' together is a contradiction: the first
    // says the value is a scalar, the second says it is a structure. Rather than
    // let one silently win, the catalogue is wrong and must say which it means.
    for (const path of spec.publicFields) {
      if (!path.includes('.')) continue;
      const root = path.split('.')[0];
      if (spec.publicFields.includes(root)) {
        defects.push(`${name}: '${root}' is declared both as a whole value and as a path prefix`);
      }
    }
    if (!spec.means?.trim()) defects.push(`${name}: no description`);
  }
  return defects;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface DomainEventRow {
  id: number;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  classification: Classification;
  actorUserId: number | null;
  actorLabel: string | null;
  correlationId: string | null;
  occurredAt: Date;
  publishedAt: Date | null;
}

/** What a public consumer — a scoreboard, an unauthenticated API — may see. */
export interface PublicEvent {
  id: number;
  eventType: DomainEventType;
  entityType: string;
  entityId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  /**
   * Paths the catalogue names as public but whose value this projection would
   * not vouch for — a structure whose shape the federation has not declared.
   *
   * Returned rather than dropped in silence so a public surface can render
   * "not published by the federation" instead of implying the event carried
   * nothing. A withheld field is a configuration gap the federation can close;
   * an invisible one is a gap nobody discovers.
   */
  withheld: string[];
}

// ─── Publishing ─────────────────────────────────────────────────────────────

export interface PublishInput {
  eventType: DomainEventType;
  entityType: string;
  entityId: string | number;
  payload: Record<string, unknown>;
  /** Omitted means the catalogue floor — never something more permissive. */
  classification?: Classification;
  actor?: Principal | { userId?: number | null; label?: string | null } | null;
  /**
   * The producer's own idempotency key for this LOGICAL event: the same business
   * fact published twice must carry the same correlationId. See `publish()` for
   * what that buys and what it does not.
   */
  correlationId?: string | null;
  /**
   * When the fact HAPPENED, if that is not now — a result finalised at 14:03 and
   * appended at 14:05 is two different timestamps, and conflating them makes the
   * feed lie about the day's timeline. `publishedAt` always records the append.
   */
  occurredAt?: Date;
}

export interface PublishResult {
  event: DomainEventRow;
  /** True when this correlationId was already on the feed; nothing was appended. */
  duplicate: boolean;
}

function actorOf(actor: PublishInput['actor']): { userId: number | null; label: string | null } {
  if (!actor) return { userId: null, label: null };
  const label = 'label' in actor && actor.label ? String(actor.label) : null;
  const userId = 'userId' in actor && actor.userId != null ? Number(actor.userId) : null;
  return { userId, label };
}

/**
 * Append one event to the feed.
 *
 * CLASSIFICATION. `classification` may raise an event's sensitivity above the
 * catalogue floor but never lower it: a caller passing 'public' for a
 * safeguarding event is refused rather than obeyed. Omitting it takes the floor,
 * and an event type with no catalogue entry is refused outright — an
 * unrecognised event has no known sensitivity, and the safe answer to "how
 * private is this?" is never "not very".
 *
 * IDEMPOTENCY, honestly stated. When `correlationId` is given, an event already
 * on the feed with the same (eventType, entityType, entityId, correlationId) is
 * returned as `duplicate: true` and NOTHING is appended — PROVIDED the fact
 * being republished is the same fact. A republish carrying a DIFFERENT payload
 * or a different classification is refused with `correlation_conflict` rather
 * than reported as a duplicate: the feed is append-only, so the first event
 * stands either way, and quietly answering "duplicate" would send the producer
 * away believing the feed now carries its corrected version when it does not.
 * The way to change what the feed says is a corrective event, and the producer
 * has to be told that rather than left to assume otherwise.
 *
 * Two guards implement the duplicate case:
 *   · a read-then-write check, which catches the ordinary retry; and
 *   · a unique-violation catch, which is what would make it airtight — but only
 *     once the federation adds the matching unique index.
 * WITHOUT that index, two truly simultaneous publishes can both find nothing and
 * both insert, leaving two rows for one fact. This is written so that the index
 * is the only thing that has to change. Claiming "idempotent" while relying on a
 * read-then-write alone would be a promise this module cannot keep — and a
 * consumer would be the one to discover it.
 *
 * SHARED-SCHEMA NOTE — the index this wants:
 *   CREATE UNIQUE INDEX domain_events_correlation_uk ON domain_events
 *     (event_type, entity_type, entity_id, correlation_id)
 *     WHERE correlation_id IS NOT NULL;
 */
export async function publish(db: DB, input: PublishInput): Promise<PublishResult> {
  const spec = specFor(input.eventType);
  if (!spec) {
    throw new DomainEventError(
      'unknown_event_type',
      `'${input.eventType}' is not a published event type. Add it to EVENT_TYPES before publishing it.`
    );
  }

  const entityId = String(input.entityId ?? '').trim();
  if (!entityId) throw new DomainEventError('bad_entity', 'An event must name the entity it is about.');
  if (!input.entityType?.trim()) {
    throw new DomainEventError('bad_entity', 'An event must name the entity type it is about.');
  }
  if (input.payload == null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new DomainEventError('bad_payload', 'An event payload must be an object.');
  }

  const classification = input.classification ?? spec.floor;
  if (!(classification in RANK)) {
    throw new DomainEventError('bad_classification', `Unknown classification '${classification}'.`);
  }
  if (RANK[classification] < RANK[spec.floor]) {
    throw new DomainEventError(
      'classification_too_low',
      `${input.eventType} may not be published below '${spec.floor}'; '${classification}' was requested.`
    );
  }

  const correlationId = input.correlationId?.trim() || null;
  const now = new Date();

  if (correlationId) {
    const existing = await findByCorrelation(db, input.eventType, input.entityType, entityId, correlationId);
    if (existing) return asDuplicate(existing, input, classification);
  }

  const actor = actorOf(input.actor);

  try {
    const [row] = await db.insert(s.domainEvents).values({
      eventType: input.eventType,
      entityType: input.entityType,
      entityId,
      payload: input.payload,
      classification,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      correlationId,
      occurredAt: input.occurredAt ?? now,
      publishedAt: now,
    }).returning();
    return { event: row as DomainEventRow, duplicate: false };
  } catch (err) {
    if (correlationId && isUniqueViolation(err)) {
      const existing = await findByCorrelation(db, input.eventType, input.entityType, entityId, correlationId);
      if (existing) return asDuplicate(existing, input, classification);
    }
    throw err;
  }
}

/**
 * Key order and JSON round-tripping are not differences. A payload that came
 * back out of jsonb has been through JSON already, so the incoming one is put
 * through it too — otherwise a Date the producer passed would compare unequal to
 * the ISO string the database stored, and every retry would look like a conflict.
 */
function canonicalJson(value: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = normalise((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalise(JSON.parse(JSON.stringify(value ?? null))));
}

/**
 * Decide whether a republish under an existing correlationId is the same fact.
 *
 * Classification counts as part of the fact: a producer republishing the same
 * payload at a HIGHER sensitivity has decided the first row is under-protected,
 * and the first row cannot be edited to match. Reporting that as a harmless
 * duplicate leaves the feed carrying the more permissive classification with
 * nobody aware of it.
 */
function asDuplicate(
  existing: DomainEventRow,
  input: PublishInput,
  classification: Classification
): PublishResult {
  const payloadDiffers = canonicalJson(existing.payload) !== canonicalJson(input.payload);
  const classDiffers = existing.classification !== classification;
  if (payloadDiffers || classDiffers) {
    throw new DomainEventError(
      'correlation_conflict',
      `correlationId '${input.correlationId}' is already on the feed as event ${existing.id} ` +
      `with a different ${payloadDiffers ? 'payload' : 'classification'}. The feed is append-only: ` +
      'event ' + existing.id + ' stands. Publish a corrective event rather than reusing the key.'
    );
  }
  return { event: existing, duplicate: true };
}

async function findByCorrelation(
  db: DB,
  eventType: string,
  entityType: string,
  entityId: string,
  correlationId: string
): Promise<DomainEventRow | null> {
  const rows = await db.select().from(s.domainEvents).where(and(
    eq(s.domainEvents.eventType, eventType),
    eq(s.domainEvents.entityType, entityType),
    eq(s.domainEvents.entityId, entityId),
    eq(s.domainEvents.correlationId, correlationId)
  )).orderBy(asc(s.domainEvents.id)).limit(1);
  return (rows[0] as DomainEventRow) ?? null;
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * The classification a principal may read up to.
 *
 * Derived from the RBAC engine, never from a local role list. `can(p, action,
 * {})` with an empty resource matches only a NATIONAL binding — that is exactly
 * the distinction that matters here, and it is expressed through the policy
 * module rather than by reading role names locally.
 *
 * Why national reach is the dividing line: the feed carries no state, district or
 * dojo columns, so scope cannot be applied to it row by row. Classification is
 * therefore the only gate available, and a state or dojo administrator must not
 * inherit a national officer's clearance over a national feed.
 *
 * Deny by default: an unrecognised or unbound principal reads the public feed
 * and nothing else.
 */
export function clearanceFor(principal: Principal | null | undefined): Classification {
  if (!principal) return 'public';
  if (can(principal, 'safeguarding:read', {})) return 'highly_restricted';
  if (can(principal, 'audit:read', {})) return 'restricted';
  if (can(principal, 'person:read_pii', {}) || can(principal, 'finance:read', {})) return 'confidential';
  // Scoped administrators: real authority over people, but no national reach.
  if (canAnywhere(principal, 'person:read_pii')) return 'official';
  if (canAnywhere(principal, 'content:read')) return 'member';
  return 'public';
}

export interface FeedQuery {
  /** Exclusive: return events with id strictly greater than this. */
  sinceId?: number;
  eventTypes?: DomainEventType[];
  entityType?: string;
  entityId?: string | number;
  limit?: number;
  /**
   * A ceiling the caller imposes on ITSELF, never a way to raise its own: the
   * effective clearance is the LOWER of this and what the principal holds.
   *
   * An internal page that is mirrored publicly pins this, so it renders the same
   * whoever happens to be signed in — otherwise an administrator reviewing that
   * page would see more than it shows the public, and would be the last person
   * to notice the difference.
   */
  upTo?: Classification;
}

export interface FeedResult {
  /** The clearance actually applied. Returned so a short read is explainable. */
  clearance: Classification;
  events: DomainEventRow[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * A bound that is not a number is not a bound.
 *
 * NaN and Infinity pass through Math.max/Math.min untouched and reach the query
 * as a broken limit, so a caller doing `Number(searchParams.get('limit'))` on
 * absent or junk input would get an error at the driver at best — and any change
 * that made that path lenient would get an unbounded read. Anything not finite
 * takes the default, which is the only answer that cannot widen a query.
 */
function boundedCount(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(1, n), max);
}

/**
 * The one place a classification ceiling is turned into SQL.
 *
 * The filter is an IN list built from the ladder and applied in the query, not a
 * post-filter in JavaScript: a restricted row must never be fetched into the
 * process that is about to serialise a response, because sooner or later
 * somebody adds a field to that serialisation.
 */
async function selectEvents(db: DB, ceiling: Classification, query: FeedQuery): Promise<DomainEventRow[]> {
  const allowed = CLASSIFICATIONS.filter((c) => RANK[c] <= RANK[ceiling]);

  const where = [inArray(s.domainEvents.classification, allowed)];
  if (query.sinceId != null) where.push(gt(s.domainEvents.id, query.sinceId));
  if (query.eventTypes?.length) where.push(inArray(s.domainEvents.eventType, query.eventTypes as string[]));
  if (query.entityType) where.push(eq(s.domainEvents.entityType, query.entityType));
  if (query.entityId != null) where.push(eq(s.domainEvents.entityId, String(query.entityId)));

  const limit = boundedCount(query.limit, DEFAULT_LIMIT, MAX_LIMIT);

  // Ordered by id, not by a timestamp. `id` is the only total order the feed
  // has: two events can share an occurredAt to the microsecond, and a clock that
  // steps backwards would otherwise reorder history.
  const rows = await db.select().from(s.domainEvents)
    .where(and(...where))
    .orderBy(asc(s.domainEvents.id))
    .limit(limit);

  return rows as DomainEventRow[];
}

/**
 * Read RAW events, in id order, never returning anything above the caller's
 * clearance.
 *
 * This returns whole events, payloads included, so it is an internal surface.
 * `ctx` may be null — that is an unauthenticated caller, and it reads only what
 * is classified 'public', which in practice is almost nothing. That is not an
 * oversight: the public does not read the raw feed, it reads `publicFeed()`,
 * where every field has been named in advance.
 */
export async function readFeed(
  db: DB,
  ctx: { principal?: Principal | null } | null,
  query: FeedQuery = {}
): Promise<FeedResult> {
  const held = clearanceFor(ctx?.principal);
  const clearance = query.upTo ? atMost(query.upTo, held) : held;
  return { clearance, events: await selectEvents(db, clearance, query) };
}

// ─── The projector ──────────────────────────────────────────────────────────
//
// A one-level allowlist is not an allowlist. `publicFields: ['placings']` reads
// like a decision that placings are public, but it publishes whatever the
// producer happened to put inside them — and the thing inside a placing is a
// competitor. The allowlist below therefore applies at EVERY depth: a declared
// name publishes a JSON scalar (or an array of scalars) and nothing else, and
// reaching inside a structure requires declaring the path.
//
// Fail closed, and say so: a value whose shape has not been declared is withheld
// and NAMED, so the federation sees a configuration gap rather than a blank.

interface FieldNode {
  /** Declared in its own right, i.e. as a whole value rather than a prefix. */
  leaf: boolean;
  children: Map<string, FieldNode>;
}

function isJsonScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Compiled path trees, memoised per catalogue entry — the catalogue is static. */
const PATH_TREES = new WeakMap<EventTypeSpec, Map<string, FieldNode>>();

function allowedPaths(spec: EventTypeSpec): Map<string, FieldNode> {
  let tree = PATH_TREES.get(spec);
  if (!tree) {
    tree = compilePaths(spec.publicFields);
    PATH_TREES.set(spec, tree);
  }
  return tree;
}

function compilePaths(publicFields: readonly string[]): Map<string, FieldNode> {
  const tree = new Map<string, FieldNode>();
  for (const path of publicFields) {
    let level = tree;
    let node: FieldNode | undefined;
    for (const part of path.split('.')) {
      node = level.get(part);
      if (!node) {
        node = { leaf: false, children: new Map() };
        level.set(part, node);
      }
      level = node.children;
    }
    if (node) node.leaf = true;
  }
  return tree;
}

type Projected = { ok: true; value: unknown } | { ok: false };
const WITHHOLD: Projected = { ok: false };

function projectValue(value: unknown, node: FieldNode): Projected {
  if (node.children.size === 0) {
    // Declared as a whole value. Only scalars travel; a structure here has
    // undeclared contents, and undeclared contents are the leak.
    if (isJsonScalar(value)) return { ok: true, value };
    if (Array.isArray(value) && value.every(isJsonScalar)) return { ok: true, value };
    return WITHHOLD;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      const projected = projectObject(element, node.children);
      // One element the projector cannot vouch for withholds the WHOLE list. A
      // partial placings list is worse than none: it looks complete, and the
      // person missing from it is the one with a complaint.
      if (!projected.ok) return WITHHOLD;
      out.push(projected.value);
    }
    return { ok: true, value: out };
  }

  return projectObject(value, node.children);
}

/**
 * Project a payload against an explicit path allowlist.
 *
 * Exported because this is where the whole public-surface guarantee lives, and
 * the nested case cannot be exercised through the catalogue until MMAKF declares
 * a nested path — which is the federation's editorial decision, not this
 * module's to make up for the sake of test coverage. A caller building a new
 * public surface can also use it directly on a non-event payload.
 */
export function projectPayload(
  payload: Record<string, unknown> | null | undefined,
  publicFields: readonly string[]
): { payload: Record<string, unknown>; withheld: string[] } {
  const source = (payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const withheld: string[] = [];
  for (const [key, node] of compilePaths(publicFields)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const projected = projectValue(source[key], node);
    if (projected.ok) out[key] = projected.value;
    else withheld.push(key);
  }
  return { payload: out, withheld };
}

function projectObject(value: unknown, children: Map<string, FieldNode>): Projected {
  // Paths were declared into this value, so a scalar or a null here means the
  // producer's shape and the catalogue's disagree. Publishing on a disagreement
  // is how the wrong field ends up public.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return WITHHOLD;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of children) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const projected = projectValue(source[key], child);
    if (!projected.ok) return WITHHOLD;
    out[key] = projected.value;
  }
  return { ok: true, value: out };
}

/**
 * Redact an event down to its public projection, or null when it has none.
 *
 * This is what lets ONE publish call feed both an internal dashboard and a
 * public scoreboard. Publishing the same fact twice, once for each audience, is
 * how the two surfaces start disagreeing.
 *
 * Two independent refusals, because one is not enough: the event's own
 * classification must be at or below the public ceiling, AND the catalogue must
 * name the fields. Either alone would be a single point of failure.
 */
export function toPublicProjection(event: DomainEventRow | null | undefined): PublicEvent | null {
  if (!event) return null;
  const spec = specFor(event.eventType);
  if (!spec) return null;                                   // unknown type → nothing is public
  if (!spec.publicFields.length) return null;
  if (RANK[event.classification] > RANK[PUBLIC_PROJECTION_CEILING]) return null;

  const { payload, withheld } = projectPayload(event.payload, spec.publicFields);

  // No actor, no correlationId, no classification: who recorded a result, and
  // under which internal key, is not the public's business — and the actor is
  // the field most likely to name a person.
  return {
    id: event.id,
    eventType: event.eventType as DomainEventType,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: event.occurredAt instanceof Date
      ? event.occurredAt.toISOString()
      : String(event.occurredAt),
    payload,
    withheld,
  };
}

/**
 * The feed as an anonymous consumer — a scoreboard, an unauthenticated API —
 * sees it.
 *
 * WHY THIS DOES NOT SIMPLY CALL `readFeed()` WITH A NULL PRINCIPAL. Two
 * different questions are being answered, and conflating them produces either a
 * leak or an empty page. `classification` says who may read the RAW event, and
 * almost nothing is raw-public: a MATCH_COMPLETED payload can legitimately carry
 * an injury note. `publicFields` says which named fields of that same event may
 * be shown to anyone. So this reads up to the public-projection ceiling and then
 * redacts — the redaction is the gate here, not the classification, and it is an
 * allowlist, so a payload key nobody anticipated cannot travel through it.
 *
 * Events with no public form drop out entirely rather than appearing empty.
 */
export async function publicFeed(db: DB, query: FeedQuery = {}): Promise<PublicEvent[]> {
  const events = await selectEvents(db, PUBLIC_PROJECTION_CEILING, query);
  return events.map(toPublicProjection).filter((e): e is PublicEvent => e !== null);
}

// ─── Consumer cursors ───────────────────────────────────────────────────────
//
// WHERE THE CURSOR LIVES, and why it is not its own table.
//
// A per-consumer cursor is a named integer counter that must survive a restart
// and advance atomically. `id_sequences` is exactly that — (prefix, year) unique,
// `next` an integer, already used for atomic allocation — and this module owns no
// migration, so inventing a table here would mean shipping DDL outside the
// migration chain. The reuse is namespaced twice over so it can never collide
// with a federation-ID prefix: the key carries a ':' (federation IDs are
// MMAKF-<PREFIX>-<year>-<n> and no prefix contains one) and the year is 0, which
// is never a real year.
//
// The trade-off is named rather than hidden: `next` here means "highest event id
// this consumer has finished with", which is a different meaning from the
// allocator's "next number to hand out". A dedicated `domain_event_cursors` table
// is the right long-term home and belongs in the next migration; nothing outside
// the three functions below would change.

const CURSOR_PREFIX = 'EVENTCURSOR';
const CURSOR_YEAR = 0;
const CONSUMER_NAME = /^[a-z0-9][a-z0-9_.:-]{1,60}$/i;

function cursorKey(consumer: string): string {
  if (!CONSUMER_NAME.test(consumer ?? '')) {
    throw new DomainEventError(
      'bad_consumer_name',
      'A consumer name must be 2–61 characters of letters, digits, dot, dash, underscore or colon.'
    );
  }
  return `${CURSOR_PREFIX}:${consumer}`;
}

/** The highest event id this consumer has finished with. 0 = it has read nothing. */
export async function cursorFor(db: DB, consumer: string): Promise<number> {
  const rows = await db.select().from(s.idSequences).where(and(
    eq(s.idSequences.prefix, cursorKey(consumer)),
    eq(s.idSequences.year, CURSOR_YEAR)
  )).limit(1);
  return Number(rows[0]?.next ?? 0);
}

/**
 * Move a cursor forward.
 *
 * greatest(), never a plain assignment: two runners of the same consumer can
 * overlap, and the slower one finishing second must not rewind the feed and
 * cause a re-delivery storm. Forward is the only safe direction here; the one
 * way back is `resetCursor()`, which is deliberate and audited.
 */
async function advanceCursor(db: DB, consumer: string, toId: number): Promise<void> {
  await db.insert(s.idSequences)
    .values({ prefix: cursorKey(consumer), year: CURSOR_YEAR, next: toId })
    .onConflictDoUpdate({
      target: [s.idSequences.prefix, s.idSequences.year],
      set: { next: sql`greatest(${s.idSequences.next}, ${toId})` },
    });
}

export type EventHandler = (event: DomainEventRow) => void | Promise<void>;

export interface ConsumeOptions {
  batchSize?: number;
  /**
   * Refuse to hand this consumer anything above the given level. Events above it
   * are stepped over and counted as `skipped`, and the cursor DOES advance past
   * them — a consumer that is not entitled to an event will never become
   * entitled to it, so stopping would wedge it permanently on a row it must
   * never see.
   */
  maxClassification?: Classification;
}

export interface ConsumeResult {
  consumer: string;
  /** Cursor before and after this run. */
  from: number;
  to: number;
  delivered: number;
  skipped: number;
  /**
   * WHICH events were stepped over for classification, not merely how many.
   *
   * The cursor advances past a skipped event, so it will never be offered to
   * this consumer again; "skipped: 3" leaves nobody able to say what those three
   * were. An operator asking why a downstream surface is missing a fact has to
   * be able to reconstruct the answer from what this call returned.
   */
  skippedEventIds: number[];
  /** The event whose handler threw. The cursor stops immediately before it. */
  failedAtEventId: number | null;
  failureMessage: string | null;
  /** There is probably more waiting: the batch filled, or it stopped on a failure. */
  more: boolean;
}

const DEFAULT_BATCH = 100;
const MAX_BATCH = 1000;

/**
 * Process a consumer's unread events, in id order, advancing its own cursor.
 *
 * SAFE TO RE-RUN. The cursor is the only state. Re-running after a success is a
 * no-op; re-running after a failure retries from the failing event.
 *
 * A FAILING CONSUMER DOES NOT ADVANCE PAST THE FAILURE. A handler that throws
 * stops the batch at that event, and the cursor is left pointing at the last
 * event that actually succeeded. The feed is a chain of state changes; skipping
 * a failure would leave that consumer's view permanently derived from an
 * incomplete history, and nothing downstream would ever know it had happened.
 *
 * AND IT DOES NOT BLOCK ANY OTHER CONSUMER. Cursors are per consumer and no lock
 * is held across a handler call, so notifications being broken cannot stall
 * analytics.
 *
 * DELIVERY IS AT-LEAST-ONCE FOR ANYTHING THE CURSOR SEES. The cursor is written
 * after the batch, so a process killed mid-batch re-delivers events whose
 * handler had already run. HANDLERS MUST THEREFORE BE IDEMPOTENT, and the feed
 * offers two keys to do it with:
 *   · `event.id` — unique per appended row. A consumer that records the ids it
 *     has applied, or writes under a uniqueness constraint keyed on
 *     (consumer, event id), is safe against re-delivery.
 *   · `event.correlationId` — the PRODUCER's key for the logical fact. Two rows
 *     can share it if the producer raced (see `publish()`), so a consumer that
 *     must act once per FACT rather than once per row keys on this instead.
 * Which to use is the consumer's decision and it should be a conscious one: id
 * means "once per row", correlationId means "once per fact".
 *
 * WHERE AT-LEAST-ONCE STOPS BEING TRUE, stated because a consumer that silently
 * misses one event is exactly the failure this module exists to prevent.
 * `domain_events.id` is a serial: the number is taken when a publish BEGINS, not
 * when it commits. Two concurrent publishers can therefore commit out of order —
 * the transaction holding id 41 commits after the one holding id 42. A consumer
 * reading in between sees 42, advances its cursor to 42, and event 41 appears a
 * moment later BELOW the cursor, where `id > cursor` will never select it again.
 * It is not re-delivered, it is not delivered. Nothing in this file can detect
 * it: to the cursor, that consumer is perfectly caught up, and `cursorReport()`
 * will show a lag of zero.
 *
 * Two remedies exist and neither belongs to this module alone:
 *   · order the feed by COMMIT rather than by allocation — a commit-ordered
 *     column, which needs a migration and a producer-side change; or
 *   · hold consumers a fixed interval behind the head, so a row cannot appear
 *     behind a cursor unless a transaction outlived the interval. That trades
 *     delivery latency for completeness, and how much latency the live
 *     scoreboard may carry is the federation's call, not an engineer's.
 * Until one is taken, a consumer whose correctness cannot survive a missed event
 * must reconcile against its source tables rather than trust the cursor alone.
 * Sequential publishers — the current callers, all of which publish inside one
 * request — are not exposed to this.
 */
export async function consume(
  db: DB,
  consumer: string,
  handler: EventHandler,
  opts: ConsumeOptions = {}
): Promise<ConsumeResult> {
  const from = await cursorFor(db, consumer);
  const batchSize = boundedCount(opts.batchSize, DEFAULT_BATCH, MAX_BATCH);
  const cap = opts.maxClassification;
  if (cap && !(cap in RANK)) {
    throw new DomainEventError('bad_classification', `Unknown classification '${cap}'.`);
  }

  // The whole batch is read regardless of classification and then stepped over.
  // Filtering in SQL instead would silently shrink the batch and make `more` lie
  // about whether the consumer had caught up.
  const rows = await db.select().from(s.domainEvents)
    .where(gt(s.domainEvents.id, from))
    .orderBy(asc(s.domainEvents.id))
    .limit(batchSize) as DomainEventRow[];

  let to = from;
  let delivered = 0;
  const skippedEventIds: number[] = [];
  let failedAtEventId: number | null = null;
  let failureMessage: string | null = null;

  for (const event of rows) {
    if (cap && RANK[event.classification] > RANK[cap]) {
      skippedEventIds.push(event.id);
      to = event.id;
      continue;
    }
    try {
      await handler(event);
    } catch (err) {
      failedAtEventId = event.id;
      failureMessage = err instanceof Error ? err.message : String(err);
      break;                                   // `to` stays at the last success
    }
    delivered++;
    to = event.id;
  }

  if (to > from) await advanceCursor(db, consumer, to);

  return {
    consumer,
    from,
    to,
    delivered,
    skipped: skippedEventIds.length,
    skippedEventIds,
    failedAtEventId,
    failureMessage,
    more: failedAtEventId != null || rows.length === batchSize,
  };
}

/**
 * Move a consumer's cursor deliberately — a replay, or a skip past an event a
 * broken handler can never process.
 *
 * The one operation that can move a cursor BACKWARDS, so it is the one that is
 * gated and audited. A replay re-runs every downstream effect the consumer has;
 * that is an administrative act with consequences, not a maintenance detail, and
 * the record has to show who ordered it and why.
 *
 * GATED ON A NATIONAL BINDING, via `can(p, 'audit:read', {})` — the same test
 * `clearanceFor()` applies, and for the same reason. The feed carries no state,
 * district or dojo column, so a cursor is a NATIONAL object; there is no such
 * thing as replaying one state's share of it. `assertCanAnywhere` would have
 * been the wrong gate and an outright contradiction: a dojo-scoped holder of
 * `audit:read` would have been able to order a replay of every consumer in the
 * federation while being unable to read a single event above 'public'.
 */
export async function resetCursor(
  db: DB,
  ctx: AuditContext,
  consumer: string,
  toEventId: number
): Promise<void> {
  assertCan(ctx.principal, 'audit:read', {});
  if (!ctx.reason?.trim()) {
    throw new DomainEventError('reason_required', 'Moving a consumer cursor requires a reason.');
  }
  if (!Number.isInteger(toEventId) || toEventId < 0) {
    throw new DomainEventError('bad_cursor', 'A cursor position must be a non-negative integer.');
  }

  const key = cursorKey(consumer);
  const before = await cursorFor(db, consumer);

  await db.insert(s.idSequences)
    .values({ prefix: key, year: CURSOR_YEAR, next: toEventId })
    .onConflictDoUpdate({
      target: [s.idSequences.prefix, s.idSequences.year],
      set: { next: toEventId },
    });

  await writeAudit(db, ctx, {
    entityType: 'domain_event_cursor',
    entityId: consumer,
    action: 'update',
    oldValue: { cursor: before },
    newValue: { cursor: toEventId },
  });
}

/**
 * Every consumer cursor with its lag, for an operations screen.
 *
 * Gated, because every other read in this module is. It names the federation's
 * internal consumers, the size of the feed and how far behind each one is —
 * which is an operational map of what the federation runs and where it is
 * currently blind. Same national `audit:read` test as `resetCursor()`, so the
 * authority to see a cursor and the authority to move it stay together.
 */
export async function cursorReport(
  db: DB,
  ctx: { principal?: Principal | null } | null
): Promise<{
  head: number;
  consumers: Array<{ consumer: string; cursor: number; lag: number }>;
}> {
  assertCan(ctx?.principal, 'audit:read', {});

  const headRows = await db
    .select({ head: sql<number>`coalesce(max(${s.domainEvents.id}), 0)::int` })
    .from(s.domainEvents);
  const head = Number(headRows[0]?.head ?? 0);

  const rows = await db.select().from(s.idSequences).where(and(
    eq(s.idSequences.year, CURSOR_YEAR),
    sql`${s.idSequences.prefix} LIKE ${CURSOR_PREFIX + ':%'}`
  ));

  return {
    head,
    consumers: rows
      .map((r: any) => ({
        consumer: String(r.prefix).slice(CURSOR_PREFIX.length + 1),
        cursor: Number(r.next),
        lag: Math.max(0, head - Number(r.next)),
      }))
      .sort((a: { consumer: string }, b: { consumer: string }) => a.consumer.localeCompare(b.consumer)),
  };
}
