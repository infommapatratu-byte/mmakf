// Admin endpoint: write a single content key.
//
// Two things were missing here and both mattered:
//
//  · Authority came from a bare cookie check, so this route re-implemented the
//    policy locally instead of asking the one module that owns it. It now goes
//    through identify() and an explicit `content:write` check, which means a
//    unit-level credential cannot write national content.
//
//  · Nothing was audited. This route writes `members` (the register behind
//    public verification) and `unitAccess` (the portal credentials), and there
//    was no record of who changed either, when, or from what. Every write now
//    stores the previous value alongside the new one.

import type { APIRoute } from 'astro';
import { get, set } from '@/lib/storage';
import { identify, clientIp } from '@/lib/session';
import { can } from '@/lib/rbac';
import { KEYS } from '@/data/seed';
import { isConfigured, db } from '@/db';
import { writeAudit } from '@/db/federation';

export const prerender = false;

/**
 * Keys writable only through the admin panel and never served by the public
 * GET /api/data. `unitAccess` holds portal credentials; `members` is the
 * federation register.
 */
const ADMIN_ONLY_KEYS = ['unitAccess'];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, params }) => {
  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Unauthorized' }, 401);

  // Site-wide content has no unit location, so only a national binding reaches
  // it — a state or club credential is refused here by scope, not by hope.
  if (!can(identity.principal, 'content:write', {})) {
    return json({ error: 'You do not have authority to edit federation content' }, 403);
  }

  const key = params.key as string;
  if (!KEYS.includes(key as any) && !ADMIN_ONLY_KEYS.includes(key)) {
    return json({ error: 'Invalid key' }, 400);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // The stored shape must not flip between array and object: the pages that
  // render these keys assume one or the other, and a flipped shape breaks the
  // public site rather than the admin panel where the mistake was made.
  const previous = await get<any>(key);
  if (previous !== null && previous !== undefined) {
    const wasArray = Array.isArray(previous);
    if (wasArray !== Array.isArray(body)) {
      return json(
        { error: `"${key}" is stored as ${wasArray ? 'a list' : 'an object'} and must stay that way.` },
        400
      );
    }
  }

  await set(key, body);

  if (isConfigured()) {
    try {
      await writeAudit(
        db(),
        {
          principal: identity.principal,
          ip: clientIp(request),
          authority: identity.shared ? `shared:${identity.via}` : 'user',
        },
        {
          entityType: 'content',
          entityId: key,
          action: 'update',
          // Recording both sides is what makes a bad edit recoverable.
          oldValue: previous ?? null,
          newValue: body,
        }
      );
    } catch (err) {
      console.error('[content] audit write failed', err);
    }
  }

  return json({ ok: true, key }, 200);
};
