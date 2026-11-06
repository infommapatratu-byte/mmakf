// /api/admin/legacy-certificates — preview and import historical certificates.
//
//   POST { action: 'preview', csv }                 what WOULD happen, row by row; writes nothing
//   POST { action: 'import',  csv, sourceLabel }    import every row the preview accepts
//
// Both need certificate:issue (the preview reveals which member records match).
// Matching, idempotency and the legacy marking live in src/db/legacy-certificates.ts.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError, assertCanAnywhere } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import { readLegacyCsv, planLegacyImport, importLegacyCertificates } from '@/db/legacy-certificates';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'legacy-certificates', 30, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to import certificates.' }, 401);
  if (identity.shared) return json({ error: 'Certificates are imported by a named person. Sign in with your own account.' }, 403);
  if (!isConfigured()) return json({ error: 'The register is not available on this deployment.' }, 503);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 1_500_000) return json({ error: 'The file is too large. Split it into parts of up to 2000 certificates.' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const { rows, errors } = readLegacyCsv(String(body?.csv ?? ''));
  if (errors.length) return json({ error: errors.join(' ') }, 400);

  const ctx: AuditContext = { principal: identity.principal, ip: clientIp(request), reason: null, authority: 'user' };
  try {
    assertCanAnywhere(identity.principal, 'certificate:issue');
    if (body.action === 'preview') {
      const plan = await planLegacyImport(db(), rows);
      return json({ ok: true, rows: plan }, 200);
    }
    if (body.action === 'import') {
      const label = typeof body.sourceLabel === 'string' && body.sourceLabel.trim()
        ? body.sourceLabel.trim().slice(0, 120)
        : 'historical certificate import';
      return json({ ok: true, report: await importLegacyCertificates(db(), ctx, rows, { sourceLabel: label }) }, 200);
    }
    return json({ error: 'Unknown action', actions: ['preview', 'import'] }, 404);
  } catch (err: any) {
    if (err instanceof ForbiddenError) return json({ error: 'Your account does not have permission to issue certificates.' }, 403);
    console.error('[api/admin/legacy-certificates] unhandled', err);
    return json({ error: 'The register did not answer. Nothing further was imported.' }, 500);
  }
};
