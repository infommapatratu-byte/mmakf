// Institutional application intake — the public edge.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO CALLERS, ONE CORE
// ─────────────────────────────────────────────────────────────────────────────
//
// Same construction as /api/auth/register, and for the same reason. The
// middleware requires `application/json` on every /api/ path — that is what a
// cross-site form cannot send without a preflight we never answer — so a
// no-JavaScript form cannot post here. It posts to /learn/apply instead, which
// is still origin-checked, and that page calls `submitApplicationRequest()`
// below rather than repeating the rate limit and the validation.
//
// Two copies of a rate limit is how one of them ends up weaker.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A FAILED AUTOMATION IS STILL A 200
// ─────────────────────────────────────────────────────────────────────────────
//
// The application is stored first, and everything derived from it — the
// institution, the lead, the task, the acknowledgement — is a consequence. If
// the acknowledgement cannot be queued, the school's application is still on
// file with its reference, and the retry sweep will finish the job.
//
// Returning 500 there would tell a principal who has just spent twenty minutes
// on a form that it failed, when it did not. They would fill it in again, and
// the federation would have two applications from one school.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import {
  saveDraft, validateSubmission, WIZARD_STEPS, TOTAL_STEPS,
  isApplicationError, type FieldProblem,
} from '@/db/applications';
import { submitApplicationWithAutomation } from '@/db/automations';
import { rateLimit } from '@/lib/ratelimit';
import { AUDIENCES } from '@/db/engagement';

export const prerender = false;

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Twenty an hour per connection.
 *
 * Looser than registration because the legitimate pattern here includes
 * repeated draft saves — the form saves as the applicant moves between steps,
 * and a school that takes its time must not be locked out of its own
 * application half way through.
 */
const RATE_LIMIT = { bucket: 'institution-application', limit: 20, windowSeconds: 3600 } as const;

export type ApplicationOutcome =
  | {
      kind: 'submitted';
      ref: string;
      accessToken: string;
      statusHref: string;
      /** True when the automation did not complete. The application is still stored. */
      followUpPending: boolean;
      message: string;
    }
  | { kind: 'draft_saved'; ref: string; accessToken: string; stepReached: number; resumeHref: string }
  | { kind: 'invalid'; problems: FieldProblem[]; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export function statusFor(outcome: ApplicationOutcome): number {
  switch (outcome.kind) {
    case 'submitted': return 200;
    case 'draft_saved': return 200;
    case 'invalid': return 400;
    case 'rate_limited': return 429;
    case 'unavailable': return 503;
    case 'failed': return 500;
  }
}

/**
 * Attribution, taken from where the browser actually knows it.
 *
 * The landing path and referrer come from the REQUEST, never from a body field,
 * so a caller cannot claim to have arrived from a campaign they did not. UTM
 * parameters do come from the body because they only exist in the URL the form
 * was served on — but they are recorded as claims, and nothing is decided by
 * them.
 */
function attribution(request: Request, body: Record<string, unknown>) {
  const referer = request.headers.get('referer');
  const utm: Record<string, string> = {};
  const raw = (body.utm ?? {}) as Record<string, unknown>;
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) utm[k] = v.trim().slice(0, 120);
  }
  return {
    referer: referer ? referer.slice(0, 400) : null,
    landingPath: typeof body.landingPath === 'string' ? body.landingPath.slice(0, 200) : null,
    utm: Object.keys(utm).length ? utm : null,
  };
}

/** Which lead source a referrer implies. Unknown rather than guessed. */
function leadSourceFrom(referer: string | null): 'organic_search' | 'social' | 'youtube' | 'referral' | 'direct' | 'unknown' {
  if (!referer) return 'direct';
  let host = '';
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (/(^|\.)google\.|(^|\.)bing\.|(^|\.)duckduckgo\./.test(host)) return 'organic_search';
  if (/(^|\.)youtube\.|(^|\.)youtu\.be/.test(host)) return 'youtube';
  if (/(^|\.)facebook\.|(^|\.)instagram\.|(^|\.)linkedin\.|(^|\.)x\.com|(^|\.)twitter\./.test(host)) return 'social';
  if (/(^|\.)mmakf\.in$/.test(host)) return 'direct';
  return 'referral';
}

export interface ApplicationRequest {
  /** 'draft' saves progress; 'submit' sends it to MMAKF. */
  intent: 'draft' | 'submit';
  payload: Record<string, unknown>;
  ref?: string | null;
  accessToken?: string | null;
  stepReached?: number;
  landingPath?: string | null;
  utm?: Record<string, unknown> | null;
}

/** The one true handler. Both entry points call this. */
export async function submitApplicationRequest(
  request: Request,
  input: ApplicationRequest
): Promise<ApplicationOutcome> {
  const rl = await rateLimit(request, RATE_LIMIT.bucket, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!rl.ok) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, rl.retryAfterSeconds),
      message:
        'Too many submissions from this connection. Wait a few minutes and try again — ' +
        'your answers are saved against the reference you were given.',
    };
  }

  if (!isConfigured()) {
    // Said plainly. An application form that accepts a twenty-step submission
    // and quietly discards it is worse than one that admits it cannot take it.
    return {
      kind: 'unavailable',
      message:
        'Applications cannot be received at the moment because the federation’s database is not reachable. ' +
        'Nothing you entered has been stored. Please try again later, or write to admin@mmakf.in.',
    };
  }

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const source = attribution(request, input as any);
  const leadSource = leadSourceFrom(source.referer);

  try {
    if (input.intent === 'draft') {
      const draft = await saveDraft(db(), {
        ref: input.ref ?? null,
        accessToken: input.accessToken ?? null,
        payload,
        stepReached: Number(input.stepReached) || 1,
        source: source as any,
      });
      return {
        kind: 'draft_saved',
        ref: draft.ref,
        accessToken: draft.accessToken!,
        stepReached: draft.stepReached,
        resumeHref: `/learn/apply?ref=${encodeURIComponent(draft.ref)}&k=${encodeURIComponent(draft.accessToken!)}`,
      };
    }

    const problems = validateSubmission(payload);
    if (problems.length) {
      return {
        kind: 'invalid',
        problems,
        message: `${problems.length} answer${problems.length === 1 ? '' : 's'} need${problems.length === 1 ? 's' : ''} attention before this can be sent.`,
      };
    }

    const result = await submitApplicationWithAutomation(db(), {
      payload,
      ref: input.ref ?? null,
      accessToken: input.accessToken ?? null,
      source: source as any,
      leadSource,
      landingPath: source.landingPath,
    });

    const followUpPending = result.automation.some(
      (run) => run.status === 'failed' || run.status === 'partially_failed'
    );

    return {
      kind: 'submitted',
      ref: result.ref,
      accessToken: result.accessToken,
      statusHref: `/learn/applications/${encodeURIComponent(result.ref)}?k=${encodeURIComponent(result.accessToken)}`,
      followUpPending,
      message: `MMAKF has your application. Your reference is ${result.ref}.`,
    };
  } catch (err: any) {
    if (isApplicationError(err)) {
      return {
        kind: 'invalid',
        problems: err.field ? [{ field: err.field, message: err.message, step: 1 }] : [],
        message: err.message,
      };
    }
    console.error('[application] unhandled', err);
    return {
      kind: 'failed',
      message:
        'Something went wrong storing the application. Nothing has been sent to MMAKF. ' +
        'Please try again, or write to admin@mmakf.in.',
    };
  }
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ kind: 'invalid', problems: [], message: 'That submission is too large.' } as ApplicationOutcome, 400);
  }

  let body: any;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ kind: 'invalid', problems: [], message: 'The submission could not be read.' } as ApplicationOutcome, 400);
  }

  const outcome = await submitApplicationRequest(request, {
    intent: body.intent === 'draft' ? 'draft' : 'submit',
    payload: body.payload ?? {},
    ref: body.ref ?? null,
    accessToken: body.accessToken ?? null,
    stepReached: body.stepReached,
    landingPath: body.landingPath ?? null,
    utm: body.utm ?? null,
  });

  return json(outcome, statusFor(outcome));
};

/** The wizard definition, so the client never carries a second copy of it. */
export const GET: APIRoute = async () =>
  json({ steps: WIZARD_STEPS, totalSteps: TOTAL_STEPS, audiences: AUDIENCES }, 200);

function json(payload: unknown, status: number): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // An application contains named contacts and a private access token.
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (status === 429) {
    const retry = (payload as any)?.retryAfterSeconds;
    if (retry) headers['Retry-After'] = String(retry);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
