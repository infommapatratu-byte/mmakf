// Record a decision on a queued item.
//
// The endpoint that makes the application queue workable. Authority comes from
// identify() — the single place a request becomes an identity — rather than
// from a local cookie check, so there is one policy path and not one per page.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { decide, isQueue, QueueError } from '@/lib/queue';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { writeAudit } from '@/db/federation';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'queue-decide', 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to record a decision' }, 401);

  let body: any;
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

  const queue = String(body.queue ?? '');
  if (!isQueue(queue)) return json({ error: 'Unknown queue' }, 400);

  try {
    const result = await decide(identity.principal, {
      queue,
      recordId: String(body.recordId ?? ''),
      toStatus: String(body.toStatus ?? ''),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      applicantNote: typeof body.applicantNote === 'string' ? body.applicantNote : undefined,
    });

    // Audited when a database is available. The decision itself is already
    // durable in the record's own append-only history either way, so a missing
    // database delays the audit trail rather than losing the decision.
    if (isConfigured()) {
      try {
        await writeAudit(
          db(),
          {
            principal: identity.principal,
            ip: clientIp(request),
            reason: typeof body.reason === 'string' ? body.reason : null,
            // Records that a shared credential was used, so the trail never
            // implies an individual took the decision when it cannot know.
            authority: identity.shared ? `shared:${identity.via}` : 'user',
          },
          {
            entityType: `queue:${queue}`,
            entityId: result.recordId,
            action: /reject|return/i.test(result.to) ? 'reject' : 'approve',
            oldValue: { status: result.from },
            newValue: { status: result.to },
          }
        );
      } catch (err) {
        console.error('[queue] audit write failed', err);
      }
    }

    return json(result, 200);
  } catch (err: any) {
    if (err instanceof QueueError) {
      const status =
        err.code === 'forbidden' ? 403 :
        err.code === 'not_found' ? 404 :
        err.code === 'already_decided' || err.code === 'no_change' ? 409 : 400;
      return json({ error: err.message, code: err.code }, status);
    }
    console.error('[queue] unexpected', err);
    return json({ error: 'Could not record the decision' }, 500);
  }
};
