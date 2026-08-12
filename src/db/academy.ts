// The Academy (LMS) and the live classroom — Q-14 and Q-15.
//
// AUTHOR → PUBLISH → ENROL → LEARN → ASSESS → COMPLETE → CERTIFICATE
//
// Two claims this module exists to keep honest.
//
//  1. NOTHING IS OFFERED THAT DOES NOT EXIST. A course cannot be published while
//     a video lesson points at a media asset that is missing, unpublished or not
//     classified as federation teaching content, and a "Free Preview" badge is
//     DERIVED from an accessible preview lesson rather than ticked by an author.
//     A player that opens on a dead embed is worse than a course that says it is
//     not ready.
//
//  2. ATTENDANCE AND PROGRESS ARE NOT PROFICIENCY. A completed lesson means the
//     lesson was marked done; watch time means a video was open. Neither is a
//     grade, neither feeds eligibility, and nothing here ever converts one into
//     the other. That conversion is exactly how attendance quietly becomes a
//     grading criterion nobody approved (see src/db/grading.ts for where grades
//     actually come from).
//
// WHAT IS DELIBERATELY NOT HERE: a pass mark, a minimum watch time, an
// attendance threshold, an attempt limit, a partial-credit rule and a weighting
// formula. Every one of those is MMAKF configuration. Where it is unset the
// module does the work anyway and SAYS the rule was not applied — an attempt
// against no pass mark is recorded UNGRADED, never passed against a threshold
// nobody approved.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { assertCan, assertCanAnywhere, type Action } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any;

export class AcademyError extends Error {
  readonly code: string;
  /** Machine-readable evidence for the caller — never a prose blob to re-parse. */
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'AcademyError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A rule the federation has not configured.
 *
 * Returned rather than thrown, and never replaced by a default. Callers render
 * it; they must not silently treat `configured: false` as "rule satisfied".
 */
export interface PolicyNote {
  rule: string;
  configured: boolean;
  /** The configured value, or null when MMAKF has set none. */
  value: number | null;
  detail: string;
}

/**
 * Thresholds the federation supplies. There is no settings table for these yet
 * (see the schema note at the foot of this file), so they arrive as an explicit
 * argument from whatever layer holds configuration. The default is NOT a
 * default policy — it is the absence of one.
 */
export interface AcademyPolicy {
  /** Seconds of a live class that count as attendance. Null = MMAKF has set none. */
  liveAttendanceMinSeconds?: number | null;
  /** Seconds of a video lesson required before completion. Null = MMAKF has set none. */
  lessonWatchMinSeconds?: number | null;
}

const NO_POLICY: AcademyPolicy = {};

// ─── Actor identity ─────────────────────────────────────────────────────────

async function actorPersonId(db: DB, ctx: AuditContext): Promise<number | null> {
  const userId = ctx.principal?.userId;
  if (userId == null) return null;
  const row = (await db.select({ personId: s.users.personId })
    .from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  return row?.personId ?? null;
}

/**
 * A learner may act on their own learning record; anyone else needs authority
 * over that person's scope.
 *
 * Gating this on `content:write` would let a content editor mark someone else's
 * lessons complete and start their quiz attempts, which is why the
 * administrative fallback is a PERSON permission, not a content one.
 */
async function assertSelfOrAuthority(
  db: DB,
  ctx: AuditContext,
  person: { id: number; stateUnitId: number | null; districtUnitId: number | null; dojoId: number | null },
  action: Action = 'person:write'
): Promise<'self' | 'authority'> {
  const self = await actorPersonId(db, ctx);
  if (self != null && self === person.id) return 'self';
  assertCan(ctx.principal, action, {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });
  return 'authority';
}

async function loadPerson(db: DB, personId: number) {
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new AcademyError('unknown_person', 'Unknown person');
  return person;
}

async function loadCourse(db: DB, courseId: number) {
  const course = (await db.select().from(s.courses).where(eq(s.courses.id, courseId)).limit(1))[0];
  if (!course) throw new AcademyError('unknown_course', 'Unknown course');
  return course;
}

/**
 * Structural edits stop at publication.
 *
 * Appending a lesson to a live course silently changes what every enrolled
 * student must finish, and would retroactively un-complete people who had
 * already finished. Withdraw the course, revise it, publish again — so the
 * change is visible instead of arriving under everyone's feet.
 */
function assertEditable(course: { id: number; status: string }) {
  if (course.status !== 'draft' && course.status !== 'review') {
    throw new AcademyError(
      'course_not_editable',
      `This course is ${course.status}. Withdraw it before changing its structure, so enrolled students are not silently given new requirements.`
    );
  }
}

// ─── Lesson availability ────────────────────────────────────────────────────

/** Media that is not federation teaching content, whatever its `published` flag says. */
const NON_TEACHING_CLASSES = new Set(['pending_review', 'rejected', 'personal']);

export interface LessonAvailability {
  lessonId: number;
  title: string;
  kind: string;
  available: boolean;
  /** Always populated — an available lesson says why it is available too. */
  reason: string;
  /** True when this would make a published course lie about what it contains. */
  blocksPublication: boolean;
}

/**
 * Decide, for each lesson, whether the thing it promises actually exists.
 *
 * Batched deliberately: the course player calls this for every lesson on every
 * page load, and a per-lesson round trip is how a fifty-lesson course becomes a
 * hundred queries.
 */
async function lessonAvailabilityMap(db: DB, lessonRows: any[]): Promise<Map<number, LessonAvailability>> {
  const assetIds = [...new Set(lessonRows.map((l) => l.mediaAssetId).filter((x): x is number => x != null))];
  const classIds = [...new Set(lessonRows.map((l) => l.liveClassId).filter((x): x is number => x != null))];
  const lessonIds = lessonRows.map((l) => l.id);

  const assets = assetIds.length
    ? await db.select().from(s.mediaAssets).where(inArray(s.mediaAssets.id, assetIds))
    : [];
  const classes = classIds.length
    ? await db.select().from(s.liveClasses).where(inArray(s.liveClasses.id, classIds))
    : [];
  const quizRows = lessonIds.length
    ? await db.select().from(s.quizzes).where(inArray(s.quizzes.lessonId, lessonIds))
    : [];
  const quizIds = quizRows.map((q: any) => q.id);
  const questionCounts = quizIds.length
    ? await db.select({ quizId: s.quizQuestions.quizId, n: sql<number>`count(*)::int` })
        .from(s.quizQuestions).where(inArray(s.quizQuestions.quizId, quizIds))
        .groupBy(s.quizQuestions.quizId)
    : [];

  const assetById = new Map<number, any>(assets.map((a: any) => [a.id, a]));
  const classById = new Map<number, any>(classes.map((c: any) => [c.id, c]));
  const quizByLesson = new Map<number, any>(quizRows.map((q: any) => [q.lessonId, q]));
  const countByQuiz = new Map<number, number>(questionCounts.map((r: any) => [r.quizId, Number(r.n)]));

  const out = new Map<number, LessonAvailability>();
  for (const l of lessonRows) {
    let available = true;
    let reason = 'available';
    let blocks = false;

    if (l.mediaAssetId != null && !assetById.has(l.mediaAssetId)) {
      available = false;
      blocks = true;
      reason = 'the media asset this lesson points at no longer exists';
    } else if (l.liveClassId != null && !classById.has(l.liveClassId)) {
      available = false;
      blocks = true;
      reason = 'the live class this lesson points at no longer exists';
    } else if (l.kind === 'video') {
      const asset = l.mediaAssetId == null ? null : assetById.get(l.mediaAssetId);
      if (!asset) {
        available = false;
        blocks = true;
        reason = 'no media asset is linked to this video lesson';
      } else if (!asset.published) {
        available = false;
        blocks = true;
        reason = 'the linked video has not been published by the federation';
      } else if (NON_TEACHING_CLASSES.has(asset.classification)) {
        available = false;
        blocks = true;
        reason = `the linked video is classified ${asset.classification} and is not federation teaching content`;
      } else {
        reason = `linked to published media asset ${asset.id}`;
      }
    } else if (l.kind === 'quiz') {
      const quiz = quizByLesson.get(l.id);
      if (!quiz) {
        available = false;
        blocks = true;
        reason = 'no quiz has been written for this quiz lesson';
      } else if ((countByQuiz.get(quiz.id) ?? 0) === 0) {
        available = false;
        blocks = true;
        reason = 'the quiz attached to this lesson has no questions';
      } else {
        reason = `quiz ${quiz.id} with ${countByQuiz.get(quiz.id)} question(s)`;
      }
    } else if (l.kind === 'reading') {
      if (!l.body || !String(l.body).trim()) {
        available = false;
        blocks = true;
        reason = 'this reading lesson has no text';
      }
    } else if (l.kind === 'live_class') {
      if (l.liveClassId == null) {
        // Not a publication blocker: a course may legitimately go live before
        // its sessions are scheduled. It is still not something to open.
        available = false;
        reason = 'no live class has been scheduled for this lesson yet';
      } else {
        const cls = classById.get(l.liveClassId);
        reason = `live class ${cls.code} is ${cls.status}`;
        if (cls.status === 'cancelled') {
          available = false;
          reason = 'this live class was cancelled';
        }
      }
    }

    out.set(l.id, { lessonId: l.id, title: l.title, kind: l.kind, available, reason, blocksPublication: blocks });
  }
  return out;
}

// ─── Authoring ──────────────────────────────────────────────────────────────

export interface CreateCourseInput {
  slug: string;
  title: string;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  level?: string | null;
  coverImageUrl?: string | null;
  feeCode?: string | null;
  leadTeacherPersonId?: number | null;
  estimatedHours?: number | null;
  certificateOnCompletion?: boolean;
  /** MMAKF's course-level pass mark. Omit when the federation has not set one. */
  passMarkPercent?: number | null;
  // `hasFreePreview` is absent from this type ON PURPOSE. It is derived at
  // publication from whether an accessible preview lesson exists; accepting it
  // as input is how a course ends up advertising a preview that opens on
  // nothing.
}

export async function createCourse(db: DB, ctx: AuditContext, input: CreateCourseInput) {
  assertCanAnywhere(ctx.principal, 'content:write');

  const slug = input.slug?.trim().toLowerCase();
  if (!slug) throw new AcademyError('slug_required', 'A course needs a slug.');
  if (!input.title?.trim()) throw new AcademyError('title_required', 'A course needs a title.');
  if (input.passMarkPercent != null &&
      (!Number.isInteger(input.passMarkPercent) || input.passMarkPercent < 0 || input.passMarkPercent > 100)) {
    throw new AcademyError('bad_pass_mark', 'A pass mark is a whole percentage between 0 and 100.');
  }

  let row;
  try {
    [row] = await db.insert(s.courses).values({
      slug,
      title: input.title.trim(),
      summary: input.summary ?? null,
      description: input.description ?? null,
      category: input.category ?? null,
      level: input.level ?? null,
      coverImageUrl: input.coverImageUrl ?? null,
      feeCode: input.feeCode ?? null,
      leadTeacherPersonId: input.leadTeacherPersonId ?? null,
      estimatedHours: input.estimatedHours ?? null,
      certificateOnCompletion: input.certificateOnCompletion ?? false,
      passMarkPercent: input.passMarkPercent ?? null,
      status: 'draft',
      hasFreePreview: false,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AcademyError('slug_taken', 'A course with that slug already exists.');
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'course', entityId: row.id, action: 'create',
    newValue: { slug, title: row.title, certificateOnCompletion: row.certificateOnCompletion },
  });
  return row;
}

export async function addModule(
  db: DB,
  ctx: AuditContext,
  input: { courseId: number; title: string; summary?: string | null; displayOrder?: number }
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  const course = await loadCourse(db, input.courseId);
  assertEditable(course);
  if (!input.title?.trim()) throw new AcademyError('title_required', 'A module needs a title.');

  const [row] = await db.insert(s.courseModules).values({
    courseId: course.id,
    title: input.title.trim(),
    summary: input.summary ?? null,
    displayOrder: input.displayOrder ?? 0,
  }).returning();
  return row;
}

export interface AddLessonInput {
  moduleId: number;
  title: string;
  kind: 'video' | 'live_class' | 'reading' | 'quiz' | 'assignment' | 'practical' | 'assessment';
  body?: string | null;
  mediaAssetId?: number | null;
  liveClassId?: number | null;
  durationMinutes?: number | null;
  isPreview?: boolean;
  displayOrder?: number;
}

/**
 * Add a lesson.
 *
 * EVERY LESSON IS REQUIRED. The schema carries no way to mark one optional, and
 * inventing "optional means not a preview" (or any other guess) would change
 * what a completion certificate means. If MMAKF wants optional lessons the
 * schema needs a column for it; until then completion means all of them.
 */
export async function addLesson(db: DB, ctx: AuditContext, input: AddLessonInput) {
  assertCanAnywhere(ctx.principal, 'content:write');

  const mod = (await db.select().from(s.courseModules)
    .where(eq(s.courseModules.id, input.moduleId)).limit(1))[0];
  if (!mod) throw new AcademyError('unknown_module', 'Unknown module');
  const course = await loadCourse(db, mod.courseId);
  assertEditable(course);
  if (!input.title?.trim()) throw new AcademyError('title_required', 'A lesson needs a title.');

  // Fail at authoring rather than at publication where we can: a dangling
  // pointer caught here names the lesson being written, not one of fifty.
  if (input.mediaAssetId != null) {
    const asset = (await db.select({ id: s.mediaAssets.id }).from(s.mediaAssets)
      .where(eq(s.mediaAssets.id, input.mediaAssetId)).limit(1))[0];
    if (!asset) throw new AcademyError('unknown_media_asset', 'Unknown media asset.');
  }
  if (input.liveClassId != null) {
    const cls = (await db.select({ id: s.liveClasses.id }).from(s.liveClasses)
      .where(eq(s.liveClasses.id, input.liveClassId)).limit(1))[0];
    if (!cls) throw new AcademyError('unknown_live_class', 'Unknown live class.');
  }

  const [row] = await db.insert(s.lessons).values({
    moduleId: mod.id,
    courseId: course.id,
    title: input.title.trim(),
    kind: input.kind,
    body: input.body ?? null,
    mediaAssetId: input.mediaAssetId ?? null,
    liveClassId: input.liveClassId ?? null,
    durationMinutes: input.durationMinutes ?? null,
    isPreview: input.isPreview ?? false,
    displayOrder: input.displayOrder ?? 0,
  }).returning();
  return row;
}

export interface AddQuizInput {
  courseId: number;
  lessonId?: number | null;
  title: string;
  /**
   * MMAKF's pass mark for this quiz. Pass null — or omit it — when the
   * federation has not set one; attempts are then recorded UNGRADED.
   */
  passMarkPercent?: number | null;
  /** Null = MMAKF has set no limit. */
  attemptsAllowed?: number | null;
  timeLimitMinutes?: number | null;
}

export async function addQuiz(db: DB, ctx: AuditContext, input: AddQuizInput) {
  assertCanAnywhere(ctx.principal, 'content:write');
  const course = await loadCourse(db, input.courseId);
  assertEditable(course);

  if (input.passMarkPercent != null &&
      (!Number.isInteger(input.passMarkPercent) || input.passMarkPercent < 0 || input.passMarkPercent > 100)) {
    throw new AcademyError('bad_pass_mark', 'A pass mark is a whole percentage between 0 and 100.');
  }
  if (input.attemptsAllowed != null &&
      (!Number.isInteger(input.attemptsAllowed) || input.attemptsAllowed < 1)) {
    throw new AcademyError('bad_attempts_allowed', 'An attempt limit must be a whole number of at least 1.');
  }
  if (input.lessonId != null) {
    const lesson = (await db.select().from(s.lessons).where(eq(s.lessons.id, input.lessonId)).limit(1))[0];
    if (!lesson) throw new AcademyError('unknown_lesson', 'Unknown lesson');
    if (lesson.courseId !== course.id) {
      throw new AcademyError('lesson_not_in_course', 'That lesson belongs to a different course.');
    }
  }

  try {
    const [row] = await db.insert(s.quizzes).values({
      courseId: course.id,
      lessonId: input.lessonId ?? null,
      title: input.title.trim(),
      // Written through unchanged, INCLUDING null. See the schema note at the
      // foot of this file: the column ships as NOT NULL DEFAULT 60, and 60 is
      // not a number MMAKF has approved.
      passMarkPercent: input.passMarkPercent ?? null,
      attemptsAllowed: input.attemptsAllowed ?? null,
      timeLimitMinutes: input.timeLimitMinutes ?? null,
    }).returning();
    return row;
  } catch (err: any) {
    if (isNotNullViolation(err, 'pass_mark_percent')) {
      throw new AcademyError(
        'pass_mark_not_storable',
        'This database still forces quizzes.pass_mark_percent NOT NULL DEFAULT 60. Sixty per cent is not federation policy, so an unset pass mark cannot be recorded honestly. Drop the default and the NOT NULL before creating a quiz with no pass mark.'
      );
    }
    throw err;
  }
}

/** SQLSTATE 23502, walking the cause chain for the same reason isUniqueViolation() does. */
function isNotNullViolation(err: any, column: string): boolean {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    const message = String(e.message ?? '');
    if (e.code === '23502' && (e.column === column || message.includes(column))) return true;
    if (new RegExp(`null value in column "${column}"`, 'i').test(message)) return true;
  }
  return false;
}

export interface AddQuizQuestionInput {
  quizId: number;
  prompt: string;
  kind?: 'single' | 'multiple' | 'true_false' | 'text';
  /** Rendered choices. Anything beyond an id and a label is stripped — see below. */
  options?: Array<string | { id?: string | number; text: string; [k: string]: unknown }>;
  correctAnswer: unknown;
  explanation?: string | null;
  marks?: number;
  displayOrder?: number;
}

/**
 * Write a question.
 *
 * Options are NORMALISED to `{ id, text }` and nothing else. Authoring tools
 * habitually carry `correct: true` on the right option, and any such key would
 * travel to the browser inside `options` however carefully `correct_answer` is
 * excluded from the student read. Stripping at write time makes that leak
 * impossible rather than merely unlikely.
 */
export async function addQuizQuestion(db: DB, ctx: AuditContext, input: AddQuizQuestionInput) {
  assertCanAnywhere(ctx.principal, 'content:write');

  const quiz = (await db.select().from(s.quizzes).where(eq(s.quizzes.id, input.quizId)).limit(1))[0];
  if (!quiz) throw new AcademyError('unknown_quiz', 'Unknown quiz');
  const course = await loadCourse(db, quiz.courseId);
  assertEditable(course);

  if (!input.prompt?.trim()) throw new AcademyError('prompt_required', 'A question needs a prompt.');
  const marks = input.marks ?? 1;
  if (!Number.isInteger(marks) || marks < 1) {
    throw new AcademyError('bad_marks', 'Marks must be a whole number of at least 1.');
  }
  const kind = input.kind ?? 'single';
  if (input.correctAnswer == null ||
      (Array.isArray(input.correctAnswer) && input.correctAnswer.length === 0)) {
    // A question with no recorded answer cannot be marked, and a quiz that
    // cannot be marked must not look like one that can.
    throw new AcademyError('correct_answer_required', 'A question must record its correct answer.');
  }

  const options = (input.options ?? []).map((o, i) =>
    typeof o === 'string' ? { id: String(i + 1), text: o } : { id: String(o.id ?? i + 1), text: String(o.text) }
  );
  if ((kind === 'single' || kind === 'multiple') && options.length < 2) {
    throw new AcademyError('options_required', 'A choice question needs at least two options.');
  }

  const [row] = await db.insert(s.quizQuestions).values({
    quizId: quiz.id,
    prompt: input.prompt.trim(),
    kind,
    options: options.length ? options : null,
    correctAnswer: input.correctAnswer as any,
    explanation: input.explanation ?? null,
    marks,
    displayOrder: input.displayOrder ?? 0,
  }).returning();
  return row;
}

// ─── Publication ────────────────────────────────────────────────────────────

export interface PublishResult {
  courseId: number;
  status: string;
  /** Derived, never accepted as input. */
  hasFreePreview: boolean;
  lessons: LessonAvailability[];
}

/**
 * Publish a course.
 *
 * REFUSES while any lesson promises something that is not there — a video with
 * no asset, an asset that is unpublished or classified as anything other than
 * teaching content, a quiz with no questions, a dangling live class. The
 * federation publishes what it has, and a player opening on a dead embed is the
 * exact fake affordance this project forbids.
 *
 * `hasFreePreview` is computed here from whether a preview lesson is genuinely
 * openable, so the badge cannot outlive the video behind it.
 */
export async function publishCourse(
  db: DB,
  ctx: AuditContext,
  courseId: number,
  now: Date = new Date()
): Promise<PublishResult> {
  assertCanAnywhere(ctx.principal, 'content:write');
  const course = await loadCourse(db, courseId);
  if (course.status === 'published') {
    throw new AcademyError('already_published', 'This course is already published.');
  }

  const lessonRows = await db.select().from(s.lessons)
    .where(eq(s.lessons.courseId, courseId))
    .orderBy(asc(s.lessons.displayOrder), asc(s.lessons.id));
  if (lessonRows.length === 0) {
    throw new AcademyError('empty_course', 'A course with no lessons cannot be published.');
  }

  const availability = await lessonAvailabilityMap(db, lessonRows);
  const all: LessonAvailability[] = lessonRows.map((l: any) => availability.get(l.id)!);
  const blockers = all.filter((a) => a.blocksPublication);
  if (blockers.length) {
    throw new AcademyError(
      'unpublishable_lessons',
      `${blockers.length} lesson(s) cannot be published: ${blockers.map((b: any) => `"${b.title}" — ${b.reason}`).join('; ')}.`,
      blockers
    );
  }

  const hasFreePreview = lessonRows.some((l: any) => l.isPreview && availability.get(l.id)!.available);

  const [row] = await db.update(s.courses).set({
    status: 'published',
    publishedAt: now,
    hasFreePreview,
  }).where(eq(s.courses.id, courseId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'course', entityId: courseId, action: 'approve',
    oldValue: { status: course.status, hasFreePreview: course.hasFreePreview },
    newValue: { status: 'published', hasFreePreview, lessons: lessonRows.length },
  });

  return { courseId, status: row.status, hasFreePreview, lessons: all };
}

/** Withdraw a published course so it can be revised. Enrolments are untouched. */
export async function withdrawCourse(db: DB, ctx: AuditContext, courseId: number, reason: string) {
  assertCanAnywhere(ctx.principal, 'content:write');
  if (!reason?.trim()) throw new AcademyError('reason_required', 'Withdrawing a course requires a reason.');
  const course = await loadCourse(db, courseId);

  const [row] = await db.update(s.courses).set({ status: 'draft', hasFreePreview: false })
    .where(eq(s.courses.id, courseId)).returning();
  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'course', entityId: courseId, action: 'update',
    oldValue: { status: course.status }, newValue: { status: 'draft' },
  });
  return row;
}

export interface CourseOutline {
  course: {
    id: number; slug: string; title: string; status: string;
    hasFreePreview: boolean; certificateOnCompletion: boolean;
  };
  modules: Array<{
    id: number; title: string; displayOrder: number;
    lessons: Array<LessonAvailability & { isPreview: boolean; durationMinutes: number | null; displayOrder: number }>;
  }>;
  totalLessons: number;
}

/**
 * The course structure with each lesson's real availability attached.
 *
 * The player renders `available: false` as "not available yet" with the reason,
 * rather than as a control that does nothing.
 */
export async function courseOutline(db: DB, ctx: AuditContext, courseId: number): Promise<CourseOutline> {
  const course = await loadCourse(db, courseId);
  // A draft is not public: seeing an unpublished syllabus is an editorial
  // privilege, not a reader's.
  if (course.status !== 'published') assertCanAnywhere(ctx.principal, 'content:write');

  const modules = await db.select().from(s.courseModules)
    .where(eq(s.courseModules.courseId, courseId))
    .orderBy(asc(s.courseModules.displayOrder), asc(s.courseModules.id));
  const lessonRows = await db.select().from(s.lessons)
    .where(eq(s.lessons.courseId, courseId))
    .orderBy(asc(s.lessons.displayOrder), asc(s.lessons.id));
  const availability = await lessonAvailabilityMap(db, lessonRows);

  return {
    course: {
      id: course.id, slug: course.slug, title: course.title, status: course.status,
      hasFreePreview: course.hasFreePreview, certificateOnCompletion: course.certificateOnCompletion,
    },
    modules: modules.map((m: any) => ({
      id: m.id, title: m.title, displayOrder: m.displayOrder,
      lessons: lessonRows.filter((l: any) => l.moduleId === m.id).map((l: any) => ({
        ...availability.get(l.id)!,
        isPreview: l.isPreview,
        durationMinutes: l.durationMinutes,
        displayOrder: l.displayOrder,
      })),
    })),
    totalLessons: lessonRows.length,
  };
}

// ─── Enrolment ──────────────────────────────────────────────────────────────

export async function enrol(
  db: DB,
  ctx: AuditContext,
  input: {
    courseId: number; personId: number; orderId?: number | null;
    status?: 'pending_payment' | 'active'; expiresAt?: Date | null;
  },
  now: Date = new Date()
) {
  const person = await loadPerson(db, input.personId);
  const actedBy = await assertSelfOrAuthority(db, ctx, person);

  const course = await loadCourse(db, input.courseId);
  if (course.status !== 'published') {
    throw new AcademyError('course_not_published', 'This course is not published, so nobody can be enrolled on it.');
  }

  let row;
  try {
    [row] = await db.insert(s.enrolments).values({
      courseId: course.id,
      personId: person.id,
      // A fee-bearing course starts unpaid: only confirmPayment() in
      // src/db/orders.ts may decide that money arrived, and nothing here may
      // assume it did.
      status: input.status ?? (course.feeCode ? 'pending_payment' : 'active'),
      orderId: input.orderId ?? null,
      enrolledAt: now,
      expiresAt: input.expiresAt ?? null,
      progressPercent: 0,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AcademyError('already_enrolled', 'This person is already enrolled on this course.');
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'enrolment', entityId: row.id, action: 'create',
    newValue: { courseId: course.id, personId: person.id, status: row.status, actedBy },
  });
  return row;
}

async function loadEnrolment(db: DB, enrolmentId: number) {
  const row = (await db.select().from(s.enrolments).where(eq(s.enrolments.id, enrolmentId)).limit(1))[0];
  if (!row) throw new AcademyError('unknown_enrolment', 'Unknown enrolment');
  return row;
}

/** Activate an enrolment once payment is confirmed elsewhere. */
export async function activateEnrolment(db: DB, ctx: AuditContext, enrolmentId: number) {
  assertCanAnywhere(ctx.principal, 'content:write');
  const enrolment = await loadEnrolment(db, enrolmentId);
  if (enrolment.status === 'active') return enrolment;
  if (enrolment.status !== 'pending_payment') {
    throw new AcademyError('enrolment_not_pending', `This enrolment is ${enrolment.status}.`);
  }
  const [row] = await db.update(s.enrolments).set({ status: 'active' })
    .where(eq(s.enrolments.id, enrolmentId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'enrolment', entityId: enrolmentId, action: 'update',
    oldValue: { status: enrolment.status }, newValue: { status: 'active' },
  });
  return row;
}

function assertLearnable(enrolment: { status: string }) {
  if (enrolment.status !== 'active') {
    throw new AcademyError(
      'enrolment_not_active',
      `This enrolment is ${enrolment.status.replace(/_/g, ' ')}, so learning cannot be recorded against it.`
    );
  }
}

// ─── Progress ───────────────────────────────────────────────────────────────

const PROGRESS_IS_NOT_PROFICIENCY =
  'Completion records that this lesson was marked done. It is not an assessment, not a grade, and it confers no rank.';

export interface LessonCompletionResult {
  progress: any;
  watchTime: {
    reportedSeconds: number;
    lessonDurationSeconds: number | null;
    minimum: PolicyNote;
  };
  /** Repeated at the point of use so nobody reads a completion as a grade. */
  note: string;
}

/**
 * Mark a lesson complete, carrying the watch-time signal for video lessons.
 *
 * THE MINIMUM WATCH TIME IS FEDERATION CONFIGURATION. When none is supplied the
 * completion is recorded AS CLAIMED and the result says the rule was not
 * applied. Inventing "90% of the runtime" here would silently make every course
 * in the federation enforce a rule MMAKF never approved.
 *
 * Watch time only ever increases: a second visit that reports fewer seconds is
 * a shorter visit, not evidence that the first one did not happen.
 */
export async function markLessonComplete(
  db: DB,
  ctx: AuditContext,
  input: { enrolmentId: number; lessonId: number; watchedSeconds?: number },
  policy: AcademyPolicy = NO_POLICY,
  now: Date = new Date()
): Promise<LessonCompletionResult> {
  const enrolment = await loadEnrolment(db, input.enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  const actedBy = await assertSelfOrAuthority(db, ctx, person);
  assertLearnable(enrolment);

  const lesson = (await db.select().from(s.lessons).where(eq(s.lessons.id, input.lessonId)).limit(1))[0];
  if (!lesson) throw new AcademyError('unknown_lesson', 'Unknown lesson');
  // Knowing a lesson id is never enough: it must belong to the course this
  // enrolment is for.
  if (lesson.courseId !== enrolment.courseId) {
    throw new AcademyError('lesson_not_in_course', 'That lesson does not belong to the course this enrolment is for.');
  }

  const availability = (await lessonAvailabilityMap(db, [lesson])).get(lesson.id)!;
  if (!availability.available) {
    throw new AcademyError('lesson_unavailable', `This lesson cannot be completed: ${availability.reason}.`);
  }

  const reported = Math.max(0, Math.trunc(input.watchedSeconds ?? 0));
  const min = policy.lessonWatchMinSeconds ?? null;
  const minimum: PolicyNote = min == null
    ? {
        rule: 'lesson_minimum_watch_seconds',
        configured: false,
        value: null,
        detail: 'MMAKF has set no minimum watch time, so none was applied and completion is recorded as claimed.',
      }
    : {
        rule: 'lesson_minimum_watch_seconds',
        configured: true,
        value: min,
        detail: `${reported}s reported against a configured minimum of ${min}s.`,
      };

  if (lesson.kind === 'video' && min != null && reported < min) {
    throw new AcademyError(
      'watch_time_below_minimum',
      `This lesson requires ${min}s of viewing; ${reported}s were reported.`
    );
  }

  const existing = (await db.select().from(s.lessonProgress).where(and(
    eq(s.lessonProgress.enrolmentId, enrolment.id),
    eq(s.lessonProgress.lessonId, lesson.id)
  )).limit(1))[0];

  let progress;
  if (existing) {
    [progress] = await db.update(s.lessonProgress).set({
      status: 'completed',
      watchedSeconds: Math.max(existing.watchedSeconds ?? 0, reported),
      completedAt: existing.completedAt ?? now,
      lastAccessedAt: now,
    }).where(eq(s.lessonProgress.id, existing.id)).returning();
  } else {
    [progress] = await db.insert(s.lessonProgress).values({
      enrolmentId: enrolment.id,
      lessonId: lesson.id,
      status: 'completed',
      watchedSeconds: reported,
      completedAt: now,
      lastAccessedAt: now,
    }).returning();
  }

  await refreshStoredProgress(db, enrolment.id, enrolment.courseId);

  // Self-service learning is not an auditable act; someone ELSE altering your
  // learning record is.
  if (actedBy === 'authority') {
    await writeAudit(db, ctx, {
      entityType: 'lesson_progress', entityId: progress.id, action: 'update',
      newValue: {
        enrolmentId: enrolment.id, lessonId: lesson.id,
        status: 'completed', onBehalfOfPersonId: person.id,
      },
    });
  }

  return {
    progress,
    watchTime: {
      reportedSeconds: progress.watchedSeconds,
      lessonDurationSeconds: lesson.durationMinutes == null ? null : lesson.durationMinutes * 60,
      minimum,
    },
    note: PROGRESS_IS_NOT_PROFICIENCY,
  };
}

/**
 * Keep `enrolments.progress_percent` in step for consumers that read the row
 * directly.
 *
 * It is a CACHE. Nothing in this module ever reads it back — every answer given
 * here is derived from the lesson_progress rows — because a stored percentage
 * drifts the moment a lesson is added or a completion corrected.
 */
async function refreshStoredProgress(db: DB, enrolmentId: number, courseId: number): Promise<void> {
  const derived = await deriveProgress(db, enrolmentId, courseId);
  await db.update(s.enrolments).set({ progressPercent: derived.progressPercent })
    .where(eq(s.enrolments.id, enrolmentId));
}

interface DerivedLesson {
  lessonId: number;
  title: string;
  kind: string;
  /** Every lesson is required — the schema offers no way to mark one optional. */
  required: true;
  completed: boolean;
  watchedSeconds: number;
  completedAt: Date | null;
}

async function deriveProgress(db: DB, enrolmentId: number, courseId: number) {
  const lessonRows = await db.select().from(s.lessons)
    .where(eq(s.lessons.courseId, courseId))
    .orderBy(asc(s.lessons.displayOrder), asc(s.lessons.id));
  const progressRows = await db.select().from(s.lessonProgress)
    .where(eq(s.lessonProgress.enrolmentId, enrolmentId));
  const byLesson = new Map<number, any>(progressRows.map((p: any) => [p.lessonId, p]));

  const lessons: DerivedLesson[] = lessonRows.map((l: any) => {
    const p = byLesson.get(l.id);
    return {
      lessonId: l.id as number,
      title: l.title as string,
      kind: l.kind as string,
      /** Every lesson is required — the schema offers no way to mark one optional. */
      required: true as const,
      completed: p?.status === 'completed',
      watchedSeconds: (p?.watchedSeconds ?? 0) as number,
      completedAt: p?.completedAt ?? null,
    };
  });
  const completedLessons = lessons.filter((l) => l.completed).length;

  return {
    lessons,
    totalLessons: lessons.length,
    completedLessons,
    // Integer percent, derived here and nowhere else.
    progressPercent: lessons.length === 0 ? 0 : Math.round((completedLessons / lessons.length) * 100),
  };
}

function passMarkNote(quiz: { passMarkPercent: number | null }): PolicyNote {
  return quiz.passMarkPercent == null
    ? {
        rule: 'quiz_pass_mark_percent',
        configured: false,
        value: null,
        detail: 'MMAKF has set no pass mark for this quiz, so attempts are recorded UNGRADED rather than passed or failed.',
      }
    : {
        rule: 'quiz_pass_mark_percent',
        configured: true,
        value: quiz.passMarkPercent,
        detail: `${quiz.passMarkPercent}% is required to pass.`,
      };
}

function attemptLimitNote(quiz: { attemptsAllowed: number | null }): PolicyNote {
  return quiz.attemptsAllowed == null
    ? {
        rule: 'quiz_attempts_allowed',
        configured: false,
        value: null,
        detail: 'MMAKF has set no attempt limit for this quiz, so none is enforced.',
      }
    : {
        rule: 'quiz_attempts_allowed',
        configured: true,
        value: quiz.attemptsAllowed,
        detail: `${quiz.attemptsAllowed} attempt(s) are allowed.`,
      };
}

export interface QuizStanding {
  quizId: number;
  title: string;
  passMark: PolicyNote;
  attemptsUsed: number;
  attemptLimit: PolicyNote;
  bestScorePercent: number | null;
  /** True only against a configured pass mark. NULL means UNGRADED. */
  passed: boolean | null;
}

async function quizStandings(db: DB, courseId: number, enrolmentId: number): Promise<QuizStanding[]> {
  const quizzes = await db.select().from(s.quizzes).where(eq(s.quizzes.courseId, courseId));
  if (!quizzes.length) return [];
  const attempts = await db.select().from(s.quizAttempts)
    .where(eq(s.quizAttempts.enrolmentId, enrolmentId));

  return quizzes.map((q: any) => {
    const mine = attempts.filter((a: any) => a.quizId === q.id);
    const submitted = mine.filter((a: any) => a.submittedAt != null);
    const scores = submitted
      .map((a: any) => a.scorePercent)
      .filter((x: any): x is number => x != null);
    // NULL, not false, while nothing has been marked: an unmarked quiz has not
    // been failed.
    const passed = submitted.some((a: any) => a.passed === true)
      ? true
      : q.passMarkPercent == null || submitted.length === 0 ? null : false;
    return {
      quizId: q.id,
      title: q.title,
      passMark: passMarkNote(q),
      attemptsUsed: mine.length,
      attemptLimit: attemptLimitNote(q),
      bestScorePercent: scores.length ? Math.max(...scores) : null,
      passed,
    };
  });
}

export interface CourseProgressReport {
  enrolmentId: number;
  courseId: number;
  personId: number;
  status: string;
  totalLessons: number;
  completedLessons: number;
  /** DERIVED at read time. The stored column is a cache and is never read here. */
  progressPercent: number;
  lessons: Array<{
    lessonId: number; title: string; kind: string; required: true;
    completed: boolean; watchedSeconds: number;
  }>;
  quizzes: QuizStanding[];
  note: string;
}

export async function courseProgress(db: DB, ctx: AuditContext, enrolmentId: number): Promise<CourseProgressReport> {
  const enrolment = await loadEnrolment(db, enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  await assertSelfOrAuthority(db, ctx, person, 'person:read');

  const derived = await deriveProgress(db, enrolment.id, enrolment.courseId);
  return {
    enrolmentId: enrolment.id,
    courseId: enrolment.courseId,
    personId: enrolment.personId,
    status: enrolment.status,
    totalLessons: derived.totalLessons,
    completedLessons: derived.completedLessons,
    progressPercent: derived.progressPercent,
    lessons: derived.lessons,
    quizzes: await quizStandings(db, enrolment.courseId, enrolment.id),
    note: PROGRESS_IS_NOT_PROFICIENCY,
  };
}

// ─── Quizzes ────────────────────────────────────────────────────────────────

export interface StudentQuestion {
  id: number;
  prompt: string;
  kind: string;
  options: Array<{ id: string; text: string }> | null;
  marks: number;
  displayOrder: number;
}

export interface StudentQuizView {
  quiz: { id: number; title: string; timeLimitMinutes: number | null };
  passMark: PolicyNote;
  attemptLimit: PolicyNote;
  questions: StudentQuestion[];
}

async function loadQuizForEnrolment(db: DB, quizId: number, enrolment: { courseId: number }) {
  const quiz = (await db.select().from(s.quizzes).where(eq(s.quizzes.id, quizId)).limit(1))[0];
  if (!quiz) throw new AcademyError('unknown_quiz', 'Unknown quiz');
  if (quiz.courseId !== enrolment.courseId) {
    throw new AcademyError('quiz_not_in_course', 'That quiz belongs to a different course from this enrolment.');
  }
  return quiz;
}

/**
 * The quiz as a student may see it BEFORE submitting.
 *
 * The column list is explicit and exhaustive: `correctAnswer` and `explanation`
 * are never named, so no later widening of the questions table can leak them
 * through a `select()` that returns whatever happens to exist. This is the one
 * read in this module that must never become `db.select().from(quizQuestions)`.
 */
export async function quizForStudent(
  db: DB,
  ctx: AuditContext,
  input: { quizId: number; enrolmentId: number }
): Promise<StudentQuizView> {
  const enrolment = await loadEnrolment(db, input.enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  await assertSelfOrAuthority(db, ctx, person, 'person:read');

  const quiz = await loadQuizForEnrolment(db, input.quizId, enrolment);

  const questions: StudentQuestion[] = await db.select({
    id: s.quizQuestions.id,
    prompt: s.quizQuestions.prompt,
    kind: s.quizQuestions.kind,
    options: s.quizQuestions.options,
    marks: s.quizQuestions.marks,
    displayOrder: s.quizQuestions.displayOrder,
  }).from(s.quizQuestions)
    .where(eq(s.quizQuestions.quizId, quiz.id))
    .orderBy(asc(s.quizQuestions.displayOrder), asc(s.quizQuestions.id));

  return {
    quiz: { id: quiz.id, title: quiz.title, timeLimitMinutes: quiz.timeLimitMinutes },
    passMark: passMarkNote(quiz),
    attemptLimit: attemptLimitNote(quiz),
    questions,
  };
}

/**
 * Open an attempt.
 *
 * An unsubmitted attempt is RESUMED rather than duplicated — otherwise a
 * refreshed browser burns a candidate's attempts, which from the candidate's
 * side is indistinguishable from being cheated out of one.
 */
export async function startAttempt(
  db: DB,
  ctx: AuditContext,
  input: { quizId: number; enrolmentId: number },
  now: Date = new Date()
): Promise<StudentQuizView & { attempt: any; resumed: boolean }> {
  const enrolment = await loadEnrolment(db, input.enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  await assertSelfOrAuthority(db, ctx, person);
  assertLearnable(enrolment);

  const quiz = await loadQuizForEnrolment(db, input.quizId, enrolment);

  const questionCount = Number((await db.select({ n: sql<number>`count(*)::int` })
    .from(s.quizQuestions).where(eq(s.quizQuestions.quizId, quiz.id)))[0]?.n ?? 0);
  if (questionCount === 0) {
    throw new AcademyError('quiz_has_no_questions', 'This quiz has no questions, so it cannot be attempted.');
  }

  const prior = await db.select().from(s.quizAttempts).where(and(
    eq(s.quizAttempts.quizId, quiz.id),
    eq(s.quizAttempts.enrolmentId, enrolment.id)
  )).orderBy(desc(s.quizAttempts.attemptNo));

  const open = prior.find((a: any) => a.submittedAt == null);
  if (open) return { attempt: open, resumed: true, ...(await quizForStudent(db, ctx, input)) };

  if (quiz.attemptsAllowed != null && prior.length >= quiz.attemptsAllowed) {
    throw new AcademyError(
      'attempts_exhausted',
      `All ${quiz.attemptsAllowed} permitted attempt(s) at this quiz have been used.`
    );
  }

  const attemptNo = (prior[0]?.attemptNo ?? 0) + 1;
  let attempt;
  try {
    [attempt] = await db.insert(s.quizAttempts).values({
      quizId: quiz.id,
      enrolmentId: enrolment.id,
      personId: enrolment.personId,
      attemptNo,
      startedAt: now,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AcademyError('attempt_in_flight', 'Another attempt at this quiz was just opened. Reload and continue it.');
    }
    throw err;
  }

  return { attempt, resumed: false, ...(await quizForStudent(db, ctx, input)) };
}

/**
 * Compare a student's response with the recorded answer.
 *
 * Exact match after trimming and case folding, with multiple-choice compared as
 * a set. NO fuzzy matching and NO partial credit: both are marking policy, and
 * a marking rule invented here would change what every certificate means.
 */
function answersMatch(given: unknown, correct: unknown): boolean {
  const norm = (v: unknown): string =>
    Array.isArray(v)
      ? v.map((x) => String(x ?? '').trim().toLowerCase()).sort().join(' ')
      : String(v ?? '').trim().toLowerCase();
  const wanted = norm(correct);
  return wanted !== '' && norm(given) === wanted;
}

export type AttemptResult = 'passed' | 'failed' | 'ungraded';

export interface SubmitAttemptResult {
  attempt: any;
  scorePercent: number;
  marksAwarded: number;
  marksAvailable: number;
  result: AttemptResult;
  passMark: PolicyNote;
  ungradedReason: string | null;
  /** Null when MMAKF has set no time limit for this quiz. */
  withinTimeLimit: boolean | null;
}

/**
 * Submit and mark an attempt.
 *
 * THE PASS MARK COMES FROM THE QUIZ ROW. Where MMAKF has set none the score is
 * still computed and stored — the work happened and the candidate is owed the
 * number — but `passed` stays NULL and the result is UNGRADED. It is never
 * measured against a threshold this module chose.
 *
 * A quiz containing free-text questions is UNGRADED as a whole: this module
 * cannot mark prose, and marking it by string equality would fail candidates
 * over punctuation.
 *
 * The full marking breakdown is stored on the attempt, so a result queried
 * months later is reconstructible from the record instead of re-derived against
 * questions that may since have been rewritten.
 */
export async function submitAttempt(
  db: DB,
  ctx: AuditContext,
  input: { attemptId: number; responses: Record<string, unknown> },
  now: Date = new Date()
): Promise<SubmitAttemptResult> {
  const attempt = (await db.select().from(s.quizAttempts)
    .where(eq(s.quizAttempts.id, input.attemptId)).limit(1))[0];
  if (!attempt) throw new AcademyError('unknown_attempt', 'Unknown quiz attempt');
  if (attempt.submittedAt) throw new AcademyError('already_submitted', 'This attempt has already been submitted.');

  const enrolment = await loadEnrolment(db, attempt.enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  await assertSelfOrAuthority(db, ctx, person);

  const quiz = (await db.select().from(s.quizzes).where(eq(s.quizzes.id, attempt.quizId)).limit(1))[0];
  const questions = await db.select().from(s.quizQuestions)
    .where(eq(s.quizQuestions.quizId, quiz.id))
    .orderBy(asc(s.quizQuestions.displayOrder), asc(s.quizQuestions.id));

  const responses = input.responses ?? {};
  const marking = questions.map((q: any) => {
    const given = responses[String(q.id)];
    // A free-text answer is not machine-markable. `correct: null` says so and
    // makes the whole attempt UNGRADED below, rather than scoring 0.
    const correct = q.kind === 'text' ? null : answersMatch(given, q.correctAnswer);
    return {
      questionId: q.id as number,
      kind: q.kind as string,
      marks: q.marks as number,
      awarded: correct === true ? (q.marks as number) : 0,
      correct,
      answered: given !== undefined,
    };
  });

  const marksAvailable = marking.reduce((n: number, m: any) => n + m.marks, 0);
  const marksAwarded = marking.reduce((n: number, m: any) => n + m.awarded, 0);
  const scorePercent = marksAvailable > 0 ? Math.round((marksAwarded / marksAvailable) * 100) : 0;

  const needsHumanMarking = marking.some((m: any) => m.correct === null);
  const passMark = passMarkNote(quiz);

  let result: AttemptResult;
  let ungradedReason: string | null = null;
  if (needsHumanMarking) {
    result = 'ungraded';
    ungradedReason = 'This quiz contains free-text answers, which this module does not mark. An examiner must mark it.';
  } else if (!passMark.configured) {
    result = 'ungraded';
    ungradedReason = passMark.detail;
  } else {
    result = scorePercent >= (passMark.value as number) ? 'passed' : 'failed';
  }

  const withinTimeLimit = quiz.timeLimitMinutes == null
    ? null
    : (now.getTime() - new Date(attempt.startedAt).getTime()) <= quiz.timeLimitMinutes * 60_000;

  const [row] = await db.update(s.quizAttempts).set({
    submittedAt: now,
    scorePercent,
    // NULL is the honest value for an unmarked attempt. `false` would read as a
    // fail the federation never declared.
    passed: result === 'ungraded' ? null : result === 'passed',
    answers: {
      responses,
      marking,
      marksAwarded,
      marksAvailable,
      scorePercent,
      passMark: { configured: passMark.configured, value: passMark.value },
      result,
      ungradedReason,
      timing: {
        startedAt: new Date(attempt.startedAt).toISOString(),
        submittedAt: now.toISOString(),
        timeLimitMinutes: quiz.timeLimitMinutes ?? null,
        withinTimeLimit,
      },
    },
  }).where(eq(s.quizAttempts.id, attempt.id)).returning();

  return {
    attempt: row, scorePercent, marksAwarded, marksAvailable,
    result, passMark, ungradedReason, withinTimeLimit,
  };
}

/**
 * The marked attempt, with correct answers and explanations.
 *
 * Only ever after submission. It is a SEPARATE FUNCTION from
 * `quizForStudent()`, not the same read with a flag, because a flag defaulting
 * the wrong way hands out the answer key mid-attempt.
 */
export async function attemptResult(db: DB, ctx: AuditContext, attemptId: number) {
  const attempt = (await db.select().from(s.quizAttempts)
    .where(eq(s.quizAttempts.id, attemptId)).limit(1))[0];
  if (!attempt) throw new AcademyError('unknown_attempt', 'Unknown quiz attempt');

  const enrolment = await loadEnrolment(db, attempt.enrolmentId);
  const person = await loadPerson(db, enrolment.personId);
  await assertSelfOrAuthority(db, ctx, person, 'person:read');

  if (!attempt.submittedAt) {
    throw new AcademyError('not_submitted', 'This attempt has not been submitted, so it has no result.');
  }

  const questions = await db.select().from(s.quizQuestions)
    .where(eq(s.quizQuestions.quizId, attempt.quizId))
    .orderBy(asc(s.quizQuestions.displayOrder), asc(s.quizQuestions.id));
  const stored = (attempt.answers ?? {}) as Record<string, any>;

  return {
    attempt,
    result: (stored.result ?? 'ungraded') as AttemptResult,
    scorePercent: attempt.scorePercent,
    passed: attempt.passed,
    questions: questions.map((q: any) => ({
      id: q.id,
      prompt: q.prompt,
      kind: q.kind,
      options: q.options,
      marks: q.marks,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      given: stored.responses?.[String(q.id)] ?? null,
      correct: (stored.marking ?? []).find((m: any) => m.questionId === q.id)?.correct ?? null,
    })),
  };
}

// ─── Completion and certificate ─────────────────────────────────────────────

export interface CompletionCheck {
  complete: boolean;
  /** Every rule checked, whether it passed and the value it saw. */
  checks: Array<{ rule: string; passed: boolean; detail: string }>;
  reasons: string[];
}

/**
 * Is this enrolment genuinely finished?
 *
 * Every lesson complete AND every quiz passed against a CONFIGURED pass mark. A
 * quiz with no pass mark can never be passed, so a course carrying one can
 * never complete — and this says exactly that, rather than waving the quiz
 * through. It is the fail-closed reading, and the alternative is a certificate
 * resting on an assessment nobody set a standard for.
 */
export async function completionCheck(db: DB, enrolmentId: number): Promise<CompletionCheck> {
  const enrolment = await loadEnrolment(db, enrolmentId);
  const derived = await deriveProgress(db, enrolment.id, enrolment.courseId);
  const quizzes = await quizStandings(db, enrolment.courseId, enrolment.id);

  const checks: CompletionCheck['checks'] = [];
  const reasons: string[] = [];

  const lessonsDone = derived.totalLessons > 0 && derived.completedLessons === derived.totalLessons;
  checks.push({
    rule: 'all_lessons_complete',
    passed: lessonsDone,
    detail: `${derived.completedLessons} of ${derived.totalLessons} lesson(s) complete`,
  });
  if (!lessonsDone) {
    reasons.push(derived.totalLessons === 0
      ? 'This course has no lessons.'
      : `${derived.totalLessons - derived.completedLessons} lesson(s) are not complete.`);
  }

  if (quizzes.length === 0) {
    checks.push({ rule: 'all_quizzes_passed', passed: true, detail: 'this course has no quizzes' });
  } else {
    for (const q of quizzes) {
      const passed = q.passed === true;
      checks.push({
        rule: 'quiz_passed',
        passed,
        detail: q.passMark.configured
          ? `"${q.title}": best ${q.bestScorePercent ?? 'no'}% against a pass mark of ${q.passMark.value}%`
          : `"${q.title}": ${q.passMark.detail}`,
      });
      if (!passed) {
        reasons.push(q.passMark.configured
          ? `The quiz "${q.title}" has not been passed.`
          : `The quiz "${q.title}" has no pass mark set by the federation, so it cannot be passed and this course cannot be completed until one is set.`);
      }
    }
  }

  return { complete: reasons.length === 0, checks, reasons };
}

export interface CompleteEnrolmentResult {
  enrolment: any;
  completion: CompletionCheck;
  certificate: any | null;
  issued: boolean;
  alreadyIssued: boolean;
  note: string;
}

/**
 * Complete an enrolment and, where the course is configured for it, issue the
 * certificate.
 *
 * Three independent conditions, all required: the course says
 * `certificateOnCompletion`, every lesson is complete, and every quiz is passed.
 * Idempotent — a retry returns the certificate already issued rather than
 * minting a second one for the same course.
 *
 * The certificate reuses the federation's `certificates` table so it verifies
 * through the same public endpoint as a grading certificate, and its snapshot
 * carries `provenance: 'course'` so nobody can mistake a course completion for
 * an examined grade. A COURSE CERTIFICATE CONFERS NO RANK: no rank_records row
 * is written here, deliberately.
 */
export async function completeEnrolment(
  db: DB,
  ctx: AuditContext,
  enrolmentId: number,
  now: Date = new Date()
): Promise<CompleteEnrolmentResult> {
  assertCanAnywhere(ctx.principal, 'certificate:issue');

  const enrolment = await loadEnrolment(db, enrolmentId);
  const course = await loadCourse(db, enrolment.courseId);
  const person = await loadPerson(db, enrolment.personId);

  if (enrolment.certificateId) {
    const existing = (await db.select().from(s.certificates)
      .where(eq(s.certificates.id, enrolment.certificateId)).limit(1))[0];
    if (existing) {
      return {
        enrolment,
        completion: await completionCheck(db, enrolmentId),
        certificate: existing,
        issued: false,
        alreadyIssued: true,
        note: 'This certificate had already been issued; it was not issued again.',
      };
    }
  }

  const completion = await completionCheck(db, enrolmentId);
  if (!completion.complete) {
    throw new AcademyError('not_complete', completion.reasons.join(' '), completion.checks);
  }

  const quizzes = await quizStandings(db, enrolment.courseId, enrolment.id);
  // An unweighted mean of the best attempts, and NOT a weighted formula: how
  // MMAKF weights one assessment against another is policy, and inventing a
  // weighting here would print an unapproved number on a certificate.
  const scored = quizzes.map((q) => q.bestScorePercent).filter((x): x is number => x != null);
  const finalScorePercent = scored.length
    ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
    : null;

  const completedOn = now.toISOString().slice(0, 10);
  const [updatedEnrolment] = await db.update(s.enrolments).set({
    status: 'completed',
    completedAt: now,
    finalScorePercent,
  }).where(eq(s.enrolments.id, enrolmentId)).returning();

  if (!course.certificateOnCompletion) {
    await writeAudit(db, ctx, {
      entityType: 'enrolment', entityId: enrolmentId, action: 'finalize',
      oldValue: { status: enrolment.status },
      newValue: { status: 'completed', certificate: null },
    });
    return {
      enrolment: updatedEnrolment,
      completion,
      certificate: null,
      issued: false,
      alreadyIssued: false,
      note: 'This course is not configured to award a certificate, so none was issued.',
    };
  }

  const certificateNo = await allocateFederationId(db, 'CERT', now.getFullYear());
  const [certificate] = await db.insert(s.certificates).values({
    certificateNo,
    kind: 'course_completion',
    personId: person.id,
    title: `${course.title} — Course Completion`,
    issuedOn: completedOn,
    validFrom: completedOn,
    issuingAuthority: 'Modern Martial Arts Karate-Do Federation of India',
    signedByPersonId: course.leadTeacherPersonId ?? null,
    status: 'issued',
    verifyToken: crypto.randomBytes(18).toString('base64url'),
    // Frozen at issue: a later course revision must not change what a document
    // already in someone's hands says they did.
    snapshot: {
      certificateNo,
      holder: person.fullName,
      federationId: person.federationId,
      course: { slug: course.slug, title: course.title },
      completedOn,
      lessonsCompleted: completion.checks.find((c) => c.rule === 'all_lessons_complete')?.detail ?? null,
      quizzes: quizzes.map((q) => ({
        title: q.title,
        bestScorePercent: q.bestScorePercent,
        passMarkPercent: q.passMark.value,
      })),
      finalScorePercent,
      issuedAt: now.toISOString(),
      // Distinguishes this from an examined grade at every verification. A
      // course completion is not a rank and never becomes one.
      provenance: 'course',
    },
  }).returning();

  await db.update(s.enrolments).set({ certificateId: certificate.id })
    .where(eq(s.enrolments.id, enrolmentId));

  await writeAudit(db, ctx, {
    entityType: 'certificate', entityId: certificate.id, action: 'create',
    newValue: { certificateNo, personId: person.id, courseId: course.id, provenance: 'course' },
  });

  return {
    enrolment: { ...updatedEnrolment, certificateId: certificate.id },
    completion,
    certificate,
    issued: true,
    alreadyIssued: false,
    note: 'A course completion certificate. It records study, not rank.',
  };
}

// ─── Live classroom ─────────────────────────────────────────────────────────

export async function scheduleLiveClass(
  db: DB,
  ctx: AuditContext,
  input: {
    title: string;
    summary?: string | null;
    teacherPersonId?: number | null;
    broadcastId?: number | null;
    courseId?: number | null;
    moduleId?: number | null;
    lessonId?: number | null;
    topic?: string | null;
    gradeRelevance?: string | null;
    scheduledStartAt?: Date | null;
    visibility?: 'public' | 'members' | 'course' | 'private';
    published?: boolean;
  },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  if (!input.title?.trim()) throw new AcademyError('title_required', 'A live class needs a title.');
  if (input.visibility === 'course' && input.courseId == null) {
    throw new AcademyError(
      'course_required',
      'A course-only class must name its course, or nobody can be checked against it.'
    );
  }

  const code = await allocateFederationId(db, 'LIVE', now.getFullYear());
  const [row] = await db.insert(s.liveClasses).values({
    code,
    broadcastId: input.broadcastId ?? null,
    title: input.title.trim(),
    summary: input.summary ?? null,
    teacherPersonId: input.teacherPersonId ?? null,
    courseId: input.courseId ?? null,
    moduleId: input.moduleId ?? null,
    lessonId: input.lessonId ?? null,
    topic: input.topic ?? null,
    gradeRelevance: input.gradeRelevance ?? null,
    status: 'upcoming',
    scheduledStartAt: input.scheduledStartAt ?? null,
    visibility: input.visibility ?? 'members',
    published: input.published ?? false,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'live_class', entityId: row.id, action: 'create',
    newValue: { code, title: row.title, visibility: row.visibility },
  });
  return row;
}

async function loadLiveClass(db: DB, liveClassId: number) {
  const row = (await db.select().from(s.liveClasses).where(eq(s.liveClasses.id, liveClassId)).limit(1))[0];
  if (!row) throw new AcademyError('unknown_live_class', 'Unknown live class');
  return row;
}

const ATTENDANCE_IS_NOT_PROFICIENCY =
  'Attendance records presence at a class. It is not an assessment, not a grade, and it confers no rank.';

export interface JoinLiveClassResult {
  attendance: any;
  threshold: PolicyNote;
  /** NULL when no threshold is configured — not false, which would read as a failure. */
  meetsThreshold: boolean | null;
  note: string;
}

/**
 * Record presence at a live class.
 *
 * THE ATTENDANCE THRESHOLD IS FEDERATION CONFIGURATION. When MMAKF has set
 * none, presence is recorded and the result SAYS no threshold is configured;
 * `meetsThreshold` is null, never a defaulted true or false. There is no "five
 * minutes" rule in this file and there must never be one — the moment a number
 * is invented here, every attendance register in the federation starts
 * enforcing a rule nobody approved.
 *
 * Watch time accumulates monotonically across rejoins, so a dropped connection
 * does not erase the first half of the class.
 */
export async function joinLiveClass(
  db: DB,
  ctx: AuditContext,
  input: { liveClassId: number; personId: number; watchedSeconds?: number; attendedLive?: boolean },
  policy: AcademyPolicy = NO_POLICY,
  now: Date = new Date()
): Promise<JoinLiveClassResult> {
  const person = await loadPerson(db, input.personId);
  await assertSelfOrAuthority(db, ctx, person);

  const cls = await loadLiveClass(db, input.liveClassId);
  if (cls.status === 'cancelled' || cls.status === 'missing') {
    throw new AcademyError(
      'class_not_available',
      `This class is ${cls.status}; attendance cannot be recorded against it.`
    );
  }
  if (cls.visibility === 'private') assertCanAnywhere(ctx.principal, 'content:write');
  if (cls.visibility === 'course') {
    const enrolled = (await db.select({ id: s.enrolments.id }).from(s.enrolments).where(and(
      eq(s.enrolments.courseId, cls.courseId as number),
      eq(s.enrolments.personId, person.id),
      inArray(s.enrolments.status, ['active', 'completed'])
    )).limit(1))[0];
    if (!enrolled) {
      throw new AcademyError('not_enrolled', 'This class is restricted to students enrolled on its course.');
    }
  }

  const reported = Math.max(0, Math.trunc(input.watchedSeconds ?? 0));
  const existing = (await db.select().from(s.liveClassAttendance).where(and(
    eq(s.liveClassAttendance.liveClassId, cls.id),
    eq(s.liveClassAttendance.personId, person.id)
  )).limit(1))[0];

  let attendance;
  if (existing) {
    [attendance] = await db.update(s.liveClassAttendance).set({
      watchedSeconds: Math.max(existing.watchedSeconds ?? 0, reported),
      attendedLive: existing.attendedLive || (input.attendedLive ?? cls.status === 'live'),
    }).where(eq(s.liveClassAttendance.id, existing.id)).returning();
  } else {
    [attendance] = await db.insert(s.liveClassAttendance).values({
      liveClassId: cls.id,
      personId: person.id,
      joinedAt: now,
      watchedSeconds: reported,
      attendedLive: input.attendedLive ?? cls.status === 'live',
    }).returning();
  }

  const min = policy.liveAttendanceMinSeconds ?? null;
  const threshold: PolicyNote = min == null
    ? {
        rule: 'live_attendance_min_seconds',
        configured: false,
        value: null,
        detail: 'MMAKF has set no attendance threshold for live classes, so none was applied. Presence is recorded as observed.',
      }
    : {
        rule: 'live_attendance_min_seconds',
        configured: true,
        value: min,
        detail: `${attendance.watchedSeconds}s watched against a configured threshold of ${min}s.`,
      };

  return {
    attendance,
    threshold,
    meetsThreshold: min == null ? null : attendance.watchedSeconds >= min,
    note: ATTENDANCE_IS_NOT_PROFICIENCY,
  };
}

/** Close an attendance record when the viewer leaves. */
export async function leaveLiveClass(
  db: DB,
  ctx: AuditContext,
  input: { liveClassId: number; personId: number; watchedSeconds?: number },
  now: Date = new Date()
) {
  const person = await loadPerson(db, input.personId);
  await assertSelfOrAuthority(db, ctx, person);

  const existing = (await db.select().from(s.liveClassAttendance).where(and(
    eq(s.liveClassAttendance.liveClassId, input.liveClassId),
    eq(s.liveClassAttendance.personId, person.id)
  )).limit(1))[0];
  if (!existing) {
    throw new AcademyError('not_attending', 'No attendance record exists for that person at this class.');
  }

  const [row] = await db.update(s.liveClassAttendance).set({
    leftAt: now,
    watchedSeconds: Math.max(existing.watchedSeconds ?? 0, Math.max(0, Math.trunc(input.watchedSeconds ?? 0))),
  }).where(eq(s.liveClassAttendance.id, existing.id)).returning();
  return row;
}

export interface AttendanceReport {
  liveClassId: number;
  code: string;
  threshold: PolicyNote;
  present: number;
  /** Null when no threshold is configured. */
  meetingThreshold: number | null;
  attendees: Array<{
    personId: number; fullName: string; watchedSeconds: number;
    attendedLive: boolean; meetsThreshold: boolean | null;
  }>;
}

export async function liveClassAttendanceReport(
  db: DB,
  ctx: AuditContext,
  liveClassId: number,
  policy: AcademyPolicy = NO_POLICY
): Promise<AttendanceReport> {
  assertCanAnywhere(ctx.principal, 'person:read');
  const cls = await loadLiveClass(db, liveClassId);

  const rows = await db.select({
    personId: s.liveClassAttendance.personId,
    fullName: s.persons.fullName,
    watchedSeconds: s.liveClassAttendance.watchedSeconds,
    attendedLive: s.liveClassAttendance.attendedLive,
  }).from(s.liveClassAttendance)
    .innerJoin(s.persons, eq(s.persons.id, s.liveClassAttendance.personId))
    .where(eq(s.liveClassAttendance.liveClassId, liveClassId));

  const min = policy.liveAttendanceMinSeconds ?? null;
  const threshold: PolicyNote = min == null
    ? {
        rule: 'live_attendance_min_seconds',
        configured: false,
        value: null,
        detail: 'MMAKF has set no attendance threshold, so this register reports presence only. It does not certify anyone as having attended for a qualifying period.',
      }
    : { rule: 'live_attendance_min_seconds', configured: true, value: min, detail: `Threshold ${min}s.` };

  return {
    liveClassId,
    code: cls.code,
    threshold,
    present: rows.length,
    meetingThreshold: min == null ? null : rows.filter((r: any) => r.watchedSeconds >= min).length,
    attendees: rows.map((r: any) => ({
      ...r,
      meetsThreshold: min == null ? null : r.watchedSeconds >= min,
    })),
  };
}

// ─── Questions ──────────────────────────────────────────────────────────────

export async function askQuestion(
  db: DB,
  ctx: AuditContext,
  input: { liveClassId: number; personId: number; question: string },
  now: Date = new Date()
) {
  const person = await loadPerson(db, input.personId);
  await assertSelfOrAuthority(db, ctx, person);
  await loadLiveClass(db, input.liveClassId);

  const text = input.question?.trim();
  if (!text) throw new AcademyError('question_required', 'A question cannot be empty.');

  const [row] = await db.insert(s.liveClassQuestions).values({
    liveClassId: input.liveClassId,
    personId: person.id,
    question: text,
    askedAt: now,
    status: 'open',
  }).returning();
  return row;
}

async function loadQuestion(db: DB, questionId: number) {
  const row = (await db.select().from(s.liveClassQuestions)
    .where(eq(s.liveClassQuestions.id, questionId)).limit(1))[0];
  if (!row) throw new AcademyError('unknown_question', 'Unknown question');
  return row;
}

export async function answerQuestion(
  db: DB,
  ctx: AuditContext,
  input: { questionId: number; answeredByPersonId: number; answer: string },
  now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  const question = await loadQuestion(db, input.questionId);
  // Answering would put a moderated question back in front of the class.
  if (question.status === 'hidden') {
    throw new AcademyError('question_hidden', 'This question has been hidden. Restore it before answering.');
  }
  if (!input.answer?.trim()) throw new AcademyError('answer_required', 'An answer cannot be empty.');

  const [row] = await db.update(s.liveClassQuestions).set({
    answer: input.answer.trim(),
    answeredByPersonId: input.answeredByPersonId,
    answeredAt: now,
    status: 'answered',
  }).where(eq(s.liveClassQuestions.id, question.id)).returning();
  return row;
}

/**
 * Upvote a question.
 *
 * HONEST LIMITATION: the schema holds a bare counter and no per-person vote
 * record, so nothing here can stop the same person voting twice. The number is
 * therefore a count of upvote EVENTS, and `uniquenessEnforced: false` says so
 * rather than letting a caller present it as a headcount. See the schema note
 * at the foot of this file.
 */
export async function upvoteQuestion(
  db: DB,
  ctx: AuditContext,
  input: { questionId: number; personId: number }
): Promise<{ questionId: number; upvotes: number; uniquenessEnforced: false }> {
  const person = await loadPerson(db, input.personId);
  await assertSelfOrAuthority(db, ctx, person);

  const question = await loadQuestion(db, input.questionId);
  if (question.status === 'hidden') {
    throw new AcademyError('question_hidden', 'This question has been hidden.');
  }

  // Incremented in SQL rather than read-modify-write: two viewers voting at the
  // same moment must not lose a vote.
  const [row] = await db.update(s.liveClassQuestions)
    .set({ upvotes: sql`${s.liveClassQuestions.upvotes} + 1` })
    .where(eq(s.liveClassQuestions.id, question.id))
    .returning({ id: s.liveClassQuestions.id, upvotes: s.liveClassQuestions.upvotes });

  return { questionId: row.id, upvotes: row.upvotes, uniquenessEnforced: false };
}

/**
 * Hide a question. IT IS NOT DELETED.
 *
 * Moderation is an act the federation must be able to account for: the text
 * stays, the reason is recorded, and both remain visible to anyone with
 * moderation authority. A deleted question leaves a member with no way to show
 * what they actually asked.
 */
export async function hideQuestion(
  db: DB,
  ctx: AuditContext,
  input: { questionId: number; reason: string }
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  if (!input.reason?.trim()) throw new AcademyError('reason_required', 'Hiding a question requires a reason.');
  const question = await loadQuestion(db, input.questionId);

  const [row] = await db.update(s.liveClassQuestions).set({ status: 'hidden' })
    .where(eq(s.liveClassQuestions.id, question.id)).returning();

  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: 'live_class_question', entityId: question.id, action: 'update',
    oldValue: { status: question.status, question: question.question },
    newValue: { status: 'hidden' },
  });
  return row;
}

/** Restore a hidden question. Audited too — a moderation reversal is a decision. */
export async function restoreQuestion(
  db: DB,
  ctx: AuditContext,
  input: { questionId: number; reason: string }
) {
  assertCanAnywhere(ctx.principal, 'content:write');
  if (!input.reason?.trim()) throw new AcademyError('reason_required', 'Restoring a question requires a reason.');
  const question = await loadQuestion(db, input.questionId);
  if (question.status !== 'hidden') return question;

  const [row] = await db.update(s.liveClassQuestions)
    .set({ status: question.answer ? 'answered' : 'open' })
    .where(eq(s.liveClassQuestions.id, question.id)).returning();
  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: 'live_class_question', entityId: question.id, action: 'update',
    oldValue: { status: 'hidden' }, newValue: { status: row.status },
  });
  return row;
}

/** What the class sees. Hidden questions are absent — they still exist. */
export async function liveClassQuestions(db: DB, liveClassId: number) {
  return db.select({
    id: s.liveClassQuestions.id,
    personId: s.liveClassQuestions.personId,
    question: s.liveClassQuestions.question,
    askedAt: s.liveClassQuestions.askedAt,
    answer: s.liveClassQuestions.answer,
    answeredAt: s.liveClassQuestions.answeredAt,
    status: s.liveClassQuestions.status,
    upvotes: s.liveClassQuestions.upvotes,
  }).from(s.liveClassQuestions)
    .where(and(
      eq(s.liveClassQuestions.liveClassId, liveClassId),
      inArray(s.liveClassQuestions.status, ['open', 'answered'])
    ))
    .orderBy(desc(s.liveClassQuestions.upvotes), asc(s.liveClassQuestions.id));
}

/** What a moderator sees: everything, including what was hidden and still is. */
export async function moderationQuestions(db: DB, ctx: AuditContext, liveClassId: number) {
  assertCanAnywhere(ctx.principal, 'content:write');
  return db.select().from(s.liveClassQuestions)
    .where(eq(s.liveClassQuestions.liveClassId, liveClassId))
    .orderBy(asc(s.liveClassQuestions.id));
}

// ─── Resources ──────────────────────────────────────────────────────────────

export interface AttachResourceInput {
  liveClassId: number;
  title: string;
  kind: 'technique' | 'kata' | 'document' | 'pdf' | 'link' | 'note';
  url?: string | null;
  techniqueId?: number | null;
  kataId?: number | null;
  /** For kind 'document': the official document whose CURRENT version is linked. */
  documentId?: number | null;
  displayOrder?: number;
}

/**
 * Attach a resource to a live class.
 *
 * Every pointer is resolved before it is stored. A technique or kata that does
 * not exist — or that the federation has not published — would become a dead
 * link on the class page, and a document is resolved to its CURRENT version's
 * file so a class never points at a superseded policy.
 */
export async function attachResource(db: DB, ctx: AuditContext, input: AttachResourceInput) {
  assertCanAnywhere(ctx.principal, 'content:write');
  await loadLiveClass(db, input.liveClassId);
  if (!input.title?.trim()) throw new AcademyError('title_required', 'A resource needs a title.');

  let url = input.url ?? null;
  let techniqueId: number | null = null;
  let kataId: number | null = null;

  if (input.kind === 'technique') {
    if (input.techniqueId == null) {
      throw new AcademyError('technique_required', 'A technique resource must name the technique.');
    }
    const t = (await db.select().from(s.techniques)
      .where(eq(s.techniques.id, input.techniqueId)).limit(1))[0];
    if (!t) throw new AcademyError('unknown_technique', 'Unknown technique.');
    if (!t.published) {
      throw new AcademyError(
        'technique_not_published',
        `"${t.nameRomaji}" has not been published, so linking to it would be a dead link.`
      );
    }
    techniqueId = t.id;
  } else if (input.kind === 'kata') {
    if (input.kataId == null) throw new AcademyError('kata_required', 'A kata resource must name the kata.');
    const k = (await db.select().from(s.kata).where(eq(s.kata.id, input.kataId)).limit(1))[0];
    if (!k) throw new AcademyError('unknown_kata', 'Unknown kata.');
    if (!k.published) {
      throw new AcademyError(
        'kata_not_published',
        `"${k.nameRomaji}" has not been published, so linking to it would be a dead link.`
      );
    }
    kataId = k.id;
  } else if (input.kind === 'document') {
    if (input.documentId == null) {
      throw new AcademyError('document_required', 'A document resource must name the document.');
    }
    const doc = (await db.select().from(s.officialDocuments)
      .where(eq(s.officialDocuments.id, input.documentId)).limit(1))[0];
    if (!doc) throw new AcademyError('unknown_document', 'Unknown document.');
    if (doc.currentVersionId == null) {
      throw new AcademyError(
        'document_has_no_version',
        `"${doc.title}" has no current version, so there is no file to link to.`
      );
    }
    const version = (await db.select().from(s.documentVersions)
      .where(eq(s.documentVersions.id, doc.currentVersionId)).limit(1))[0];
    if (!version?.fileUrl) {
      throw new AcademyError(
        'document_has_no_file',
        `The current version of "${doc.title}" has no file attached.`
      );
    }
    url = version.fileUrl;
  } else if (!url?.trim()) {
    throw new AcademyError('url_required', `A ${input.kind} resource needs a URL.`);
  }

  const [row] = await db.insert(s.liveClassResources).values({
    liveClassId: input.liveClassId,
    title: input.title.trim(),
    kind: input.kind,
    url,
    techniqueId,
    kataId,
    displayOrder: input.displayOrder ?? 0,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'live_class_resource', entityId: row.id, action: 'create',
    newValue: { liveClassId: input.liveClassId, kind: input.kind, title: row.title },
  });
  return row;
}

export async function liveClassResources(db: DB, liveClassId: number) {
  return db.select().from(s.liveClassResources)
    .where(eq(s.liveClassResources.liveClassId, liveClassId))
    .orderBy(asc(s.liveClassResources.displayOrder), asc(s.liveClassResources.id));
}

// ─── Schema notes for the federation ────────────────────────────────────────
//
// Three things this module works around rather than papers over. Each needs a
// migration owned outside this file:
//
//  1. `quizzes.pass_mark_percent` is NOT NULL DEFAULT 60. Sixty per cent is not
//     a number MMAKF has approved, and while that default stands every quiz
//     silently acquires an unapproved pass mark. It must become nullable with
//     no default so that "the federation has not set one" is representable and
//     attempts record as UNGRADED.
//  2. There is no store for the live-class attendance threshold or the lesson
//     minimum watch time, so both arrive through `AcademyPolicy`. A federation
//     settings table (or columns on `live_classes` / `courses`) would let the
//     federation configure them once instead of at every call site.
//  3. `live_class_questions.upvotes` is a bare counter with no per-person vote
//     record, so repeat voting cannot be prevented. A
//     `live_class_question_votes` table with a unique (question_id, person_id)
//     index would fix it.
