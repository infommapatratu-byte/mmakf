// MMAKF authorisation — the single policy choke point (§65, §38, §75).
//
// Every federation endpoint and page loader asks this module the same question:
//
//     can(principal, action, resource) -> boolean
//
// Rules:
//  · DENY BY DEFAULT. An action not explicitly granted to a role is refused.
//  · SCOPE IS ALWAYS CHECKED. A state admin may only touch rows inside their
//    own state; a dojo admin only their own dojo. This is what prevents IDOR:
//    knowing an id is never sufficient, the id must fall inside the caller's
//    scope.
//  · Bindings must be active and unexpired.
//  · No page or endpoint may re-implement these checks locally.

// ─── Roles (§65) ────────────────────────────────────────────────────────────

export const ROLES = [
  'SUPER_ADMIN',
  'FEDERATION_ADMIN',
  'PRESIDENT',
  'GENERAL_SECRETARY',
  'TECHNICAL_DIRECTOR',
  'STATE_ADMIN',
  'DISTRICT_ADMIN',
  'DOJO_ADMIN',
  'INSTRUCTOR',
  'EXAMINER',
  'REFEREE',
  'JUDGE',
  'ATHLETE',
  'MEMBER',
  'FINANCE_OFFICER',
  'SAFEGUARDING_OFFICER',
] as const;

export type Role = (typeof ROLES)[number];
export type ScopeType = 'national' | 'state' | 'district' | 'dojo';

/** Actions are `domain:verb`. Keep them coarse enough to reason about. */
export type Action =
  | 'unit:read' | 'unit:write' | 'unit:charter'
  | 'dojo:read' | 'dojo:write' | 'dojo:approve'
  | 'person:read' | 'person:read_pii' | 'person:write'
  | 'membership:read' | 'membership:issue' | 'membership:revoke'
  | 'rank:read' | 'rank:award' | 'rank:revoke'
  | 'grading:read' | 'grading:score' | 'grading:approve'
  | 'certificate:read' | 'certificate:issue' | 'certificate:revoke'
  | 'competition:read' | 'competition:write' | 'competition:sanction'
  | 'result:read' | 'result:enter' | 'result:finalize'
  | 'content:read' | 'content:write'
  | 'finance:read' | 'finance:write'
  | 'safeguarding:read' | 'safeguarding:write'
  | 'audit:read'
  | 'user:read' | 'user:write' | 'role:grant'
  // Training and engagement: the lead pipeline, institutional clients and
  // training requests. NOT folded into 'unit:*' — a state unit is part of the
  // federation and a school that buys a term of karate is a client, and giving
  // one action authority over both puts a customer inside the hierarchy.
  | 'engagement:read' | 'engagement:write';

export interface Binding {
  role: Role;
  scopeType: ScopeType;
  scopeId: number | null;   // null == national
  status?: string;          // 'active' unless stated
  expiresAt?: Date | string | null;
}

export interface Principal {
  userId: number | null;
  label: string;            // for audit records
  bindings: Binding[];
}

/** Where a resource sits in the federation hierarchy. */
export interface Resource {
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;
  /** For self-service: the person this resource belongs to. */
  personId?: number | null;
}

// ─── Role → permitted actions ───────────────────────────────────────────────

const NATIONAL_FULL: Action[] = [
  'unit:read', 'unit:write', 'unit:charter',
  'dojo:read', 'dojo:write', 'dojo:approve',
  'person:read', 'person:read_pii', 'person:write',
  'membership:read', 'membership:issue', 'membership:revoke',
  'rank:read', 'rank:award', 'rank:revoke',
  'grading:read', 'grading:score', 'grading:approve',
  'certificate:read', 'certificate:issue', 'certificate:revoke',
  'competition:read', 'competition:write', 'competition:sanction',
  'result:read', 'result:enter', 'result:finalize',
  'content:read', 'content:write',
  'finance:read', 'finance:write',
  'audit:read',
  'user:read', 'user:write', 'role:grant',
  'engagement:read', 'engagement:write',
];

const GRANTS: Record<Role, Action[]> = {
  // Full authority including safeguarding and role granting.
  SUPER_ADMIN: [...NATIONAL_FULL, 'safeguarding:read', 'safeguarding:write'],

  // Operational national administration — no safeguarding case access.
  FEDERATION_ADMIN: NATIONAL_FULL,

  PRESIDENT: [
    'unit:read', 'dojo:read', 'dojo:approve', 'person:read',
    'membership:read', 'rank:read', 'grading:read', 'grading:approve',
    'certificate:read', 'certificate:issue',
    'competition:read', 'competition:sanction', 'result:read',
    'content:read', 'finance:read', 'audit:read',
  ],

  GENERAL_SECRETARY: [
    'unit:read', 'unit:write', 'dojo:read', 'dojo:write', 'dojo:approve',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'membership:issue', 'membership:revoke',
    'rank:read', 'certificate:read', 'certificate:issue',
    'competition:read', 'competition:write', 'result:read',
    'content:read', 'content:write', 'audit:read', 'user:read',
  ],

  // Technical authority: syllabus, gradings, ranks — not finance or users.
  TECHNICAL_DIRECTOR: [
    'unit:read', 'dojo:read', 'person:read',
    'rank:read', 'rank:award', 'rank:revoke',
    'grading:read', 'grading:score', 'grading:approve',
    'certificate:read', 'certificate:issue',
    'content:read', 'content:write', 'audit:read',
  ],

  // Scoped administrators — same verbs, but their bindings are state/district/
  // dojo-scoped so `can()` restricts them to their own rows.
  STATE_ADMIN: [
    'unit:read', 'unit:write',
    'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'membership:issue',
    'rank:read', 'grading:read', 'certificate:read',
    'competition:read', 'competition:write', 'result:read', 'result:enter',
    'content:read',
    'engagement:read', 'engagement:write',
  ],

  DISTRICT_ADMIN: [
    'unit:read', 'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'rank:read', 'grading:read',
    'competition:read', 'result:read', 'result:enter', 'content:read',
  ],

  DOJO_ADMIN: [
    'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'rank:read', 'grading:read',
    'competition:read', 'result:read', 'content:read',
  ],

  INSTRUCTOR: [
    'dojo:read', 'person:read', 'membership:read',
    'rank:read', 'grading:read', 'competition:read', 'result:read', 'content:read',
  ],

  // An examiner scores; only the approving authority finalises (§30).
  EXAMINER: [
    'person:read', 'rank:read', 'grading:read', 'grading:score', 'content:read',
  ],

  REFEREE: ['competition:read', 'result:read', 'result:enter', 'content:read'],
  JUDGE: ['competition:read', 'result:read', 'result:enter', 'content:read'],

  ATHLETE: ['person:read', 'rank:read', 'certificate:read', 'competition:read', 'result:read', 'content:read'],
  MEMBER: ['person:read', 'content:read'],

  FINANCE_OFFICER: ['finance:read', 'finance:write', 'person:read', 'membership:read', 'audit:read', 'content:read', 'engagement:read'],
  SAFEGUARDING_OFFICER: ['safeguarding:read', 'safeguarding:write', 'person:read', 'person:read_pii', 'audit:read'],
};

// ─── Scope logic ────────────────────────────────────────────────────────────

function bindingActive(b: Binding): boolean {
  if (b.status && b.status !== 'active') return false;
  if (b.expiresAt) {
    const exp = b.expiresAt instanceof Date ? b.expiresAt : new Date(b.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) return false;
  }
  return true;
}

/**
 * Does a binding's scope contain the resource?
 * National contains everything. A state binding contains resources in that
 * state. District and dojo bindings must match exactly.
 *
 * A resource with NO location (e.g. site-wide content) is only reachable from
 * a national binding — a state admin cannot edit national content.
 */
function scopeContains(b: Binding, r: Resource): boolean {
  switch (b.scopeType) {
    case 'national':
      return true;
    case 'state':
      return b.scopeId != null && r.stateUnitId === b.scopeId;
    case 'district':
      return b.scopeId != null && r.districtUnitId === b.scopeId;
    case 'dojo':
      return b.scopeId != null && r.dojoId === b.scopeId;
    default:
      return false;
  }
}

/** The authorisation decision. Deny by default. */
export function can(
  principal: Principal | null | undefined,
  action: Action,
  resource: Resource = {}
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;

  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role)) continue;          // unknown role → ignore
    if (!bindingActive(b)) continue;
    const grants = GRANTS[b.role];
    if (!grants || !grants.includes(action)) continue;
    if (!scopeContains(b, resource)) continue;
    return true;
  }
  return false;
}

/**
 * Does the principal hold this action in ANY scope?
 *
 * Use for LIST gates: `can()` answers about one resource, so passing an empty
 * resource would wrongly refuse every scoped administrator (a state admin has
 * no national binding). List endpoints gate with this, then apply
 * `visibleScopes()` as a SQL filter so rows are still restricted.
 */
export function canAnywhere(
  principal: Principal | null | undefined,
  action: Action
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;
  return principal.bindings.some(
    (b) => ROLES.includes(b.role) && bindingActive(b) && GRANTS[b.role]?.includes(action)
  );
}

/** Throwing variant for endpoints: returns void or throws ForbiddenError. */
export class ForbiddenError extends Error {
  // Declared as a field rather than a constructor parameter property, so this
  // module can be run directly by Node's type-stripping (used by the operator
  // scripts in scripts/) without a build step.
  readonly action: Action;

  constructor(action: Action) {
    super(`Forbidden: ${action}`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

export function assertCan(
  principal: Principal | null | undefined,
  action: Action,
  resource: Resource = {}
): void {
  if (!can(principal, action, resource)) throw new ForbiddenError(action);
}

/** Throwing list gate — pairs with visibleScopes() for the SQL filter. */
export function assertCanAnywhere(
  principal: Principal | null | undefined,
  action: Action
): void {
  if (!canAnywhere(principal, action)) throw new ForbiddenError(action);
}

// ─── Role granting (§53 privilege escalation) ───────────────────────────────

/**
 * Roles that only a SUPER_ADMIN may confer. Safeguarding sees child-protection
 * casework, and SUPER_ADMIN is the root of the authority tree — neither may be
 * minted by ordinary national administration (§41, §53).
 */
const RESTRICTED_ROLES: Role[] = ['SUPER_ADMIN', 'SAFEGUARDING_OFFICER'];

/** Does a binding's scope contain the scope a new binding is being made in? */
function bindingScopeCovers(b: Binding, target: { scopeType: ScopeType; scopeId: number | null }): boolean {
  if (b.scopeType === 'national') return true;
  // Conservative: a scoped granter may only grant at their exact scope. Granting
  // downward (state -> dojo inside it) needs a hierarchy lookup, so callers that
  // want it must resolve the parent scope and pass it explicitly.
  return b.scopeType === target.scopeType && b.scopeId != null && b.scopeId === target.scopeId;
}

/**
 * May this principal bind `role` at `target` scope?
 *
 * Three independent conditions, all required:
 *  1. the granter holds `role:grant` in a scope covering the target scope;
 *  2. the role is not SUPER_ADMIN/SAFEGUARDING_OFFICER unless they are SUPER_ADMIN;
 *  3. no amplification — every action the new role would hold must already be
 *     held by the granter. Without this, a granter could mint a role more
 *     powerful than themselves and then act through it.
 */
export function canGrantRole(
  principal: Principal | null | undefined,
  role: Role,
  target: { scopeType: ScopeType; scopeId: number | null }
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;
  if (!ROLES.includes(role)) return false;

  const granting = principal.bindings.filter(
    (b) => ROLES.includes(b.role) && bindingActive(b) && GRANTS[b.role]?.includes('role:grant')
  );
  if (!granting.length) return false;
  if (!granting.some((b) => bindingScopeCovers(b, target))) return false;

  if (RESTRICTED_ROLES.includes(role)) {
    const isSuper = granting.some((b) => b.role === 'SUPER_ADMIN');
    if (!isSuper) return false;
  }

  // No amplification: the target role's actions must be a subset of the actions
  // the granter holds across all their active bindings.
  const held = new Set<Action>();
  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role) || !bindingActive(b)) continue;
    for (const a of GRANTS[b.role] ?? []) held.add(a);
  }
  return (GRANTS[role] ?? []).every((a) => held.has(a));
}

/** The action set a role confers — exported for grant-time review screens. */
export function actionsForRole(role: Role): Action[] {
  return [...(GRANTS[role] ?? [])];
}

/**
 * SQL-level scope filter for list queries: returns the state/district/dojo ids
 * a principal may see for an action, or 'all' for national reach, or 'none'.
 * Endpoints must apply this to WHERE clauses so scoping is enforced in the
 * query, not by filtering after the fact.
 */
export function visibleScopes(
  principal: Principal | null | undefined,
  action: Action
): { kind: 'all' } | { kind: 'none' } | { kind: 'scoped'; states: number[]; districts: number[]; dojos: number[] } {
  if (!principal) return { kind: 'none' };
  const states: number[] = [], districts: number[] = [], dojos: number[] = [];
  let national = false;

  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role) || !bindingActive(b)) continue;
    if (!GRANTS[b.role]?.includes(action)) continue;
    if (b.scopeType === 'national') national = true;
    else if (b.scopeType === 'state' && b.scopeId != null) states.push(b.scopeId);
    else if (b.scopeType === 'district' && b.scopeId != null) districts.push(b.scopeId);
    else if (b.scopeType === 'dojo' && b.scopeId != null) dojos.push(b.scopeId);
  }

  if (national) return { kind: 'all' };
  if (!states.length && !districts.length && !dojos.length) return { kind: 'none' };
  return { kind: 'scoped', states, districts, dojos };
}

/** Convenience for building principals from the legacy session types. */
export function legacyAdminPrincipal(): Principal {
  return {
    userId: null,
    label: 'legacy-admin',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };
}

export function legacyUnitPrincipal(unit: {
  name: string;
  level: string;
  stateUnitId: number | null;
}): Principal {
  const role: Role =
    unit.level === 'State' ? 'STATE_ADMIN' :
    unit.level === 'District' ? 'DISTRICT_ADMIN' : 'DOJO_ADMIN';
  return {
    userId: null,
    label: unit.name,
    // Legacy unit codes only carry a state, so district/club codes are bound at
    // state scope with the narrower role's action set.
    bindings: [{ role, scopeType: 'state', scopeId: unit.stateUnitId }],
  };
}
