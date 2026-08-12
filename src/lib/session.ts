// Request -> Principal. The single place a request becomes an identity.
//
// Three credential types can be presented, in descending order of trust:
//
//   1. mmakf_user  — a per-person account. Roles come from role_bindings on
//                    every request, so withdrawal is immediate.
//   2. mmakf_admin — the legacy shared office password session. Maps to a
//                    national FEDERATION_ADMIN principal labelled so the audit
//                    trail shows plainly that the action was not attributable
//                    to a person.
//   3. mmakf_unit  — the legacy shared unit access code. Maps to a state-scoped
//                    principal.
//
// Pages and endpoints must call this rather than reading cookies themselves;
// re-implementing the check locally is how gaps appear (§75).

import { getUserSession, getUnitSession, isAuthenticated } from './auth';
import { legacyAdminPrincipal, legacyUnitPrincipal, type Principal } from './rbac';
import { isConfigured, db } from '@/db';
import { resolvePrincipal } from '@/db/users';

export interface Identity {
  principal: Principal;
  /** How the caller authenticated — recorded in the audit trail. */
  via: 'user' | 'shared-admin-password' | 'shared-unit-code';
  /** True when the credential is shared and cannot identify an individual. */
  shared: boolean;
  userId: number | null;
  mustChangePassword?: boolean;
}

/**
 * Resolve the caller. Returns null when unauthenticated.
 *
 * A user cookie that no longer resolves — account disabled, session epoch
 * bumped, bindings all revoked — yields null rather than falling through to a
 * shared credential, so a revoked account cannot silently regain the shared
 * level of access.
 */
export async function identify(cookieHeader: string | null | undefined): Promise<Identity | null> {
  const userClaims = getUserSession(cookieHeader);
  if (userClaims) {
    if (!isConfigured()) return null;      // cannot verify without the database
    const principal = await resolvePrincipal(db(), userClaims.userId, userClaims.epoch);
    if (!principal) return null;
    return { principal, via: 'user', shared: false, userId: principal.userId };
  }

  if (isAuthenticated(cookieHeader)) {
    return {
      principal: legacyAdminPrincipal(),
      via: 'shared-admin-password',
      shared: true,
      userId: null,
    };
  }

  const unit = getUnitSession(cookieHeader);
  if (unit) {
    return {
      principal: legacyUnitPrincipal({ name: unit.name, level: unit.level, stateUnitId: null }),
      via: 'shared-unit-code',
      shared: true,
      userId: null,
    };
  }

  return null;
}

/** The client IP, for rate limiting and hashed audit records. */
export function clientIp(request: Request): string | null {
  const h = request.headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return h.get('x-real-ip') || h.get('cf-connecting-ip') || null;
}
