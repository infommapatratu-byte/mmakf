// The Academy and the live classroom, against real Postgres.
//
// Four claims these tests exist to protect:
//   · a course cannot be published while it promises a video that is not there;
//   · progress is DERIVED, so a poisoned cached percentage changes nothing;
//   · a student cannot reach the answer key before submitting;
//   · an unset federation rule is NOT APPLIED and the result says so — an
//     attempt against no pass mark is UNGRADED, never passed.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  createCourse, addModule, addLesson, addQuiz, addQuizQuestion, publishCourse,
  withdrawCourse, courseOutline, enrol, activateEnrolment, markLessonComplete, courseProgress,
  quizForStudent, startAttempt, submitAttempt, attemptResult,
  completionCheck, completeEnrolment,
  scheduleLiveClass, joinLiveClass, liveClassAttendanceReport,
  askQuestion, answerQuestion, upvoteQuestion, hideQuestion,
  liveClassQuestions, moderationQuestions, attachResource, liveClassResources,
  AcademyError,
} from '../src/db/academy';
import type { Principal } from '../src/lib/rbac';

let client: PGlite;
let db: any;
let JH: number, DOJO: number;
let STUDENT: number, STUDENT_USER: number;
let OTHER: number, OTHER_USER: number;
let TEACHER: number;
let ASSET_OK: number, ASSET_UNPUBLISHED: number, ASSET_PENDING: number;

const NOW = new Date('2026-08-12T10:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** The learner, acting on their own record. */
let student: Principal;
/** A different member with no authority over the learner. */
let outsider: Principal;

const admin = { principal: national };

async function applyMigrations(target: PGlite) {
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await target.exec(st.trim());
    }
  }
}

/**
 * THE PENDING SCHEMA CORRECTION, applied here so the unset-pass-mark path can be
 * exercised at all.
 *
 * `quizzes.pass_mark_percent` ships as NOT NULL DEFAULT 60. Sixty per cent is
 * not a number MMAKF has approved, and while the default stands every quiz in
 * the federation silently acquires an unapproved pass mark. The migration that
 * fixes it belongs to whoever owns the schema (reported as a shared-file edit);
 * these tests apply it locally so the module's honest behaviour is provable
 * today. The un-migrated behaviour is tested separately, on its own database,
 * further down.
 */
async function applyPendingPassMarkCorrection(target: PGlite) {
  await target.exec('ALTER TABLE quizzes ALTER COLUMN pass_mark_percent DROP DEFAULT');
  await target.exec('ALTER TABLE quizzes ALTER COLUMN pass_mark_percent DROP NOT NULL');
}

async function makePerson(name: string) {
  return createPerson(db, admin, { fullName: name, stateUnitId: JH, dojoId: DOJO } as any);
}

async function makeUserFor(personId: number, email: string): Promise<number> {
  const [u] = await db.insert(s.users).values({ personId, email }).returning({ id: s.users.id });
  return u.id;
}

let slugCounter = 0;
function nextSlug(prefix: string) {
  slugCounter += 1;
  return `${prefix}-${slugCounter}`;
}

/** A one-module course with a reading lesson, published and ready to enrol on. */
async function makeSimpleCourse(over: { certificateOnCompletion?: boolean } = {}) {
  const course = await createCourse(db, admin, {
    slug: nextSlug('course'),
    title: 'Shotokan Basics',
    certificateOnCompletion: over.certificateOnCompletion ?? false,
    leadTeacherPersonId: TEACHER,
  });
  const mod = await addModule(db, admin, { courseId: course.id, title: 'Module 1' });
  const lesson = await addLesson(db, admin, {
    moduleId: mod.id, kind: 'reading', title: 'Dojo kun', body: 'Read this.',
  });
  await publishCourse(db, admin, course.id, NOW);
  return { course, mod, lesson };
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  await applyMigrations(client);
  await applyPendingPassMarkCorrection(client);

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;

  STUDENT = (await makePerson('Student One')).id;
  STUDENT_USER = await makeUserFor(STUDENT, 'student@example.test');
  OTHER = (await makePerson('Unrelated Member')).id;
  OTHER_USER = await makeUserFor(OTHER, 'other@example.test');
  TEACHER = (await makePerson('Sensei')).id;

  student = {
    userId: STUDENT_USER, label: 'student',
    bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
  };
  outsider = {
    userId: OTHER_USER, label: 'outsider',
    bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
  };

  const [a1] = await db.insert(s.mediaAssets).values({
    externalId: 'vid-published', url: 'https://youtu.be/vid-published', title: 'Mae-geri drill',
    classification: 'master_teaching', published: true,
  }).returning({ id: s.mediaAssets.id });
  ASSET_OK = a1.id;

  const [a2] = await db.insert(s.mediaAssets).values({
    externalId: 'vid-unpublished', url: 'https://youtu.be/vid-unpublished', title: 'Unreviewed drill',
    classification: 'master_teaching', published: false,
  }).returning({ id: s.mediaAssets.id });
  ASSET_UNPUBLISHED = a2.id;

  const [a3] = await db.insert(s.mediaAssets).values({
    externalId: 'vid-pending', url: 'https://youtu.be/vid-pending', title: 'Family holiday',
    classification: 'pending_review', published: true,
  }).returning({ id: s.mediaAssets.id });
  ASSET_PENDING = a3.id;
});

// ─── Publication ────────────────────────────────────────────────────────────

describe('a course cannot promise a video that is not there', () => {
  async function draftWithVideo(mediaAssetId: number | null) {
    const course = await createCourse(db, admin, { slug: nextSlug('vid'), title: 'Video course' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'video', title: 'Mae-geri', mediaAssetId });
    return course;
  }

  it('refuses to publish a video lesson with no media asset at all', async () => {
    const course = await draftWithVideo(null);
    await expect(publishCourse(db, admin, course.id, NOW))
      .rejects.toThrow(/no media asset is linked/i);
    const after = (await db.select().from(s.courses).where(eq(s.courses.id, course.id)))[0];
    expect(after.status).toBe('draft');
  });

  it('refuses to publish when the linked video is unpublished', async () => {
    const course = await draftWithVideo(ASSET_UNPUBLISHED);
    await expect(publishCourse(db, admin, course.id, NOW))
      .rejects.toThrow(/has not been published by the federation/i);
  });

  it('refuses to publish when the linked video is not federation teaching content', async () => {
    const course = await draftWithVideo(ASSET_PENDING);
    await expect(publishCourse(db, admin, course.id, NOW))
      .rejects.toThrow(/classified pending_review/i);
  });

  it('names every offending lesson in the refusal, as machine-readable detail', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('multi'), title: 'Multi' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'video', title: 'A', mediaAssetId: ASSET_UNPUBLISHED });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'video', title: 'B', mediaAssetId: null });

    const err = await publishCourse(db, admin, course.id, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(AcademyError);
    expect(err.code).toBe('unpublishable_lessons');
    expect((err.detail as any[]).map((d) => d.title).sort()).toEqual(['A', 'B']);
  });

  it('refuses to publish a quiz lesson with no questions behind it', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('emptyquiz'), title: 'Empty quiz' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'quiz', title: 'Test' });
    await addQuiz(db, admin, { courseId: course.id, lessonId: lesson.id, title: 'Test', passMarkPercent: 50 });

    await expect(publishCourse(db, admin, course.id, NOW)).rejects.toThrow(/no questions/i);
  });

  it('refuses to publish a course with no lessons', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('empty'), title: 'Nothing' });
    await expect(publishCourse(db, admin, course.id, NOW)).rejects.toThrow(/no lessons/i);
  });

  it('publishes once every lesson resolves, and reports why each one is available', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('good'), title: 'Good course' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'video', title: 'Mae-geri', mediaAssetId: ASSET_OK });

    const result = await publishCourse(db, admin, course.id, NOW);
    expect(result.status).toBe('published');
    expect(result.lessons.every((l) => l.available)).toBe(true);
    expect(result.lessons[0].reason).toMatch(/published media asset/);
  });
});

describe('hasFreePreview is derived, never asserted', () => {
  it('ignores hasFreePreview supplied by the author', async () => {
    const course = await createCourse(db, admin, {
      slug: nextSlug('claimed-preview'), title: 'Claimed preview', hasFreePreview: true,
    } as any);
    expect(course.hasFreePreview).toBe(false);
  });

  it('is true only when an accessible preview lesson genuinely exists', async () => {
    const withPreview = await createCourse(db, admin, { slug: nextSlug('withpreview'), title: 'With preview' });
    let mod = await addModule(db, admin, { courseId: withPreview.id, title: 'M1' });
    await addLesson(db, admin, {
      moduleId: mod.id, kind: 'video', title: 'Free lesson', mediaAssetId: ASSET_OK, isPreview: true,
    });
    expect((await publishCourse(db, admin, withPreview.id, NOW)).hasFreePreview).toBe(true);

    const without = await createCourse(db, admin, { slug: nextSlug('nopreview'), title: 'No preview' });
    mod = await addModule(db, admin, { courseId: without.id, title: 'M1' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'video', title: 'Paid lesson', mediaAssetId: ASSET_OK });
    expect((await publishCourse(db, admin, without.id, NOW)).hasFreePreview).toBe(false);
  });

  it('drops the badge again when the course is withdrawn', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('withdrawme'), title: 'Withdraw me' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    await addLesson(db, admin, {
      moduleId: mod.id, kind: 'video', title: 'Free', mediaAssetId: ASSET_OK, isPreview: true,
    });
    await publishCourse(db, admin, course.id, NOW);
    const after = await withdrawCourse(db, admin, course.id, 'Video replaced');
    expect(after.hasFreePreview).toBe(false);
    expect(after.status).toBe('draft');
  });
});

describe('structure is frozen once students are enrolled on it', () => {
  it('refuses to append a lesson to a published course', async () => {
    const { course, mod } = await makeSimpleCourse();
    await expect(addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'Late', body: 'x' }))
      .rejects.toThrow(/Withdraw it before changing its structure/i);
  });

  it('shows a draft outline only to an editor', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('draftout'), title: 'Draft outline' });
    await expect(courseOutline(db, { principal: student }, course.id)).rejects.toThrow(/Forbidden/);
    const outline = await courseOutline(db, admin, course.id);
    expect(outline.course.status).toBe('draft');
  });
});

// ─── Enrolment and progress ─────────────────────────────────────────────────

describe('enrolment', () => {
  it('refuses to enrol anyone on an unpublished course', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('unpub'), title: 'Unpublished' });
    await expect(enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW))
      .rejects.toThrow(/not published/i);
  });

  it('refuses a duplicate enrolment', async () => {
    const { course } = await makeSimpleCourse();
    await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    await expect(enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW))
      .rejects.toThrow(/already enrolled/i);
  });

  it('starts a fee-bearing course unpaid — this module never assumes money arrived', async () => {
    const course = await createCourse(db, admin, {
      slug: nextSlug('paid'), title: 'Paid course', feeCode: 'ACADEMY-BASIC',
    });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'L', body: 'x' });
    await publishCourse(db, admin, course.id, NOW);

    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    expect(e.status).toBe('pending_payment');
    await expect(markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: 1 }))
      .rejects.toThrow(/pending payment/i);
  });

  it('lets a learner enrol themselves but not an unrelated member', async () => {
    const { course } = await makeSimpleCourse();
    const e = await enrol(db, { principal: student }, { courseId: course.id, personId: STUDENT }, NOW);
    expect(e.personId).toBe(STUDENT);

    const other = await makeSimpleCourse();
    await expect(enrol(db, { principal: outsider }, { courseId: other.course.id, personId: STUDENT }, NOW))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('progress is derived at read time, never trusted from storage', () => {
  it('computes the percentage from lesson rows and ignores the stored column', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('two'), title: 'Two lessons' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const l1 = await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'One', body: 'a' });
    await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'Two', body: 'b' });
    await publishCourse(db, admin, course.id, NOW);

    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    await markLessonComplete(db, { principal: student }, { enrolmentId: e.id, lessonId: l1.id }, {}, NOW);
    expect((await courseProgress(db, admin, e.id)).progressPercent).toBe(50);

    // Poison the cached column. The derived answer must not move.
    await db.update(s.enrolments).set({ progressPercent: 99 }).where(eq(s.enrolments.id, e.id));
    const report = await courseProgress(db, admin, e.id);
    expect(report.progressPercent).toBe(50);
    expect(report.completedLessons).toBe(1);
    expect(report.totalLessons).toBe(2);
  });

  it('says plainly that progress is not proficiency', async () => {
    const { course, lesson } = await makeSimpleCourse();
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    const done = await markLessonComplete(db, { principal: student }, { enrolmentId: e.id, lessonId: lesson.id }, {}, NOW);
    expect(done.note).toMatch(/not an assessment, not a grade/i);
    expect((await courseProgress(db, admin, e.id)).note).toMatch(/confers no rank/i);
  });

  it('refuses a lesson id belonging to a different course', async () => {
    const a = await makeSimpleCourse();
    const b = await makeSimpleCourse();
    const e = await enrol(db, admin, { courseId: a.course.id, personId: STUDENT }, NOW);
    await expect(markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: b.lesson.id }))
      .rejects.toThrow(/does not belong to the course/i);
  });

  it('refuses an unrelated member marking someone else complete', async () => {
    const { course, lesson } = await makeSimpleCourse();
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    await expect(markLessonComplete(db, { principal: outsider }, { enrolmentId: e.id, lessonId: lesson.id }))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('watch time is a signal, and its threshold is federation configuration', () => {
  async function videoCourse() {
    const course = await createCourse(db, admin, { slug: nextSlug('watch'), title: 'Watch course' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, {
      moduleId: mod.id, kind: 'video', title: 'Mae-geri', mediaAssetId: ASSET_OK, durationMinutes: 10,
    });
    await publishCourse(db, admin, course.id, NOW);
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    return { course, lesson, enrolment: e };
  }

  it('records the claim and states that no minimum is configured', async () => {
    const { lesson, enrolment } = await videoCourse();
    const r = await markLessonComplete(
      db, { principal: student }, { enrolmentId: enrolment.id, lessonId: lesson.id, watchedSeconds: 12 }, {}, NOW
    );
    expect(r.watchTime.minimum.configured).toBe(false);
    expect(r.watchTime.minimum.value).toBeNull();
    expect(r.watchTime.minimum.detail).toMatch(/no minimum watch time/i);
    expect(r.watchTime.reportedSeconds).toBe(12);
    expect(r.watchTime.lessonDurationSeconds).toBe(600);
  });

  it('enforces a minimum ONLY when the federation supplies one', async () => {
    const { lesson, enrolment } = await videoCourse();
    await expect(markLessonComplete(
      db, { principal: student },
      { enrolmentId: enrolment.id, lessonId: lesson.id, watchedSeconds: 30 },
      { lessonWatchMinSeconds: 540 }, NOW
    )).rejects.toThrow(/requires 540s of viewing/);

    const ok = await markLessonComplete(
      db, { principal: student },
      { enrolmentId: enrolment.id, lessonId: lesson.id, watchedSeconds: 600 },
      { lessonWatchMinSeconds: 540 }, NOW
    );
    expect(ok.watchTime.minimum.configured).toBe(true);
  });

  it('never lets recorded watch time go backwards', async () => {
    const { lesson, enrolment } = await videoCourse();
    await markLessonComplete(db, { principal: student }, { enrolmentId: enrolment.id, lessonId: lesson.id, watchedSeconds: 300 }, {}, NOW);
    const second = await markLessonComplete(db, { principal: student }, { enrolmentId: enrolment.id, lessonId: lesson.id, watchedSeconds: 5 }, {}, NOW);
    expect(second.watchTime.reportedSeconds).toBe(300);
  });

  it('refuses to complete a lesson whose video has since been unpublished', async () => {
    const { lesson, enrolment } = await videoCourse();
    await db.update(s.mediaAssets).set({ published: false }).where(eq(s.mediaAssets.id, ASSET_OK));
    await expect(markLessonComplete(db, { principal: student }, { enrolmentId: enrolment.id, lessonId: lesson.id }))
      .rejects.toThrow(/cannot be completed: the linked video has not been published/i);
    await db.update(s.mediaAssets).set({ published: true }).where(eq(s.mediaAssets.id, ASSET_OK));
  });
});

// ─── Quizzes ────────────────────────────────────────────────────────────────

/** A published course carrying one quiz, built to order. */
async function quizCourse(opts: {
  passMarkPercent?: number | null;
  attemptsAllowed?: number | null;
  timeLimitMinutes?: number | null;
  freeText?: boolean;
  certificateOnCompletion?: boolean;
}) {
  const course = await createCourse(db, admin, {
    slug: nextSlug('quiz'), title: 'Quiz course',
    certificateOnCompletion: opts.certificateOnCompletion ?? false,
  });
  const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
  const lesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'quiz', title: 'Assessment' });
  const quiz = await addQuiz(db, admin, {
    courseId: course.id, lessonId: lesson.id, title: 'Terminology',
    passMarkPercent: opts.passMarkPercent ?? null,
    attemptsAllowed: opts.attemptsAllowed ?? null,
    timeLimitMinutes: opts.timeLimitMinutes ?? null,
  });
  const q1 = await addQuizQuestion(db, admin, {
    quizId: quiz.id, prompt: 'Which is the front kick?', kind: 'single',
    // Authoring tools habitually flag the right option. The extra key must not
    // survive to the student read.
    options: [{ id: 'a', text: 'Mae-geri', correct: true }, { id: 'b', text: 'Yoko-geri' }],
    correctAnswer: 'a', explanation: 'Mae travels straight ahead.', marks: 2, displayOrder: 1,
  });
  const q2 = opts.freeText
    ? await addQuizQuestion(db, admin, {
        quizId: quiz.id, prompt: 'Describe hikite.', kind: 'text',
        correctAnswer: 'the withdrawing hand', marks: 2, displayOrder: 2,
      })
    : await addQuizQuestion(db, admin, {
        quizId: quiz.id, prompt: 'Which stance is the front stance?', kind: 'single',
        options: [{ id: 'a', text: 'Kiba-dachi' }, { id: 'b', text: 'Zenkutsu-dachi' }],
        correctAnswer: 'b', marks: 2, displayOrder: 2,
      });
  await publishCourse(db, admin, course.id, NOW);
  const enrolment = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
  return { course, lesson, quiz, q1, q2, enrolment };
}

describe('the answer key is unreachable before submission', () => {
  it('returns no correct answer, no explanation, and no answer-bearing option key', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const view = await quizForStudent(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id });

    for (const q of view.questions) {
      expect(Object.keys(q).sort()).toEqual(['displayOrder', 'id', 'kind', 'marks', 'options', 'prompt']);
      expect(q).not.toHaveProperty('correctAnswer');
      expect(q).not.toHaveProperty('explanation');
      for (const o of q.options ?? []) {
        expect(Object.keys(o).sort()).toEqual(['id', 'text']);
      }
    }
    // The explanation text appears nowhere in the serialised payload.
    expect(JSON.stringify(view)).not.toContain('Mae travels straight ahead');
    expect(JSON.stringify(view)).not.toContain('correctAnswer');
  });

  it('strips an authoring "correct" flag at write time, not merely at read time', async () => {
    const { q1 } = await quizCourse({ passMarkPercent: 50 });
    const stored = (await db.select().from(s.quizQuestions).where(eq(s.quizQuestions.id, q1.id)))[0];
    expect(stored.options).toEqual([{ id: 'a', text: 'Mae-geri' }, { id: 'b', text: 'Yoko-geri' }]);
  });

  it('refuses to hand back a result for an attempt that has not been submitted', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const started = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    await expect(attemptResult(db, { principal: student }, started.attempt.id))
      .rejects.toThrow(/has not been submitted/i);
  });

  it('reveals the answers once the attempt is closed', async () => {
    const { quiz, q1, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const started = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: started.attempt.id, responses: { [q1.id]: 'a' } }, NOW);

    const result = await attemptResult(db, { principal: student }, started.attempt.id);
    expect(result.questions.find((q: any) => q.id === q1.id)!.correctAnswer).toBe('a');
    expect(result.questions.find((q: any) => q.id === q1.id)!.explanation).toMatch(/straight ahead/);
  });
});

describe('attempts', () => {
  it('enforces the configured attempt limit and refuses a further attempt', async () => {
    const { quiz, q1, q2, enrolment } = await quizCourse({ passMarkPercent: 50, attemptsAllowed: 2 });

    for (const answer of ['b', 'b']) {
      const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
      await submitAttempt(db, { principal: student }, {
        attemptId: a.attempt.id, responses: { [q1.id]: answer, [q2.id]: 'a' },
      }, NOW);
    }
    await expect(startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW))
      .rejects.toThrow(/All 2 permitted attempt\(s\).*have been used/i);
  });

  it('reports that no attempt limit is configured rather than inventing one', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const view = await quizForStudent(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id });
    expect(view.attemptLimit.configured).toBe(false);
    expect(view.attemptLimit.detail).toMatch(/no attempt limit/i);

    for (let i = 0; i < 3; i++) {
      const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
      await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: {} }, NOW);
    }
    const progress = await courseProgress(db, admin, enrolment.id);
    expect(progress.quizzes[0].attemptsUsed).toBe(3);
  });

  it('resumes an open attempt instead of consuming another', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50, attemptsAllowed: 1 });
    const first = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const again = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    expect(again.resumed).toBe(true);
    expect(again.attempt.id).toBe(first.attempt.id);
  });

  it('refuses a second submission of the same attempt', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: {} }, NOW);
    await expect(submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: {} }, NOW))
      .rejects.toThrow(/already been submitted/i);
  });
});

describe('an unset pass mark yields UNGRADED, never a pass', () => {
  it('records the score but refuses to declare a result', async () => {
    const { quiz, q1, q2, enrolment } = await quizCourse({ passMarkPercent: null });
    const started = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const r = await submitAttempt(db, { principal: student }, {
      attemptId: started.attempt.id, responses: { [q1.id]: 'a', [q2.id]: 'b' },
    }, NOW);

    // Every mark was earned — and it still is not a pass, because nobody set one.
    expect(r.scorePercent).toBe(100);
    expect(r.result).toBe('ungraded');
    expect(r.passMark.configured).toBe(false);
    expect(r.ungradedReason).toMatch(/no pass mark/i);
    // NULL, not false: an unmarked attempt has not been failed either.
    expect(r.attempt.passed).toBeNull();
  });

  it('marks a quiz containing free text as UNGRADED, awaiting an examiner', async () => {
    const { quiz, q1, q2, enrolment } = await quizCourse({ passMarkPercent: 50, freeText: true });
    const started = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const r = await submitAttempt(db, { principal: student }, {
      attemptId: started.attempt.id, responses: { [q1.id]: 'a', [q2.id]: 'the withdrawing hand' },
    }, NOW);
    expect(r.result).toBe('ungraded');
    expect(r.ungradedReason).toMatch(/examiner must mark it/i);
    expect(r.attempt.passed).toBeNull();
  });

  it('passes and fails only against a pass mark the federation set', async () => {
    const passing = await quizCourse({ passMarkPercent: 75 });
    let a = await startAttempt(db, { principal: student }, { quizId: passing.quiz.id, enrolmentId: passing.enrolment.id }, NOW);
    let r = await submitAttempt(db, { principal: student }, {
      attemptId: a.attempt.id, responses: { [passing.q1.id]: 'a', [passing.q2.id]: 'b' },
    }, NOW);
    expect(r.result).toBe('passed');
    expect(r.attempt.passed).toBe(true);

    const failing = await quizCourse({ passMarkPercent: 75 });
    a = await startAttempt(db, { principal: student }, { quizId: failing.quiz.id, enrolmentId: failing.enrolment.id }, NOW);
    r = await submitAttempt(db, { principal: student }, {
      attemptId: a.attempt.id, responses: { [failing.q1.id]: 'a', [failing.q2.id]: 'a' },
    }, NOW);
    expect(r.scorePercent).toBe(50);
    expect(r.result).toBe('failed');
    expect(r.attempt.passed).toBe(false);
  });

  it('stores the whole marking breakdown so a result is explainable from the record', async () => {
    const { quiz, q1, q2, enrolment } = await quizCourse({ passMarkPercent: 50 });
    const started = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, {
      attemptId: started.attempt.id, responses: { [q1.id]: 'a', [q2.id]: 'a' },
    }, NOW);

    const stored = (await db.select().from(s.quizAttempts).where(eq(s.quizAttempts.id, started.attempt.id)))[0];
    expect(stored.answers.marksAvailable).toBe(4);
    expect(stored.answers.marksAwarded).toBe(2);
    expect(stored.answers.passMark).toEqual({ configured: true, value: 50 });
    expect(stored.answers.marking).toHaveLength(2);
  });
});

// ─── Completion and certificate ─────────────────────────────────────────────

describe('a certificate is issued only when the course is genuinely complete', () => {
  async function fullCourse(certificateOnCompletion: boolean, passMarkPercent: number | null = 50) {
    const course = await createCourse(db, admin, {
      slug: nextSlug('cert'), title: 'Certificate course', certificateOnCompletion,
      leadTeacherPersonId: TEACHER,
    });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const reading = await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'Theory', body: 'x' });
    const quizLesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'quiz', title: 'Assessment' });
    const quiz = await addQuiz(db, admin, {
      courseId: course.id, lessonId: quizLesson.id, title: 'Terminology', passMarkPercent,
    });
    const q1 = await addQuizQuestion(db, admin, {
      quizId: quiz.id, prompt: 'Front kick?', kind: 'single',
      options: ['Mae-geri', 'Yoko-geri'], correctAnswer: '1', marks: 1,
    });
    await publishCourse(db, admin, course.id, NOW);
    const enrolment = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    return { course, reading, quizLesson, quiz, q1, enrolment };
  }

  async function finishLessons(enrolmentId: number, lessonIds: number[]) {
    for (const id of lessonIds) {
      await markLessonComplete(db, { principal: student }, { enrolmentId, lessonId: id }, {}, NOW);
    }
  }

  it('refuses while a lesson is outstanding', async () => {
    const c = await fullCourse(true);
    const check = await completionCheck(db, c.enrolment.id);
    expect(check.complete).toBe(false);
    await expect(completeEnrolment(db, admin, c.enrolment.id, NOW)).rejects.toThrow(/lesson\(s\) are not complete/i);
  });

  it('refuses while a quiz is unpassed', async () => {
    const c = await fullCourse(true);
    await finishLessons(c.enrolment.id, [c.reading.id, c.quizLesson.id]);
    await expect(completeEnrolment(db, admin, c.enrolment.id, NOW)).rejects.toThrow(/has not been passed/i);
  });

  it('refuses when a quiz has no pass mark, and says why it can never be passed', async () => {
    const c = await fullCourse(true, null);
    await finishLessons(c.enrolment.id, [c.reading.id, c.quizLesson.id]);
    const a = await startAttempt(db, { principal: student }, { quizId: c.quiz.id, enrolmentId: c.enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: { [c.q1.id]: '1' } }, NOW);

    const err = await completeEnrolment(db, admin, c.enrolment.id, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(AcademyError);
    expect(err.code).toBe('not_complete');
    expect(err.message).toMatch(/no pass mark set by the federation/i);
  });

  it('issues a course certificate, with provenance that is not a grade', async () => {
    const c = await fullCourse(true);
    await finishLessons(c.enrolment.id, [c.reading.id, c.quizLesson.id]);
    const a = await startAttempt(db, { principal: student }, { quizId: c.quiz.id, enrolmentId: c.enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: { [c.q1.id]: '1' } }, NOW);

    const done = await completeEnrolment(db, admin, c.enrolment.id, NOW);
    expect(done.issued).toBe(true);
    expect(done.certificate.kind).toBe('course_completion');
    expect(done.certificate.certificateNo).toMatch(/^MMAKF-CERT-2026-\d{6}$/);
    expect(done.certificate.snapshot.provenance).toBe('course');
    expect(done.enrolment.status).toBe('completed');
    expect(done.enrolment.finalScorePercent).toBe(100);

    // A course completion is not a rank and must never mint one.
    const ranks = await db.select().from(s.rankRecords).where(eq(s.rankRecords.personId, STUDENT));
    expect(ranks).toHaveLength(0);
  });

  it('is idempotent — a retry returns the same certificate, and only one exists', async () => {
    const c = await fullCourse(true);
    await finishLessons(c.enrolment.id, [c.reading.id, c.quizLesson.id]);
    const a = await startAttempt(db, { principal: student }, { quizId: c.quiz.id, enrolmentId: c.enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: { [c.q1.id]: '1' } }, NOW);

    const first = await completeEnrolment(db, admin, c.enrolment.id, NOW);
    const second = await completeEnrolment(db, admin, c.enrolment.id, NOW);
    expect(second.issued).toBe(false);
    expect(second.alreadyIssued).toBe(true);
    expect(second.certificate.id).toBe(first.certificate.id);

    const all = await db.select().from(s.certificates)
      .where(and(eq(s.certificates.personId, STUDENT), eq(s.certificates.kind, 'course_completion')));
    expect(all.filter((x: any) => x.snapshot.course.slug === c.course.slug)).toHaveLength(1);
  });

  it('completes without a certificate when the course is not configured for one', async () => {
    const c = await fullCourse(false);
    await finishLessons(c.enrolment.id, [c.reading.id, c.quizLesson.id]);
    const a = await startAttempt(db, { principal: student }, { quizId: c.quiz.id, enrolmentId: c.enrolment.id }, NOW);
    await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: { [c.q1.id]: '1' } }, NOW);

    const done = await completeEnrolment(db, admin, c.enrolment.id, NOW);
    expect(done.issued).toBe(false);
    expect(done.certificate).toBeNull();
    expect(done.note).toMatch(/not configured to award a certificate/i);
    expect(done.enrolment.status).toBe('completed');
  });

  it('refuses to issue to a caller without certificate authority', async () => {
    const c = await fullCourse(true);
    await expect(completeEnrolment(db, { principal: student }, c.enrolment.id, NOW)).rejects.toThrow(/Forbidden/);
  });
});

// ─── Live classroom ─────────────────────────────────────────────────────────

describe('live class attendance', () => {
  async function liveClass(over: Record<string, unknown> = {}) {
    return scheduleLiveClass(db, admin, { title: 'Saturday kihon', teacherPersonId: TEACHER, ...over }, NOW);
  }

  it('records presence and states that no threshold is configured', async () => {
    const cls = await liveClass();
    const r = await joinLiveClass(db, { principal: student }, {
      liveClassId: cls.id, personId: STUDENT, watchedSeconds: 45,
    }, {}, NOW);

    expect(r.attendance.watchedSeconds).toBe(45);
    expect(r.threshold.configured).toBe(false);
    expect(r.threshold.value).toBeNull();
    expect(r.threshold.detail).toMatch(/no attendance threshold/i);
    // Not false — nothing was measured, so nothing was missed.
    expect(r.meetsThreshold).toBeNull();
    expect(r.note).toMatch(/confers no rank/i);
  });

  it('applies a threshold only when the federation supplies one', async () => {
    const cls = await liveClass();
    const below = await joinLiveClass(db, { principal: student }, {
      liveClassId: cls.id, personId: STUDENT, watchedSeconds: 100,
    }, { liveAttendanceMinSeconds: 300 }, NOW);
    expect(below.meetsThreshold).toBe(false);

    const above = await joinLiveClass(db, { principal: student }, {
      liveClassId: cls.id, personId: STUDENT, watchedSeconds: 900,
    }, { liveAttendanceMinSeconds: 300 }, NOW);
    expect(above.meetsThreshold).toBe(true);
    // Rejoining accumulates rather than resets.
    expect(above.attendance.watchedSeconds).toBe(900);
  });

  it('reports a register as presence only while no threshold exists', async () => {
    const cls = await liveClass();
    await joinLiveClass(db, { principal: student }, { liveClassId: cls.id, personId: STUDENT, watchedSeconds: 20 }, {}, NOW);

    const report = await liveClassAttendanceReport(db, admin, cls.id);
    expect(report.present).toBe(1);
    expect(report.meetingThreshold).toBeNull();
    expect(report.threshold.detail).toMatch(/presence only/i);
    expect(report.attendees[0].meetsThreshold).toBeNull();

    const measured = await liveClassAttendanceReport(db, admin, cls.id, { liveAttendanceMinSeconds: 10 });
    expect(measured.meetingThreshold).toBe(1);
  });

  it('keeps a course-only class to students enrolled on that course', async () => {
    const { course } = await makeSimpleCourse();
    const cls = await liveClass({ visibility: 'course', courseId: course.id });

    await expect(joinLiveClass(db, admin, { liveClassId: cls.id, personId: OTHER }, {}, NOW))
      .rejects.toThrow(/restricted to students enrolled/i);

    await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    const ok = await joinLiveClass(db, admin, { liveClassId: cls.id, personId: STUDENT }, {}, NOW);
    expect(ok.attendance.personId).toBe(STUDENT);
  });

  it('refuses attendance at a cancelled class', async () => {
    const cls = await liveClass();
    await db.update(s.liveClasses).set({ status: 'cancelled' }).where(eq(s.liveClasses.id, cls.id));
    await expect(joinLiveClass(db, admin, { liveClassId: cls.id, personId: STUDENT }, {}, NOW))
      .rejects.toThrow(/cancelled/i);
  });
});

describe('questions are moderated, never destroyed', () => {
  it('asks, answers and upvotes — declaring that repeat votes cannot be prevented', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Q and A' }, NOW);
    const q = await askQuestion(db, { principal: student }, {
      liveClassId: cls.id, personId: STUDENT, question: 'How deep should zenkutsu-dachi be?',
    }, NOW);

    const voted = await upvoteQuestion(db, { principal: student }, { questionId: q.id, personId: STUDENT });
    expect(voted.upvotes).toBe(1);
    expect(voted.uniquenessEnforced).toBe(false);

    const answered = await answerQuestion(db, admin, {
      questionId: q.id, answeredByPersonId: TEACHER, answer: 'As set out in the syllabus.',
    }, NOW);
    expect(answered.status).toBe('answered');
  });

  it('refuses an empty question', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Empty' }, NOW);
    await expect(askQuestion(db, { principal: student }, { liveClassId: cls.id, personId: STUDENT, question: '   ' }, NOW))
      .rejects.toThrow(/cannot be empty/i);
  });

  it('hides a question from the class while keeping it on the record', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Moderated' }, NOW);
    const kept = await askQuestion(db, { principal: student }, { liveClassId: cls.id, personId: STUDENT, question: 'Fine question' }, NOW);
    const hidden = await askQuestion(db, { principal: student }, { liveClassId: cls.id, personId: STUDENT, question: 'Abusive question' }, NOW);

    await hideQuestion(db, admin, { questionId: hidden.id, reason: 'Abusive language' });

    const publicList = await liveClassQuestions(db, admin, cls.id);
    expect(publicList.map((r: any) => r.id)).toEqual([kept.id]);

    // Still there, with its text intact, for anyone who has to account for it.
    const moderation = await moderationQuestions(db, admin, cls.id);
    const row = moderation.find((r: any) => r.id === hidden.id);
    expect(row.status).toBe('hidden');
    expect(row.question).toBe('Abusive question');

    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'live_class_question'), eq(s.auditEvents.entityId, String(hidden.id))));
    expect(audit[0].reason).toBe('Abusive language');
  });

  it('refuses to hide without a reason, and refuses to answer what is hidden', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Reasons' }, NOW);
    const q = await askQuestion(db, { principal: student }, { liveClassId: cls.id, personId: STUDENT, question: 'Anything' }, NOW);

    await expect(hideQuestion(db, admin, { questionId: q.id, reason: '' })).rejects.toThrow(/requires a reason/i);
    await hideQuestion(db, admin, { questionId: q.id, reason: 'Off topic' });
    await expect(answerQuestion(db, admin, { questionId: q.id, answeredByPersonId: TEACHER, answer: 'x' }, NOW))
      .rejects.toThrow(/has been hidden/i);
    await expect(upvoteQuestion(db, { principal: student }, { questionId: q.id, personId: STUDENT }))
      .rejects.toThrow(/has been hidden/i);
  });
});

describe('resources resolve before they are stored', () => {
  it('links a published technique and a published kata, and refuses unpublished ones', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Resources' }, NOW);

    const [draftTechnique] = await db.insert(s.techniques)
      .values({ slug: 'mae-geri-draft', nameRomaji: 'Mae-geri', category: 'geri', published: false })
      .returning({ id: s.techniques.id });
    await expect(attachResource(db, admin, {
      liveClassId: cls.id, title: 'Mae-geri', kind: 'technique', techniqueId: draftTechnique.id,
    })).rejects.toThrow(/has not been published/i);

    const [technique] = await db.insert(s.techniques)
      .values({ slug: 'mae-geri', nameRomaji: 'Mae-geri', category: 'geri', published: true })
      .returning({ id: s.techniques.id });
    const [kata] = await db.insert(s.kata)
      .values({ slug: 'heian-shodan', nameRomaji: 'Heian Shodan', published: true })
      .returning({ id: s.kata.id });

    await attachResource(db, admin, { liveClassId: cls.id, title: 'Mae-geri', kind: 'technique', techniqueId: technique.id });
    await attachResource(db, admin, { liveClassId: cls.id, title: 'Heian Shodan', kind: 'kata', kataId: kata.id, displayOrder: 1 });

    const resources = await liveClassResources(db, admin, cls.id);
    expect(resources.map((r: any) => r.kind)).toEqual(['technique', 'kata']);
  });

  it('resolves a document to its current version file, and refuses one with no file', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Documents' }, NOW);

    const [doc] = await db.insert(s.officialDocuments)
      .values({ code: 'MMAKF-DOC-TEST', title: 'Competition Rules', category: 'regulation' })
      .returning({ id: s.officialDocuments.id });
    await expect(attachResource(db, admin, { liveClassId: cls.id, title: 'Rules', kind: 'document', documentId: doc.id }))
      .rejects.toThrow(/no current version/i);

    const [version] = await db.insert(s.documentVersions)
      .values({ documentId: doc.id, version: '1.0', status: 'published', fileUrl: 'https://example.test/rules.pdf' })
      .returning({ id: s.documentVersions.id });
    await db.update(s.officialDocuments).set({ currentVersionId: version.id })
      .where(eq(s.officialDocuments.id, doc.id));

    const row = await attachResource(db, admin, {
      liveClassId: cls.id, title: 'Rules', kind: 'document', documentId: doc.id,
    });
    expect(row.url).toBe('https://example.test/rules.pdf');
  });

  it('refuses a link with no URL', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Links' }, NOW);
    await expect(attachResource(db, admin, { liveClassId: cls.id, title: 'Somewhere', kind: 'link' }))
      .rejects.toThrow(/needs a URL/i);
  });
});

// ─── Attacks ────────────────────────────────────────────────────────────────
//
// Each of these reproduces something the module actually did wrong. They are
// written from the attacker's side: a student who wants the course without
// paying, an editor who wants to declare that payment arrived, a dojo admin who
// wants the national register, a candidate who wants the answer key before the
// attempt that counts.

describe('a learner cannot enrol themselves past the fee', () => {
  async function paidCourse() {
    const course = await createCourse(db, admin, {
      slug: nextSlug('fee'), title: 'Fee-bearing', feeCode: 'ACADEMY-BASIC',
    });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'L', body: 'x' });
    await publishCourse(db, admin, course.id, NOW);
    return { course, lesson };
  }

  it('ignores a status the caller supplies for themselves', async () => {
    const { course, lesson } = await paidCourse();
    // The attack: self-service enrolment asking for 'active' on a fee-bearing
    // course. `assertSelfOrAuthority` says 'self', so nothing else was looking.
    const e = await enrol(db, { principal: student }, {
      courseId: course.id, personId: STUDENT, status: 'active',
    } as any, NOW);

    expect(e.status).toBe('pending_payment');
    const stored = (await db.select().from(s.enrolments).where(eq(s.enrolments.id, e.id)))[0];
    expect(stored.status).toBe('pending_payment');
    await expect(markLessonComplete(db, { principal: student }, { enrolmentId: e.id, lessonId: lesson.id }))
      .rejects.toThrow(/pending payment/i);
  });

  it('refuses to activate a fee-bearing enrolment with no order behind it', async () => {
    const { course } = await paidCourse();
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    // content:write is an EDITORIAL permission. It is not the power to say a
    // student paid.
    const err = await activateEnrolment(db, admin, e.id).catch((x) => x);
    expect(err).toBeInstanceOf(AcademyError);
    expect(err.code).toBe('no_order');
  });

  it('refuses an unpaid order, and one that does not cover this course', async () => {
    const { course } = await paidCourse();

    const [unpaid] = await db.insert(s.orders).values({
      orderNo: nextSlug('ORD'), personId: STUDENT, status: 'awaiting_payment', totalPaise: 50000,
    }).returning();
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT, orderId: unpaid.id }, NOW);
    let err = await activateEnrolment(db, admin, e.id).catch((x) => x);
    expect(err.code).toBe('order_not_paid');

    // Now it is paid — but for a T-shirt, not for this course.
    await db.update(s.orders)
      .set({ status: 'paid', paidAt: NOW })
      .where(eq(s.orders.id, unpaid.id));
    await db.insert(s.orderLines).values({
      orderId: unpaid.id, kind: 'product', description: 'Dojo t-shirt',
      unitPricePaise: 50000, totalPaise: 50000,
    });
    err = await activateEnrolment(db, admin, e.id).catch((x) => x);
    expect(err.code).toBe('order_does_not_cover_this_course');

    // And with a real course line, it activates and the audit says on what.
    await db.insert(s.orderLines).values({
      orderId: unpaid.id, kind: 'course', refType: 'course', refId: course.id,
      description: 'Fee-bearing', unitPricePaise: 50000, totalPaise: 50000,
    });
    const active = await activateEnrolment(db, admin, e.id);
    expect(active.status).toBe('active');

    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'enrolment'), eq(s.auditEvents.entityId, String(e.id))));
    const activation = audit.find((a: any) => a.newValue?.status === 'active');
    expect(activation.newValue.evidence.basis).toBe('captured payment');
    expect(activation.newValue.evidence.orderNo).toBe(
      (await db.select().from(s.orders).where(eq(s.orders.id, unpaid.id)))[0].orderNo
    );
  });

  it('refuses an order raised for somebody else', async () => {
    const { course } = await paidCourse();
    const [order] = await db.insert(s.orders).values({
      orderNo: nextSlug('ORD'), personId: OTHER, status: 'paid', paidAt: NOW, totalPaise: 50000,
    }).returning();
    await db.insert(s.orderLines).values({
      orderId: order.id, kind: 'course', refType: 'course', refId: course.id,
      description: 'Fee-bearing', unitPricePaise: 50000, totalPaise: 50000,
    });
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT, orderId: order.id }, NOW);
    const err = await activateEnrolment(db, admin, e.id).catch((x) => x);
    expect(err.code).toBe('order_belongs_to_another_person');
  });
});

describe('an expired enrolment is not a live one', () => {
  const LATER = new Date('2026-09-01T10:00:00Z');

  it('refuses learning and refuses a certificate once the expiry has passed', async () => {
    const course = await createCourse(db, admin, {
      slug: nextSlug('expiring'), title: 'Expiring', certificateOnCompletion: true,
      leadTeacherPersonId: TEACHER,
    });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'reading', title: 'L', body: 'x' });
    await publishCourse(db, admin, course.id, NOW);

    const e = await enrol(db, admin, {
      courseId: course.id, personId: STUDENT, expiresAt: new Date('2026-08-20T00:00:00Z'),
    }, NOW);

    // Inside the window: fine.
    await markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: lesson.id }, {}, NOW);

    // Past it: the date was stored and never read, so the enrolment stayed
    // fully learnable — and, with every lesson ticked, fully certifiable.
    await expect(markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: lesson.id }, {}, LATER))
      .rejects.toThrow(/expired on 2026-08-20/i);
    await expect(completeEnrolment(db, admin, e.id, LATER))
      .rejects.toThrow(/expired on 2026-08-20/i);

    const certs = await db.select().from(s.certificates).where(eq(s.certificates.personId, STUDENT));
    expect(certs.filter((c: any) => c.title.startsWith('Expiring'))).toHaveLength(0);
  });

  it('refuses to complete an enrolment that was withdrawn after the work was done', async () => {
    const { course, lesson } = await makeSimpleCourse({ certificateOnCompletion: true });
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    await markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: lesson.id }, {}, NOW);
    await db.update(s.enrolments).set({ status: 'withdrawn' }).where(eq(s.enrolments.id, e.id));

    await expect(completeEnrolment(db, admin, e.id, NOW)).rejects.toThrow(/withdrawn, so it cannot be completed/i);
  });

  it('completes a course with no certificate exactly once', async () => {
    const { course, lesson } = await makeSimpleCourse({ certificateOnCompletion: false });
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    await markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: lesson.id }, {}, NOW);

    const first = await completeEnrolment(db, admin, e.id, NOW);
    expect(first.issued).toBe(false);
    // No certificate row means nothing to be idempotent against — the status is
    // the guard, and without it the whole completion ran a second time.
    const again = await completeEnrolment(db, admin, e.id, new Date('2026-08-13T10:00:00Z'));
    expect(again.alreadyIssued).toBe(true);

    const stored = (await db.select().from(s.enrolments).where(eq(s.enrolments.id, e.id)))[0];
    expect(new Date(stored.completedAt).toISOString()).toBe(NOW.toISOString());
    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'enrolment'), eq(s.auditEvents.entityId, String(e.id))
    ));
    expect(audit.filter((a: any) => a.action === 'finalize')).toHaveLength(1);
  });
});

describe('marking is decided in whole marks, and a limit that is set is honoured', () => {
  /** Two questions worth 3 and 4 marks: 3 of 7 is 42.86%, which ROUNDS to 43. */
  async function unevenQuiz(passMarkPercent: number, timeLimitMinutes: number | null = null) {
    const course = await createCourse(db, admin, { slug: nextSlug('round'), title: 'Rounding' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, { moduleId: mod.id, kind: 'quiz', title: 'Q' });
    const quiz = await addQuiz(db, admin, {
      courseId: course.id, lessonId: lesson.id, title: 'Uneven', passMarkPercent, timeLimitMinutes,
    });
    const q1 = await addQuizQuestion(db, admin, {
      quizId: quiz.id, prompt: 'Three marks', kind: 'single',
      options: ['a', 'b'], correctAnswer: '1', marks: 3, displayOrder: 1,
    });
    const q2 = await addQuizQuestion(db, admin, {
      quizId: quiz.id, prompt: 'Four marks', kind: 'single',
      options: ['a', 'b'], correctAnswer: '1', marks: 4, displayOrder: 2,
    });
    await publishCourse(db, admin, course.id, NOW);
    const enrolment = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    return { quiz, q1, q2, enrolment };
  }

  it('does not round a candidate up over the pass mark', async () => {
    const { quiz, q1, enrolment } = await unevenQuiz(43);
    const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const r = await submitAttempt(db, { principal: student }, {
      attemptId: a.attempt.id, responses: { [q1.id]: '1' },
    }, NOW);

    // The displayed integer is 43, which reads as a pass against a 43% mark.
    expect(r.scorePercent).toBe(43);
    // 3 marks of 7 is 42.86% and is NOT 43%.
    expect(r.result).toBe('failed');
    expect(r.attempt.passed).toBe(false);
  });

  it('records an attempt handed in after a configured time limit as ungraded, not as a pass', async () => {
    const { quiz, q1, q2, enrolment } = await unevenQuiz(50, 30);
    const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const late = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);
    const r = await submitAttempt(db, { principal: student }, {
      attemptId: a.attempt.id, responses: { [q1.id]: '1', [q2.id]: '1' },
    }, late);

    expect(r.scorePercent).toBe(100);
    expect(r.withinTimeLimit).toBe(false);
    expect(r.result).toBe('ungraded');
    expect(r.ungradedReason).toMatch(/outside the configured time limit of 30 minute/i);
    // Not failed either — MMAKF has said nothing about late work.
    expect(r.attempt.passed).toBeNull();
  });

  it('cannot pass an attempt whose questions have all been removed', async () => {
    const { quiz, enrolment } = await unevenQuiz(50);
    const a = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    await db.delete(s.quizQuestions).where(eq(s.quizQuestions.quizId, quiz.id));

    const r = await submitAttempt(db, { principal: student }, { attemptId: a.attempt.id, responses: {} }, NOW);
    // 0 marks awarded of 0 available clears any threshold by arithmetic.
    expect(r.result).toBe('ungraded');
    expect(r.ungradedReason).toMatch(/no marks/i);
    expect(r.attempt.passed).toBeNull();
  });
});

describe('the answer key does not decide the attempt that has not happened yet', () => {
  it('withholds the marked detail while a configured attempt limit still has attempts left', async () => {
    const { quiz, q1, q2, enrolment } = await quizCourse({ passMarkPercent: 50, attemptsAllowed: 2 });
    const first = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const submitted = await submitAttempt(db, { principal: student }, {
      attemptId: first.attempt.id, responses: { [q1.id]: 'b', [q2.id]: 'a' },
    }, NOW);

    // The score is owed to the candidate. The key is not — one attempt remains.
    expect(submitted.scorePercent).toBe(0);
    expect(submitted.answerKey.released).toBe(false);
    expect(submitted.attempt.answers).toBeNull();

    const review = await attemptResult(db, { principal: student }, first.attempt.id);
    expect(review.answerKey.released).toBe(false);
    expect(review.answerKey.reason).toMatch(/1 of 2 permitted attempt/i);
    for (const q of review.questions) {
      expect(q).not.toHaveProperty('correctAnswer');
      expect(q).not.toHaveProperty('explanation');
      expect(q).not.toHaveProperty('correct');
    }
    // Not through the attempt row either, which carries the same breakdown.
    expect(JSON.stringify(review)).not.toContain('Mae travels straight ahead');
    expect(JSON.stringify(review)).not.toContain('marking');

    // An instructor with authority over the learner sees everything, always.
    const staff = await attemptResult(db, admin, first.attempt.id);
    expect(staff.answerKey.released).toBe(true);
    expect(staff.questions.find((q: any) => q.id === q1.id).correctAnswer).toBe('a');

    // And once the last attempt is spent there is nothing left to protect.
    const second = await startAttempt(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id }, NOW);
    const done = await submitAttempt(db, { principal: student }, {
      attemptId: second.attempt.id, responses: { [q1.id]: 'b' },
    }, NOW);
    expect(done.answerKey.released).toBe(true);
    const after = await attemptResult(db, { principal: student }, second.attempt.id);
    expect(after.questions.find((q: any) => q.id === q1.id).correctAnswer).toBe('a');

    // The record itself never lost the breakdown — only the reply did.
    const stored = (await db.select().from(s.quizAttempts).where(eq(s.quizAttempts.id, first.attempt.id)))[0];
    expect(stored.answers.marking).toHaveLength(2);
  });

  it('strips an answer-bearing option written straight into the table', async () => {
    const { quiz, enrolment } = await quizCourse({ passMarkPercent: 50 });
    // A seed, an import or a migration — anything that is not addQuizQuestion().
    await db.insert(s.quizQuestions).values({
      quizId: quiz.id, prompt: 'Imported question', kind: 'single',
      options: [{ id: 'a', text: 'Right one', correct: true }, { id: 'b', text: 'Wrong one' }],
      correctAnswer: 'a', explanation: 'Because.', marks: 1, displayOrder: 9,
    });

    const view = await quizForStudent(db, { principal: student }, { quizId: quiz.id, enrolmentId: enrolment.id });
    const imported = view.questions.find((q: any) => q.prompt === 'Imported question')!;
    for (const o of imported.options ?? []) expect(Object.keys(o).sort()).toEqual(['id', 'text']);
    expect(JSON.stringify(view)).not.toContain('correct":true');
    expect(JSON.stringify(view)).not.toContain('"correct"');
  });
});

describe('a live class is not readable just because its id is known', () => {
  it('refuses a private class to a member, and to nobody at all', async () => {
    const cls = await scheduleLiveClass(db, admin, {
      title: 'Instructors only', visibility: 'private', published: true,
    }, NOW);
    await askQuestion(db, admin, { liveClassId: cls.id, personId: STUDENT, question: 'A private question' }, NOW);
    await attachResource(db, admin, { liveClassId: cls.id, title: 'Notes', kind: 'link', url: 'https://example.test/n' });

    const anonymous = { principal: { userId: null, label: 'anonymous', bindings: [] } as Principal };
    await expect(liveClassQuestions(db, anonymous, cls.id)).rejects.toThrow(/Forbidden/);
    await expect(liveClassQuestions(db, { principal: student }, cls.id)).rejects.toThrow(/Forbidden/);
    await expect(liveClassResources(db, { principal: student }, cls.id)).rejects.toThrow(/Forbidden/);

    // The moderator still sees it — hiding it from everyone would be its own bug.
    expect(await liveClassQuestions(db, admin, cls.id)).toHaveLength(1);
  });

  it('keeps a course-only class to its students and an unpublished one to editors', async () => {
    const { course } = await makeSimpleCourse();
    const cls = await scheduleLiveClass(db, admin, {
      title: 'Course only', visibility: 'course', courseId: course.id, published: true,
    }, NOW);
    await askQuestion(db, admin, { liveClassId: cls.id, personId: STUDENT, question: 'Enrolled question' }, NOW);

    await expect(liveClassQuestions(db, { principal: outsider }, cls.id)).rejects.toThrow(/enrolled/i);
    await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    expect(await liveClassQuestions(db, { principal: student }, cls.id)).toHaveLength(1);

    const draft = await scheduleLiveClass(db, admin, { title: 'Not yet', visibility: 'members' }, NOW);
    await expect(liveClassQuestions(db, { principal: student }, draft.id))
      .rejects.toThrow(/has not been published/i);
  });

  it('does not name the asker on a class the whole internet can read', async () => {
    const cls = await scheduleLiveClass(db, admin, {
      title: 'Open day', visibility: 'public', published: true,
    }, NOW);
    await askQuestion(db, admin, { liveClassId: cls.id, personId: STUDENT, question: 'Public question' }, NOW);

    const anonymous = { principal: { userId: null, label: 'anonymous', bindings: [] } as Principal };
    const rows = await liveClassQuestions(db, anonymous, cls.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('personId');
    expect(Object.keys(rows[0]).sort())
      .toEqual(['answer', 'answeredAt', 'askedAt', 'id', 'question', 'status', 'upvotes']);

    // A member of the federation sees who asked; the public page does not.
    expect((await liveClassQuestions(db, { principal: student }, cls.id))[0].personId).toBe(STUDENT);
  });
});

describe('an attendance register is not a national export', () => {
  it('restricts attendees to the caller’s own scope, in SQL, and says it did', async () => {
    const [kl] = await db.insert(s.stateUnits)
      .values({ code: 'ST-KL', state: 'Kerala', name: 'KL', status: 'active' })
      .returning({ id: s.stateUnits.id });
    const [klDojo] = await db.insert(s.dojos)
      .values({ code: 'DJ-KL', name: 'Kochi', stateUnitId: kl.id, status: 'active' })
      .returning({ id: s.dojos.id });
    const klStudent = await createPerson(db, admin, {
      fullName: 'Kerala Student', stateUnitId: kl.id, dojoId: klDojo.id,
    } as any);

    const cls = await scheduleLiveClass(db, admin, { title: 'National kihon' }, NOW);
    await joinLiveClass(db, admin, { liveClassId: cls.id, personId: STUDENT, watchedSeconds: 60 }, {}, NOW);
    await joinLiveClass(db, admin, { liveClassId: cls.id, personId: klStudent.id, watchedSeconds: 60 }, {}, NOW);

    const nationalView = await liveClassAttendanceReport(db, admin, cls.id);
    expect(nationalView.present).toBe(2);
    expect(nationalView.scope.kind).toBe('all');

    // A Jharkhand administrator holds person:read — but only over Jharkhand.
    const jhAdmin = {
      principal: {
        userId: null, label: 'jh-admin',
        bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
      } as Principal,
    };
    const scoped = await liveClassAttendanceReport(db, jhAdmin, cls.id);
    expect(scoped.scope.kind).toBe('scoped');
    expect(scoped.attendees.map((a: any) => a.personId)).toEqual([STUDENT]);
    expect(scoped.present).toBe(1);
    expect(JSON.stringify(scoped)).not.toContain('Kerala Student');

    // A binding that resolves to no scope at all passes the gate and must still
    // grant nothing.
    const unscoped = {
      principal: {
        userId: null, label: 'stateless-admin',
        bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: null }],
      } as Principal,
    };
    const none = await liveClassAttendanceReport(db, unscoped, cls.id);
    expect(none.scope.kind).toBe('none');
    expect(none.attendees).toHaveLength(0);
    expect(none.present).toBe(0);
  });
});

describe('accumulated watch time is not thrown away', () => {
  it('measures a configured minimum against the total, not against the last visit', async () => {
    const course = await createCourse(db, admin, { slug: nextSlug('watch'), title: 'Watch' });
    const mod = await addModule(db, admin, { courseId: course.id, title: 'M1' });
    const lesson = await addLesson(db, admin, {
      moduleId: mod.id, kind: 'video', title: 'Mae-geri', mediaAssetId: ASSET_OK,
    });
    await publishCourse(db, admin, course.id, NOW);
    const e = await enrol(db, admin, { courseId: course.id, personId: STUDENT }, NOW);
    const policy = { lessonWatchMinSeconds: 300 };

    await markLessonComplete(db, admin, { enrolmentId: e.id, lessonId: lesson.id, watchedSeconds: 320 }, policy, NOW);
    // Coming back and clicking again reports this visit, not the whole history.
    // Refusing here contradicts the record the module itself stored.
    const again = await markLessonComplete(db, admin, {
      enrolmentId: e.id, lessonId: lesson.id, watchedSeconds: 5,
    }, policy, NOW);
    expect(again.watchTime.reportedSeconds).toBe(320);
    expect(again.watchTime.minimum.detail).toMatch(/320s watched in total/);

    // Someone who genuinely has not watched it is still refused.
    const fresh = await enrol(db, admin, { courseId: course.id, personId: OTHER }, NOW);
    await expect(markLessonComplete(db, admin, {
      enrolmentId: fresh.id, lessonId: lesson.id, watchedSeconds: 10,
    }, policy, NOW)).rejects.toThrow(/requires 300s of viewing/i);
  });
});

describe('a published answer cannot be rewritten without trace', () => {
  it('audits the superseded answer, and refuses an answerer who does not exist', async () => {
    const cls = await scheduleLiveClass(db, admin, { title: 'Answers' }, NOW);
    const q = await askQuestion(db, { principal: student }, {
      liveClassId: cls.id, personId: STUDENT, question: 'Which foot leads?',
    }, NOW);

    await expect(answerQuestion(db, admin, {
      questionId: q.id, answeredByPersonId: 999999, answer: 'Anything',
    }, NOW)).rejects.toThrow(/Unknown person/i);

    await answerQuestion(db, admin, { questionId: q.id, answeredByPersonId: TEACHER, answer: 'The left.' }, NOW);
    await answerQuestion(db, admin, { questionId: q.id, answeredByPersonId: TEACHER, answer: 'The right.' }, NOW);

    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'live_class_question'), eq(s.auditEvents.entityId, String(q.id))
    ));
    const rewrite = audit.find((a: any) => a.oldValue?.answer === 'The left.');
    expect(rewrite.newValue.answer).toBe('The right.');
  });
});

// ─── The schema defect this module refuses to paper over ────────────────────

describe('the invented DEFAULT 60 pass mark', () => {
  it('is refused loudly on an uncorrected database rather than silently applied', async () => {
    // A second, untouched database: exactly what production has today.
    const raw = new PGlite();
    const rawDb = drizzle(raw, { schema: s });
    await applyMigrations(raw);

    const course = await createCourse(rawDb, admin, { slug: 'raw-schema', title: 'Raw schema' });
    const err = await addQuiz(rawDb, admin, {
      courseId: course.id, title: 'No pass mark', passMarkPercent: null,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AcademyError);
    expect(err.code).toBe('pass_mark_not_storable');
    expect(err.message).toMatch(/not federation policy/i);
    await raw.close();
  }, 120_000);
});
