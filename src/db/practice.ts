// Practice marks and instructor assignments. §43, §44.
//
// The schema's header sets out the rule this module enforces at the write path:
// nothing here is evidence of competence, and the vocabulary has no terminal
// state a student can put themselves into.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTHORISED BY CONSTRUCTION, NOT BY A CHECK SOMEBODY CAN FORGET
// ─────────────────────────────────────────────────────────────────────────────
//
// `markPractice()` and `myMarks()` take NO personId. They resolve the caller's
// own person from the session and write there. There is no parameter to pass
// the wrong value to and no query string a curious visitor can edit — which is
// the same construction src/db/notifications-inbox.ts uses, and for the same
// reason: a permission check that must be remembered is a permission check that
// eventually is not.
//
// Assignment is the opposite shape and therefore IS gated: an instructor writes
// to somebody else's record, so `assignPractice()` demands a permission and
// writes an audit row.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND EVERY SUBJECT IS RESOLVED BEFORE IT IS STORED
// ─────────────────────────────────────────────────────────────────────────────
//
// The subject is (kind, slug) rather than a foreign key — see the schema header
// for why — so the database cannot refuse a slug that does not exist. This
// module refuses it instead, against the same library the pages render from. A
// bookmark pointing at nothing is a row that renders as a blank line forever and
// that nobody can explain later.

import { and, desc, eq, inArray } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { techniqueBySlug, kumiteSystem, kumiteConcept, videoById } from '@/data/shotokan';
import { kataBySlug } from '@/data/kata';

type DB = any;

export type SubjectKind = 'technique' | 'kata' | 'kumite' | 'video' | 'drill';
export type Mark = 'watched' | 'practising' | 'needs_work' | 'bookmarked';

export const MARKS: readonly Mark[] = ['watched', 'practising', 'needs_work', 'bookmarked'];

/**
 * How each mark is described to the person choosing it.
 *
 * Written here rather than in the template because two surfaces show them and
 * the wording is the feature: "watched" must not read as progress, and
 * "needs work" must read as a useful thing to admit rather than a failure.
 */
export const MARK_LABEL: Record<Mark, { label: string; help: string }> = {
  watched: {
    label: 'Watched',
    help: 'You have seen it explained. This records that and nothing more — it is not progress toward a grade.',
  },
  practising: {
    label: 'Practising',
    help: 'You are working on it at the moment.',
  },
  needs_work: {
    label: 'Needs work',
    help: 'You cannot do it yet, or not reliably. The most useful thing on this list, and the one worth being honest about.',
  },
  bookmarked: {
    label: 'Bookmarked',
    help: 'Keep it to hand. No claim about it either way.',
  },
};

export class PracticeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PracticeError';
    this.code = code;
  }
}

export function isPracticeError(err: unknown): err is PracticeError {
  return !!err && typeof err === 'object' && (err as any).name === 'PracticeError'
    && typeof (err as any).code === 'string';
}

// ─── Subjects ───────────────────────────────────────────────────────────────

export interface ResolvedSubject {
  kind: SubjectKind;
  slug: string;
  title: string;
  /** Where the subject can be read. Null for a video, which has no own page. */
  href: string | null;
}

/**
 * Resolve (kind, slug) against the library, or null.
 *
 * `drill` resolves against its PARENT — a technique or a kumite record — because
 * drills are lines inside those records rather than entities with slugs of their
 * own. That is a real limitation of the content model and is recorded here
 * rather than papered over: an assignment to "the chamber-hold drill" is stored
 * as the technique it belongs to, with the specific drill named in the
 * instruction text.
 */
export function resolveSubject(kind: SubjectKind, slug: string): ResolvedSubject | null {
  if (!slug) return null;

  if (kind === 'technique' || kind === 'drill') {
    const t = techniqueBySlug(slug);
    if (t) return { kind, slug, title: t.name, href: `/shotokan/techniques/${t.slug}` };
    if (kind === 'technique') return null;
  }

  if (kind === 'kata') {
    const k = kataBySlug(slug);
    return k ? { kind, slug, title: k.name, href: `/kata/${k.slug}` } : null;
  }

  if (kind === 'kumite' || kind === 'drill') {
    const c = kumiteConcept(slug) ?? kumiteSystem(slug);
    if (c) return { kind, slug, title: c.name, href: `/shotokan/kumite/${c.slug}` };
    if (kind === 'kumite') return null;
  }

  if (kind === 'video') {
    const v = videoById(slug);
    // A registered recording has no page of its own — it is listed on the source
    // register — so the href is null and the surfaces link to the register.
    return v ? { kind, slug, title: v.title, href: null } : null;
  }

  return null;
}

// ─── Who is marking ─────────────────────────────────────────────────────────

/**
 * The caller's own person, or null.
 *
 * Null has three distinct causes the surfaces are expected to tell apart: no
 * session, a SHARED credential (the office password identifies no individual and
 * therefore has no practice record), and an account not yet linked to a person.
 * None of them is "you have marked nothing".
 */
export async function practitionerFor(
  db: DB,
  principal: Principal | null | undefined
): Promise<{ userId: number; personId: number } | null> {
  if (!principal || principal.userId == null) return null;
  const [user] = await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, principal.userId))
    .limit(1);
  if (!user?.personId) return null;
  return { userId: principal.userId, personId: user.personId };
}

// ─── Marking ────────────────────────────────────────────────────────────────

/**
 * Record, or change, what the caller says about one subject.
 *
 * Upserts on (person, kind, slug): a student has one current relationship with a
 * technique, not a log of every visit. Re-marking moves `markedAt`.
 */
export async function markPractice(
  db: DB,
  principal: Principal | null | undefined,
  input: { subjectKind: SubjectKind; subjectSlug: string; mark: Mark; note?: string | null }
) {
  const me = await practitionerFor(db, principal);
  if (!me) {
    throw new PracticeError(
      'no_practitioner',
      'A practice record belongs to one person. Sign in with your own account — the shared office password identifies nobody.'
    );
  }

  if (!MARKS.includes(input.mark)) {
    throw new PracticeError('bad_mark', `"${input.mark}" is not something a student can record about themselves.`);
  }

  const subject = resolveSubject(input.subjectKind, input.subjectSlug);
  if (!subject) {
    throw new PracticeError(
      'unknown_subject',
      `The library has no ${input.subjectKind} called "${input.subjectSlug}".`
    );
  }

  const note = input.note?.trim() || null;

  const [row] = await db
    .insert(s.practiceMarks)
    .values({
      personId: me.personId,
      subjectKind: input.subjectKind,
      subjectSlug: input.subjectSlug,
      mark: input.mark,
      note,
      // Never set from input. See rule 3 in the schema header.
      selfReported: true,
      markedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [s.practiceMarks.personId, s.practiceMarks.subjectKind, s.practiceMarks.subjectSlug],
      set: { mark: input.mark, note, markedAt: new Date() },
    })
    .returning();

  return row;
}

/** Remove the caller's own mark. Theirs to withdraw, so no reason is demanded. */
export async function clearPractice(
  db: DB,
  principal: Principal | null | undefined,
  subjectKind: SubjectKind,
  subjectSlug: string
): Promise<boolean> {
  const me = await practitionerFor(db, principal);
  if (!me) return false;
  const removed = await db
    .delete(s.practiceMarks)
    .where(and(
      eq(s.practiceMarks.personId, me.personId),
      eq(s.practiceMarks.subjectKind, subjectKind),
      eq(s.practiceMarks.subjectSlug, subjectSlug),
    ))
    .returning({ id: s.practiceMarks.id });
  return removed.length > 0;
}

/** Everything the caller has marked, most recent first. */
export async function myMarks(db: DB, principal: Principal | null | undefined, limit = 200) {
  const me = await practitionerFor(db, principal);
  if (!me) return [];
  const rows = await db
    .select()
    .from(s.practiceMarks)
    .where(eq(s.practiceMarks.personId, me.personId))
    .orderBy(desc(s.practiceMarks.markedAt))
    .limit(limit);

  return rows.map((r: any) => ({ ...r, subject: resolveSubject(r.subjectKind, r.subjectSlug) }));
}

/** The caller's mark on one subject, for rendering the control in its current state. */
export async function myMarkFor(
  db: DB,
  principal: Principal | null | undefined,
  subjectKind: SubjectKind,
  subjectSlug: string
) {
  const me = await practitionerFor(db, principal);
  if (!me) return null;
  const [row] = await db
    .select()
    .from(s.practiceMarks)
    .where(and(
      eq(s.practiceMarks.personId, me.personId),
      eq(s.practiceMarks.subjectKind, subjectKind),
      eq(s.practiceMarks.subjectSlug, subjectSlug),
    ))
    .limit(1);
  return row ?? null;
}

// ─── Assignment ─────────────────────────────────────────────────────────────

/**
 * An instructor asks a student to work on something.
 *
 * GATED, because this writes to somebody else's record. `content:write` is
 * deliberately NOT the permission: writing federation copy and directing a named
 * member's training are different authorities. `person:read` is required too —
 * an assigner who cannot see the member has no business assigning to them.
 */
export async function assignPractice(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    subjectKind: SubjectKind;
    subjectSlug: string;
    instruction: string;
    dueOn?: Date | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'person:read');

  const subject = resolveSubject(input.subjectKind, input.subjectSlug);
  if (!subject) {
    throw new PracticeError('unknown_subject', `The library has no ${input.subjectKind} called "${input.subjectSlug}".`);
  }

  const instruction = input.instruction?.trim();
  if (!instruction) {
    throw new PracticeError(
      'instruction_required',
      'An assignment without an instruction is a link. Say what you want worked on.'
    );
  }

  const assigner = await practitionerFor(db, ctx.principal);
  if (!assigner) {
    throw new PracticeError(
      'no_assigner',
      'An assignment records who gave it. Sign in with your own account rather than a shared credential.'
    );
  }

  const [row] = await db.insert(s.practiceAssignments).values({
    personId: input.personId,
    assignedByPersonId: assigner.personId,
    subjectKind: input.subjectKind,
    subjectSlug: input.subjectSlug,
    instruction,
    dueOn: input.dueOn ?? null,
    state: 'assigned',
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'practice_assignment',
    entityId: row.id,
    action: 'create',
    // The instruction itself is deliberately NOT in the audit payload: an audit
    // trail is read by more people than the record, and a teacher's note about a
    // named member's weaknesses is not general reading.
    newValue: { personId: input.personId, subjectKind: input.subjectKind, subjectSlug: input.subjectSlug },
  });

  return row;
}

/** The caller acknowledges an assignment. The furthest state a student can move it to. */
export async function acknowledgeAssignment(
  db: DB,
  principal: Principal | null | undefined,
  assignmentId: number
) {
  const me = await practitionerFor(db, principal);
  if (!me) throw new PracticeError('no_practitioner', 'Sign in with your own account.');

  const updated = await db
    .update(s.practiceAssignments)
    .set({ state: 'acknowledged', acknowledgedAt: new Date() })
    .where(and(
      eq(s.practiceAssignments.id, assignmentId),
      // Scoped to the caller's own row, so an id from someone else's list does
      // nothing rather than acknowledging their work for them.
      eq(s.practiceAssignments.personId, me.personId),
      eq(s.practiceAssignments.state, 'assigned'),
    ))
    .returning({ id: s.practiceAssignments.id });

  if (updated.length === 0) {
    throw new PracticeError('not_assigned_to_you', 'That assignment is not yours, or has already been answered.');
  }
  return updated[0];
}

/** Withdraw an assignment. A reason is required, as every refusal here is. */
export async function withdrawAssignment(
  db: DB,
  ctx: AuditContext,
  assignmentId: number,
  reason: string
) {
  assertCanAnywhere(ctx.principal, 'person:read');
  if (!reason?.trim()) {
    throw new PracticeError('reason_required', 'Withdrawing an assignment requires a reason.');
  }

  const updated = await db
    .update(s.practiceAssignments)
    .set({ state: 'withdrawn', withdrawnReason: reason.trim() })
    .where(eq(s.practiceAssignments.id, assignmentId))
    .returning({ id: s.practiceAssignments.id });

  if (updated.length === 0) throw new PracticeError('unknown_assignment', 'No such assignment.');

  await writeAudit(db, { ...ctx, reason: reason.trim() }, {
    entityType: 'practice_assignment',
    entityId: assignmentId,
    action: 'update',
    newValue: { state: 'withdrawn' },
  });
  return updated[0];
}

/** Assignments given to the caller, open ones first. */
export async function myAssignments(db: DB, principal: Principal | null | undefined, limit = 100) {
  const me = await practitionerFor(db, principal);
  if (!me) return [];
  const rows = await db
    .select()
    .from(s.practiceAssignments)
    .where(and(
      eq(s.practiceAssignments.personId, me.personId),
      inArray(s.practiceAssignments.state, ['assigned', 'acknowledged']),
    ))
    .orderBy(desc(s.practiceAssignments.assignedAt))
    .limit(limit);

  return rows.map((r: any) => ({ ...r, subject: resolveSubject(r.subjectKind, r.subjectSlug) }));
}

// ─── Summary ────────────────────────────────────────────────────────────────

/**
 * Counts by mark, for the caller's own page.
 *
 * DELIBERATELY NOT A PERCENTAGE, AND NOT A TOTAL AGAINST THE LIBRARY. "You have
 * watched 14% of Shotokan" is a progress bar toward a destination that does not
 * exist, and it is precisely the reading §44 forbids — the library is reference
 * material, not a course with an end.
 */
export async function myPracticeSummary(db: DB, principal: Principal | null | undefined) {
  const marks = await myMarks(db, principal, 1000);
  const byMark: Record<string, number> = {};
  for (const m of marks) byMark[m.mark] = (byMark[m.mark] ?? 0) + 1;
  return {
    total: marks.length,
    byMark,
    needsWork: marks.filter((m: any) => m.mark === 'needs_work'),
  };
}
