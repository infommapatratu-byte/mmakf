// Two-person control — the decision path.
//
// THE ONE RULE THIS ROUTE SERVES: the approver must not be the requester. It is
// enforced in src/lib/approvals.ts against identity, under a row lock, for every
// role including SUPER_ADMIN. Nothing here re-checks it, and nothing here could
// weaken it — this file only carries the request to the module and the module's
// answer back.
//
// WHAT IS DELIBERATELY ABSENT: there is no `request` action.
//
// `requestApproval()` freezes a PAYLOAD that `executeIfApproved()` later hands
// to a handler owned by the subsystem performing the act — revoking the
// certificate, settling the money, correcting the result. A generic "raise a
// request" form here would mint requests that no handler is wired to execute:
// they would be approved, sit at `approved`, and never happen. That is a
// control that cannot work, so it is not offered. Requests are raised by the
// subsystem that will carry the act out, and executed there too.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import { approve, reject, approvalState, ApprovalError } from '@/lib/approvals';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * ApprovalError code → HTTP status.
 *
 * `self_approval` is 403, not 409: it is a refusal of authority, not a state
 * clash. The queue never offers the button that produces it — a request you
 * raised is excluded from your own queue by `pendingApprovals`, and the
 * single-request view renders a withdrawal control instead — so a caller
 * reaching this line has gone round the UI, and the status should say so.
 */
function statusFor(code: string): number {
  switch (code) {
    case 'unknown_request': return 404;
    case 'self_approval':
    case 'unidentified_principal': return 403;
    case 'not_pending':
    case 'already_approved_by_you': return 409;
    default: return 400;
  }
}

function unavailable() {
  return json({
    error: 'The federation database is not configured on this deployment. Two-person control is recorded in the domain event log, and there is no log to append to until DATABASE_URL is set.',
    code: 'unavailable',
  }, 503);
}

// ─── Read one request ───────────────────────────────────────────────────────
//
// GET, because it changes nothing. `approvalState` applies the same authority
// check the act itself requires, in the request's own scope: if you could not
// approve it, you cannot read it.

export const GET: APIRoute = async ({ request, params, url }) => {
  const rl = await rateLimit(request, 'approvals-read', 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  if (action !== 'state') return json({ error: 'Unknown approvals action' }, 404);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to read an approval request' }, 401);
  if (!isConfigured()) return unavailable();

  const requestId = (url.searchParams.get('requestId') ?? '').trim();
  if (!requestId || requestId.length > 64) {
    return json({ error: 'Give the request identifier, for example MMAKF-APR-2026-000001.' }, 400);
  }

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };

  try {
    const state = await approvalState(db(), ctx, requestId);
    return json({ ok: true, result: state }, 200);
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({
        error: 'Your credential does not hold the authority this request requires, in its scope. A request you could not approve is a request you cannot read.',
        code: 'forbidden',
      }, 403);
    }
    if (err instanceof ApprovalError) {
      return json({ error: err.message, code: err.code }, statusFor(err.code));
    }
    console.error('[approvals] unexpected read', err);
    return json({ error: 'Could not read that request.' }, 500);
  }
};

// ─── Approve / reject ───────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, params }) => {
  const rl = await rateLimit(request, 'approvals-decide', 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  if (action !== 'approve' && action !== 'reject') {
    return json({ error: 'Unknown approvals action' }, 404);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to decide an approval request' }, 401);
  if (!isConfigured()) return unavailable();

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!requestId || requestId.length > 64) {
    return json({ error: 'Give the request identifier, for example MMAKF-APR-2026-000001.' }, 400);
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: reason || null,
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };

  try {
    // `approve` takes no reason: agreement is evidenced by the approver's
    // identity in the event log. `reject` requires one, and refuses without it.
    const state = action === 'approve'
      ? await approve(db(), ctx, requestId)
      : await reject(db(), ctx, requestId, reason);
    return json({ ok: true, result: state }, 200);
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({
        error: 'Your credential does not hold the authority this act requires, in its scope. A second person who lacks the permission is not a second authorisation.',
        code: 'forbidden',
      }, 403);
    }
    if (err instanceof ApprovalError) {
      return json({ error: err.message, code: err.code }, statusFor(err.code));
    }
    console.error('[approvals] unexpected decide', action, err);
    return json({ error: 'The decision was not recorded. Nothing was changed.' }, 500);
  }
};
