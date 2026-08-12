// Federation record operations (Wave 2a).
//
// This module owns the invariants that make federation records trustworthy:
//   · federation IDs are sequence-allocated, never time-derived (§73);
//   · rank history is append-only and current rank is derived (§31, §72);
//   · every privileged mutation writes an audit_events row (§52);
//   · scope filters come from the RBAC module, applied in SQL (§38).
//
// All functions take an explicit Principal — nothing here trusts ambient state.

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { isUniqueViolation } from './pgerror';
import { assertCan, assertCanAnywhere, visibleScopes, type Action, type Principal, type Resource } from '@/lib/rbac';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

// ─── Federation ID allocation (§73) ─────────────────────────────────────────

/**
 * Allocate the next federation ID for a prefix, e.g. MMAKF-MEM-2026-000001.
 * Uses an atomic UPDATE ... RETURNING so concurrent allocation cannot collide
 * or reuse a number.
 */
export async function allocateFederationId(
  db: DB,
  prefix: string,
  year = new Date().getFullYear()
): Promise<string> {
  await db
    .insert(s.idSequences)
    .values({ prefix, year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });

  const rows = await db
    .update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, prefix), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });

  const allocated = (rows[0]?.next ?? 1) - 1;
  return `MMAKF-${prefix}-${year}-${String(allocated).padStart(6, '0')}`;
}

// ─── Audit (§52) ────────────────────────────────────────────────────────────

export interface AuditContext {
  principal: Principal;
  ip?: string | null;
  requestId?: string | null;
  reason?: string | null;
  authority?: string | null;
}

function hashIp(ip?: string | null): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

export async function writeAudit(
  db: DB,
  ctx: AuditContext,
  entry: {
    entityType: string;
    entityId?: string | number | null;
    action: (typeof s.auditAction.enumValues)[number];
    oldValue?: unknown;
    newValue?: unknown;
  }
): Promise<void> {
  await db.insert(s.auditEvents).values({
    actorUserId: ctx.principal.userId ?? null,
    actorLabel: ctx.principal.label,
    actorRole: ctx.principal.bindings[0]?.role ?? null,
    actorIpHash: hashIp(ctx.ip),
    entityType: entry.entityType,
    entityId: entry.entityId == null ? null : String(entry.entityId),
    action: entry.action,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    reason: ctx.reason ?? null,
    authority: ctx.authority ?? null,
    requestId: ctx.requestId ?? null,
  });
}

// ─── Scope helpers ──────────────────────────────────────────────────────────

/**
 * Build a SQL condition restricting rows to the principal's scope for an
 * action. Returns null when the principal has national reach, and `sql\`false\``
 * when they have none — so callers always filter in the query (§53 IDOR).
 */
function scopeCondition(principal: Principal, action: Action, table: any) {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const clauses: any[] = [];
  if (scopes.states.length && table.stateUnitId) clauses.push(inArray(table.stateUnitId, scopes.states));
  if (scopes.districts.length && table.districtUnitId) clauses.push(inArray(table.districtUnitId, scopes.districts));
  if (scopes.dojos.length && table.dojoId) clauses.push(inArray(table.dojoId, scopes.dojos));
  if (!clauses.length) return sql`false`;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

// ─── Hierarchy integrity (§54 relational integrity, §53 scope laundering) ───

export class HierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HierarchyError';
  }
}

export interface Placement {
  stateUnitId: number | null;
  districtUnitId: number | null;
  dojoId: number | null;
}

/**
 * Resolve a caller-supplied placement against the real unit hierarchy.
 *
 * Foreign keys alone prove each id EXISTS; they do not prove the ids agree with
 * one another. Without this check a district administrator could file a record
 * with their own districtUnitId but another state's stateUnitId — passing the
 * scope check on the district column while landing the row in a state they have
 * no authority over. The row is then visible and editable by that other state.
 *
 * We validate rather than silently correct: a mismatch is a bug or an attack,
 * and quietly rewriting it would hide both.
 */
export async function resolvePlacement(
  db: DB,
  input: { stateUnitId?: number | null; districtUnitId?: number | null; dojoId?: number | null }
): Promise<Placement> {
  const stateUnitId = input.stateUnitId ?? null;
  const districtUnitId = input.districtUnitId ?? null;
  const dojoId = input.dojoId ?? null;

  if (districtUnitId != null) {
    const d = (await db.select().from(s.districtUnits).where(eq(s.districtUnits.id, districtUnitId)).limit(1))[0];
    if (!d) throw new HierarchyError('Unknown district unit');
    if (stateUnitId != null && d.stateUnitId !== stateUnitId) {
      throw new HierarchyError('Hierarchy inconsistent: district does not belong to the given state');
    }
  }

  if (dojoId != null) {
    const dj = (await db.select().from(s.dojos).where(eq(s.dojos.id, dojoId)).limit(1))[0];
    if (!dj) throw new HierarchyError('Unknown dojo');
    if (stateUnitId != null && dj.stateUnitId !== stateUnitId) {
      throw new HierarchyError('Hierarchy inconsistent: dojo does not belong to the given state');
    }
    if (districtUnitId != null && dj.districtUnitId != null && dj.districtUnitId !== districtUnitId) {
      throw new HierarchyError('Hierarchy inconsistent: dojo does not belong to the given district');
    }
  }

  if (stateUnitId != null) {
    const st = (await db.select().from(s.stateUnits).where(eq(s.stateUnits.id, stateUnitId)).limit(1))[0];
    if (!st) throw new HierarchyError('Unknown state unit');
  }

  return { stateUnitId, districtUnitId, dojoId };
}

/** Where an audited entity sits, so audit reads can be scope-checked. */
async function entityPlacement(db: DB, entityType: string, entityId: string | number): Promise<Resource> {
  const id = Number(entityId);
  if (!Number.isFinite(id)) return {};                     // unresolvable -> national only

  const fromPerson = async (personId: number): Promise<Resource> => {
    const p = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
    return p ? { stateUnitId: p.stateUnitId, districtUnitId: p.districtUnitId, dojoId: p.dojoId } : {};
  };

  switch (entityType) {
    case 'person':
      return fromPerson(id);
    case 'membership': {
      const m = (await db.select().from(s.memberships).where(eq(s.memberships.id, id)).limit(1))[0];
      return m ? fromPerson(m.personId) : {};
    }
    case 'rank_record': {
      const r = (await db.select().from(s.rankRecords).where(eq(s.rankRecords.id, id)).limit(1))[0];
      return r ? fromPerson(r.personId) : {};
    }
    case 'dojo': {
      const d = (await db.select().from(s.dojos).where(eq(s.dojos.id, id)).limit(1))[0];
      return d ? { stateUnitId: d.stateUnitId, districtUnitId: d.districtUnitId, dojoId: d.id } : {};
    }
    default:
      // Unknown entity types are treated as national records: only a principal
      // with national reach may read their trail. Fail closed.
      return {};
  }
}

// ─── People ─────────────────────────────────────────────────────────────────

export interface NewPerson {
  fullName: string;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  gender?: string | null;
}

export async function createPerson(
  db: DB,
  ctx: AuditContext,
  input: NewPerson
): Promise<{ id: number; federationId: string }> {
  // Validate the hierarchy first so the authorisation check below is made
  // against a placement that actually exists, not one the caller asserted.
  const placement = await resolvePlacement(db, input);
  assertCan(ctx.principal, 'person:write', placement);

  const federationId = await allocateFederationId(db, 'MEM');
  const rows = await db
    .insert(s.persons)
    .values({ ...input, federationId, status: 'pending' })
    .returning({ id: s.persons.id, federationId: s.persons.federationId });

  await writeAudit(db, ctx, {
    entityType: 'person',
    entityId: rows[0].id,
    action: 'create',
    newValue: { federationId, fullName: input.fullName },
  });
  return rows[0];
}

/** List people the principal is allowed to see, scope-filtered in SQL. */
export async function listPersons(db: DB, principal: Principal, limit = 100) {
  // Gate on holding the action anywhere; scope is enforced by the SQL filter
  // below, so a state admin lists their own state rather than being refused.
  assertCanAnywhere(principal, 'person:read');
  const cond = scopeCondition(principal, 'person:read', s.persons);
  const q = db.select().from(s.persons);
  return cond ? q.where(cond).limit(limit) : q.limit(limit);
}

/**
 * Public register view — the ONLY shape exposed to unauthenticated verification.
 * Contains no PII (§66): no dob, gender, email, phone.
 */
export async function publicRegisterEntry(db: DB, federationId: string) {
  const rows = await db
    .select({
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      status: s.persons.status,
      city: s.persons.city,
      stateUnitId: s.persons.stateUnitId,
      dojoId: s.persons.dojoId,
    })
    .from(s.persons)
    .where(eq(s.persons.federationId, federationId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Rank records (§31 append-only, §72 derived current rank) ───────────────


export async function awardRank(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    kind: 'kyu' | 'dan';
    gradeLabel: string;
    gradeOrdinal: number;
    awardedOn: string;
    syllabusVersion?: string | null;
    score?: number | null;
    gradingEventId?: number | null;
  }
): Promise<{ id: number }> {
  const person = (
    await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1)
  )[0];
  if (!person) throw new Error('Unknown person');

  assertCan(ctx.principal, 'rank:award', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  // Supersede — never overwrite — any currently active rank of the same kind,
  // then insert the new one.
  //
  // Concurrent promotions can all observe "no active rank" and all insert. The
  // partial unique index rank_records_one_active_uk makes every loser's insert
  // fail rather than leaving several active ranks. A loser retries: the
  // supersede now finds the winner's row and stands it down, so the award still
  // lands and history keeps EVERY event — the correct append-only outcome.
  //
  // Retries are bounded. With N racers the losers can collide with each other
  // again on the way back in, so a single retry is not sufficient; but each
  // round strictly reduces the contenders, so a small bound converges. Passing
  // the bound means something other than contention is wrong, and we raise it
  // rather than loop.
  const supersedeThenInsert = async () => {
    await db
      .update(s.rankRecords)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(s.rankRecords.personId, input.personId),
          eq(s.rankRecords.kind, input.kind),
          eq(s.rankRecords.status, 'active')
        )
      );
    return db
      .insert(s.rankRecords)
      .values({ ...input, status: 'active' })
      .returning({ id: s.rankRecords.id });
  };

  let rows;
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      rows = await supersedeThenInsert();
      break;
    } catch (err: any) {
      if (attempt >= MAX_ATTEMPTS || !isUniqueViolation(err)) throw err;
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'rank_record',
    entityId: rows[0].id,
    action: 'create',
    newValue: { personId: input.personId, grade: input.gradeLabel, awardedOn: input.awardedOn },
  });
  return rows[0];
}

/** Current rank is DERIVED from the append-only history, never stored twice. */
export async function currentRank(db: DB, personId: number, kind?: 'kyu' | 'dan') {
  const conds = [eq(s.rankRecords.personId, personId), eq(s.rankRecords.status, 'active')];
  if (kind) conds.push(eq(s.rankRecords.kind, kind));
  const rows = await db
    .select()
    .from(s.rankRecords)
    .where(and(...conds))
    .orderBy(desc(s.rankRecords.awardedOn), desc(s.rankRecords.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Full grading history, newest first — including superseded and revoked rows. */
export async function rankHistory(db: DB, personId: number) {
  return db
    .select()
    .from(s.rankRecords)
    .where(eq(s.rankRecords.personId, personId))
    .orderBy(desc(s.rankRecords.awardedOn), desc(s.rankRecords.id));
}

/** Revocation never deletes (§78). */
export async function revokeRank(
  db: DB,
  ctx: AuditContext,
  rankId: number,
  reason: string
): Promise<void> {
  const before = (
    await db.select().from(s.rankRecords).where(eq(s.rankRecords.id, rankId)).limit(1)
  )[0];
  if (!before) throw new Error('Unknown rank record');

  const person = (
    await db.select().from(s.persons).where(eq(s.persons.id, before.personId)).limit(1)
  )[0];
  assertCan(ctx.principal, 'rank:revoke', {
    stateUnitId: person?.stateUnitId,
    districtUnitId: person?.districtUnitId,
    dojoId: person?.dojoId,
  });
  if (!reason || !reason.trim()) throw new Error('Revocation requires a reason');

  await db
    .update(s.rankRecords)
    .set({ status: 'revoked', revokedReason: reason })
    .where(eq(s.rankRecords.id, rankId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'rank_record',
    entityId: rankId,
    action: 'revoke',
    oldValue: { status: before.status },
    newValue: { status: 'revoked' },
  });
}

// ─── Memberships ────────────────────────────────────────────────────────────

/**
 * @deprecated Use `renew()` from src/db/membership.ts.
 *
 * This was the original path to issuing a membership and it enforced NONE of
 * the lifecycle rules: it would happily issue over a REVOKED membership, letting
 * an administrator reverse a federation decision by filling in a form, and it
 * reported no gap when a renewal followed a lapse. Two functions performing the
 * same act with different rules is how a system ends up with two answers, so
 * this one now delegates rather than duplicating.
 *
 * `validTo` is REQUIRED here as it is there — including an explicit null. It was
 * optional before, which meant an omitted term silently became an open-ended
 * membership nobody decided on.
 */
export async function issueMembership(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    category: 'athlete' | 'instructor' | 'dojo' | 'official';
    validFrom: string;
    validTo: string | null;
  }
) {
  const { renew } = await import('@/db/membership');
  const result = await renew(db, ctx, input);
  // The original returned `{ id }`; callers depend on that shape.
  return { id: result.membershipId };
}

export async function auditTrail(db: DB, principal: Principal, entityType: string, entityId: string | number) {
  // Holding audit:read somewhere is not enough — the entity must fall inside the
  // reader's scope, or a state officer could read every other state's history.
  assertCan(principal, 'audit:read', await entityPlacement(db, entityType, entityId));
  return db
    .select()
    .from(s.auditEvents)
    .where(and(eq(s.auditEvents.entityType, entityType), eq(s.auditEvents.entityId, String(entityId))))
    .orderBy(desc(s.auditEvents.at));
}
