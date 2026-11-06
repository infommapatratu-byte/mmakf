// /api/admin/academy — the office's authoring door to the academy engine.
//
//   POST { action: 'create-course', title, slug?, summary?, description?, category?, level?,
//          feeCode?, estimatedHours?, certificateOnCompletion?, passMarkPercent? }
//   POST { action: 'add-module', courseId, title, summary? }
//   POST { action: 'add-lesson', moduleId, title, kind: 'video'|'reading',
//          videoUrl?, classification?, body?, durationMinutes?, isPreview? }
//   POST { action: 'publish', courseId }
//   POST { action: 'withdraw', courseId, reason }
//
// Permission (content:write), draft-only editing and publish-time checks are
// enforced inside src/db/academy.ts; this route never bypasses them. Every
// write is audited against the signed-in person.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import { createCourse, addModule, addLesson, publishCourse, withdrawCourse, AcademyError } from '@/db/academy';
import { registerYouTubeVideo, isCourseAuthoringError, slugify, type TeachingClass } from '@/db/course-authoring';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'admin-academy', 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to author courses.' }, 401);
  if (identity.shared) return json({ error: 'Courses are authored by a named person. Sign in with your own account.' }, 403);
  if (!isConfigured()) return json({ error: 'The academy is not available on this deployment.' }, 503);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request' }, 400);

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: text(body.reason, 1000),
    authority: 'user',
  };

  try {
    switch (String(body.action ?? '')) {
      case 'create-course': {
        const title = text(body.title, 200);
        if (!title) return json({ error: 'A course needs a title.' }, 400);
        const course = await createCourse(db(), ctx, {
          title,
          slug: text(body.slug, 80) ?? slugify(title),
          summary: text(body.summary, 600),
          description: text(body.description, 8000),
          category: text(body.category, 80),
          level: text(body.level, 80),
          feeCode: text(body.feeCode, 120),
          estimatedHours: int(body.estimatedHours),
          certificateOnCompletion: body.certificateOnCompletion === true,
          passMarkPercent: body.passMarkPercent == null || body.passMarkPercent === '' ? null : Number(body.passMarkPercent),
        });
        return json({ ok: true, course }, 200);
      }
      case 'add-module': {
        const courseId = int(body.courseId);
        const title = text(body.title, 200);
        if (!courseId || !title) return json({ error: 'A module needs a course and a title.' }, 400);
        const mod = await addModule(db(), ctx, { courseId, title, summary: text(body.summary, 600) });
        return json({ ok: true, module: mod }, 200);
      }
      case 'add-lesson': {
        const moduleId = int(body.moduleId);
        const title = text(body.title, 200);
        const kind = String(body.kind ?? '');
        if (!moduleId || !title) return json({ error: 'A lesson needs a module and a title.' }, 400);
        if (kind !== 'video' && kind !== 'reading') {
          return json({ error: 'A lesson added here is a video or a reading.' }, 400);
        }
        let mediaAssetId: number | null = null;
        let registered: any = null;
        if (kind === 'video') {
          const url = text(body.videoUrl, 500);
          if (!url) return json({ error: 'A video lesson needs a YouTube link.' }, 400);
          registered = await registerYouTubeVideo(db(), ctx, { url, classification: body.classification as TeachingClass });
          mediaAssetId = registered.asset.id;
        }
        const lesson = await addLesson(db(), ctx, {
          moduleId,
          title,
          kind,
          body: kind === 'reading' ? text(body.body, 20000) : null,
          mediaAssetId,
          durationMinutes: int(body.durationMinutes),
          isPreview: body.isPreview === true,
        });
        return json({ ok: true, lesson, video: registered ? { id: registered.asset.id, title: registered.asset.title, created: registered.created } : null }, 200);
      }
      case 'publish': {
        const courseId = int(body.courseId);
        if (!courseId) return json({ error: 'Which course?' }, 400);
        return json({ ok: true, result: await publishCourse(db(), ctx, courseId) }, 200);
      }
      case 'withdraw': {
        const courseId = int(body.courseId);
        const reason = text(body.reason, 1000);
        if (!courseId) return json({ error: 'Which course?' }, 400);
        if (!reason) return json({ error: 'Withdrawing a course requires a reason.' }, 400);
        return json({ ok: true, course: await withdrawCourse(db(), ctx, courseId, reason) }, 200);
      }
      default:
        return json({ error: 'Unknown action', actions: ['create-course', 'add-module', 'add-lesson', 'publish', 'withdraw'] }, 404);
    }
  } catch (err: any) {
    if (err instanceof ForbiddenError) return json({ error: 'Your account does not have permission to author courses.', code: 'forbidden' }, 403);
    if (isCourseAuthoringError(err)) return json({ error: err.message, code: err.code }, 409);
    if (err instanceof AcademyError) {
      // The authoring surface is where publishCourse()'s detail (the list of
      // lessons that block publication) belongs, so it is forwarded here.
      return json({ error: err.message, code: err.code, detail: (err as any).detail ?? null }, 409);
    }
    console.error('[api/admin/academy] unhandled', err);
    return json({ error: 'The academy did not answer.', code: 'internal' }, 500);
  }
};
