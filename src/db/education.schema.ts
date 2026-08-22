// Academy (LMS), media registry and the Live Master Teacher system.
//
// THE LIVE CLASS PROBLEM THIS SOLVES: when an authorised Master Teacher goes
// live on their own YouTube channel, the class must appear inside MMAKF by
// itself. Nobody should be pasting a URL into an admin panel every time, which
// is what makes "live classes" quietly stop happening.
//
// YouTube is the streaming TRANSPORT. MMAKF is the authoritative learning
// environment: attendance, questions, curriculum links, progress and
// certificates live here, not there.
//
// MEDIA IS NOT AUTOMATICALLY FEDERATION CONTENT. A teacher's channel carries
// personal material alongside teaching material. Every discovered video lands
// as `pending_review` and is classified before it can surface — the federation
// publishes what it has approved, not whatever was uploaded.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, dojos } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const courseStatus = pgEnum('course_status', [
  'draft', 'review', 'published', 'archived', 'withdrawn',
]);

export const lessonKind = pgEnum('lesson_kind', [
  'video', 'live_class', 'reading', 'quiz', 'assignment', 'practical', 'assessment',
]);

export const enrolmentStatus = pgEnum('enrolment_status', [
  'pending_payment', 'active', 'completed', 'expired', 'withdrawn', 'suspended',
]);

/**
 * Media classification. Only the federation-relevant kinds surface publicly;
 * `personal` and `pending_review` never do.
 */
export const mediaClass = pgEnum('media_class', [
  'federation_official', 'federation_relevant', 'master_teaching',
  'shotokan_technical', 'seminar', 'competition', 'historical',
  'personal', 'other', 'pending_review', 'rejected',
]);

export const broadcastStatus = pgEnum('broadcast_status', [
  'upcoming', 'live', 'ended', 'recording_processing', 'recorded',
  'archived', 'cancelled', 'missing',
]);

/**
 * Whether MMAKF may use a piece of media, and how.
 *
 * EXTENDED BY 0031 (technical library), additively. The original six values
 * answered "have we cleared this?" but could not express the two distinctions
 * the technical directive treats as critical:
 *
 *   'embed_allowed' vs 'link_only' — the difference between a lawful provider
 *   embed and rehosting somebody's instructional video. Publicly viewable is
 *   not the same as ours to serve.
 *
 *   'unknown' vs 'not_cleared' — the difference between "nobody has looked at
 *   this yet" and "somebody looked, and the answer was no". Collapsing them
 *   loses the review queue's entire reason to exist, and lets an unexamined
 *   asset be mistaken for a rejected one (or worse, the reverse).
 *
 * 'do_not_use' is terminal: a rights holder has refused, and no reviewer should
 * have to re-litigate it.
 *
 * Nothing was renamed or removed. Existing rows and existing code keep working.
 */
export const rightsStatus = pgEnum('rights_status', [
  'cleared', 'federation_owned', 'licensed', 'permission_pending',
  'restricted', 'not_cleared',
  'embed_allowed', 'link_only', 'unknown', 'do_not_use',
]);

// ─── Authorised media sources ───────────────────────────────────────────────

/**
 * A channel the federation has authorised as a media source.
 *
 * Authorisation is explicit and revocable. A channel belonging to a person is
 * linked to that person, so when their role ends the link is auditable rather
 * than forgotten.
 *
 * TOKENS: only refresh tokens are stored, encrypted, and they never reach the
 * browser. Every YouTube API call happens server-side. A channel owner can
 * revoke consent at Google's end at any time, which is why `tokenStatus`
 * exists — the system must notice and say so rather than failing silently.
 */
export const mediaChannels = pgTable('media_channels', {
  id: serial('id').primaryKey(),
  platform: text('platform').notNull().default('youtube'),
  externalId: text('external_id').notNull(),     // UCGb5ET3JdoCUdNNCqekYJ1g
  handle: text('handle'),                        // @PramodPathakMartialArt
  title: text('title').notNull(),
  url: text('url').notNull(),

  ownerPersonId: integer('owner_person_id').references(() => persons.id),
  ownerKind: text('owner_kind').notNull().default('person'), // federation | person | unit | dojo

  authorised: boolean('authorised').notNull().default(false),
  authorisedByUserId: integer('authorised_by_user_id'),
  authorisedAt: timestamp('authorised_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),

  // Encrypted at rest. Never selected into any response that reaches a client.
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  tokenStatus: text('token_status').notNull().default('none'), // none | valid | expired | revoked
  scopes: jsonb('scopes'),

  // What a live broadcast from this channel becomes by default. Still reviewable.
  defaultLiveClass: mediaClass('default_live_class').notNull().default('pending_review'),
  autoPublishLive: boolean('auto_publish_live').notNull().default(false),

  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncError: text('last_sync_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  externalIdx: uniqueIndex('media_channels_external_uk').on(t.platform, t.externalId),
  ownerIdx: index('media_channels_owner_idx').on(t.ownerPersonId),
}));

/**
 * A video or broadcast discovered on an authorised channel.
 *
 * Discovery does NOT mean publication. Everything arrives classified
 * `pending_review`; a human decides what becomes federation content.
 */
export const mediaAssets = pgTable('media_assets', {
  id: serial('id').primaryKey(),
  channelId: integer('channel_id').references(() => mediaChannels.id),
  platform: text('platform').notNull().default('youtube'),
  externalId: text('external_id').notNull(),     // the video id
  url: text('url').notNull(),

  title: text('title').notNull(),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  durationSeconds: integer('duration_seconds'),
  publishedAt: timestamp('published_at', { withTimezone: true }),

  classification: mediaClass('classification').notNull().default('pending_review'),
  classifiedByUserId: integer('classified_by_user_id'),
  classifiedAt: timestamp('classified_at', { withTimezone: true }),

  // Rights are tracked separately from classification: a video can be entirely
  // federation-relevant and still not be ours to publish.
  rights: rightsStatus('rights').notNull().default('not_cleared'),
  rightsHolder: text('rights_holder'),
  rightsNote: text('rights_note'),
  consentEvidence: text('consent_evidence'),

  teacherPersonId: integer('teacher_person_id').references(() => persons.id),
  topic: text('topic'),
  gradeRelevance: text('grade_relevance'),

  published: boolean('published').notNull().default(false),
  featured: boolean('featured').notNull().default(false),

  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
}, (t) => ({
  externalIdx: uniqueIndex('media_assets_external_uk').on(t.platform, t.externalId),
  classIdx: index('media_assets_class_idx').on(t.classification, t.published),
  channelIdx: index('media_assets_channel_idx').on(t.channelId),
}));

// ─── Live classes ───────────────────────────────────────────────────────────

/**
 * A broadcast detected on an authorised channel.
 *
 * This is the row the poller writes. `liveClasses` is the federation's teaching
 * object built on top of it — the two are separate because a broadcast is a
 * fact about YouTube, and a class is a fact about MMAKF.
 */
export const broadcasts = pgTable('broadcasts', {
  id: serial('id').primaryKey(),
  channelId: integer('channel_id').notNull().references(() => mediaChannels.id),
  externalId: text('external_id').notNull(),
  status: broadcastStatus('status').notNull().default('upcoming'),

  title: text('title').notNull(),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
  actualStartAt: timestamp('actual_start_at', { withTimezone: true }),
  actualEndAt: timestamp('actual_end_at', { withTimezone: true }),

  concurrentViewers: integer('concurrent_viewers'),
  // Set once processing finishes — the recording is usually a DIFFERENT id from
  // the live broadcast, which is why detection has to run after the stream ends.
  recordingAssetId: integer('recording_asset_id').references(() => mediaAssets.id),

  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
}, (t) => ({
  externalIdx: uniqueIndex('broadcasts_external_uk').on(t.channelId, t.externalId),
  statusIdx: index('broadcasts_status_idx').on(t.status),
}));

export const liveClasses = pgTable('live_classes', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-LIVE-2026-000001
  broadcastId: integer('broadcast_id').references(() => broadcasts.id),

  title: text('title').notNull(),
  summary: text('summary'),
  teacherPersonId: integer('teacher_person_id').references(() => persons.id),

  // Curriculum links — what makes this a lesson rather than a video.
  courseId: integer('course_id'),
  moduleId: integer('module_id'),
  lessonId: integer('lesson_id'),
  topic: text('topic'),
  gradeRelevance: text('grade_relevance'),

  status: broadcastStatus('status').notNull().default('upcoming'),
  scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),

  // Visibility is decided by MMAKF, not by YouTube's own setting.
  visibility: text('visibility').notNull().default('members'), // public | members | course | private
  published: boolean('published').notNull().default(false),

  recordingAssetId: integer('recording_asset_id').references(() => mediaAssets.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('live_classes_code_uk').on(t.code),
  statusIdx: index('live_classes_status_idx').on(t.status, t.scheduledStartAt),
}));

/**
 * Attendance at a live class.
 *
 * Recorded as presence, deliberately NOT as proficiency — a student who watched
 * a class has attended it, and nothing more. Conflating the two is how
 * attendance quietly becomes a grading criterion nobody approved.
 */
export const liveClassAttendance = pgTable('live_class_attendance', {
  id: serial('id').primaryKey(),
  liveClassId: integer('live_class_id').notNull().references(() => liveClasses.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
  watchedSeconds: integer('watched_seconds').notNull().default(0),
  attendedLive: boolean('attended_live').notNull().default(true),
}, (t) => ({
  uniqueAttendee: uniqueIndex('live_class_attendance_uk').on(t.liveClassId, t.personId),
  classIdx: index('live_class_attendance_class_idx').on(t.liveClassId),
}));

export const liveClassQuestions = pgTable('live_class_questions', {
  id: serial('id').primaryKey(),
  liveClassId: integer('live_class_id').notNull().references(() => liveClasses.id),
  personId: integer('person_id').references(() => persons.id),
  question: text('question').notNull(),
  askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
  answeredByPersonId: integer('answered_by_person_id').references(() => persons.id),
  answer: text('answer'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  status: text('status').notNull().default('open'),  // open | answered | hidden
  upvotes: integer('upvotes').notNull().default(0),
}, (t) => ({ classIdx: index('live_class_questions_class_idx').on(t.liveClassId) }));

export const liveClassResources = pgTable('live_class_resources', {
  id: serial('id').primaryKey(),
  liveClassId: integer('live_class_id').notNull().references(() => liveClasses.id),
  title: text('title').notNull(),
  kind: text('kind').notNull(),                  // pdf | link | note | technique | kata
  url: text('url'),
  techniqueId: integer('technique_id'),
  kataId: integer('kata_id'),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({ classIdx: index('live_class_resources_class_idx').on(t.liveClassId) }));

// ─── Courses ────────────────────────────────────────────────────────────────

export const courses = pgTable('courses', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  description: text('description'),
  category: text('category'),                    // shotokan | referee | instructor | sports_science
  level: text('level'),
  coverImageUrl: text('cover_image_url'),

  status: courseStatus('status').notNull().default('draft'),
  feeCode: text('fee_code'),
  // Only true when a genuinely accessible preview lesson exists. A "Free
  // Preview" badge on a course with nothing behind it is exactly the kind of
  // fake affordance this project forbids.
  hasFreePreview: boolean('has_free_preview').notNull().default(false),

  leadTeacherPersonId: integer('lead_teacher_person_id').references(() => persons.id),
  estimatedHours: integer('estimated_hours'),
  certificateOnCompletion: boolean('certificate_on_completion').notNull().default(false),
  passMarkPercent: integer('pass_mark_percent'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('courses_slug_uk').on(t.slug),
  statusIdx: index('courses_status_idx').on(t.status),
}));

export const courseModules = pgTable('course_modules', {
  id: serial('id').primaryKey(),
  courseId: integer('course_id').notNull().references(() => courses.id),
  title: text('title').notNull(),
  summary: text('summary'),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({ courseIdx: index('course_modules_course_idx').on(t.courseId) }));

export const lessons = pgTable('lessons', {
  id: serial('id').primaryKey(),
  moduleId: integer('module_id').notNull().references(() => courseModules.id),
  courseId: integer('course_id').notNull().references(() => courses.id),
  title: text('title').notNull(),
  kind: lessonKind('kind').notNull(),
  body: text('body'),

  // A video lesson points at an approved media asset. If the asset is absent or
  // unpublished the lesson renders as unavailable rather than as a dead player
  // — the system never pretends a video exists.
  mediaAssetId: integer('media_asset_id').references(() => mediaAssets.id),
  liveClassId: integer('live_class_id').references(() => liveClasses.id),

  durationMinutes: integer('duration_minutes'),
  isPreview: boolean('is_preview').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({
  moduleIdx: index('lessons_module_idx').on(t.moduleId),
  courseIdx: index('lessons_course_idx').on(t.courseId),
}));

export const quizzes = pgTable('quizzes', {
  id: serial('id').primaryKey(),
  lessonId: integer('lesson_id').references(() => lessons.id),
  courseId: integer('course_id').notNull().references(() => courses.id),
  title: text('title').notNull(),
  // NULLABLE, and no default. 60% was not a number MMAKF approved, and while a
  // NOT NULL DEFAULT 60 stood, "the federation has not set a pass mark" was
  // literally unrepresentable in the database — every quiz silently acquired a
  // marking threshold nobody wrote. An unset pass mark now records the attempt
  // UNGRADED for a human to decide, which is the honest outcome.
  passMarkPercent: integer('pass_mark_percent'),
  attemptsAllowed: integer('attempts_allowed'),
  timeLimitMinutes: integer('time_limit_minutes'),
}, (t) => ({ courseIdx: index('quizzes_course_idx').on(t.courseId) }));

export const quizQuestions = pgTable('quiz_questions', {
  id: serial('id').primaryKey(),
  quizId: integer('quiz_id').notNull().references(() => quizzes.id),
  prompt: text('prompt').notNull(),
  kind: text('kind').notNull().default('single'), // single | multiple | true_false | text
  options: jsonb('options'),
  // Never selected into anything a student can read before submitting.
  correctAnswer: jsonb('correct_answer'),
  explanation: text('explanation'),
  marks: integer('marks').notNull().default(1),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({ quizIdx: index('quiz_questions_quiz_idx').on(t.quizId) }));

// ─── Enrolment and progress ─────────────────────────────────────────────────

export const enrolments = pgTable('enrolments', {
  id: serial('id').primaryKey(),
  courseId: integer('course_id').notNull().references(() => courses.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  status: enrolmentStatus('status').notNull().default('pending_payment'),
  orderId: integer('order_id'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  progressPercent: integer('progress_percent').notNull().default(0),
  finalScorePercent: integer('final_score_percent'),
  certificateId: integer('certificate_id'),
}, (t) => ({
  uniqueEnrolment: uniqueIndex('enrolments_uk').on(t.courseId, t.personId),
  personIdx: index('enrolments_person_idx').on(t.personId),
}));

export const lessonProgress = pgTable('lesson_progress', {
  id: serial('id').primaryKey(),
  enrolmentId: integer('enrolment_id').notNull().references(() => enrolments.id),
  lessonId: integer('lesson_id').notNull().references(() => lessons.id),
  status: text('status').notNull().default('not_started'), // not_started | in_progress | completed
  watchedSeconds: integer('watched_seconds').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
}, (t) => ({
  uniqueProgress: uniqueIndex('lesson_progress_uk').on(t.enrolmentId, t.lessonId),
}));

export const quizAttempts = pgTable('quiz_attempts', {
  id: serial('id').primaryKey(),
  quizId: integer('quiz_id').notNull().references(() => quizzes.id),
  enrolmentId: integer('enrolment_id').notNull().references(() => enrolments.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  attemptNo: integer('attempt_no').notNull().default(1),
  answers: jsonb('answers'),
  scorePercent: integer('score_percent'),
  passed: boolean('passed'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
}, (t) => ({
  uniqueAttempt: uniqueIndex('quiz_attempts_uk').on(t.quizId, t.enrolmentId, t.attemptNo),
}));

// ─── Attendance (dojo and academy) ──────────────────────────────────────────

export const trainingSessions = pgTable('training_sessions', {
  id: serial('id').primaryKey(),
  dojoId: integer('dojo_id').references(() => dojos.id),
  title: text('title'),
  heldOn: date('held_on').notNull(),
  startsAt: text('starts_at'),
  endsAt: text('ends_at'),
  instructorPersonId: integer('instructor_person_id').references(() => persons.id),
  focus: text('focus'),

  /**
   * The scheduling-engine occurrence this register was taken at (migration 0049).
   *
   * ONE COLUMN, NOT A THIRD ATTENDANCE TABLE. `session_attendance` already hangs
   * off this table and is already READ by src/db/grading.ts, which counts a
   * candidate's sessions since their last grade, and by src/db/athletes.ts. A
   * separate `class_session_attendance` would have meant grading silently
   * ignoring half the federation's attendance — a defect that surfaces years
   * later as a candidate refused a grading they had in fact trained for.
   *
   * Nullable: a register may still be taken for a session the engine never
   * generated. Unique when set, so one occurrence has at most one register —
   * two registers for one class are two answers to "who was there", and the
   * reader cannot tell which the instructor meant.
   *
   * No drizzle `.references()`: `class_sessions` lives in scheduling.schema.ts,
   * which imports THIS file's siblings, and a type-level reference back would be
   * a cycle. The foreign key is real and is created by migration 0049.
   */
  classSessionId: integer('class_session_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dojoDateIdx: index('training_sessions_dojo_date_idx').on(t.dojoId, t.heldOn),
  classSessionUk: uniqueIndex('training_sessions_class_session_uk')
    .on(t.classSessionId)
    .where(sql`class_session_id is not null`),
}));

export const sessionAttendance = pgTable('session_attendance', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => trainingSessions.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  present: boolean('present').notNull().default(true),
  note: text('note'),
  recordedByPersonId: integer('recorded_by_person_id').references(() => persons.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueAttendance: uniqueIndex('session_attendance_uk').on(t.sessionId, t.personId),
  personIdx: index('session_attendance_person_idx').on(t.personId),
}));
