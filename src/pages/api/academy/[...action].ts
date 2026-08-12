// The academy API — what a learner does, expressed as endpoints.
//
// Everything here is the CALLER acting on their OWN learning record. The person
// is resolved from the session and is NEVER read from the request body: an
// endpoint that accepts a personId is an endpoint that will one day be sent
// somebody else's. src/db/academy.ts still makes its own self-or-authority
// check on every call — this is belt and braces, not a substitute for it.
//
// Nothing in this file decides authorisation, marks a quiz, applies a pass
// mark, an attempt limit, a watch-time minimum or an attendance threshold. All
// of those live in the module and every one of them is federation policy the
// module refuses to invent. The endpoint's whole job is: identify, rate limit,
// parse, delegate, and return the module's own message with its own status.

import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Principal } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import {
  AcademyError,
  enrol,
  markLessonComplete,
  startAttempt,
  submitAttempt,
  joinLiveClass,
  leaveLiveClass,
  askQuestion,
  upvoteQuestion,
  liveClassQuestions,
} from '@/db/academy';

export const prerender = false;

/** 16 KB. A quiz submission is the largest thing sent here by a long way. */
const MAX_BODY = 16_384;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * The module's own error code decides the status.
 *
 * Listed explicitly rather than pattern-matched, so a new code added to
 * academy.ts falls through to 400 instead of being silently mapped to whatever
 * a regular expression happened to catch.
 */
function statusForAcademyError(code: string): number {
  switch (code) {
    case 'unknown_person':
    case 'unknown_course':
    case 'unknown_enrolment':
    case 'unknown_lesson':
    case 'unknown_quiz':
    case 'unknown_attempt':
    case 'unknown_live_class':
    case 'unknown_question':
    case 'unknown_order':
      return 404;

    case 'not_enrolled':
    case 'class_not_published':
    case 'question_hidden':
      return 403;

    case 'already_enrolled':
    case 'already_submitted':
    case 'attempt_in_flight':
    case 'attempts_exhausted':
    case 'enrolment_not_active':
    case 'enrolment_expired':
    case 'enrolment_not_pending':
    case 'course_not_published':
    case 'course_not_editable':
    case 'lesson_unavailable':
    case 'class_not_available':
    case 'watch_time_below_minimum':
      return 409;

    default:
      return 400;
  }
}

/** Anyone at all, for the one read a public class is genuinely open to. */
const ANONYMOUS: Principal = { userId: null, label: 'anonymous', bindings: [] };

interface Caller {
  ctx: AuditContext;
  personId: number;
}

/**
 * The signed-in caller AND their person record, or the reason there is none.
 *
 * A shared office credential resolves to no person by construction, so it can
 * never act as a learner here — which is correct: a shared credential cannot
 * say whose lesson was completed.
 */
async function caller(request: Request): Promise<Caller | Response> {
  if (!isConfigured()) {
    return json(
      {
        error:
          'The federation database is not configured on this deployment, so learning records cannot be read or written.',
      },
      503
    );
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to use the academy' }, 401);

  if (identity.userId == null) {
    return json(
      {
        error:
          'You are signed in with a shared credential, which is not attributable to a person. Sign in with your own account to use the academy.',
      },
      403
    );
  }

  const user = (
    await db().select({ personId: s.users.personId }).from(s.users).where(eq(s.users.id, identity.userId)).limit(1)
  )[0];
  if (!user?.personId) {
    return json(
      {
        error:
          'Your account is not linked to a member record, so there is nobody to record this against. The federation office links accounts to member records.',
      },
      403
    );
  }

  return {
    ctx: {
      principal: identity.principal,
      ip: clientIp(request),
      authority: identity.shared ? `shared:${identity.via}` : 'user',
    },
    personId: user.personId,
  };
}

/** A live class is addressed by its published code, not by a guessable row id. */
async function liveClassIdForCode(code: string): Promise<number | null> {
  const row = (
    await db().select({ id: s.liveClasses.id }).from(s.liveClasses).where(eq(s.liveClasses.code, code)).limit(1)
  )[0];
  return row?.id ?? null;
}

function intOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function secondsOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : undefined;
}

// ─── GET: the one read that belongs on this API ─────────────────────────────
//
// The Q&A of a live class, polled by /live so the board stays current without a
// page reload. Authorisation is liveClassQuestions()'s own — including its
// withholding of the asker's identity on a public class.

export const GET: APIRoute = async ({ params, request, url }) => {
  const action = String(params.action ?? '');
  if (action !== 'questions') return json({ error: 'Unknown action' }, 404);

  const rl = await rateLimit(request, 'academy-questions', 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!isConfigured()) {
    return json({ error: 'The federation database is not configured on this deployment.' }, 503);
  }

  const code = (url.searchParams.get('code') || '').trim();
  if (!code || code.length > 64) return json({ error: 'Provide a class code' }, 400);

  const identity = await identify(request.headers.get('cookie'));
  const principal = identity?.principal ?? ANONYMOUS;

  try {
    const id = await liveClassIdForCode(code);
    if (id == null) return json({ error: 'Unknown class' }, 404);
    const questions = await liveClassQuestions(db(), { principal }, id);
    return json({ questions }, 200);
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({ error: 'This class is not open to you.' }, 403);
    }
    if (err instanceof AcademyError) {
      return json({ error: err.message, code: err.code }, statusForAcademyError(err.code));
    }
    console.error('[academy] questions', err);
    return json({ error: 'Could not read the questions for this class' }, 500);
  }
};

// ─── POST: everything a learner does ────────────────────────────────────────

export const POST: APIRoute = async ({ params, request }) => {
  const action = String(params.action ?? '');

  const rl = await rateLimit(request, `academy-${action}`, 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const who = await caller(request);
  if (who instanceof Response) return who;
  const { ctx, personId } = who;

  try {
    switch (action) {
      // ── Enrolment ────────────────────────────────────────────────────────
      case 'enrol': {
        const courseId = intOf(body.courseId);
        if (courseId == null) return json({ error: 'Provide a course' }, 400);
        // The person is the caller's own. enrol() derives the status from the
        // course's fee, so a learner cannot ask to be made active.
        const enrolment = await enrol(db(), ctx, { courseId, personId });
        return json({ ok: true, enrolment }, 200);
      }

      // ── Progress ─────────────────────────────────────────────────────────
      case 'lesson-complete': {
        const enrolmentId = intOf(body.enrolmentId);
        const lessonId = intOf(body.lessonId);
        if (enrolmentId == null || lessonId == null) {
          return json({ error: 'Provide an enrolment and a lesson' }, 400);
        }
        // No policy argument: MMAKF has published no minimum watch time, and
        // supplying one here would impose a rule the federation never set. The
        // module reports in `watchTime.minimum` that none was applied.
        const result = await markLessonComplete(db(), ctx, {
          enrolmentId,
          lessonId,
          watchedSeconds: secondsOf(body.watchedSeconds),
        });
        return json({ ok: true, ...result }, 200);
      }

      // ── Quizzes ──────────────────────────────────────────────────────────
      case 'quiz-start': {
        const quizId = intOf(body.quizId);
        const enrolmentId = intOf(body.enrolmentId);
        if (quizId == null || enrolmentId == null) {
          return json({ error: 'Provide a quiz and an enrolment' }, 400);
        }
        // startAttempt() returns the STUDENT view, built by quizForStudent().
        // The correct answers and the explanations are not in the shape it
        // returns — so nothing is filtered here, and nothing can be forgotten
        // here either.
        const result = await startAttempt(db(), ctx, { quizId, enrolmentId });
        return json({ ok: true, ...result }, 200);
      }

      case 'quiz-submit': {
        const attemptId = intOf(body.attemptId);
        if (attemptId == null) return json({ error: 'Provide an attempt' }, 400);
        const responses = body.responses;
        if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
          return json({ error: 'Provide your answers' }, 400);
        }
        const result = await submitAttempt(db(), ctx, { attemptId, responses });
        return json({ ok: true, ...result }, 200);
      }

      // ── The live classroom ───────────────────────────────────────────────
      case 'live-join':
      case 'live-leave': {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!code || code.length > 64) return json({ error: 'Provide a class code' }, 400);
        const liveClassId = await liveClassIdForCode(code);
        if (liveClassId == null) return json({ error: 'Unknown class' }, 404);

        if (action === 'live-leave') {
          const attendance = await leaveLiveClass(db(), ctx, {
            liveClassId,
            personId,
            watchedSeconds: secondsOf(body.watchedSeconds),
          });
          return json({ ok: true, attendance }, 200);
        }

        // No policy argument again: there is no attendance threshold to apply,
        // and joinLiveClass() says so in `threshold` rather than defaulting one.
        const result = await joinLiveClass(db(), ctx, {
          liveClassId,
          personId,
          watchedSeconds: secondsOf(body.watchedSeconds),
        });
        return json({ ok: true, ...result }, 200);
      }

      case 'question-ask': {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const question = typeof body.question === 'string' ? body.question : '';
        if (!code || code.length > 64) return json({ error: 'Provide a class code' }, 400);
        if (question.length > 2000) return json({ error: 'That question is too long' }, 400);
        const liveClassId = await liveClassIdForCode(code);
        if (liveClassId == null) return json({ error: 'Unknown class' }, 404);
        const row = await askQuestion(db(), ctx, { liveClassId, personId, question });
        return json({ ok: true, question: row }, 200);
      }

      case 'question-upvote': {
        const questionId = intOf(body.questionId);
        if (questionId == null) return json({ error: 'Provide a question' }, 400);
        // The module reports uniquenessEnforced:false — the schema holds a bare
        // counter with no per-person vote row. It is passed straight through so
        // the page can label the number a count of votes, not of people.
        const result = await upvoteQuestion(db(), ctx, { questionId, personId });
        return json({ ok: true, ...result }, 200);
      }

      default:
        return json({ error: 'Unknown action' }, 404);
    }
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({ error: 'You are not permitted to do that.' }, 403);
    }
    if (err instanceof AcademyError) {
      // The module's message was written to be read by the person who hit it.
      return json(
        { error: err.message, code: err.code, detail: err.detail ?? null },
        statusForAcademyError(err.code)
      );
    }
    console.error(`[academy] ${action}`, err);
    return json({ error: 'Could not complete that action' }, 500);
  }
};
