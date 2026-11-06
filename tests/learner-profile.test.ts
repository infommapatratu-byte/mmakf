// A new student can go from "I registered" to "I paid for a course" on their own,
// and an existing member links the record they already have instead of becoming two.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createUser, resolvePrincipal } from '../src/db/users';
import { claimMemberRecord, createLearnerProfile, ageOn, normalisePhone } from '../src/db/learner-profile';
import { importFeeMaster } from '../src/db/fee-register';
import { startCoursePayment } from '../src/db/course-payments';
import { legacyAdminPrincipal } from '../src/lib/rbac';

const NOW = new Date('2026-11-07T06:00:00Z');

describe('small rules', () => {
  it('age is counted to the birthday, not the year', () => {
    expect(ageOn('2008-11-07', NOW)).toBe(18);
    expect(ageOn('2008-11-08', NOW)).toBe(17);
  });
  it('mobile numbers compare on their last ten digits', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('09876543210')).toBe('9876543210');
    expect(normalisePhone('12345')).toBeNull();
  });
  it('the member page offers both doors and posts to the profile API', () => {
    const page = readFileSync('src/pages/my/index.astro', 'utf8');
    expect(page).toContain('id="claimForm"');
    expect(page).toContain('id="createForm"');
    expect(page).toContain('/api/my/profile');
  });
});

describe('the self-service member record, against a real schema', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
  const account = async (email: string) => createUser(db, { email, password: 'correct horse battery staple 1' } as any);

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2019-000042', fullName: 'Existing Member', dob: '1990-05-15',
      email: 'old-address@example.com', phone: '9000000042', status: 'active',
    });
  }, 120_000);

  it('an existing member links their own record with member ID and date of birth', async () => {
    const u = await account('member@example.com');
    const r = await claimMemberRecord(db, { userId: u.id, federationId: 'mmakf-mem-2019-000042', dob: '1990-05-15' });
    expect(r).toMatchObject({ federationId: 'MMAKF-MEM-2019-000042', fullName: 'Existing Member' });
    const [row] = await db.select().from(s.users).where(eq(s.users.id, u.id));
    expect(row.personId).toBe(r.personId);
    // The record's own address is told, so a claim with someone else's details is noticed.
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.personId, r.personId));
    expect(notes.some((n: any) => n.channel === 'email' && /linked to a sign-in/.test(n.title))).toBe(true);
  });

  it('a wrong date of birth and an unknown ID get the same answer, so IDs cannot be discovered', async () => {
    const u = await account('prober@example.com');
    const a = await claimMemberRecord(db, { userId: u.id, federationId: 'MMAKF-MEM-2019-000042', dob: '1991-01-01' }).catch((e) => e);
    const b = await claimMemberRecord(db, { userId: u.id, federationId: 'MMAKF-MEM-1900-999999', dob: '1990-05-15' }).catch((e) => e);
    expect(a.code).toBe('no_match');
    expect(b.code).toBe('no_match');
    expect(a.message).toBe(b.message);
  });

  it('one record, one account: a record already linked elsewhere is refused', async () => {
    const u = await account('second@example.com');
    await expect(claimMemberRecord(db, { userId: u.id, federationId: 'MMAKF-MEM-2019-000042', dob: '1990-05-15' }))
      .rejects.toMatchObject({ code: 'linked_elsewhere' });
  });

  it('a new adult creates a learner record with a register ID, linked to their account', async () => {
    const u = await account('newcomer@example.com');
    const r = await createLearnerProfile(db, { userId: u.id, fullName: '  Asha   Kumari ', dob: '1998-03-02', phone: '+91 91234 56789', city: 'Ranchi' }, NOW);
    expect(r.federationId).toMatch(/^MMAKF-MEM-\d{4}-\d{6}$/);
    const [p] = await db.select().from(s.persons).where(eq(s.persons.id, r.personId));
    expect(p).toMatchObject({ fullName: 'Asha Kumari', dob: '1998-03-02', phone: '9123456789', email: 'newcomer@example.com', status: 'pending' });
    const [row] = await db.select().from(s.users).where(eq(s.users.id, u.id));
    expect(row.personId).toBe(r.personId);
    await expect(createLearnerProfile(db, { userId: u.id, fullName: 'Again', dob: '1998-03-02', phone: '9123456789' }, NOW))
      .rejects.toMatchObject({ code: 'already_linked' });
  });

  it('never a second record for an existing member: same email or same mobile is sent to the claim door', async () => {
    const u = await account('old-address@example.com');
    await expect(createLearnerProfile(db, { userId: u.id, fullName: 'Existing Member', dob: '1990-05-15', phone: '9999999999' }, NOW))
      .rejects.toMatchObject({ code: 'possible_duplicate' });
    const v = await account('different@example.com');
    await expect(createLearnerProfile(db, { userId: v.id, fullName: 'Someone', dob: '1990-05-15', phone: '+91 90000 00042' }, NOW))
      .rejects.toMatchObject({ code: 'possible_duplicate' });
  });

  it('a child is not created through self-service', async () => {
    const u = await account('teen@example.com');
    await expect(createLearnerProfile(db, { userId: u.id, fullName: 'Young Learner', dob: '2012-01-01', phone: '9876500000' }, NOW))
      .rejects.toMatchObject({ code: 'minor' });
  });

  it('the whole journey: register -> create record -> pay for a course, as an ordinary account with no role', async () => {
    await importFeeMaster(db, { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any);
    const [course] = await db.insert(s.courses).values({
      slug: 'journey-course', title: 'Course 01 – Taste the Discipline', status: 'published',
      feeCode: 'course.shotokan.01-taste-the-discipline',
    }).returning();

    const u = await account('journey@example.com');
    const created = await createLearnerProfile(db, { userId: u.id, fullName: 'Journey Learner', dob: '1995-07-07', phone: '9811111111' }, NOW);
    const [userRow] = await db.select().from(s.users).where(eq(s.users.id, u.id));
    const principal = await resolvePrincipal(db, u.id, userRow.sessionEpoch ?? 0);
    expect(principal).toBeTruthy();
    expect(principal!.bindings ?? []).toHaveLength(0);   // a plain learner: no role at all

    const started = await startCoursePayment(db, { principal, reason: null, authority: 'user' } as any, {
      courseId: course.id, personId: created.personId, buyerName: 'Journey Learner', email: 'journey@example.com',
    });
    expect(started).toMatchObject({ totalPaise: 800000, reused: false });
    const [enrolment] = await db.select().from(s.enrolments)
      .where(and(eq(s.enrolments.courseId, course.id), eq(s.enrolments.personId, created.personId)));
    expect(enrolment.status).toBe('pending_payment');
  });
});
