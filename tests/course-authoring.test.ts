// Course authoring: the door the academy engine never had.
// Driven against a real schema; YouTube's oEmbed answer is injected, never fetched.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createCourse, addModule, addLesson, publishCourse, withdrawCourse } from '../src/db/academy';
import {
  parseYouTubeId, youtubeOEmbed, registerYouTubeVideo, courseAuthoringView, courseList, slugify,
} from '../src/db/course-authoring';
import { legacyAdminPrincipal, ForbiddenError } from '../src/lib/rbac';

const ctx = { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any;
const nobody = { principal: null, reason: 'test', authority: 'test' } as any;
const ok = (title = 'Heian Shodan — full kata') =>
  (async () => new Response(JSON.stringify({ title, author_name: 'MMAKF', thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }), { status: 200 })) as unknown as typeof fetch;
const status = (code: number) => (async () => new Response('', { status: code })) as unknown as typeof fetch;

describe('reading a YouTube link', () => {
  it('accepts every ordinary form and nothing else', () => {
    const id = 'dQw4w9WgXcQ';
    for (const link of [
      `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=42s`, `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/embed/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`,
      `youtube.com/watch?v=${id}`, id,
    ]) expect(parseYouTubeId(link), link).toBe(id);
    for (const bad of ['', 'https://vimeo.com/123', 'https://www.youtube.com/watch?v=short', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'not a link']) {
      expect(parseYouTubeId(bad), bad).toBeNull();
    }
  });

  it('turns a title into a usable slug', () => {
    expect(slugify('Course 01 – Taste the Discipline')).toBe('course-01-taste-the-discipline');
    expect(slugify('Women’s Self-Défense!!')).toBe('women-s-self-defense');
  });
});

describe('asking YouTube whether a video can be played in a lesson', () => {
  it('reads the title from oEmbed', async () => {
    expect(await youtubeOEmbed('dQw4w9WgXcQ', ok('Kanku Dai'))).toMatchObject({ title: 'Kanku Dai', authorName: 'MMAKF' });
  });
  it('refuses a private or embed-disabled video, and a removed one, with a reason a teacher can act on', async () => {
    await expect(youtubeOEmbed('dQw4w9WgXcQ', status(401))).rejects.toMatchObject({ code: 'not_embeddable' });
    await expect(youtubeOEmbed('dQw4w9WgXcQ', status(403))).rejects.toMatchObject({ code: 'not_embeddable' });
    await expect(youtubeOEmbed('dQw4w9WgXcQ', status(404))).rejects.toMatchObject({ code: 'video_not_found' });
  });
  it('reports an outage instead of guessing', async () => {
    await expect(youtubeOEmbed('dQw4w9WgXcQ', status(503))).rejects.toMatchObject({ code: 'youtube_unreachable' });
    const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(youtubeOEmbed('dQw4w9WgXcQ', down)).rejects.toMatchObject({ code: 'youtube_unreachable' });
  });
});

describe('authoring a course end to end, against a real schema', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
  }, 120_000);

  it('only someone with content:write may register a video', async () => {
    await expect(registerYouTubeVideo(db, nobody, { url: 'https://youtu.be/dQw4w9WgXcQ' }, ok()))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('registers a playable video once, as published federation teaching media', async () => {
    const first = await registerYouTubeVideo(db, ctx, { url: 'https://youtu.be/dQw4w9WgXcQ', classification: 'shotokan_technical' }, ok());
    expect(first.created).toBe(true);
    expect(first.asset).toMatchObject({ platform: 'youtube', externalId: 'dQw4w9WgXcQ', published: true, classification: 'shotokan_technical', rights: 'embed_allowed' });
    const again = await registerYouTubeVideo(db, ctx, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, ok());
    expect(again.created).toBe(false);
    expect(again.asset.id).toBe(first.asset.id);
    const rows = await db.select().from(s.mediaAssets).where(eq(s.mediaAssets.externalId, 'dQw4w9WgXcQ'));
    expect(rows).toHaveLength(1);
  });

  it('a video YouTube will not embed is refused before any lesson points at it', async () => {
    await expect(registerYouTubeVideo(db, ctx, { url: 'https://youtu.be/AAAAAAAAAAA' }, status(401)))
      .rejects.toMatchObject({ code: 'not_embeddable' });
    expect(await db.select().from(s.mediaAssets).where(eq(s.mediaAssets.externalId, 'AAAAAAAAAAA'))).toHaveLength(0);
  });

  it('create -> module -> video and reading lessons -> publish -> withdraw, all through the engine', async () => {
    const course = await createCourse(db, ctx, { title: 'Taste the Discipline', slug: slugify('Taste the Discipline'), summary: 'White to Yellow' });
    const mod = await addModule(db, ctx, { courseId: course.id, title: 'Module 01 – Stances' });
    const video = (await registerYouTubeVideo(db, ctx, { url: 'https://youtu.be/BBBBBBBBBBB' }, ok('Zenkutsu dachi'))).asset;
    await addLesson(db, ctx, { moduleId: mod.id, title: 'Zenkutsu dachi', kind: 'video', mediaAssetId: video.id, durationMinutes: 12, isPreview: true });
    await addLesson(db, ctx, { moduleId: mod.id, title: 'Why stances matter', kind: 'reading', body: 'A stance is the root of every technique.' });

    const view = await courseAuthoringView(db, course.id);
    expect(view!.modules).toHaveLength(1);
    expect(view!.modules[0].lessons.map((l) => l.kind)).toEqual(['video', 'reading']);
    expect(view!.modules[0].lessons[0]).toMatchObject({ videoId: 'BBBBBBBBBBB', isPreview: true });

    const published = await publishCourse(db, ctx, course.id);
    expect(published.status).toBe('published');
    expect(published.hasFreePreview).toBe(true);
    expect((await courseList(db)).find((c: any) => c.id === course.id)).toMatchObject({ status: 'published', lessonCount: 2 });

    // Published means locked: structure cannot change under enrolled learners.
    await expect(addModule(db, ctx, { courseId: course.id, title: 'Late module' })).rejects.toMatchObject({ code: 'course_not_editable' });
    const withdrawn = await withdrawCourse(db, ctx, course.id, 'Revising module order');
    expect(withdrawn.status).toBe('draft');
  });

  it('a video lesson without a playable video blocks publication, with the reason', async () => {
    const course = await createCourse(db, ctx, { title: 'Broken course', slug: 'broken-course' });
    const mod = await addModule(db, ctx, { courseId: course.id, title: 'Only module' });
    await addLesson(db, ctx, { moduleId: mod.id, title: 'Missing video', kind: 'video', mediaAssetId: null });
    await expect(publishCourse(db, ctx, course.id)).rejects.toMatchObject({ code: expect.any(String) });
    const [row] = await db.select().from(s.courses).where(eq(s.courses.id, course.id));
    expect(row.status).not.toBe('published');
  });
});
