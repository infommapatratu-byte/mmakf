// Course authoring: the office's door to the academy engine.
//
// The academy (src/db/academy.ts) is complete — author, publish, enrol, learn,
// assess, certify — and held 0 courses, because createCourse(), addModule(),
// addLesson(), publishCourse() and withdrawCourse() had no caller. This module
// adds only what the door needs and the engine did not have:
//
//   registerYouTubeVideo()  a teacher pastes a YouTube link for a lesson. The
//                           engine's video lessons point at a media_assets row
//                           (classified, rights recorded, published); until a
//                           channel is connected through OAuth, nothing created
//                           one. The video is checked against YouTube's public
//                           oEmbed endpoint first, so a private, removed or
//                           non-embeddable video is refused at authoring time
//                           rather than discovered by a learner.
//   courseAuthoringView()   one read of a course's structure for the page.
//
// Every write still goes through academy.ts and its checks (content:write,
// draft-only editing, publish-time availability). Nothing here re-implements
// them.

import { asc, eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere } from '@/lib/rbac';
import { isUniqueViolation } from '@/db/pgerror';

type DB = any;

export class CourseAuthoringError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'CourseAuthoringError';
  }
}

export function isCourseAuthoringError(err: unknown): err is CourseAuthoringError {
  return err instanceof CourseAuthoringError;
}

/** Teaching classifications a registered lesson video may carry. */
export const TEACHING_CLASSES = ['master_teaching', 'shotokan_technical', 'federation_official', 'seminar', 'competition'] as const;
export type TeachingClass = (typeof TEACHING_CLASSES)[number];

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video id from any ordinary YouTube link, or null.
 * Accepts watch?v=, youtu.be/, /embed/, /shorts/, /live/ and a bare id.
 */
export function parseYouTubeId(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (ID.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] || null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && ID.test(id) ? id : null;
}

export interface OEmbedResult {
  title: string;
  authorName: string | null;
  thumbnailUrl: string | null;
}

/**
 * Ask YouTube whether this video exists and may be embedded. oEmbed is public,
 * needs no key and costs no API quota. 401/403 = embedding disabled or private;
 * 404 = no such video. Anything else (network, 5xx) is reported, not guessed.
 */
export async function youtubeOEmbed(videoId: string, fetchImpl: typeof fetch = fetch): Promise<OEmbedResult> {
  const target = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  let res: Response;
  try {
    res = await fetchImpl(target, { headers: { Accept: 'application/json' } });
  } catch {
    throw new CourseAuthoringError('youtube_unreachable', 'YouTube could not be reached to check this video. Try again shortly.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new CourseAuthoringError('not_embeddable', 'This video is private or its owner has disabled embedding, so it cannot be played inside a lesson.');
  }
  if (res.status === 404 || res.status === 400) {
    throw new CourseAuthoringError('video_not_found', 'YouTube has no public video at that link. Check the link and that the video is Public or Unlisted.');
  }
  if (!res.ok) {
    throw new CourseAuthoringError('youtube_unreachable', `YouTube answered ${res.status} when checking this video. Try again shortly.`);
  }
  const body: any = await res.json().catch(() => ({}));
  return {
    title: String(body?.title ?? '').slice(0, 300) || `YouTube video ${videoId}`,
    authorName: body?.author_name ? String(body.author_name).slice(0, 200) : null,
    thumbnailUrl: body?.thumbnail_url ? String(body.thumbnail_url) : null,
  };
}

/**
 * Register a YouTube video as federation teaching media, so a lesson can use it.
 * Idempotent: the same video (platform + id is unique) returns the existing row.
 * A deliberate act by a named person with content:write — never automatic.
 */
export async function registerYouTubeVideo(
  db: DB,
  ctx: AuditContext,
  input: { url: string; classification?: TeachingClass; title?: string | null },
  fetchImpl: typeof fetch = fetch,
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  const videoId = parseYouTubeId(input.url);
  if (!videoId) {
    throw new CourseAuthoringError('bad_link', 'That is not a YouTube video link. Paste the link from the video\'s Share button.');
  }
  const classification: TeachingClass = TEACHING_CLASSES.includes(input.classification as TeachingClass)
    ? (input.classification as TeachingClass)
    : 'master_teaching';

  const existing = (await db.select().from(s.mediaAssets)
    .where(sql`${s.mediaAssets.platform} = 'youtube' and ${s.mediaAssets.externalId} = ${videoId}`).limit(1))[0];
  if (existing) return { asset: existing, created: false };

  const oembed = await youtubeOEmbed(videoId, fetchImpl);
  const who = (ctx.principal as any)?.label ?? 'an administrator';
  const now = new Date();
  try {
    const [asset] = await db.insert(s.mediaAssets).values({
      channelId: null,
      platform: 'youtube',
      externalId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: input.title?.trim() ? input.title.trim().slice(0, 300) : oembed.title,
      thumbnailUrl: oembed.thumbnailUrl,
      classification,
      classifiedByUserId: (ctx.principal as any)?.userId ?? null,
      classifiedAt: now,
      rights: 'embed_allowed',
      rightsHolder: oembed.authorName,
      rightsNote: `Registered for teaching by ${who}. YouTube reports the video as public and embeddable.`,
      published: true,
      discoveredAt: now,
    }).returning();
    await writeAudit(db, ctx, {
      entityType: 'media_asset', entityId: asset.id, action: 'create',
      newValue: { platform: 'youtube', externalId: videoId, classification, rights: 'embed_allowed', published: true },
    });
    return { asset, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = (await db.select().from(s.mediaAssets)
        .where(sql`${s.mediaAssets.platform} = 'youtube' and ${s.mediaAssets.externalId} = ${videoId}`).limit(1))[0];
      return { asset: again, created: false };
    }
    throw err;
  }
}

export interface AuthoringLesson {
  id: number;
  title: string;
  kind: string;
  displayOrder: number;
  durationMinutes: number | null;
  isPreview: boolean;
  videoTitle: string | null;
  videoId: string | null;
  hasBody: boolean;
}

export interface AuthoringModule {
  id: number;
  title: string;
  summary: string | null;
  displayOrder: number;
  lessons: AuthoringLesson[];
}

/** Every course for the list, newest first, with structure and enrolment counts. */
export async function courseList(db: DB) {
  const courses = await db.select().from(s.courses).orderBy(asc(s.courses.status), asc(s.courses.title));
  const lessonCounts = await db.select({ courseId: s.lessons.courseId, n: sql<number>`count(*)::int` })
    .from(s.lessons).groupBy(s.lessons.courseId);
  const enrolCounts = await db.select({ courseId: s.enrolments.courseId, n: sql<number>`count(*)::int` })
    .from(s.enrolments).groupBy(s.enrolments.courseId);
  const lc = new Map(lessonCounts.map((r: any) => [r.courseId, Number(r.n)]));
  const ec = new Map(enrolCounts.map((r: any) => [r.courseId, Number(r.n)]));
  return courses.map((c: any) => ({ ...c, lessonCount: lc.get(c.id) ?? 0, enrolmentCount: ec.get(c.id) ?? 0 }));
}

/** One course's structure, for the authoring page. */
export async function courseAuthoringView(db: DB, courseId: number) {
  const course = (await db.select().from(s.courses).where(eq(s.courses.id, courseId)).limit(1))[0];
  if (!course) return null;
  const modules = await db.select().from(s.courseModules)
    .where(eq(s.courseModules.courseId, courseId))
    .orderBy(asc(s.courseModules.displayOrder), asc(s.courseModules.id));
  const lessons = await db.select({
    id: s.lessons.id, moduleId: s.lessons.moduleId, title: s.lessons.title, kind: s.lessons.kind,
    displayOrder: s.lessons.displayOrder, durationMinutes: s.lessons.durationMinutes, isPreview: s.lessons.isPreview,
    body: s.lessons.body, videoTitle: s.mediaAssets.title, videoId: s.mediaAssets.externalId,
  })
    .from(s.lessons)
    .leftJoin(s.mediaAssets, eq(s.lessons.mediaAssetId, s.mediaAssets.id))
    .where(eq(s.lessons.courseId, courseId))
    .orderBy(asc(s.lessons.displayOrder), asc(s.lessons.id));
  const out: AuthoringModule[] = modules.map((m: any) => ({
    id: m.id, title: m.title, summary: m.summary ?? null, displayOrder: m.displayOrder ?? 0,
    lessons: lessons.filter((l: any) => l.moduleId === m.id).map((l: any) => ({
      id: l.id, title: l.title, kind: l.kind, displayOrder: l.displayOrder ?? 0,
      durationMinutes: l.durationMinutes ?? null, isPreview: Boolean(l.isPreview),
      videoTitle: l.videoTitle ?? null, videoId: l.videoId ?? null, hasBody: Boolean(l.body),
    })),
  }));
  const [{ n: enrolments }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.enrolments).where(eq(s.enrolments.courseId, courseId));
  return { course, modules: out, enrolments: Number(enrolments) };
}

/** A URL-safe slug from a title: lower-case, hyphenated, ASCII. */
export function slugify(title: string): string {
  return String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'course';
}
