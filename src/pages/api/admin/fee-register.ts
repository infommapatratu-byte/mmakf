// /api/admin/fee-register — load, approve and archive the prices checkout charges.
//
//   POST { action: 'import' }                 load the 2026 fee master   (feeframework:write)
//   POST { action: 'approve', id }            proposed -> chargeable     (feeframework:publish)
//   POST { action: 'archive', id }            stop charging, keep record (feeframework:publish)
//
// Every write runs as the signed-in person and is audited against them. The
// permission checks live in src/db/fee-register.ts, so no caller can skip them.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import { importFeeMaster, approveFee, archiveFee, isFeeRegisterError } from '@/db/fee-register';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'fee-register', 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to change the fee register.' }, 401);
  if (identity.shared) return json({ error: 'Fees are approved by a named person. Sign in with your own account.' }, 403);
  if (!isConfigured()) return json({ error: 'The register is not available on this deployment.' }, 503);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const action = String(body?.action ?? '');
  const id = Number(body?.id);

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: typeof body?.reason === 'string' ? body.reason.slice(0, 1000) : null,
    authority: 'user',
  };

  try {
    switch (action) {
      case 'import':
        return json({ ok: true, report: await importFeeMaster(db(), ctx) }, 200);
      case 'approve':
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Which fee? An id is required.' }, 400);
        return json({ ok: true, fee: await approveFee(db(), ctx, id) }, 200);
      case 'archive':
        if (!Number.isInteger(id) || id <= 0) return json({ error: 'Which fee? An id is required.' }, 400);
        return json({ ok: true, fee: await archiveFee(db(), ctx, id) }, 200);
      default:
        return json({ error: 'Unknown action', actions: ['import', 'approve', 'archive'] }, 404);
    }
  } catch (err: any) {
    if (err instanceof ForbiddenError) return json({ error: 'Your account does not have permission for this.', code: 'forbidden' }, 403);
    if (isFeeRegisterError(err)) return json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : 409);
    console.error('[api/admin/fee-register] unhandled', err);
    return json({ error: 'The fee register failed to answer.', code: 'internal' }, 500);
  }
};
