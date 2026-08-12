// The grading chain, exposed over HTTP.
//
// ELIGIBILITY -> APPLICATION -> PANEL -> SCORECARD -> DECISION -> CERTIFICATE -> LOCK
//
// Every action below is ONE call into src/db/grading.ts and nothing else. No
// grading policy is decided here: not a pass mark, not a minimum interval, not
// who may examine, not whether a certificate may be issued. Those live in the
// module, which is tested, and duplicating any of them at the edge is how the
// two would come to disagree - with the endpoint winning, silently.
//
// So this file does exactly four things:
//   1. turns a request into an identity (identify(), never a cookie read),
//   2. rate limits,
//   3. parses and shape-checks the body,
//   4. hands the module's own error message and code back to the caller.
//
// The module's typed error decides the status. GradingError.code is a closed
// set defined in src/db/grading.ts and mapped here once; an unrecognised code
// falls back to 400 rather than being reported as a server fault.

import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError, assertCan } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import * as s from '@/db/schema';
import {
  GradingError,
  checkEligibility,
  applyForGrading,
  assignExaminer,
  recordScore,
  summariseScores,
  decideCandidate,
  issueGradeCertificate,
  lockGrading,
  revokeCertificate,
} from '@/db/grading';

export const prerender = false;

// --- Wire helpers -----------------------------------------------------------

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    // Authenticated, record-bearing responses. Never cached, never shared.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * GradingError.code -> HTTP status.
 *
 * 404  the named record does not exist
 * 409  the record exists but its state refuses the request (locked, already
 *      entered, no pass on record, examiner unlicensed on the day)
 * 400  the request itself is malformed or incomplete
 *
 * `examiner_not_authorised` is 409, not 403: the caller is permitted to appoint
 * examiners - it is the appointee's licence that conflicts.
 */
const STATUS_BY_CODE: Record<string, number> = {
  unknown_person: 404,
  unknown_grade: 404,
  unknown_event: 404,
  unknown_candidate: 404,
  unknown_certificate: 404,

  registration_closed: 409,
  already_entered: 409,
  already_on_panel: 409,
  already_locked: 409,
  locked: 409,
  examiner_not_authorised: 409,
  not_on_panel: 409,
  observer_cannot_score: 409,
  ineligible: 409,
  no_scores: 409,
  not_passed: 409,
  candidates_undecided: 409,

  syllabus_mismatch: 400,
  bad_score: 400,
  refer_needs_components: 400,
  evidence_required: 400,
  reason_required: 400,
};

class BadRequest extends Error {}

function requireInt(body: Record<string, unknown>, field: string): number {
  const raw = body[field];
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequest(`"${field}" must be a record id.`);
  }
  return n;
}

function optionalInt(body: Record<string, unknown>, field: string): number | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`"${field}" must be a record id.`);
  return n;
}

function requireText(body: Record<string, unknown>, field: string, max = 4000): string {
  const raw = body[field];
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequest(`"${field}" is required.`);
  if (raw.length > max) throw new BadRequest(`"${field}" is too long (limit ${max} characters).`);
  return raw.trim();
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  max = 4000
): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new BadRequest(`"${field}" must be text.`);
  if (raw.length > max) throw new BadRequest(`"${field}" is too long (limit ${max} characters).`);
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

const ACTIONS = [
  'eligibility',
  'apply',
  'assign-examiner',
  'score',
  'decide',
  'issue-certificate',
  'lock',
  'revoke-certificate',
] as const;
type ActionName = (typeof ACTIONS)[number];

function isAction(v: string): v is ActionName {
  return (ACTIONS as readonly string[]).includes(v);
}

const PANEL_ROLES = ['chief', 'examiner', 'assessor', 'observer'] as const;
const OUTCOMES = ['pass', 'fail', 'refer'] as const;

// --- Handler ----------------------------------------------------------------

export const POST: APIRoute = async ({ request, params }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  if (!isAction(action)) {
    return json({ error: 'Unknown grading action', code: 'unknown_action', actions: ACTIONS }, 404);
  }

  const rl = await rateLimit(request, `grading-${action}`, 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to work a grading' }, 401);

  // No fake features: without a database there is no grading chain to act on,
  // and saying so is the honest answer - not a 500, and not a silent no-op.
  if (!isConfigured()) {
    return json(
      {
        error:
          'The federation database is not configured on this deployment, so grading records ' +
          'cannot be read or written. This is not a result about your request.',
        code: 'not_configured',
      },
      503
    );
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    // Examiner notes and candidate feedback are the longest fields here.
    if (raw.length > 16384) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const database = db();

  try {
    const ctx: AuditContext = {
      principal: identity.principal,
      ip: clientIp(request),
      reason: optionalText(body, 'reason', 1000) ?? null,
      // A shared credential is recorded as shared, so the trail never implies
      // an individual took a decision it cannot attribute.
      authority: identity.shared ? `shared:${identity.via}` : 'user',
    };

    switch (action) {
      // -- Eligibility ---------------------------------------------------
      // A read of a candidate's standing against a grade. checkEligibility()
      // carries no authorisation of its own, so the person's own scope is
      // resolved and handed to rbac - the same check applyForGrading() makes.
      case 'eligibility': {
        const personId = requireInt(body, 'personId');
        const gradeDefinitionId = requireInt(body, 'gradeDefinitionId');

        const person = (
          await database.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1)
        )[0];
        if (!person) return json({ error: 'Unknown person', code: 'unknown_person' }, 404);

        assertCan(identity.principal, 'grading:read', {
          stateUnitId: person.stateUnitId,
          districtUnitId: person.districtUnitId,
          dojoId: person.dojoId,
        });

        const result = await checkEligibility(database, personId, gradeDefinitionId);
        return json(result, 200);
      }

      // -- Application ---------------------------------------------------
      case 'apply': {
        const row = await applyForGrading(database, ctx, {
          gradingEventId: requireInt(body, 'gradingEventId'),
          personId: requireInt(body, 'personId'),
          gradeDefinitionId: requireInt(body, 'gradeDefinitionId'),
          presentedByPersonId: optionalInt(body, 'presentedByPersonId'),
          dojoId: optionalInt(body, 'dojoId'),
        });
        return json(row, 201);
      }

      // -- Panel ---------------------------------------------------------
      case 'assign-examiner': {
        const role = String(body.role ?? '');
        if (!(PANEL_ROLES as readonly string[]).includes(role)) {
          throw new BadRequest(`"role" must be one of: ${PANEL_ROLES.join(', ')}.`);
        }
        const row = await assignExaminer(database, ctx, {
          gradingEventId: requireInt(body, 'gradingEventId'),
          personId: requireInt(body, 'personId'),
          role: role as (typeof PANEL_ROLES)[number],
        });
        return json(row, 201);
      }

      // -- Scorecard -----------------------------------------------------
      case 'score': {
        const candidateId = requireInt(body, 'candidateId');
        const rawScore = body.score;
        const score =
          typeof rawScore === 'number' ? rawScore : Number(String(rawScore ?? '').trim());
        if (!Number.isFinite(score)) throw new BadRequest('"score" is required.');

        const rawMax = body.maxScore;
        const maxScore =
          rawMax === undefined || rawMax === null || rawMax === ''
            ? undefined
            : typeof rawMax === 'number'
              ? rawMax
              : Number(String(rawMax).trim());
        if (maxScore !== undefined && !Number.isInteger(maxScore)) {
          throw new BadRequest('"maxScore" must be a whole number.');
        }

        const row = await recordScore(database, ctx, {
          candidateId,
          examinerPersonId: requireInt(body, 'examinerPersonId'),
          component: requireText(body, 'component', 120),
          // Passed through as given: recordScore() owns the range rules and
          // returns its own message. Rounding here would change a mark the
          // panel gave.
          score,
          maxScore,
          gradeRequirementId: optionalInt(body, 'gradeRequirementId'),
          comment: optionalText(body, 'comment', 2000) ?? null,
        });

        // The running totals the panel sees come from the module's own
        // aggregation, so the tablet never shows a figure this file computed.
        const summary = await summariseScores(database, candidateId);
        return json({ score: row, summary }, 200);
      }

      // -- Decision ------------------------------------------------------
      case 'decide': {
        const outcome = String(body.outcome ?? '');
        if (!(OUTCOMES as readonly string[]).includes(outcome)) {
          throw new BadRequest(`"outcome" must be one of: ${OUTCOMES.join(', ')}.`);
        }
        const referred = body.referredComponents;
        let referredComponents: string[] | undefined;
        if (referred !== undefined && referred !== null) {
          if (!Array.isArray(referred) || referred.some((c) => typeof c !== 'string')) {
            throw new BadRequest('"referredComponents" must be a list of component names.');
          }
          referredComponents = referred
            .map((c: string) => c.trim())
            .filter(Boolean)
            .slice(0, 40);
        }

        const row = await decideCandidate(database, ctx, {
          candidateId: requireInt(body, 'candidateId'),
          outcome: outcome as (typeof OUTCOMES)[number],
          referredComponents,
          examinerNotes: optionalText(body, 'examinerNotes', 4000),
          candidateFeedback: optionalText(body, 'candidateFeedback', 4000),
        });
        return json(row, 200);
      }

      // -- Certificate ---------------------------------------------------
      case 'issue-certificate': {
        const certificate = await issueGradeCertificate(
          database,
          ctx,
          requireInt(body, 'candidateId')
        );
        return json(certificate, 201);
      }

      case 'revoke-certificate': {
        // The module requires a reason and makes it public on every subsequent
        // verification. Asking for it here as well only saves a round trip.
        const reason = requireText(body, 'reason', 1000);
        const certificateId = requireInt(body, 'certificateId');
        await revokeCertificate(database, { ...ctx, reason }, certificateId, reason);
        return json({ ok: true, certificateId, status: 'revoked', reason }, 200);
      }

      // -- Lock ----------------------------------------------------------
      case 'lock': {
        const gradingEventId = requireInt(body, 'gradingEventId');
        await lockGrading(database, ctx, gradingEventId);
        return json({ ok: true, gradingEventId, status: 'locked' }, 200);
      }
    }
  } catch (err: any) {
    if (err instanceof BadRequest) {
      return json({ error: err.message, code: 'invalid_request' }, 400);
    }
    if (err instanceof ForbiddenError) {
      return json(
        {
          error: `You do not have authority to do this (${err.action}).`,
          code: 'forbidden',
          action: err.action,
        },
        403
      );
    }
    if (err instanceof GradingError) {
      // The module's message was written to be read by a human. Return it.
      return json({ error: err.message, code: err.code }, STATUS_BY_CODE[err.code] ?? 400);
    }
    // Never leak a stack trace. The server log keeps the detail.
    console.error(`[grading:${action}] unexpected`, err);
    return json({ error: 'The grading record could not be updated. Nothing was changed.' }, 500);
  }

  // Unreachable: every case above returns. Kept so the function is total.
  return json({ error: 'Unknown grading action', code: 'unknown_action' }, 404);
};
