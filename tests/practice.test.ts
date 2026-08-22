// Practice marks and assignments. §43, §44.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TEST THIS FILE EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// §44 is one sentence and it is the whole point:
//
//     Watching Bassai Dai does NOT make Bassai Dai "completed".
//
// A feature that lets a student tick things off is one schema change away from
// being read as attainment — by a report, by an export, by a well-meaning
// instructor, or by a future migration adding `grading_candidate_id` "just to
// link them". Every guard below is aimed at that single failure, and the first
// one reads information_schema rather than the source, because a comment
// promising the separation is not the separation.
//
// The rest are the ordinary refusals: a mark belongs to the person who made it
// and to nobody else, an unknown subject is refused on the way in rather than
// stored as a dangling slug, and withdrawing an assignment requires a reason.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql as raw } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  markPractice, clearPractice, myMarks, myMarkFor, myPracticeSummary,
  assignPractice, acknowledgeAssignment, withdrawAssignment, myAssignments,
  resolveSubject, isPracticeError, MARKS, MARK_LABEL,
} from '../src/db/practice';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let client: PGlite;
let STUDENT = 0, TEACHER = 0, OTHER = 0;

const student: Principal = {
  userId: 1, label: 'a student',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const teacher: Principal = {
  userId: 2, label: 'an instructor',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const stranger: Principal = {
  userId: 3, label: 'another member',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/** The shared office password: authenticated, and attributable to nobody. */
const shared: Principal = { userId: null, label: 'shared office password', bindings: [] };

const ctx = (p: Principal = teacher): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const people = await db.insert(s.persons).values([
    { federationId: 'MMAKF-MEM-2026-900001', fullName: 'A Student', status: 'active', dob: '2005-01-01', gender: 'female' },
    { federationId: 'MMAKF-MEM-2026-900002', fullName: 'An Instructor', status: 'active', dob: '1980-01-01', gender: 'male' },
    { federationId: 'MMAKF-MEM-2026-900003', fullName: 'Another Member', status: 'active', dob: '2004-01-01', gender: 'male' },
  ]).returning({ id: s.persons.id });
  [STUDENT, TEACHER, OTHER] = people.map((p: any) => p.id);

  await db.insert(s.users).values([
    { id: 1, email: 'student@mmakf.in', status: 'active', personId: STUDENT },
    { id: 2, email: 'teacher@mmakf.in', status: 'active', personId: TEACHER },
    { id: 3, email: 'other@mmakf.in', status: 'active', personId: OTHER },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a practice record can never become examination evidence', () => {
  it('references nothing but persons — asserted against the catalogue, not the comment', async () => {
    // THE GUARD THE WHOLE FEATURE RESTS ON.
    //
    // If either table ever gains a foreign key into the grading engine, a tick a
    // member gave themselves becomes reachable from a certificate. Reading
    // information_schema means the assertion cannot be satisfied by editing a
    // comment, and it fails on the migration that introduces the link rather
    // than on the report that exposes it a year later.
    const rows: any = await db.execute(raw`
      SELECT tc.table_name, ccu.table_name AS refs
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name IN ('practice_marks', 'practice_assignments')
    `);
    const list = (rows.rows ?? rows) as Array<{ refs: string }>;
    expect(list.length).toBeGreaterThan(0);
    const targets = [...new Set(list.map((r) => r.refs))].sort();
    expect(targets, 'practice tables reference something other than persons').toEqual(['persons']);
  });

  it('nothing in the grading engine points back at practice either', async () => {
    // The other direction. A grading table with a `practice_mark_id` would be
    // the same failure wearing the opposite hat.
    const rows: any = await db.execute(raw`
      SELECT tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name IN ('practice_marks', 'practice_assignments')
    `);
    const list = (rows.rows ?? rows) as Array<{ table_name: string }>;
    expect(list.map((r) => r.table_name)).toEqual([]);
  });

  it('offers no terminal state a student could read as completion', () => {
    // §44 again. The vocabulary is the guard: there is nothing to press that
    // says "done", so there is nothing for a report to count as done.
    for (const forbidden of ['completed', 'complete', 'mastered', 'passed', 'achieved', 'certified']) {
      expect(MARKS as readonly string[], `"${forbidden}" is markable`).not.toContain(forbidden);
    }
    expect(MARKS).toEqual(['watched', 'practising', 'needs_work', 'bookmarked']);
  });

  it('says out loud that watching is not progress', () => {
    // The help text is the feature. A student choosing "Watched" must not come
    // away thinking they have advanced toward a grade.
    expect(MARK_LABEL.watched.help).toMatch(/not\s+progress|not\s+a\s+claim|nothing more/i);
    expect(MARK_LABEL.needs_work.help.length).toBeGreaterThan(30);
  });

  it('stores every mark flagged as a self-report', async () => {
    await markPractice(db, student, { subjectKind: 'kata', subjectSlug: 'bassai-dai', mark: 'watched' });
    const row = await myMarkFor(db, student, 'kata', 'bassai-dai');
    expect(row.selfReported).toBe(true);
  });

  it('has no score, percentage or completion column anywhere', () => {
    const src = readFileSync('src/db/practice.schema.ts', 'utf8');
    for (const forbidden of ['score', 'percent', 'completed_at', 'passed', 'grade']) {
      expect(src.toLowerCase(), `practice.schema.ts declares a ${forbidden} column`)
        .not.toMatch(new RegExp(`\\b${forbidden}\\b\\s*:\\s*(integer|boolean|timestamp|text)\\(`));
    }
  });

  it('reports no progress percentage against the library', async () => {
    // "You have watched 14% of Shotokan" is a progress bar toward a destination
    // that does not exist. The summary deliberately cannot produce one.
    const summary = await myPracticeSummary(db, student);
    expect(Object.keys(summary)).toEqual(['total', 'byMark', 'needsWork']);
    expect(JSON.stringify(summary)).not.toMatch(/percent/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a mark belongs to the person who made it', () => {
  it('writes to the caller and takes no personId to get wrong', async () => {
    await markPractice(db, student, { subjectKind: 'technique', subjectSlug: 'gyaku-zuki', mark: 'needs_work' });
    const mine = await myMarks(db, student);
    const theirs = await myMarks(db, stranger);
    expect(mine.some((m: any) => m.subjectSlug === 'gyaku-zuki')).toBe(true);
    expect(theirs.some((m: any) => m.subjectSlug === 'gyaku-zuki')).toBe(false);
  });

  it('refuses a shared credential, which identifies nobody', async () => {
    await expect(
      markPractice(db, shared, { subjectKind: 'kata', subjectSlug: 'jion', mark: 'watched' })
    ).rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'no_practitioner');
  });

  it('re-marking updates rather than duplicating', async () => {
    await markPractice(db, student, { subjectKind: 'kata', subjectSlug: 'unsu', mark: 'watched' });
    await markPractice(db, student, { subjectKind: 'kata', subjectSlug: 'unsu', mark: 'needs_work' });
    const rows = (await myMarks(db, student)).filter((m: any) => m.subjectSlug === 'unsu');
    expect(rows.length).toBe(1);
    expect(rows[0].mark).toBe('needs_work');
  });

  it('clears only the caller’s own mark', async () => {
    await markPractice(db, stranger, { subjectKind: 'kata', subjectSlug: 'empi', mark: 'bookmarked' });
    await markPractice(db, student, { subjectKind: 'kata', subjectSlug: 'empi', mark: 'bookmarked' });
    expect(await clearPractice(db, student, 'kata', 'empi')).toBe(true);
    expect(await myMarkFor(db, student, 'kata', 'empi')).toBeNull();
    expect(await myMarkFor(db, stranger, 'kata', 'empi')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('subjects are resolved against the library, never stored blind', () => {
  it('resolves each kind the directive names', () => {
    expect(resolveSubject('technique', 'gyaku-zuki')?.title).toBe('Gyaku-zuki');
    expect(resolveSubject('kata', 'bassai-dai')?.title).toBe('Bassai Dai');
    expect(resolveSubject('kumite', 'sen-no-sen')?.title).toBe('Sen-no-sen');
    expect(resolveSubject('kumite', 'gohon-kumite')?.title).toBe('Gohon kumite');
  });

  it('refuses an unknown subject rather than storing a dangling slug', async () => {
    await expect(
      markPractice(db, student, { subjectKind: 'technique', subjectSlug: 'not-a-technique', mark: 'watched' })
    ).rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'unknown_subject');
  });

  it('refuses a mark that is not in the vocabulary', async () => {
    await expect(
      markPractice(db, student, { subjectKind: 'kata', subjectSlug: 'jion', mark: 'completed' as any })
    ).rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'bad_mark');
  });

  it('every stored slug still resolves', async () => {
    // The cost of a polymorphic subject is that Postgres cannot enforce it. This
    // is where that cost is paid back: an orphaned mark renders as a blank line
    // forever and nobody can explain it later.
    for (const m of await myMarks(db, student, 1000)) {
      expect(m.subject, `${m.subjectKind}/${m.subjectSlug} no longer resolves`).not.toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('assignment records the instruction and nothing about the outcome', () => {
  it('an instructor can assign, and it is audited', async () => {
    const row = await assignPractice(db, ctx(teacher), {
      personId: STUDENT, subjectKind: 'technique', subjectSlug: 'mae-geri',
      instruction: 'Chamber only, held for a count, both legs, every session this week.',
    });
    expect(row.state).toBe('assigned');

    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'practice_assignment'));
    expect(audit.length).toBeGreaterThan(0);
    // The instruction is about a named member and is deliberately NOT in the
    // audit payload — an audit trail is read by more people than the record.
    expect(JSON.stringify(audit[0].newValue)).not.toMatch(/Chamber only/);
  });

  it('refuses an assignment with no instruction', async () => {
    await expect(
      assignPractice(db, ctx(teacher), {
        personId: STUDENT, subjectKind: 'kata', subjectSlug: 'jion', instruction: '   ',
      })
    ).rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'instruction_required');
  });

  it('a student can acknowledge their own, and cannot touch somebody else’s', async () => {
    const row = await assignPractice(db, ctx(teacher), {
      personId: STUDENT, subjectKind: 'kata', subjectSlug: 'heian-nidan', instruction: 'Slowly, watching the stance width.',
    });
    await expect(acknowledgeAssignment(db, stranger, row.id))
      .rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'not_assigned_to_you');
    const done = await acknowledgeAssignment(db, student, row.id);
    expect(done.id).toBe(row.id);
  });

  it('offers no way for a student to mark an assignment complete', async () => {
    // Acknowledged is the furthest a student can move it: they have seen it.
    // That is a fact about a notification, not about karate.
    const src = readFileSync('src/db/practice.ts', 'utf8');
    expect(src).not.toMatch(/completeAssignment|markAssignmentComplete|signOff/);
    const states = readFileSync('src/db/practice.schema.ts', 'utf8');
    expect(states).toMatch(/assignmentState/);
    expect(states).not.toMatch(/'completed'|'passed'|'signed_off'/);
  });

  it('withdrawing requires a reason, and the database refuses it too', async () => {
    const row = await assignPractice(db, ctx(teacher), {
      personId: STUDENT, subjectKind: 'kata', subjectSlug: 'jitte', instruction: 'For the grading you are not entered for.',
    });
    await expect(withdrawAssignment(db, ctx(teacher), row.id, '  '))
      .rejects.toSatisfy((e: unknown) => isPracticeError(e) && (e as any).code === 'reason_required');

    // And the CHECK constraint refuses it independently of the module, because a
    // module check is a promise and a constraint is a guarantee.
    await expect(
      client.exec(`UPDATE practice_assignments SET state='withdrawn' WHERE id=${row.id}`)
    ).rejects.toThrow(/withdrawn_needs_reason/);

    await withdrawAssignment(db, ctx(teacher), row.id, 'Entered for a later grading instead.');
    const open = await myAssignments(db, student);
    expect(open.some((a: any) => a.id === row.id)).toBe(false);
  });

  it('lists a student’s own assignments with the subject resolved', async () => {
    const list = await myAssignments(db, student);
    expect(list.length).toBeGreaterThan(0);
    for (const a of list) expect(a.subject).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('multi-angle recordings', () => {
  it('ships empty, which is the honest state', async () => {
    const groups = await db.select().from(s.mediaAngleGroups);
    expect(groups).toEqual([]);
  });

  it('allows several recordings whose camera position was never written down', async () => {
    // The partial index excludes 'unknown' on purpose: an unrecorded position is
    // the normal state, and a constraint that refused the second one would push
    // somebody into inventing an angle to get past it.
    const [asset1] = await db.insert(s.mediaAssets).values({
      platform: 'youtube', externalId: 'angletest001', url: 'https://example.invalid/1', title: 'One',
    }).returning({ id: s.mediaAssets.id });
    const [asset2] = await db.insert(s.mediaAssets).values({
      platform: 'youtube', externalId: 'angletest002', url: 'https://example.invalid/2', title: 'Two',
    }).returning({ id: s.mediaAssets.id });

    const [group] = await db.insert(s.mediaAngleGroups).values({
      slug: 'test-performance', title: 'A test performance',
    }).returning({ id: s.mediaAngleGroups.id });

    await db.insert(s.mediaAngleMembers).values({ groupId: group.id, mediaAssetId: asset1.id });
    await db.insert(s.mediaAngleMembers).values({ groupId: group.id, mediaAssetId: asset2.id });

    const members = await db.select().from(s.mediaAngleMembers).where(eq(s.mediaAngleMembers.groupId, group.id));
    expect(members.length).toBe(2);
    expect(members.every((m: any) => m.angle === 'unknown')).toBe(true);
    // And an unmeasured offset is NULL, not zero — zero would assert alignment.
    expect(members.every((m: any) => m.offsetMs === null)).toBe(true);
  });

  it('refuses two cameras claiming the same position at the same speed', async () => {
    const [g] = await db.select().from(s.mediaAngleGroups).where(eq(s.mediaAngleGroups.slug, 'test-performance'));
    const members = await db.select().from(s.mediaAngleMembers).where(eq(s.mediaAngleMembers.groupId, g.id));
    await db.update(s.mediaAngleMembers).set({ angle: 'front' }).where(eq(s.mediaAngleMembers.id, members[0].id));

    // Drizzle wraps the driver error as "Failed query: …" and puts the real one
    // on `cause`. Asserting on the wrapper's message would pass for ANY failed
    // update — including one that failed for the wrong reason — so the
    // constraint name is read off the cause chain instead.
    let caught: any = null;
    try {
      await db.update(s.mediaAngleMembers).set({ angle: 'front' }).where(eq(s.mediaAngleMembers.id, members[1].id));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'a second front camera was accepted').not.toBeNull();
    const chain = [caught?.message, caught?.cause?.message, caught?.cause?.constraint_name, caught?.cause?.detail]
      .filter(Boolean).join(' | ');
    expect(chain, `rejected, but not by the angle index: ${chain}`).toMatch(/media_angle_members_angle_uk/);
  });
});
