// Coach applications — the public edge.
//
// Two callers, one core, for the reason set out in api/learn/application.ts:
// the middleware requires `application/json` on every /api/ path, so a
// no-JavaScript form cannot post here. It posts to /learn/coaches, which is
// still origin-checked, and that page calls submitCoachApplication() rather
// than repeating the rate limit and the validation.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { applyAsCoachWithAutomation } from '@/db/automations';
import { isCoachError } from '@/db/coaches';
import { rateLimit } from '@/lib/ratelimit';

export const prerender = false;

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Five an hour.
 *
 * Applying to teach is a once-in-a-career act for a real person, so the limit
 * can be tight — the same reasoning as account registration.
 */
const RATE_LIMIT = { bucket: 'coach-application', limit: 5, windowSeconds: 3600 } as const;

export type CoachOutcome =
  | { kind: 'submitted'; ref: string; deduplicated: boolean; message: string }
  | { kind: 'invalid'; field: string | null; message: string }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string };

export function statusFor(o: CoachOutcome): number {
  switch (o.kind) {
    case 'submitted': return 200;
    case 'invalid': return 400;
    case 'rate_limited': return 429;
    case 'unavailable': return 503;
    case 'failed': return 500;
  }
}

export interface CoachFields {
  fullName: string;
  email?: string;
  phone?: string;
  city?: string;
  danGrade?: string;
  gradeAwardedBy?: string;
  teachingYears?: string | number;
  competitionExperience?: string;
  qualificationsSummary?: string;
  preferredPrograms?: string[];
  preferredLocations?: string;
  availabilityNote?: string;
  languages?: string[];
  refereeName?: string;
  refereeContact?: string;
  refereeRelationship?: string;
}

/** The one true handler. Both entry points call this. */
export async function submitCoachApplication(
  request: Request,
  fields: CoachFields
): Promise<CoachOutcome> {
  const rl = await rateLimit(request, RATE_LIMIT.bucket, RATE_LIMIT.limit, RATE_LIMIT.windowSeconds);
  if (!rl.ok) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, rl.retryAfterSeconds),
      message: 'Too many applications from this connection. Wait a few minutes and try again.',
    };
  }

  const fullName = String(fields.fullName ?? '').trim();
  const email = String(fields.email ?? '').trim().toLowerCase();
  const phone = String(fields.phone ?? '').trim();

  // Validation before the database is touched, so no validation path can become
  // a signal about which addresses already applied.
  if (!fullName) {
    return { kind: 'invalid', field: 'fullName', message: 'Your name is needed.' };
  }
  if (!email && !phone) {
    return {
      kind: 'invalid', field: 'email',
      message: 'An email address or a telephone number is needed — otherwise MMAKF cannot tell you the outcome.',
    };
  }
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return { kind: 'invalid', field: 'email', message: 'That does not look like an email address.' };
  }

  const years = Number(fields.teachingYears);

  if (!isConfigured()) {
    return {
      kind: 'unavailable',
      message:
        'Applications cannot be received at the moment because the federation’s database is not reachable. ' +
        'Nothing you entered has been stored. Please write to admin@mmakf.in.',
    };
  }

  try {
    const referees = fields.refereeName
      ? [{
          name: String(fields.refereeName).trim(),
          relationship: String(fields.refereeRelationship ?? '').trim() || undefined,
          contact: String(fields.refereeContact ?? '').trim() || undefined,
        }]
      : null;

    const result = await applyAsCoachWithAutomation(db(), {
      fullName,
      email: email || null,
      phone: phone || null,
      city: String(fields.city ?? '').trim() || null,
      danGrade: String(fields.danGrade ?? '').trim() || null,
      gradeAwardedBy: String(fields.gradeAwardedBy ?? '').trim() || null,
      teachingYears: Number.isFinite(years) && years >= 0 ? Math.trunc(years) : null,
      competitionExperience: String(fields.competitionExperience ?? '').trim() || null,
      qualificationsSummary: String(fields.qualificationsSummary ?? '').trim() || null,
      preferredPrograms: Array.isArray(fields.preferredPrograms) && fields.preferredPrograms.length
        ? fields.preferredPrograms.map(String) : null,
      preferredLocations: String(fields.preferredLocations ?? '').trim()
        ? [String(fields.preferredLocations).trim()] : null,
      availabilityNote: String(fields.availabilityNote ?? '').trim() || null,
      languages: Array.isArray(fields.languages) && fields.languages.length
        ? fields.languages.map(String) : null,
      referees,
    });

    return {
      kind: 'submitted',
      ref: result.ref,
      // Reported plainly rather than hidden. Somebody who applied last month and
      // has forgotten is better served by "we already have this" than by a
      // second reference for the same application.
      deduplicated: result.deduplicated === true,
      message: result.deduplicated
        ? `MMAKF already has an open application from you. Its reference is ${result.ref}.`
        : `MMAKF has your application. Your reference is ${result.ref}.`,
    };
  } catch (err: any) {
    if (isCoachError(err)) {
      return { kind: 'invalid', field: null, message: err.message };
    }
    console.error('[coach-application] unhandled', err);
    return {
      kind: 'failed',
      message: 'Something went wrong storing the application. Please try again, or write to admin@mmakf.in.',
    };
  }
}

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ kind: 'invalid', field: null, message: 'That submission is too large.' }, 400);
  }
  let body: any;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ kind: 'invalid', field: null, message: 'The submission could not be read.' }, 400);
  }

  const outcome = await submitCoachApplication(request, body as CoachFields);
  return json(outcome, statusFor(outcome));
};

function json(payload: unknown, status: number): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (status === 429) {
    const retry = (payload as any)?.retryAfterSeconds;
    if (retry) headers['Retry-After'] = String(retry);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
