// THE OPERATIONAL FEDERATION TEAM — reads and writes over `departments`,
// `team_appointments` and `team_appointment_history`.
//
// Migration 0056 carries the schema reasoning. This file carries the four rules
// that cannot be expressed as a CHECK constraint.
//
// ═══════════════════════════════════════════════════════════════════════════
// 1. `publicTeam()` TAKES NO PRINCIPAL, AND THAT IS THE SECURITY MODEL
// ═══════════════════════════════════════════════════════════════════════════
//
// Every other read in this module takes a `Principal` and filters by scope. The
// public one takes none at all, selects a fixed column list that contains no
// private column, and filters on `published`. It CANNOT be called with a filter
// that widens it, because it accepts no filter — there is no `includeDrafts`
// parameter to be passed `true` by a page that meant well.
//
// The alternative pattern — one function, a `public` flag — is how a public
// page ends up rendering a draft: somebody adds an admin caller, the flag
// defaults the wrong way, and nothing fails. Two functions cannot drift.
//
// ═══════════════════════════════════════════════════════════════════════════
// 2. PUBLICATION IS A SEPARATE ACT UNDER A SEPARATE PERMISSION
// ═══════════════════════════════════════════════════════════════════════════
//
// `createAppointment()` and `updateAppointment()` need `team:write` and CANNOT
// set `published`. Publishing needs `team:publish`, which a STATE_ADMIN does not
// hold. Recording that somebody joined the competition desk and putting their
// name and photograph on the public internet under the federation's masthead
// are different acts, and the second is a public statement about a named
// private individual.
//
// The database backs this up: `team_appointments_publish_ck` refuses to publish
// anything whose status is not `active`, so a draft, a suspended officer and
// somebody who left cannot reach /team even by a direct UPDATE.
//
// ═══════════════════════════════════════════════════════════════════════════
// 3. NOTHING HERE ENDS A MEMBERSHIP, A RANK OR A LOGIN
// ═══════════════════════════════════════════════════════════════════════════
//
// `endAppointment()` closes ONE row. It does not touch `persons.status`, it does
// not revoke a `rank_record`, and it does not disable a `role_binding`.
//
// This is deliberate and it is the §4 requirement made real: one person holds
// many relationships with MMAKF, and a Sensei who stops running the media desk
// is still a Sensei, still a 4th Dan, still a member. A function here that
// helpfully "tidied up" the person's other records would destroy exactly the
// information the one-canonical-person model exists to keep.
//
// The consequence is stated rather than hidden: closing an appointment leaves
// the person's LOGIN untouched. Removing their access is a `role_bindings` act
// under `role:grant`, and the admin screen says so beside the control, because
// an administrator who ends an appointment and believes they have revoked
// access has been misled by the software.
//
// ═══════════════════════════════════════════════════════════════════════════
// 4. THE HISTORY TABLE IS APPEND-ONLY
// ═══════════════════════════════════════════════════════════════════════════
//
// There is no UPDATE and no DELETE against `team_appointment_history` anywhere
// below, and `tests/team.test.ts` asserts that by reading this file's source
// rather than by trusting this paragraph.

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as t from '@/db/team.schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import {
  assertCan, assertCanAnywhere, canAnywhere, visibleScopes, ForbiddenError,
  type Principal,
} from '@/lib/rbac';
import { publish } from '@/lib/domain-events';

type DB = any;

// ─── Failures ───────────────────────────────────────────────────────────────

export type TeamErrorCode =
  | 'no_such_department'
  | 'no_such_appointment'
  | 'no_such_person'
  | 'department_cycle'
  | 'duplicate_appointment'
  | 'bad_scope'
  | 'bad_link'
  | 'bad_period'
  | 'not_publishable'
  | 'already_ended';

export class TeamError extends Error {
  readonly code: TeamErrorCode;
  constructor(code: TeamErrorCode, message: string) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
  }
}

export function isTeamError(err: unknown): err is TeamError {
  return err instanceof TeamError;
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type OrgLevel = (typeof t.orgLevel.enumValues)[number];
export type AppointmentStatus = (typeof t.teamAppointmentStatus.enumValues)[number];

export interface PublicLink {
  label: string;
  url: string;
}

/**
 * The public card. Note what is NOT on it: no email, no telephone that is not an
 * office route, no date of birth, no address, no employment data. Not because a
 * caller is trusted to omit them, but because `publicTeam()` selects this list
 * and no other.
 */
export interface PublicTeamMember {
  appointmentId: number;
  /**
   * The federation id, so a visitor can carry a name to /verify. NOT the
   * internal `persons.id` — that is a database key, and putting it on a public
   * page invites enumeration of the register.
   */
  federationId: string;
  fullName: string;
  photoUrl: string | null;
  title: string;
  orgLevel: OrgLevel;
  department: string | null;
  departmentCode: string | null;
  responsibility: string | null;
  bio: string | null;
  contact: string | null;
  links: PublicLink[];
  scopeType: string;
  /** A place name, when the appointment is scoped to one. Never an id. */
  scopeLabel: string | null;
  sortOrder: number;
}

export interface AdminAppointment extends PublicTeamMember {
  personId: number;
  departmentId: number | null;
  status: AppointmentStatus;
  published: boolean;
  startedOn: string;
  endedOn: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayIso(timeZone = 'Asia/Kolkata'): string {
  // `sv-SE` renders ISO-8601 by default, which is the shortest correct way to
  // get a calendar date in a named zone without a date library.
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date());
}

/**
 * Accept only links that can be safely rendered as an anchor on a public page.
 *
 * HTTPS ONLY. `javascript:` is the obvious one; `data:` is the one people
 * forget, and it is a stored-XSS vector the moment a template renders the URL
 * into an href. `http:` is refused too — a federation publishing a plaintext
 * link in 2026 is a mixed-content warning on its own site.
 *
 * A malformed entry is REFUSED, not dropped. Silently discarding one link out
 * of four leaves an administrator looking at a saved form that lost something
 * without saying so.
 */
export function sanitiseLinks(value: unknown): PublicLink[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TeamError('bad_link', 'Public links must be a list.');
  }
  const out: PublicLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      throw new TeamError('bad_link', 'Each public link must be an object with a label and a url.');
    }
    const label = String((raw as any).label ?? '').trim();
    const url = String((raw as any).url ?? '').trim();
    if (!label) throw new TeamError('bad_link', 'Each public link needs a label.');
    if (label.length > 60) throw new TeamError('bad_link', `Link label '${label.slice(0, 20)}…' is too long.`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TeamError('bad_link', `'${url.slice(0, 40)}' is not a URL.`);
    }
    if (parsed.protocol !== 'https:') {
      throw new TeamError(
        'bad_link',
        `Public links must be https. '${parsed.protocol}' is refused — it cannot be rendered safely on a public page.`
      );
    }
    out.push({ label, url: parsed.toString() });
  }
  if (out.length > 8) throw new TeamError('bad_link', 'At most eight public links.');
  return out;
}

/**
 * Restrict a query to the appointments the principal may see.
 *
 * Written against THIS table's scope columns rather than reusing
 * `scopeCondition()` from federation.ts, which looks for `stateUnitId` /
 * `districtUnitId` / `dojoId`. Passing this table to that helper finds none of
 * those names, falls through to `sql\`false\`` and returns an empty list to a
 * legitimate state administrator — a fail-closed bug, but still a bug, and a
 * silent one.
 *
 * A national appointment is visible to a scoped holder: the state coordinator
 * needs to see who the national credential registrar is. What they may not do
 * is WRITE one, which `assertWriteScope()` below enforces separately.
 */
function readScope(principal: Principal) {
  const scopes = visibleScopes(principal, 'team:read');
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const clauses: any[] = [eq(t.teamAppointments.scopeType, 'national')];
  if (scopes.states.length) clauses.push(inArray(t.teamAppointments.scopeStateUnitId, scopes.states));
  if (scopes.districts.length) clauses.push(inArray(t.teamAppointments.scopeDistrictUnitId, scopes.districts));
  if (scopes.dojos.length) clauses.push(inArray(t.teamAppointments.scopeDojoId, scopes.dojos));
  return or(...clauses);
}

/**
 * May this principal WRITE an appointment at this scope?
 *
 * Separate from `readScope()` because the answers differ: everybody with
 * `team:read` sees the national office, and only a national holder may change
 * it. Without this, a state administrator could POST a national appointment and
 * put a name on the federation's own masthead.
 */
function assertWriteScope(
  principal: Principal,
  target: { scopeType: string; scopeStateUnitId?: number | null; scopeDistrictUnitId?: number | null; scopeDojoId?: number | null }
) {
  const scopes = visibleScopes(principal, 'team:write');
  if (scopes.kind === 'all') return;
  if (scopes.kind === 'none') throw new ForbiddenError('team:write');

  if (target.scopeType === 'national') throw new ForbiddenError('team:write');
  if (target.scopeType === 'state') {
    if (target.scopeStateUnitId != null && scopes.states.includes(target.scopeStateUnitId)) return;
    throw new ForbiddenError('team:write');
  }
  if (target.scopeType === 'district') {
    if (target.scopeDistrictUnitId != null && scopes.districts.includes(target.scopeDistrictUnitId)) return;
    throw new ForbiddenError('team:write');
  }
  if (target.scopeType === 'dojo') {
    if (target.scopeDojoId != null && scopes.dojos.includes(target.scopeDojoId)) return;
    throw new ForbiddenError('team:write');
  }
  // An unrecognised scope type fails closed rather than falling through to a
  // permissive default. 'institution' reaches here: a client school's staff are
  // not MMAKF's establishment, and there is no reading of /team on which they
  // belong on it.
  throw new ForbiddenError('team:write');
}

/**
 * PUBLISHING TO /team IS A NATIONAL ACT, AND `assertCanAnywhere` DOES NOT SAY SO.
 *
 * This exists because the obvious gate is wrong in a way that is invisible until
 * somebody exercises it. `assertCanAnywhere(principal, 'team:publish')` asks only
 * "does this caller hold the action in SOME scope" — and a role carrying
 * `team:publish` can be bound at a state. GENERAL_SECRETARY holds it; bind that
 * role at one state and `assertCanAnywhere` passes, after which the holder could
 * publish or WITHDRAW any appointment in the country by id, including the
 * national secretariat's own.
 *
 * That is precisely the defect an adversarial review found in
 * `decideDuplicate()` (IMPLEMENTATION-STATUS.md, sixth wave): a gate that had
 * already been asserted, re-asserted in place of a per-record check, under a
 * comment describing the IDOR it was failing to prevent.
 *
 * `/team` is ONE national page under the federation's masthead. There is no
 * per-record scope that would make a state holder correct here, so the rule is
 * not "check the record's scope" but "require national reach" — which is what
 * this asserts, and what the RBAC table already intends.
 */
function assertNationalPublish(principal: Principal) {
  const scopes = visibleScopes(principal, 'team:publish');
  if (scopes.kind !== 'all') throw new ForbiddenError('team:publish');
}

/** Normalise and validate the scope triple that the CHECK constraint requires. */
function normaliseScope(input: {
  scopeType?: string | null;
  scopeStateUnitId?: number | null;
  scopeDistrictUnitId?: number | null;
  scopeDojoId?: number | null;
}) {
  const scopeType = (input.scopeType || 'national') as any;
  const out = {
    scopeType,
    scopeStateUnitId: null as number | null,
    scopeDistrictUnitId: null as number | null,
    scopeDojoId: null as number | null,
  };
  if (scopeType === 'national') return out;
  if (scopeType === 'state') {
    if (input.scopeStateUnitId == null) throw new TeamError('bad_scope', 'A state appointment needs a state unit.');
    out.scopeStateUnitId = input.scopeStateUnitId;
    return out;
  }
  if (scopeType === 'district') {
    if (input.scopeDistrictUnitId == null) throw new TeamError('bad_scope', 'A district appointment needs a district unit.');
    out.scopeDistrictUnitId = input.scopeDistrictUnitId;
    out.scopeStateUnitId = input.scopeStateUnitId ?? null;
    return out;
  }
  if (scopeType === 'dojo') {
    if (input.scopeDojoId == null) throw new TeamError('bad_scope', 'A dojo appointment needs a dojo.');
    out.scopeDojoId = input.scopeDojoId;
    out.scopeStateUnitId = input.scopeStateUnitId ?? null;
    out.scopeDistrictUnitId = input.scopeDistrictUnitId ?? null;
    return out;
  }
  throw new TeamError(
    'bad_scope',
    `'${scopeType}' is not a scope an appointment can hold. An institution is a client of the federation, not part of its establishment.`
  );
}

/** Append a before/after pair. Never updates, never deletes — see rule 4. */
async function recordHistory(
  db: DB,
  ctx: AuditContext,
  entry: { appointmentId: number; change: string; before: unknown; after: unknown; reason?: string | null }
) {
  await db.insert(t.teamAppointmentHistory).values({
    appointmentId: entry.appointmentId,
    change: entry.change,
    before: entry.before ?? null,
    after: entry.after,
    reason: entry.reason ?? ctx.reason ?? null,
    actorUserId: ctx.principal.userId ?? null,
    actorLabel: ctx.principal.label,
  });
}

async function loadAppointment(db: DB, id: number) {
  const [row] = await db.select().from(t.teamAppointments).where(eq(t.teamAppointments.id, id)).limit(1);
  if (!row) throw new TeamError('no_such_appointment', `No appointment ${id}.`);
  return row;
}

// ─── Departments ────────────────────────────────────────────────────────────

export async function listDepartments(db: DB, opts: { includeInactive?: boolean } = {}) {
  const where = opts.includeInactive ? undefined : eq(t.departments.active, true);
  return db
    .select()
    .from(t.departments)
    .where(where as any)
    .orderBy(asc(t.departments.sortOrder), asc(t.departments.name));
}

export async function createDepartment(
  db: DB,
  ctx: AuditContext,
  input: { code: string; name: string; slug?: string | null; description?: string | null; parentId?: number | null; sortOrder?: number }
) {
  assertCanAnywhere(ctx.principal, 'team:write');

  const code = input.code?.trim().toUpperCase();
  if (!code) throw new TeamError('bad_scope', 'A department needs a code.');
  const name = input.name?.trim();
  if (!name) throw new TeamError('bad_scope', 'A department needs a name.');

  if (input.parentId != null) {
    const [parent] = await db.select().from(t.departments).where(eq(t.departments.id, input.parentId)).limit(1);
    if (!parent) throw new TeamError('no_such_department', `No department ${input.parentId} to be the parent.`);
  }

  const [row] = await db
    .insert(t.departments)
    .values({
      code,
      name,
      slug: input.slug?.trim() || null,
      description: input.description?.trim() || null,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();

  await writeAudit(db, ctx, { entityType: 'department', entityId: row.id, action: 'create', newValue: row });
  return row;
}

/**
 * Re-parent a department, refusing a cycle.
 *
 * The CHECK in 0056 catches only self-parenting. A → B → A needs a walk, and it
 * is done here rather than in a trigger so the refusal carries a sentence an
 * administrator can act on.
 */
export async function setDepartmentParent(db: DB, ctx: AuditContext, departmentId: number, parentId: number | null) {
  assertCanAnywhere(ctx.principal, 'team:write');

  const [dept] = await db.select().from(t.departments).where(eq(t.departments.id, departmentId)).limit(1);
  if (!dept) throw new TeamError('no_such_department', `No department ${departmentId}.`);

  if (parentId != null) {
    if (parentId === departmentId) {
      throw new TeamError('department_cycle', 'A department cannot be its own parent.');
    }
    // Walk up from the proposed parent. If we meet ourselves, the edge closes a
    // loop. Bounded by a hop count so a pre-existing cycle in the data cannot
    // hang the request.
    let cursor: number | null = parentId;
    for (let hops = 0; cursor != null && hops < 64; hops++) {
      if (cursor === departmentId) {
        throw new TeamError(
          'department_cycle',
          'That would make the department its own ancestor.'
        );
      }
      // ANNOTATED, TO BREAK A CIRCULAR INFERENCE. `cursor` narrows the where
      // clause, which types the row, which types `next.parentId`, which is
      // assigned back to `cursor` — so TypeScript reports `next` as implicitly
      // `any` (TS7022) and every property read off it goes unchecked. Naming
      // the row shape stops the cycle and restores the check that matters here:
      // that `parentId` really can be null, which is what ends the walk.
      const up: Array<{ parentId: number | null }> = await db
        .select({ parentId: t.departments.parentId })
        .from(t.departments).where(eq(t.departments.id, cursor)).limit(1);
      const next = up[0];
      if (!next) break;
      cursor = next.parentId;
    }
  }

  const [row] = await db.update(t.departments)
    .set({ parentId, updatedAt: new Date() })
    .where(eq(t.departments.id, departmentId))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'department', entityId: departmentId, action: 'update',
    oldValue: { parentId: dept.parentId }, newValue: { parentId },
  });
  return row;
}

// ─── Appointments: writing ──────────────────────────────────────────────────

export interface AppointmentInput {
  personId: number;
  title: string;
  orgLevel: OrgLevel;
  departmentId?: number | null;
  responsibility?: string | null;
  scopeType?: string | null;
  scopeStateUnitId?: number | null;
  scopeDistrictUnitId?: number | null;
  scopeDojoId?: number | null;
  startedOn?: string;
  publicBio?: string | null;
  publicContact?: string | null;
  publicLinks?: unknown;
  sortOrder?: number;
}

/**
 * Record that a person holds a post. Creates a DRAFT — see rule 2.
 *
 * `published` is not a parameter. There is no way to reach this function and
 * create something already on the public site, which is what keeps the
 * `team:publish` gate from being a formality.
 */
export async function createAppointment(db: DB, ctx: AuditContext, input: AppointmentInput) {
  assertCanAnywhere(ctx.principal, 'team:write');

  const title = input.title?.trim();
  if (!title) throw new TeamError('bad_scope', 'An appointment needs a title.');

  const [person] = await db.select({ id: s.persons.id })
    .from(s.persons).where(eq(s.persons.id, input.personId)).limit(1);
  if (!person) {
    throw new TeamError(
      'no_such_person',
      `No person ${input.personId}. An appointment attaches to somebody already in the register — create the person first, so there is one record of them and not two.`
    );
  }

  if (input.departmentId != null) {
    const [dept] = await db.select({ id: t.departments.id })
      .from(t.departments).where(eq(t.departments.id, input.departmentId)).limit(1);
    if (!dept) throw new TeamError('no_such_department', `No department ${input.departmentId}.`);
  }

  const scope = normaliseScope(input);
  assertWriteScope(ctx.principal, scope);
  const links = sanitiseLinks(input.publicLinks);

  // The partial unique index cannot see this case: in Postgres two rows with a
  // NULL department_id do not collide, so an unfiled appointment could be
  // created twice. Checked explicitly rather than by putting COALESCE(dept, 0)
  // in the index, which would make "no department" indistinguishable from
  // department zero for every future query.
  if (input.departmentId == null) {
    const [clash] = await db.select({ id: t.teamAppointments.id })
      .from(t.teamAppointments)
      .where(and(
        eq(t.teamAppointments.personId, input.personId),
        isNull(t.teamAppointments.departmentId),
        eq(t.teamAppointments.title, title),
        inArray(t.teamAppointments.status, ['draft', 'active', 'suspended'])
      ))
      .limit(1);
    if (clash) {
      throw new TeamError(
        'duplicate_appointment',
        `That person already holds an open appointment titled '${title}' with no department (#${clash.id}).`
      );
    }
  }

  const [row] = await db.insert(t.teamAppointments).values({
    personId: input.personId,
    departmentId: input.departmentId ?? null,
    title,
    orgLevel: input.orgLevel,
    responsibility: input.responsibility?.trim() || null,
    ...scope,
    startedOn: input.startedOn || todayIso(),
    status: 'draft',
    published: false,
    sortOrder: input.sortOrder ?? 0,
    publicBio: input.publicBio?.trim() || null,
    publicContact: input.publicContact?.trim() || null,
    publicLinks: links.length ? links : null,
  }).returning();

  await recordHistory(db, ctx, { appointmentId: row.id, change: 'created', before: null, after: row });
  await writeAudit(db, ctx, { entityType: 'team_appointment', entityId: row.id, action: 'create', newValue: row });
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_CREATED',
    entityType: 'team_appointment',
    entityId: row.id,
    payload: { personId: row.personId, title: row.title, orgLevel: row.orgLevel, departmentId: row.departmentId },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * Correct an appointment.
 *
 * `status` and `published` are NOT accepted here. Both have their own function
 * with their own gate and their own history entry, because "the row changed"
 * and "the federation withdrew somebody from its public site" are different
 * facts and an audit that renders them identically is not much of an audit.
 */
export async function updateAppointment(
  db: DB,
  ctx: AuditContext,
  id: number,
  patch: Partial<Omit<AppointmentInput, 'personId'>>
) {
  assertCanAnywhere(ctx.principal, 'team:write');
  const before = await loadAppointment(db, id);
  assertWriteScope(ctx.principal, before);

  const next: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.title !== undefined) {
    const title = patch.title?.trim();
    if (!title) throw new TeamError('bad_scope', 'An appointment needs a title.');
    next.title = title;
  }
  if (patch.orgLevel !== undefined) next.orgLevel = patch.orgLevel;
  if (patch.responsibility !== undefined) next.responsibility = patch.responsibility?.trim() || null;
  if (patch.publicBio !== undefined) next.publicBio = patch.publicBio?.trim() || null;
  if (patch.publicContact !== undefined) next.publicContact = patch.publicContact?.trim() || null;
  if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
  if (patch.publicLinks !== undefined) {
    const links = sanitiseLinks(patch.publicLinks);
    next.publicLinks = links.length ? links : null;
  }
  if (patch.departmentId !== undefined) {
    if (patch.departmentId != null) {
      const [dept] = await db.select({ id: t.departments.id })
        .from(t.departments).where(eq(t.departments.id, patch.departmentId)).limit(1);
      if (!dept) throw new TeamError('no_such_department', `No department ${patch.departmentId}.`);
    }
    next.departmentId = patch.departmentId;
  }
  if (patch.scopeType !== undefined) {
    const scope = normaliseScope({ ...before, ...patch });
    // Checked at BOTH ends: a state administrator may not move an appointment
    // out of their state, and may not move one in from elsewhere either.
    assertWriteScope(ctx.principal, scope);
    Object.assign(next, scope);
  }

  const [row] = await db.update(t.teamAppointments)
    .set(next).where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, { appointmentId: id, change: 'updated', before, after: row });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id, action: 'update',
    oldValue: before, newValue: row,
  });
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_UPDATED',
    entityType: 'team_appointment',
    entityId: id,
    payload: { personId: row.personId, changed: Object.keys(next).filter((k) => k !== 'updatedAt') },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * Bring a draft into force. Still not public — see `publishAppointment()`.
 */
export async function activateAppointment(db: DB, ctx: AuditContext, id: number) {
  assertCanAnywhere(ctx.principal, 'team:write');
  const before = await loadAppointment(db, id);
  assertWriteScope(ctx.principal, before);

  if (before.status === 'ended') {
    throw new TeamError('already_ended', 'That appointment has ended. Record a new one rather than reopening it — the register should show that the person left and came back.');
  }

  const [row] = await db.update(t.teamAppointments)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, {
    appointmentId: id,
    change: before.status === 'suspended' ? 'reinstated' : 'activated',
    before, after: row,
  });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id,
    action: before.status === 'suspended' ? 'reinstate' : 'update',
    oldValue: { status: before.status }, newValue: { status: 'active' },
  });
  return row;
}

/**
 * Put an appointment on the public site.
 *
 * Gated on `team:publish`, which a STATE_ADMIN does not hold: /team is a
 * national page under the federation's masthead, and deciding that a name and a
 * photograph appear there is a national editorial act.
 */
export async function publishAppointment(db: DB, ctx: AuditContext, id: number) {
  assertNationalPublish(ctx.principal);
  const before = await loadAppointment(db, id);

  if (before.status !== 'active') {
    throw new TeamError(
      'not_publishable',
      `An appointment must be active before it is published; this one is '${before.status}'. A draft is unfinished, a suspended post is under review, and an ended one has left — publishing any of the three would put a false statement about a named person on the public site.`
    );
  }

  const [row] = await db.update(t.teamAppointments)
    .set({ published: true, publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, { appointmentId: id, change: 'published', before, after: row });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id, action: 'approve',
    oldValue: { published: false }, newValue: { published: true },
  });
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_PUBLISHED',
    entityType: 'team_appointment',
    entityId: id,
    payload: { personId: row.personId, title: row.title },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * Take an appointment off the public site WITHOUT ending the post.
 *
 * The two are separate on purpose. Somebody may ask not to appear publicly, or
 * the press office may pull a page pending a correction, and neither means the
 * person stopped doing the job.
 */
export async function unpublishAppointment(db: DB, ctx: AuditContext, id: number, reason?: string | null) {
  assertNationalPublish(ctx.principal);
  const before = await loadAppointment(db, id);

  const [row] = await db.update(t.teamAppointments)
    .set({ published: false, updatedAt: new Date() })
    .where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, { appointmentId: id, change: 'unpublished', before, after: row, reason });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id, action: 'update',
    oldValue: { published: true }, newValue: { published: false },
  });
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_UNPUBLISHED',
    entityType: 'team_appointment',
    entityId: id,
    payload: { personId: row.personId },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * Suspend a post, and take it off the public site in the same act.
 *
 * The unpublish is NOT a courtesy — `team_appointments_publish_ck` would refuse
 * the UPDATE outright if `published` stayed true while the status left `active`.
 * Doing it here means the caller gets a suspension rather than a constraint
 * violation, and the page stops naming somebody as a serving officer at the
 * moment the federation decided they are not one.
 *
 * A REASON IS REQUIRED. A suspension nobody had to justify is the kind of record
 * that cannot be defended later, and this is the one act in the module that
 * touches a person's standing.
 */
export async function suspendAppointment(db: DB, ctx: AuditContext, id: number, reason: string) {
  assertCanAnywhere(ctx.principal, 'team:write');
  const before = await loadAppointment(db, id);
  assertWriteScope(ctx.principal, before);

  const why = reason?.trim();
  if (!why) throw new TeamError('bad_scope', 'A suspension needs a reason.');
  if (before.status === 'ended') throw new TeamError('already_ended', 'That appointment has already ended.');

  const [row] = await db.update(t.teamAppointments)
    .set({ status: 'suspended', published: false, updatedAt: new Date() })
    .where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, { appointmentId: id, change: 'suspended', before, after: row, reason: why });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id, action: 'suspend',
    oldValue: { status: before.status, published: before.published },
    newValue: { status: 'suspended', published: false },
  });
  // 'restricted' — national audit:read only. See the catalogue note: at
  // 'official' this would tell every dojo administrator in India that a named
  // officer is under review. The reason is deliberately NOT on the feed.
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_SUSPENDED',
    entityType: 'team_appointment',
    entityId: id,
    payload: { personId: row.personId },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * The person stopped holding the post.
 *
 * ENDS ONE ROW AND NOTHING ELSE — see rule 3 in the header. Their membership,
 * their rank, their black belt and their LOGIN are all untouched. Removing
 * access is a `role_bindings` act under `role:grant`, and the admin screen says
 * so beside this control.
 */
export async function endAppointment(
  db: DB, ctx: AuditContext, id: number,
  opts: { endedOn?: string; reason?: string | null } = {}
) {
  assertCanAnywhere(ctx.principal, 'team:write');
  const before = await loadAppointment(db, id);
  assertWriteScope(ctx.principal, before);

  if (before.status === 'ended') throw new TeamError('already_ended', 'That appointment has already ended.');

  const endedOn = opts.endedOn || todayIso();
  if (endedOn < before.startedOn) {
    throw new TeamError('bad_period', `An appointment cannot end (${endedOn}) before it started (${before.startedOn}).`);
  }

  const [row] = await db.update(t.teamAppointments)
    .set({ status: 'ended', endedOn, published: false, updatedAt: new Date() })
    .where(eq(t.teamAppointments.id, id)).returning();

  await recordHistory(db, ctx, { appointmentId: id, change: 'ended', before, after: row, reason: opts.reason });
  await writeAudit(db, ctx, {
    entityType: 'team_appointment', entityId: id, action: 'update',
    oldValue: { status: before.status }, newValue: { status: 'ended', endedOn },
  });
  await publish(db, {
    eventType: 'TEAM_APPOINTMENT_ENDED',
    entityType: 'team_appointment',
    entityId: id,
    payload: { personId: row.personId, endedOn },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

// ─── Appointments: reading ──────────────────────────────────────────────────

function mapRow(r: any): AdminAppointment {
  return {
    appointmentId: r.id,
    personId: r.personId,
    federationId: r.federationId,
    fullName: r.fullName,
    photoUrl: r.photoUrl ?? null,
    title: r.title,
    orgLevel: r.orgLevel,
    department: r.departmentName ?? null,
    departmentCode: r.departmentCode ?? null,
    departmentId: r.departmentId ?? null,
    responsibility: r.responsibility ?? null,
    bio: r.publicBio ?? null,
    contact: r.publicContact ?? null,
    links: Array.isArray(r.publicLinks) ? (r.publicLinks as PublicLink[]) : [],
    scopeType: r.scopeType,
    scopeLabel: r.stateName ?? r.districtName ?? r.dojoName ?? null,
    sortOrder: r.sortOrder,
    status: r.status,
    published: r.published,
    startedOn: r.startedOn,
    endedOn: r.endedOn ?? null,
  };
}

const BASE_COLUMNS = {
  id: t.teamAppointments.id,
  personId: t.teamAppointments.personId,
  departmentId: t.teamAppointments.departmentId,
  title: t.teamAppointments.title,
  orgLevel: t.teamAppointments.orgLevel,
  responsibility: t.teamAppointments.responsibility,
  scopeType: t.teamAppointments.scopeType,
  sortOrder: t.teamAppointments.sortOrder,
  publicBio: t.teamAppointments.publicBio,
  publicContact: t.teamAppointments.publicContact,
  publicLinks: t.teamAppointments.publicLinks,
  status: t.teamAppointments.status,
  published: t.teamAppointments.published,
  startedOn: t.teamAppointments.startedOn,
  endedOn: t.teamAppointments.endedOn,
  federationId: s.persons.federationId,
  fullName: s.persons.fullName,
  photoUrl: s.persons.photoUrl,
  departmentName: t.departments.name,
  departmentCode: t.departments.code,
  stateName: s.stateUnits.name,
  districtName: s.districtUnits.name,
  dojoName: s.dojos.name,
};

/**
 * THE PUBLIC TEAM. Takes no principal, accepts no filter that could widen it.
 *
 * The column list above contains `persons.federationId`, `fullName` and
 * `photoUrl` and NOTHING else from `persons` — no email, no telephone, no date
 * of birth, no address, no `matchKey`. A test asserts the absence by name,
 * because the failure mode here is somebody adding a column to `BASE_COLUMNS`
 * for an admin screen and publishing it to the internet in the same commit.
 */
export async function publicTeam(db: DB): Promise<PublicTeamMember[]> {
  const rows = await db
    .select(BASE_COLUMNS)
    .from(t.teamAppointments)
    .innerJoin(s.persons, eq(s.persons.id, t.teamAppointments.personId))
    .leftJoin(t.departments, eq(t.departments.id, t.teamAppointments.departmentId))
    .leftJoin(s.stateUnits, eq(s.stateUnits.id, t.teamAppointments.scopeStateUnitId))
    .leftJoin(s.districtUnits, eq(s.districtUnits.id, t.teamAppointments.scopeDistrictUnitId))
    .leftJoin(s.dojos, eq(s.dojos.id, t.teamAppointments.scopeDojoId))
    // Belt and braces. `published` alone is sufficient — the CHECK constraint
    // guarantees a published row is active — but the status test is written out
    // so that a future migration relaxing the constraint cannot silently put a
    // suspended officer on the public page.
    .where(and(eq(t.teamAppointments.published, true), eq(t.teamAppointments.status, 'active')))
    .orderBy(asc(t.teamAppointments.sortOrder), asc(s.persons.fullName));

  return rows.map((r: any) => {
    const m = mapRow(r);
    // Strip the admin-only fields structurally rather than trusting the caller
    // to ignore them.
    const { personId, departmentId, status, published, startedOn, endedOn, ...pub } = m;
    return pub;
  });
}

/** The admin register: every appointment the principal's scope can see. */
export async function adminAppointments(
  db: DB,
  principal: Principal,
  opts: { status?: AppointmentStatus[]; departmentId?: number; personId?: number; limit?: number } = {}
): Promise<AdminAppointment[]> {
  assertCanAnywhere(principal, 'team:read');

  const clauses: any[] = [];
  const scope = readScope(principal);
  if (scope) clauses.push(scope);
  if (opts.status?.length) clauses.push(inArray(t.teamAppointments.status, opts.status));
  if (opts.departmentId != null) clauses.push(eq(t.teamAppointments.departmentId, opts.departmentId));
  if (opts.personId != null) clauses.push(eq(t.teamAppointments.personId, opts.personId));

  const rows = await db
    .select(BASE_COLUMNS)
    .from(t.teamAppointments)
    .innerJoin(s.persons, eq(s.persons.id, t.teamAppointments.personId))
    .leftJoin(t.departments, eq(t.departments.id, t.teamAppointments.departmentId))
    .leftJoin(s.stateUnits, eq(s.stateUnits.id, t.teamAppointments.scopeStateUnitId))
    .leftJoin(s.districtUnits, eq(s.districtUnits.id, t.teamAppointments.scopeDistrictUnitId))
    .leftJoin(s.dojos, eq(s.dojos.id, t.teamAppointments.scopeDojoId))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(t.teamAppointments.sortOrder), asc(s.persons.fullName))
    .limit(opts.limit ?? 500);

  return rows.map(mapRow);
}

/**
 * Every relationship one person holds with MMAKF, in one place.
 *
 * This is the §4/§29 requirement made visible: the same `persons` row carries an
 * appointment, a rank, an instructor qualification and a membership, and an
 * administrator looking at somebody should see all four rather than four
 * screens that each know about one.
 *
 * It reads no private column — no email, no telephone, no date of birth. An
 * administrator who needs those has `person:read_pii` and a different screen.
 */
export async function personRelationships(db: DB, principal: Principal, personId: number) {
  assertCanAnywhere(principal, 'team:read');

  // EACH SECTION BEHIND ITS OWN ACTION, and this is a correction rather than a
  // flourish. The first version of this function gated the whole thing on
  // `team:read` and returned ranks, instructor qualifications and memberships
  // for any person id — which handed a MEDIA_OFFICER, who holds `team:read` and
  // neither `rank:read` nor `membership:read`, a way to read the rank and
  // membership history of anybody in the federation by walking ids.
  //
  // That is the /my/family pattern applied here: every field behind the check
  // that actually governs it. A caller who lacks the action gets `null` for that
  // section — distinguishable from `[]`, which means the register genuinely
  // holds nothing — so a surface can say "not yours to see" rather than printing
  // an empty list and implying the person has no grades.
  const mayRank = canAnywhere(principal, 'rank:read');
  const mayMembership = canAnywhere(principal, 'membership:read');

  const [person] = await db.select({
    id: s.persons.id,
    federationId: s.persons.federationId,
    fullName: s.persons.fullName,
    photoUrl: s.persons.photoUrl,
    status: s.persons.status,
  }).from(s.persons).where(eq(s.persons.id, personId)).limit(1);
  if (!person) throw new TeamError('no_such_person', `No person ${personId}.`);

  const [appointments, ranks, instructor, memberships] = await Promise.all([
    adminAppointments(db, principal, { personId, limit: 50 }),
    mayRank
      ? db.select({
          kind: s.rankRecords.kind,
          gradeLabel: s.rankRecords.gradeLabel,
          awardedOn: s.rankRecords.awardedOn,
          status: s.rankRecords.status,
          gradingEventId: s.rankRecords.gradingEventId,
        }).from(s.rankRecords).where(eq(s.rankRecords.personId, personId))
          .orderBy(desc(s.rankRecords.awardedOn))
      : Promise.resolve(null),
    // An instructor qualification is a TEACHING authorisation, and the register
    // publishes the fact that somebody teaches on /teachers. It rides with
    // 'rank:read' rather than getting a third gate: both answer "what has the
    // federation certified about this person".
    mayRank
      ? db.select({
          level: s.instructorQuals.level,
          grantedOn: s.instructorQuals.grantedOn,
          expiresOn: s.instructorQuals.expiresOn,
          status: s.instructorQuals.status,
        }).from(s.instructorQuals).where(eq(s.instructorQuals.personId, personId))
      : Promise.resolve(null),
    mayMembership
      ? db.select({
          category: s.memberships.category,
          status: s.memberships.status,
          validTo: s.memberships.validTo,
        }).from(s.memberships).where(eq(s.memberships.personId, personId))
      : Promise.resolve(null),
  ]);

  // `null` means "you may not see this"; `[]` means "the register holds none".
  // A surface that rendered both as an empty list would tell a press officer
  // that a 5th Dan holds no grades.
  return { person, appointments, ranks, instructor, memberships };
}

/** The version trail for one appointment. */
export async function appointmentHistory(db: DB, principal: Principal, appointmentId: number) {
  assertCanAnywhere(principal, 'team:read');

  // Scope is checked on the APPOINTMENT, not on the history rows — otherwise a
  // scoped administrator could read another state's trail by id. This is the
  // IDOR that `decideDuplicate()` shipped with, recorded in
  // IMPLEMENTATION-STATUS.md's sixth wave; it is written out here rather than
  // assumed because the gate above only proves they hold the action somewhere.
  const [appt] = await db.select({
    id: t.teamAppointments.id,
    scopeType: t.teamAppointments.scopeType,
    scopeStateUnitId: t.teamAppointments.scopeStateUnitId,
    scopeDistrictUnitId: t.teamAppointments.scopeDistrictUnitId,
    scopeDojoId: t.teamAppointments.scopeDojoId,
  }).from(t.teamAppointments).where(eq(t.teamAppointments.id, appointmentId)).limit(1);
  if (!appt) throw new TeamError('no_such_appointment', `No appointment ${appointmentId}.`);

  const scopes = visibleScopes(principal, 'team:read');
  if (scopes.kind === 'none') throw new ForbiddenError('team:read');
  if (scopes.kind === 'scoped') {
    const visible =
      appt.scopeType === 'national' ||
      (appt.scopeStateUnitId != null && scopes.states.includes(appt.scopeStateUnitId)) ||
      (appt.scopeDistrictUnitId != null && scopes.districts.includes(appt.scopeDistrictUnitId)) ||
      (appt.scopeDojoId != null && scopes.dojos.includes(appt.scopeDojoId));
    if (!visible) throw new ForbiddenError('team:read');
  }

  return db.select()
    .from(t.teamAppointmentHistory)
    .where(eq(t.teamAppointmentHistory.appointmentId, appointmentId))
    .orderBy(desc(t.teamAppointmentHistory.id));
}
