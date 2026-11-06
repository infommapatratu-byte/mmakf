// /api/my/profile — attach a member record to the signed-in account.
//
//   POST { action: 'claim', federationId, dob }               an existing member
//   POST { action: 'create', fullName, dob, phone, city? }    someone new to MMAKF
//
// Only ever for the caller's own account. Tight rate limit: a member ID plus a
// date of birth is a factor, so guessing must be slow. The rules (one record per
// account, no duplicate people, no self-created records for children) live in
// src/db/learner-profile.ts.

import type { APIRoute } from 'astro';
import { identify } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { claimMemberRecord, createLearnerProfile, isLearnerProfileError } from '@/db/learner-profile';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const STATUS: Record<string, number> = {
  bad_input: 400, no_match: 404, minor: 409, possible_duplicate: 409,
  already_linked: 409, linked_elsewhere: 409, not_claimable: 409, no_account: 401,
};

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'my-profile', 8, 3600);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity || identity.userId == null) return json({ error: 'Sign in with your own account first.' }, 401);
  if (!isConfigured()) return json({ error: 'The member register is not available on this deployment.' }, 503);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  try {
    switch (String(body?.action ?? '')) {
      case 'claim': {
        const r = await claimMemberRecord(db(), { userId: identity.userId, federationId: body.federationId, dob: body.dob });
        return json({ ok: true, linked: 'existing', federationId: r.federationId, fullName: r.fullName }, 200);
      }
      case 'create': {
        const r = await createLearnerProfile(db(), {
          userId: identity.userId, fullName: body.fullName, dob: body.dob, phone: body.phone, city: body.city ?? null,
        });
        return json({ ok: true, linked: 'new', federationId: r.federationId }, 200);
      }
      default:
        return json({ error: 'Unknown action', actions: ['claim', 'create'] }, 404);
    }
  } catch (err: any) {
    if (isLearnerProfileError(err)) return json({ error: err.message, code: err.code }, STATUS[err.code] ?? 409);
    console.error('[api/my/profile] unhandled', err);
    return json({ error: 'The member register did not answer. Nothing was changed.' }, 500);
  }
};
