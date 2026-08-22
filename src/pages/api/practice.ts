// Practice marks — the write path for §43.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS ENDPOINT CANNOT DO, WHICH IS THE INTERESTING PART
// ─────────────────────────────────────────────────────────────────────────────
//
// It cannot write to anybody but the caller. There is no personId in the request
// body and no code path that reads one: `markPractice()` resolves the caller's
// own person from the session. A member cannot mark another member's practice by
// editing a payload, because there is nothing in the payload to edit.
//
// It cannot record attainment. The only values it accepts are the four in the
// practice vocabulary — watched, practising, needs_work, bookmarked — none of
// which is terminal, and the module refuses anything else. §44's rule that
// watching Bassai Dai does not complete Bassai Dai is enforced by there being no
// word for "completed" to send.
//
// It cannot reach the grading engine. `practice_marks` has no foreign key into
// it, in either direction, and tests/practice.test.ts asserts that against
// information_schema.
//
// CSRF is handled in src/middleware.ts, which requires a same-origin mutating
// request and a JSON content type before this file runs.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { identify } from '@/lib/session';
import { rateLimit } from '@/lib/ratelimit';
import {
  markPractice, clearPractice, acknowledgeAssignment,
  isPracticeError, MARKS, type Mark, type SubjectKind,
} from '@/db/practice';

export const prerender = false;

const SUBJECT_KINDS: readonly SubjectKind[] = ['technique', 'kata', 'kumite', 'video', 'drill'];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // Generous, because marking is a normal browsing action — a student working
  // through the kihon library legitimately marks several things in a minute.
  const rl = await rateLimit(request, 'practice', 120, 60);
  if (!rl.ok) {
    return json({ error: 'Too many requests. Wait a moment and try again.' }, 429);
  }

  if (!isConfigured()) {
    // Named rather than reported as a failure to save. A member whose mark did
    // not stick deserves to know it was never going to.
    return json({ error: 'The federation register is not connected on this deployment, so practice marks cannot be saved.' }, 503);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to record your own practice.' }, 401);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const action = String(body.action ?? 'mark');

  try {
    if (action === 'acknowledge') {
      const id = Number(body.assignmentId);
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid assignment' }, 400);
      await acknowledgeAssignment(db(), identity.principal, id);
      return json({ ok: true, action: 'acknowledge' }, 200);
    }

    const subjectKind = String(body.subjectKind ?? '') as SubjectKind;
    const subjectSlug = String(body.subjectSlug ?? '').slice(0, 120);
    if (!SUBJECT_KINDS.includes(subjectKind)) return json({ error: 'Unknown subject kind' }, 400);
    if (!subjectSlug) return json({ error: 'Which subject?' }, 400);

    if (action === 'clear') {
      const removed = await clearPractice(db(), identity.principal, subjectKind, subjectSlug);
      return json({ ok: true, action: 'clear', removed }, 200);
    }

    if (action !== 'mark') return json({ error: 'Unknown action' }, 400);

    const mark = String(body.mark ?? '') as Mark;
    if (!MARKS.includes(mark)) {
      return json(
        { error: `"${mark}" is not something a student records about themselves. A grading records attainment; this does not.` },
        400
      );
    }

    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
    const row = await markPractice(db(), identity.principal, { subjectKind, subjectSlug, mark, note });
    return json({ ok: true, action: 'mark', mark: row.mark }, 200);
  } catch (err: any) {
    // The module writes its refusals to be read by the person who hit them, so
    // those are returned as written. Anything else is a fact about the server
    // and is not repeated to the caller — see src/pages/my/index.astro:41.
    if (isPracticeError(err)) {
      const status = err.code === 'no_practitioner' ? 403 : 400;
      return json({ error: err.message, code: err.code }, status);
    }
    return json({ error: 'The mark could not be saved.' }, 500);
  }
};
