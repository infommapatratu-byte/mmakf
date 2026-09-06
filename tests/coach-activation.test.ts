// Approve-to-faculty: the join that made /teachers permanently empty.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT
// ─────────────────────────────────────────────────────────────────────────────
//
// `activateCoach()` is the only thing in the repository that creates a
// `coach_profiles` row with `status = 'active'`. `publicFaculty()` — the read
// behind the public /teachers page — returns only active profiles.
//
// `activateCoach()` had NO CALLER ANYWHERE IN `src/`.
//
// So the coach pipeline could run all the way to `approved` and stop. However
// many instructors MMAKF approved, the public faculty page could never contain
// one, and nothing failed anywhere: the module was written, tested and green.
// /admin/coaches even said so in its own frontmatter — "neither has a screen
// yet" — which is the honest description of a feature that does not work.
//
// The last test in this file is the one that would have caught it: it asserts
// the chain END TO END, from an application to a name on /teachers.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import {
  advanceCoachApplication, activateApprovedCoach, publicFaculty,
  COACH_TRANSITIONS, isCoachError,
} from '../src/db/coaches';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

/** Holds coach:review and coach:write. */
const manager: Principal = {
  userId: 1, label: 'coach manager',
  bindings: [{ role: 'COACH_MANAGER', scopeType: 'national', scopeId: null }],
};
/** Reads the pipeline and can do nothing to it. */
const auditor: Principal = {
  userId: 2, label: 'auditor',
  bindings: [{ role: 'AUDITOR', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = manager): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

let seq = 500;
async function application(over: Record<string, unknown> = {}) {
  const [a] = await db.insert(o.coachApplications).values({
    ref: `MMAKF-CA-2026-${String(seq++).padStart(6, '0')}`,
    fullName: 'Meera Nair',
    email: 'meera@example.invalid',
    city: 'Ranchi',
    danGrade: 'Sandan',
    status: 'candidate',
    ...over,
  }).returning();
  return a;
}

/** Walk the real stage machine to `approved`, as the screen makes an office do. */
async function approve(appId: number) {
  for (const to of ['screening', 'interview', 'technical_review', 'document_check', 'approved'] as const) {
    await advanceCoachApplication(db, ctx(), appId, to, {});
  }
}

beforeAll(async () => {
  const pg = new PGlite();
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });
  for (const id of [1, 2]) {
    await db.insert(s.users).values({ id, email: `u${id}@test.invalid`, status: 'active' }).onConflictDoNothing();
  }
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM coach_stage_events');
  await db.execute?.('DELETE FROM coach_applications');
  await db.execute?.('DELETE FROM coach_profiles');
  await db.execute?.('DELETE FROM audit_events');
  await db.execute?.('DELETE FROM persons');
});

// ─── The end-to-end chain ───────────────────────────────────────────────────

describe('an approved candidate reaches the public teaching faculty', () => {
  it('THE WHOLE POINT: application → stages → approved → active → /teachers', async () => {
    const app = await application();

    // Nobody is on the faculty, and nobody is in the register.
    expect(await publicFaculty(db)).toEqual([]);
    expect(await db.select().from(s.persons)).toHaveLength(0);

    await approve(app.id);

    // STILL nobody — approval is not activation, and this is exactly the state
    // the system was permanently stuck in.
    expect(await publicFaculty(db)).toEqual([]);
    expect(await db.select().from(s.persons)).toHaveLength(0);

    const { profile, personId, createdPerson } = await activateApprovedCoach(db, ctx(), app.id);
    expect(createdPerson).toBe(true);
    expect(profile.status).toBe('active');

    const faculty = await publicFaculty(db);
    expect(faculty).toHaveLength(1);
    expect(faculty[0].fullName).toBe('Meera Nair');

    // The person record carries the application it came from, so the register
    // can always answer where somebody entered it.
    const [person] = await db.select().from(s.persons).where(eq(s.persons.id, personId));
    expect(person.sourceRef).toBe(app.ref);
    expect(person.status).toBe('active');
  });

  it('reuses an existing person rather than creating a second', async () => {
    const [existing] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000900', fullName: 'Already Known', status: 'active',
    }).returning({ id: s.persons.id });

    const app = await application({ personId: existing.id, fullName: 'Already Known' });
    await approve(app.id);
    const { personId, createdPerson } = await activateApprovedCoach(db, ctx(), app.id);

    expect(createdPerson).toBe(false);
    expect(personId).toBe(existing.id);
    // ONE person. A coach who is already a member must not get a second record.
    expect(await db.select().from(s.persons)).toHaveLength(1);
  });

  it('is idempotent — a retried activation makes no second person or profile', async () => {
    const app = await application();
    await approve(app.id);
    const first = await activateApprovedCoach(db, ctx(), app.id);
    const again = await activateApprovedCoach(db, ctx(), app.id);

    // The first run set the application to 'active', so a naive second call
    // reported "the candidate is active, not approved" — an error message for
    // somebody who double-clicked or retried after a dropped connection. It
    // returns the first run's answer instead.
    expect(again.personId).toBe(first.personId);
    expect(again.profile.id).toBe(first.profile.id);
    expect(again.createdPerson).toBe(false);
    expect(await db.select().from(s.persons)).toHaveLength(1);
    expect(await db.select().from(o.coachProfiles)).toHaveLength(1);
    expect(await publicFaculty(db)).toHaveLength(1);
  });
});

// ─── The candidate who is not hired never enters the register ───────────────

describe('an unsuccessful candidate never becomes a person', () => {
  it('a rejected candidate leaves the register untouched', async () => {
    const app = await application();
    await advanceCoachApplication(db, ctx(), app.id, 'screening', {});
    await advanceCoachApplication(db, ctx(), app.id, 'rejected', { reason: 'No teaching history.' });

    expect(await db.select().from(s.persons)).toHaveLength(0);
    expect(await publicFaculty(db)).toEqual([]);
  });

  it('a rejection without a reason is refused', async () => {
    const app = await application();
    await advanceCoachApplication(db, ctx(), app.id, 'screening', {});
    await expect(advanceCoachApplication(db, ctx(), app.id, 'rejected', {}))
      .rejects.toMatchObject({ code: 'reason_required' });
  });

  it('an unapproved candidate cannot be activated', async () => {
    const app = await application();
    await advanceCoachApplication(db, ctx(), app.id, 'screening', {});
    await expect(activateApprovedCoach(db, ctx(), app.id))
      .rejects.toMatchObject({ code: 'not_approved' });
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });
});

// ─── The stages cannot be skipped ───────────────────────────────────────────

describe('the stage machine', () => {
  it('refuses a skipped stage, so an approval means the stages happened', async () => {
    const app = await application();
    await expect(advanceCoachApplication(db, ctx(), app.id, 'approved', {}))
      .rejects.toMatchObject({ code: 'bad_transition' });
  });

  it('the screen offers only the moves the machine permits', () => {
    // /admin/coaches builds its control from COACH_TRANSITIONS itself, so it
    // cannot suggest a transition the module then refuses. A second copy in the
    // page would drift the first time a stage was added.
    const page = readFileSync('src/pages/admin/coaches.astro', 'utf8');
    expect(page).toContain('COACH_TRANSITIONS');
    expect(page).not.toMatch(/const NEXT_STAGES\s*[:=]\s*\{/);
    expect(COACH_TRANSITIONS.approved).toContain('active');
    expect(COACH_TRANSITIONS.candidate).not.toContain('approved');
  });
});

// ─── Authority ──────────────────────────────────────────────────────────────

describe('authority', () => {
  it('an auditor can do neither', async () => {
    const app = await application();
    await expect(advanceCoachApplication(db, ctx(auditor), app.id, 'screening', {}))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(activateApprovedCoach(db, ctx(auditor), app.id))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the screen gates the two acts on two different actions', () => {
    const page = readFileSync('src/pages/admin/coaches.astro', 'utf8');
    // Moving somebody between stages and putting their name on the public
    // faculty are different authorities, and the page must not conflate them.
    expect(page).toContain("canAnywhere(principal!, 'coach:review')");
    expect(page).toContain("canAnywhere(principal!, 'coach:write')");
  });

  it('activation writes an audit row naming the actor', async () => {
    const app = await application();
    await approve(app.id);
    await activateApprovedCoach(db, ctx(), app.id);

    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'coach_profile'));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorLabel).toBe('coach manager');
  });
});
