// The individual and parent intake — the public edge.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO CALLERS, ONE CORE
// ─────────────────────────────────────────────────────────────────────────────
//
// Same construction as /api/learn/application, and for the same reason. The
// middleware requires `application/json` on every /api/ path — which is what a
// cross-site form cannot send without a preflight this application never
// answers — so a no-JavaScript form cannot post here. It posts to
// /start/individual instead, which is still origin-checked by the same
// middleware, and that page calls `submitIndividualRequest()` below rather than
// repeating the rate limit and the validation.
//
// Two copies of a rate limit is how one of them ends up weaker.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ATTRIBUTION HELPERS ARE IMPORTED, NOT COPIED
// ─────────────────────────────────────────────────────────────────────────────
//
// `attribution()` and `leadSourceFrom()` come from the institutional endpoint.
// They decide which channel introduced somebody, and the federation reads that
// number to decide where to spend. Two implementations would answer the same
// question differently and nobody would know which page produced which count.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A FAILED AUTOMATION IS STILL A SUCCESS
// ─────────────────────────────────────────────────────────────────────────────
//
// The lead and the training request are written first; the acknowledgement, the
// task and the event are consequences. If the acknowledgement cannot be queued,
// the enquiry is still on file with its reference and the retry sweep finishes
// the job. Reporting failure there would tell somebody who has just answered
// ten questions that it did not work, when it did — and they would fill it in
// again, and the federation would hold two enquiries from one person.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import {
  INDIVIDUAL_STEPS, validateIndividual, isApplicationError,
  type IndividualAnswers, type IndividualProblem,
} from '@/db/applications';
import { submitIndividualEnquiryWithAutomation } from '@/db/automations';
import { rateLimit } from '@/lib/ratelimit';
import { attribution, leadSourceFrom } from '@/pages/api/learn/application';

export const prerender = false;

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Ten an hour per connection.
 *
 * Tighter than the institutional form's twenty because this endpoint is only
 * ever reached by a FINAL submission — moving between the questions writes
 * nothing and is not counted — and looser than one because a parent enquiring
 * for two children legitimately sends the form twice in a sitting.
 */
const RATE_LIMIT = { bucket: 'training-enquiry', limit: 10, windowSeconds: 3600 } as const;

export type IndividualOutcome =
  | {
      kind: 'recorded';
      ref: string;
      summary: string;
      /** True when the same submission had already been recorded. */
      alreadyRecorded: boolean;
      /** True when the follow-up automation did not complete. The enquiry is stored. */
      followUpPending: boolean;
      message: string;
    }
  | { kind: 'invalid'; problems: IndividualProblem[]; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export function statusFor(outcome: IndividualOutcome): number {
  switch (outcome.kind) {
    case 'recorded': return 200;
    case 'invalid': return 400;
    case 'rate_limited': return 429;
    case 'unavailable': return 503;
    case 'failed': return 500;
  }
}

export interface IndividualRequest {
  answers: IndividualAnswers;
  /** Carried by the form from its first step, so a resend is not a second enquiry. */
  formNonce: string;
  landingPath?: string | null;
  utm?: Record<string, unknown> | null;
}

/** The one true handler. Both entry points call this. */
export async function submitIndividualRequest(
  request: Request,
  input: IndividualRequest
): Promise<IndividualOutcome> {
  const rl = await rateLimit(request, RATE_LIMIT.bucket, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!rl.ok) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, rl.retryAfterSeconds),
      message:
        'Too many enquiries have been sent from this connection. Wait a few minutes and try again — ' +
        'your answers are still on the page.',
    };
  }

  const answers = (input.answers ?? {}) as IndividualAnswers;

  // Validated before the database is consulted, so somebody on an unconfigured
  // deployment still gets told what is missing rather than only that the system
  // is down.
  const problems = validateIndividual(answers);
  if (problems.length) {
    return {
      kind: 'invalid',
      problems,
      message: `${problems.length} answer${problems.length === 1 ? '' : 's'} need${problems.length === 1 ? 's' : ''} attention before this can be sent.`,
    };
  }

  if (!isConfigured()) {
    // Said plainly. A form that accepts an enquiry and quietly discards it is
    // worse than one that admits it cannot take it.
    return {
      kind: 'unavailable',
      message:
        'MMAKF cannot receive enquiries at the moment because the federation’s database is not reachable. ' +
        'Nothing you entered has been stored. Please write to admin@mmakf.in with what you are looking for.',
    };
  }

  const source = attribution(request, input as any);
  const leadSource = leadSourceFrom(source.referer);

  try {
    const result = await submitIndividualEnquiryWithAutomation(db(), {
      answers,
      formNonce: String(input.formNonce ?? ''),
      leadSource,
      landingPath: source.landingPath,
      utm: source.utm,
    });

    const followUpPending = result.automation.some(
      (run) => run.status === 'failed' || run.status === 'partially_failed'
    );

    return {
      kind: 'recorded',
      ref: result.ref,
      summary: result.summary,
      alreadyRecorded: result.alreadyRecorded,
      followUpPending,
      message: `MMAKF has your enquiry. Your reference is ${result.ref}.`,
    };
  } catch (err: any) {
    if (isApplicationError(err)) {
      return {
        kind: 'invalid',
        problems: err.field
          ? [{ field: err.field, message: err.message, stepKey: 'contact' }]
          : [],
        message: err.message,
      };
    }
    console.error('[start/individual] unhandled', err);
    return {
      kind: 'failed',
      message:
        'Something went wrong recording the enquiry, and nothing has been sent to MMAKF. ' +
        'Please try again, or write to admin@mmakf.in.',
    };
  }
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ kind: 'invalid', problems: [], message: 'That submission is too large.' }, 400);
  }

  let body: any;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ kind: 'invalid', problems: [], message: 'The submission could not be read.' }, 400);
  }

  const outcome = await submitIndividualRequest(request, {
    answers: body.answers ?? {},
    formNonce: body.formNonce ?? '',
    landingPath: body.landingPath ?? null,
    utm: body.utm ?? null,
  });

  return json(outcome, statusFor(outcome));
};

/**
 * The question set, so nothing carries a second copy of it.
 *
 * The relevance rules are FUNCTIONS and cannot be serialised, so what is
 * returned here is the shape of the form and not its behaviour. A client that
 * wanted to reproduce the branching would have to ask the server which step
 * comes next, which is exactly what the server-rendered form already does.
 */
export const GET: APIRoute = async () =>
  json(
    {
      steps: INDIVIDUAL_STEPS.map((s) => ({
        key: s.key,
        title: s.title,
        conditional: Boolean(s.when),
        fields: s.fields.map((f) => ({
          name: f.name,
          label: f.label,
          kind: f.kind,
          required: Boolean(f.required),
          conditional: Boolean(f.when || f.optionsFor),
        })),
      })),
      note:
        'Steps and fields marked conditional are asked only when earlier answers make them relevant. ' +
        'The server decides which step comes next.',
    },
    200
  );

function json(payload: unknown, status: number): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // An enquiry names a person, and where a child is involved it names the
    // adult responsible for one.
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (status === 429) {
    const retry = (payload as any)?.retryAfterSeconds;
    if (retry) headers['Retry-After'] = String(retry);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
