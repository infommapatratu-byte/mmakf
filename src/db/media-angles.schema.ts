// Multi-angle recordings. §28.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A RELATIONSHIP AND NOT TWO COLUMNS ON media_assets
// ─────────────────────────────────────────────────────────────────────────────
//
// The obvious shape is `camera_angle` and `angle_group_id` on `media_assets`,
// and it is wrong for what §28 actually asks for:
//
//     FRONT / REAR / LEFT / RIGHT / 45 DEGREE / OVERHEAD ... Synchronize
//     multiple camera views where technically feasible.
//
// Synchronising views is a fact about the RELATIONSHIP between recordings, not a
// property of any one of them. Two cameras rolling on one performance of Bassai
// Dai did not start at the same instant; playing them together needs the offset
// between them, and an offset has no home on a single asset row. Columns would
// store the angle and lose the only number that makes the feature work.
//
// So: a GROUP is one performance, and each member is one camera on it, carrying
// its own angle and its own offset from the group's reference recording.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND IT IS EMPTY, WHICH IS THE HONEST STATE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF has recorded no multi-angle material. Not one group exists, and the
// surfaces say so rather than rendering an angle switcher with one angle in it.
// The tables are here because §28 is about what the federation's own future
// recordings must be able to express, and because the shape is much cheaper to
// get right now than to retrofit onto a hundred assets later.
//
// Nothing here is inferred from an existing recording. A camera position that
// nobody wrote down is `unknown`, and the player prints "camera position not
// recorded" — guessing one from a thumbnail would be a fabricated technical
// fact, which is the failure this whole library is organised against.

import {
  pgTable, serial, text, integer, timestamp, boolean,
  uniqueIndex, index, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons } from './schema';
import { mediaAssets } from './education.schema';

/**
 * Where a recording was filmed from. §28's list, plus `unknown`.
 *
 * `unknown` is the DEFAULT and is a real answer, not a placeholder: it is the
 * true state of every recording currently on file.
 */
export const cameraAngle = pgEnum('camera_angle', [
  'front', 'rear', 'left', 'right', 'forty_five', 'overhead', 'unknown',
]);

/** Normal speed, or a deliberate slow-motion capture. §28 asks for both. */
export const captureSpeed = pgEnum('capture_speed', ['normal', 'slow_motion']);

/**
 * One performance, filmed by one or more cameras.
 *
 * The group is the unit a learner switches angles within — "this performance of
 * Bassai Dai, from the front / from the side". A group with a single member is
 * legitimate and simply offers no switcher.
 */
export const mediaAngleGroups = pgTable('media_angle_groups', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),

  /** What was performed. Polymorphic for the same reason practice marks are. */
  subjectKind: text('subject_kind'),             // kata | technique | kumite
  subjectSlug: text('subject_slug'),

  /**
   * The member every offset is measured against. Nullable until a group has a
   * member, and set to one of its own members thereafter — deliberately NOT a
   * foreign key to media_angle_members, because that would make the two tables
   * mutually dependent and neither insertable first.
   */
  referenceMemberId: integer('reference_member_id'),

  recordedOn: timestamp('recorded_on', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdByPersonId: integer('created_by_person_id').references(() => persons.id),
}, (t) => ({
  slugIdx: uniqueIndex('media_angle_groups_slug_uk').on(t.slug),
  subjectIdx: index('media_angle_groups_subject_idx').on(t.subjectKind, t.subjectSlug),
}));

/**
 * One camera on one performance.
 *
 * `offsetMs` is the whole reason this table exists. It is how far this
 * recording's clock is ahead of the group's reference recording, so a player
 * showing two angles can keep them together. Signed, because a camera can start
 * either before or after the reference.
 *
 * NULL means the offset has not been measured — different from zero, which
 * asserts they are already aligned. A player must not synchronise on an
 * unmeasured offset; it offers the angles separately instead.
 */
export const mediaAngleMembers = pgTable('media_angle_members', {
  id: serial('id').primaryKey(),
  groupId: integer('group_id').notNull().references(() => mediaAngleGroups.id),
  mediaAssetId: integer('media_asset_id').notNull().references(() => mediaAssets.id),

  angle: cameraAngle('angle').notNull().default('unknown'),
  speed: captureSpeed('speed').notNull().default('normal'),

  /** Signed milliseconds from the group's reference. NULL = not measured. */
  offsetMs: integer('offset_ms'),
  /** How the offset was established — a clapperboard, a waveform, by eye. */
  offsetMethod: text('offset_method'),

  /** The angle shown first. At most one per group — see the partial index. */
  isPrimary: boolean('is_primary').notNull().default(false),

  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One asset appears once in a group. It may legitimately appear in another
  // group — the same recording can be a member of a re-cut performance — so the
  // uniqueness is per group rather than global.
  uniqueMember: uniqueIndex('media_angle_members_uk').on(t.groupId, t.mediaAssetId),

  // One camera position of each kind per group, at each speed: two "front"
  // cameras at normal speed on one performance is a data-entry error, while
  // front-normal and front-slow are two legitimate members.
  //
  // PARTIAL, EXCLUDING `unknown`, and the exclusion is the point. Several
  // recordings whose camera position was never written down is the NORMAL state
  // — it is the state of every recording currently on file — and a plain unique
  // index would make the second one unstorable, which would push whoever hit it
  // into inventing an angle to get past the constraint. That is precisely the
  // fabricated technical fact this library exists to prevent, arrived at through
  // a database error rather than through carelessness.
  uniqueAngle: uniqueIndex('media_angle_members_angle_uk')
    .on(t.groupId, t.angle, t.speed)
    .where(sql`angle <> 'unknown'`),

  // At most one primary per group. Partial, so the many `false` rows do not
  // collide with one another.
  onePrimary: uniqueIndex('media_angle_members_primary_uk')
    .on(t.groupId)
    .where(sql`is_primary`),

  groupIdx: index('media_angle_members_group_idx').on(t.groupId),
}));
