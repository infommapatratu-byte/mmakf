// Public endpoint: entry into a sanctioned MMAKF competition.
//
// WHAT CHANGED, AND WHY IT MATTERED
//
// This endpoint used to append a free-text record — an event TITLE, a name and
// a phone number — to a Redis list called `eventRegs`. Nothing read that list.
// The approval queue read a list called `eventEntries`; draws, results, the
// annual report and every ranking read the Postgres table `event_entries`. An
// athlete entered a championship, received a reference number, and the entry
// arrived nowhere at all.
//
// There is now ONE canonical model: the Postgres entry register. This endpoint
// is a thin shell over submitPublicEntry() in src/db/competition.ts, which owns
// the event lookup, the competitor lookup, the eligibility decision and its
// stored evidence. This file identifies the request, limits it, caps it, parses
// it, and lets the module's own typed error choose the status code.
//
// WHAT THE CALLER MAY SAY: an event code, a category code, a federation
// membership number and a date of birth. Nothing else is read from the body.
// Eligibility, scope, dojo, state and the entry's status are ALL derived
// server-side from the competitor's own record — a client that posts them is
// posting fields this file never looks at.
//
// The strays already in `eventRegs` are not touched. They carry no competitor
// on the register and no category, so migrating them would mean inventing both;
// they stay in Redis and are read and decided by /admin/queue instead.

import type { APIRoute } from 'astro';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { clientIp } from '@/lib/session';
import { isConfigured, db } from '@/db';
import { CompetitionError, submitPublicEntry } from '@/db/competition';
import { ForbiddenError } from '@/lib/rbac';

export const prerender = false;

const MAX_BODY = 16 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * The module's error code decides the status, the same rule the competition API
 * applies, so the two endpoints cannot classify the same refusal differently.
 */
function statusForCode(code: string): number {
  if (/^unknown_/.test(code)) return 404;
  if (/^(already_|duplicate_)/.test(code)) return 409;
  return 400;
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'event-register', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // The entry register is a federation record and lives in the federation
  // database. Say that plainly rather than accepting an entry into a store
  // nothing reads — which is the defect this endpoint used to be.
  if (!isConfigured()) {
    return json(
      {
        error:
          'The federation database is not configured on this deployment, so entries cannot be recorded. Contact the office.',
        code: 'database_not_configured',
      },
      503
    );
  }

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  try {
    const result = await submitPublicEntry(
      db(),
      {
        eventCode: body.eventCode,
        categoryCode: body.categoryCode,
        federationId: body.federationId,
        dob: body.dob,
      },
      new Date(),
      { ip: clientIp(request) }
    );

    // `duplicate` is reported rather than hidden: a competitor who submits
    // twice is told they already have this entry and given the same number,
    // which is the truthful answer and the one that stops them trying again.
    return json(
      {
        ok: true,
        ref: result.entryNo,
        status: result.status,
        duplicate: result.duplicate,
        event: result.eventTitle,
        category: result.categoryLabel,
        eligible: result.eligible,
        // Present only on a refusal, and written by the eligibility rules the
        // federation configured — never composed here.
        reasons: result.reasons,
      },
      200
    );
  } catch (err: any) {
    if (err instanceof CompetitionError) {
      return json({ error: err.message, code: err.code }, statusForCode(err.code));
    }
    // The intake acts as the federation, so this should be unreachable; it is
    // handled rather than leaked as a 500 with a stack trace.
    if (err instanceof ForbiddenError) {
      return json({ error: 'This entry cannot be accepted through the public form.', code: 'forbidden' }, 403);
    }
    console.error('[event-register] unexpected', err);
    return json({ error: 'The entry could not be recorded.' }, 500);
  }
};
