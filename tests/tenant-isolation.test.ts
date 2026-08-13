// PART AC, attacked rather than asserted.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE FEDERATION ASKED FOR
// ─────────────────────────────────────────────────────────────────────────────
//
//   Institution A cannot access Institution B.
//   Coach A cannot access Coach B's private calendar.
//   School administrator cannot access federation finance.
//   Training admin cannot access safeguarding cases.
//   Institution users cannot access pricing rules.
//   Users cannot manipulate quote totals.
//   Users cannot manipulate calendar availability.
//   Users cannot create official certificates.
//
// Each of those is a sentence somebody could write in a document and believe.
// This file is the version that can fail.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS MOST
// ─────────────────────────────────────────────────────────────────────────────
//
// 'institution' is a TENANT scope, not another rung of the federation
// hierarchy. A school is a client, not a unit. The consequence — and the reason
// it is safe — is that an institution binding contains NO federation resource
// at all: a federation row carries no institutionId, so `undefined === 7` is
// false and the check fails closed without a rule written per resource type.
//
// The tests below try to get round that by guessing ids, which is what an
// attacker actually does.

import { describe, it, expect } from 'vitest';
import {
  can, canAnywhere, canGrantRole, visibleScopes, actionsForRole,
  ROLES, type Principal, type Role, type Action,
} from '../src/lib/rbac';

const SCHOOL_A = 101;
const SCHOOL_B = 202;

const bind = (role: Role, scopeType: any, scopeId: number | null): Principal => ({
  userId: 1, label: `test:${role}`,
  bindings: [{ role, scopeType, scopeId }],
});

const schoolAdminA = bind('INSTITUTION_ADMIN', 'institution', SCHOOL_A);
const schoolAdminB = bind('INSTITUTION_ADMIN', 'institution', SCHOOL_B);
const coordinatorA = bind('INSTITUTION_COORDINATOR', 'institution', SCHOOL_A);
const parent = bind('PARENT', 'institution', SCHOOL_A);
const trainingOps = bind('TRAINING_OPERATIONS', 'national', null);
const trainingDirector = bind('TRAINING_DIRECTOR', 'national', null);
const federationAdmin = bind('FEDERATION_ADMIN', 'national', null);
const superAdmin = bind('SUPER_ADMIN', 'national', null);
const finance = bind('FINANCE_OFFICER', 'national', null);
const safeguarding = bind('SAFEGUARDING_OFFICER', 'national', null);
const coachManager = bind('COACH_MANAGER', 'national', null);
const supportAgent = bind('SUPPORT_AGENT', 'national', null);
const auditor = bind('AUDITOR', 'national', null);
const hr = bind('HR_OFFICER', 'national', null);

// ════════════════════════════════════════════════════════════════════════════
describe('Institution A cannot access Institution B', () => {
  it('refuses B’s resources to A, however the id is presented', () => {
    for (const action of ['program:read', 'booking:read', 'attendance:read', 'document:read', 'quote:read'] as Action[]) {
      expect(can(schoolAdminA, action, { institutionId: SCHOOL_A }), `A should reach its own ${action}`).toBe(true);
      expect(can(schoolAdminA, action, { institutionId: SCHOOL_B }), `A reached B via ${action}`).toBe(false);
      expect(can(schoolAdminB, action, { institutionId: SCHOOL_A }), `B reached A via ${action}`).toBe(false);
    }
  });

  it('refuses a resource with NO institution at all', () => {
    // The important direction. A federation row — a person, a unit, a
    // competition — carries no institutionId, so this is `undefined === 101`,
    // which is false. That single comparison is what keeps a client out of the
    // federation's own data without a rule per resource type.
    expect(can(schoolAdminA, 'person:read', {})).toBe(false);
    expect(can(schoolAdminA, 'program:read', {})).toBe(false);
    expect(can(schoolAdminA, 'content:read', {})).toBe(false);
    expect(can(schoolAdminA, 'booking:read', { stateUnitId: 1, districtUnitId: 2, dojoId: 3 })).toBe(false);
  });

  it('is not fooled by a null or undefined institutionId', () => {
    // `null === null` would be TRUE for a binding with a null scopeId, so both
    // sides are checked for presence. Without that, a national-scope row and an
    // unscoped binding would match each other.
    expect(can(schoolAdminA, 'program:read', { institutionId: null })).toBe(false);
    expect(can(schoolAdminA, 'program:read', { institutionId: undefined })).toBe(false);

    const nullScoped: Principal = {
      userId: 9, label: 'malformed',
      bindings: [{ role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: null }],
    };
    expect(can(nullScoped, 'program:read', { institutionId: null })).toBe(false);
    expect(can(nullScoped, 'program:read', { institutionId: SCHOOL_A })).toBe(false);
  });

  it('lists only its own institution in the SQL scope filter', () => {
    const scopes = visibleScopes(schoolAdminA, 'program:read');
    expect(scopes.kind).toBe('scoped');
    if (scopes.kind === 'scoped') {
      expect(scopes.institutions).toEqual([SCHOOL_A]);
      // No federation reach whatsoever, so a query built from this filter
      // returns nothing from the federation's own tables.
      expect(scopes.states).toEqual([]);
      expect(scopes.districts).toEqual([]);
      expect(scopes.dojos).toEqual([]);
    }
  });

  it('never reports "all" for an institution binding', () => {
    for (const action of actionsForRole('INSTITUTION_ADMIN')) {
      const scopes = visibleScopes(schoolAdminA, action);
      expect(scopes.kind, `${action} gave an institution binding national reach`).not.toBe('all');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a school administrator cannot reach federation finance', () => {
  it('holds no finance action at all', () => {
    for (const p of [schoolAdminA, coordinatorA, parent]) {
      expect(canAnywhere(p, 'finance:read')).toBe(false);
      expect(canAnywhere(p, 'finance:write')).toBe(false);
    }
  });

  it('cannot reach finance even for its own institution', () => {
    // Not merely out of scope — the action is not in the role at all, so no
    // resource makes it reachable.
    expect(can(schoolAdminA, 'finance:read', { institutionId: SCHOOL_A })).toBe(false);
  });
});

describe('institution users cannot access pricing RULES', () => {
  it('may read a quote and never the framework that produced it', () => {
    expect(canAnywhere(schoolAdminA, 'quote:read')).toBe(true);
    // The distinction the whole fee design turns on: a client sees the number
    // it was quoted; whoever can edit a rule changes every FUTURE quote
    // silently.
    expect(canAnywhere(schoolAdminA, 'feeframework:read')).toBe(false);
    expect(canAnywhere(schoolAdminA, 'feeframework:write')).toBe(false);
    expect(canAnywhere(schoolAdminA, 'feeframework:publish')).toBe(false);
  });

  it('cannot issue or approve its own quote', () => {
    expect(canAnywhere(schoolAdminA, 'quote:issue')).toBe(false);
    expect(canAnywhere(schoolAdminA, 'quote:approve')).toBe(false);
  });

  it('keeps rule-writing away from the people who quote day to day', () => {
    // A training administrator issues quotes and cannot rewrite the rules
    // behind them; the director reads the framework and still cannot write it.
    // Publishing a framework is a federation-level act.
    expect(canAnywhere(trainingOps, 'quote:issue')).toBe(true);
    expect(canAnywhere(trainingOps, 'feeframework:read')).toBe(false);
    expect(canAnywhere(trainingDirector, 'feeframework:read')).toBe(true);
    expect(canAnywhere(trainingDirector, 'feeframework:write')).toBe(false);
    expect(canAnywhere(trainingDirector, 'feeframework:publish')).toBe(false);
  });

  it('separates issuing a quote from approving it', () => {
    // One person doing both is how a discount gets granted with nobody else in
    // the room.
    expect(canAnywhere(trainingOps, 'quote:issue')).toBe(true);
    expect(canAnywhere(trainingOps, 'quote:approve')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a training administrator cannot reach safeguarding', () => {
  it('holds no safeguarding action', () => {
    for (const p of [trainingOps, trainingDirector, coachManager, supportAgent, finance, auditor]) {
      expect(canAnywhere(p, 'safeguarding:read'), `${p.label} reached safeguarding`).toBe(false);
      expect(canAnywhere(p, 'safeguarding:write'), `${p.label} reached safeguarding`).toBe(false);
    }
  });

  it('is not held by FEDERATION_ADMIN either', () => {
    // Deliberate and long-standing: operational national administration does
    // not include child-protection casework.
    expect(canAnywhere(federationAdmin, 'safeguarding:read')).toBe(false);
    expect(canAnywhere(superAdmin, 'safeguarding:read')).toBe(true);
  });
});

describe('HR and medical data stay out of ordinary administration', () => {
  it('is unreachable by every operations role', () => {
    for (const p of [trainingOps, trainingDirector, coachManager, supportAgent, federationAdmin, auditor]) {
      expect(canAnywhere(p, 'hr:read'), `${p.label} reached HR`).toBe(false);
      expect(canAnywhere(p, 'medical:read'), `${p.label} reached medical`).toBe(false);
    }
  });

  it('cannot be minted by a federation administrator', () => {
    // Two independent barriers. NATIONAL_FULL omits hr:* and medical:*, so the
    // no-amplification rule refuses; and both roles are in RESTRICTED_ROLES, so
    // the day somebody adds hr:read to NATIONAL_FULL for a report, this still
    // refuses.
    const target = { scopeType: 'national' as const, scopeId: null };
    expect(canGrantRole(federationAdmin, 'HR_OFFICER', target)).toBe(false);
    expect(canGrantRole(federationAdmin, 'MEDICAL_OFFICER', target)).toBe(false);
    expect(canGrantRole(federationAdmin, 'SAFEGUARDING_OFFICER', target)).toBe(false);
    expect(canGrantRole(federationAdmin, 'SUPER_ADMIN', target)).toBe(false);

    expect(canGrantRole(superAdmin, 'HR_OFFICER', target)).toBe(true);
  });

  it('lets HR read coaches without letting the coach manager read HR', () => {
    expect(canAnywhere(hr, 'coach:read')).toBe(true);
    expect(canAnywhere(coachManager, 'hr:read')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('nobody mints authority they do not already hold', () => {
  it('refuses every role a training director does not fully cover', () => {
    const target = { scopeType: 'national' as const, scopeId: null };
    // A training director holds no 'role:grant' at all, so this is not about
    // amplification — it is about not being a granter in the first place.
    for (const role of ROLES) {
      expect(canGrantRole(trainingDirector, role, target), `training director granted ${role}`).toBe(false);
    }
  });

  it('lets a national administrator grant only roles inside its own authority', () => {
    const target = { scopeType: 'national' as const, scopeId: null };
    const granted = ROLES.filter((r) => canGrantRole(federationAdmin, r, target));
    const refused = ROLES.filter((r) => !canGrantRole(federationAdmin, r, target));

    expect(granted).toContain('TRAINING_OPERATIONS');
    expect(granted).toContain('INSTITUTION_ADMIN');
    expect(refused).toContain('SUPER_ADMIN');
    expect(refused).toContain('SAFEGUARDING_OFFICER');
    expect(refused).toContain('HR_OFFICER');
    expect(refused).toContain('MEDICAL_OFFICER');

    // And the general rule the specific cases are examples of.
    const held = new Set(actionsForRole('FEDERATION_ADMIN'));
    for (const role of granted) {
      for (const a of actionsForRole(role)) {
        expect(held.has(a), `granting ${role} would confer ${a}, which FEDERATION_ADMIN does not hold`).toBe(true);
      }
    }
  });

  it('does not let an institution administrator grant anything', () => {
    for (const role of ROLES) {
      expect(canGrantRole(schoolAdminA, role, { scopeType: 'institution', scopeId: SCHOOL_A })).toBe(false);
      expect(canGrantRole(schoolAdminA, role, { scopeType: 'national', scopeId: null })).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('users cannot create official credentials', () => {
  it('keeps certificate issuing away from clients, coaches and support', () => {
    for (const p of [schoolAdminA, coordinatorA, parent, supportAgent, coachManager, trainingOps]) {
      expect(canAnywhere(p, 'certificate:issue'), `${p.label} could issue a certificate`).toBe(false);
      expect(canAnywhere(p, 'certificate:revoke'), `${p.label} could revoke a certificate`).toBe(false);
      expect(canAnywhere(p, 'rank:award'), `${p.label} could award a rank`).toBe(false);
      expect(canAnywhere(p, 'grading:approve'), `${p.label} could approve a grading`).toBe(false);
      expect(canAnywhere(p, 'result:finalize'), `${p.label} could finalise a result`).toBe(false);
    }
  });

  it('keeps membership issuing away from the training side', () => {
    // A school buying a term of karate does not thereby make its pupils members
    // of the federation.
    for (const p of [schoolAdminA, trainingOps, trainingDirector]) {
      expect(canAnywhere(p, 'membership:issue'), `${p.label} could issue a membership`).toBe(false);
    }
  });
});

describe('the auditor reads everything and writes nothing', () => {
  it('holds not one writing verb', () => {
    const WRITING = /:(write|issue|award|revoke|approve|reject|grant|assign|review|send|enter|finalize|charter|suspend|escalate|publish)$/;
    const writes = actionsForRole('AUDITOR').filter((a) => WRITING.test(a));
    // An auditor who can change a record is not an auditor.
    expect(writes).toEqual([]);
  });

  it('can still read the things it is there to check', () => {
    for (const a of ['audit:read', 'finance:read', 'quote:read', 'contract:read', 'feeframework:read', 'coach:read'] as Action[]) {
      expect(canAnywhere(auditor, a), `an auditor cannot read ${a}`).toBe(true);
    }
  });

  it('cannot read safeguarding, HR or medical casework', () => {
    // Read-only is not the same as read-everything.
    for (const a of ['safeguarding:read', 'hr:read', 'medical:read', 'person:read_pii'] as Action[]) {
      expect(canAnywhere(auditor, a), `the auditor reached ${a}`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('inactive and expired bindings confer nothing', () => {
  it('refuses a suspended binding', () => {
    const suspended: Principal = {
      userId: 5, label: 'suspended',
      bindings: [{ role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: SCHOOL_A, status: 'suspended' }],
    };
    expect(can(suspended, 'program:read', { institutionId: SCHOOL_A })).toBe(false);
    expect(canAnywhere(suspended, 'program:read')).toBe(false);
  });

  it('refuses an expired binding', () => {
    const expired: Principal = {
      userId: 6, label: 'expired',
      bindings: [{
        role: 'INSTITUTION_ADMIN', scopeType: 'institution', scopeId: SCHOOL_A,
        expiresAt: new Date(Date.now() - 60_000),
      }],
    };
    expect(can(expired, 'program:read', { institutionId: SCHOOL_A })).toBe(false);
  });

  it('ignores a role that does not exist', () => {
    const bogus = {
      userId: 7, label: 'bogus',
      bindings: [{ role: 'GOD_MODE' as Role, scopeType: 'national' as const, scopeId: null }],
    };
    expect(can(bogus, 'person:read', {})).toBe(false);
    expect(canAnywhere(bogus, 'person:read')).toBe(false);
    expect(visibleScopes(bogus, 'person:read').kind).toBe('none');
  });

  it('refuses a principal that is null, empty or malformed', () => {
    expect(can(null, 'person:read', {})).toBe(false);
    expect(can(undefined, 'person:read', {})).toBe(false);
    expect(can({ userId: null, label: 'x', bindings: [] }, 'person:read', {})).toBe(false);
    expect(can({ userId: null, label: 'x' } as any, 'person:read', {})).toBe(false);
  });
});

describe('every role is reachable and every action is held by somebody', () => {
  it('grants each role at least one action', () => {
    // A role with no actions is a role somebody will be given, believing it
    // does something.
    for (const role of ROLES) {
      expect(actionsForRole(role).length, `${role} confers nothing`).toBeGreaterThan(0);
    }
  });

  it('leaves no role ungrantable', () => {
    // The check that found the real defect. A role can hold real authority,
    // appear in ROLES, be listed in the admin UI — and be impossible to confer,
    // because canGrantRole() refuses to hand over an action the granter does
    // not already hold. HR_OFFICER and MEDICAL_OFFICER were exactly that: they
    // existed, they meant something, and nobody on earth could assign them.
    //
    // "At least one role can grant it" is the weakest true statement of the
    // requirement, which is why it is the one asserted.
    const target = { scopeType: 'national' as const, scopeId: null };
    for (const role of ROLES) {
      const granters = ROLES.filter((g) =>
        canGrantRole(bind(g, 'national', null), role, target)
      );
      expect(granters.length, `no role can grant ${role}`).toBeGreaterThan(0);
    }
  });

  it('leaves no action unreachable by every role', () => {
    // The reverse: an action nothing grants is a permanently closed door, and
    // the endpoint behind it is dead code nobody notices.
    const held = new Set<string>();
    for (const role of ROLES) for (const a of actionsForRole(role)) held.add(a);

    // Collected from the union of what the roles grant, then checked against
    // the operations actions this session introduced.
    const introduced: Action[] = [
      'coach:read', 'coach:write', 'coach:review', 'coach:assign',
      'program:read', 'program:write', 'program:approve', 'program:publish',
      'quote:read', 'quote:issue', 'quote:approve',
      'feeframework:read', 'feeframework:write', 'feeframework:publish',
      'contract:read', 'contract:write', 'booking:read', 'booking:write',
      'venue:read', 'venue:write', 'attendance:read', 'attendance:write',
      'task:read', 'task:write', 'support:read', 'support:write', 'support:escalate',
      'document:read', 'document:write', 'report:read', 'export:run',
      'workflow:read', 'workflow:write', 'notification:read', 'notification:send',
      'seo:read', 'seo:write', 'hr:read', 'hr:write', 'medical:read', 'medical:write',
    ];
    for (const a of introduced) {
      expect(held.has(a), `no role grants ${a}`).toBe(true);
    }
  });
});
