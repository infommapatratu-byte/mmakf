// THE PARENT-AND-CHILD JOURNEY, end to end, twice.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE THIS FILE GUARDS
// ═════════════════════════════════════════════════════════════════════════════
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//
// A parent registers a child, finds a club, finds a class, chooses training,
// is quoted, pays, and the child trains. At NO POINT in that sequence may the
// system ask for a membership, a subscription, a registration fee, a platform
// fee or an account fee — and "at no point" is asserted at every stage rather
// than once at the end, because a single closing assertion cannot tell you
// WHERE a membership crept in, and a membership that crept in at stage three
// is invisible to a test that only looks at stage twelve.
//
// Every invoice line the journey produces is walked, one at a time, and each is
// checked against the four forbidden shapes. A count is not enough: an order
// with one training line and one "annual registration" line has the right
// number of lines and the wrong content.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND WHERE THE CHAIN ACTUALLY STOPS TODAY
// ═════════════════════════════════════════════════════════════════════════════
//
// MMAKF has published no fee framework. activeFramework() returns null, every
// pricing path ends at "the federation has not published a fee for this", and
// the journey therefore reaches the price and goes no further. PART ONE asserts
// exactly that — the true boundary, named, with the tables that stay empty
// listed one by one.
//
// A test that pretended the whole journey completed today would be worse than
// no test at all: it would report a working checkout to a federation that has
// no prices, and the first person to trust it would be a parent.
//
// PART TWO then publishes a framework and carries the same calls through to a
// training entitlement, a class booking, a calendar, a notification, attendance
// and a receipt. NOT ONE LINE OF SOURCE CHANGES BETWEEN THE TWO PARTS. What
// changes is data the federation enters.
//
// PART THREE is the money and safeguarding spine: a replayed webhook, a gateway
// figure that disagrees with the server's, a refund, an expiry, and a minor's
// record.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE FOUND, AND DID NOT PAPER OVER
// ═════════════════════════════════════════════════════════════════════════════
//
// Four boundaries are asserted as they ARE rather than as they ought to be.
// Each is marked FINDING where it appears, and each has a test whose name says
// what is missing:
//
//   1. TWO FEE REGISTERS, AND PUBLISHING ONE DOES NOT OPEN CHECKOUT.
//      The figure a surface SHOWS comes from `fee_frameworks` through feeFor().
//      The figure createOrder() CHARGES comes from `fee_schedule`. Publishing a
//      framework makes the price appear and leaves the checkout refusing.
//
//   2. THE QUOTATION ROUTE ENTITLES NOBODY. createPaymentLink() raises its
//      order line as `kind: 'other'`, and subjectForLine() maps 'other' to
//      nothing — so a fully paid quotation produces `not_entitling` and no
//      training entitlement at all.
//
//   3. A PARENT CANNOT BOOK THEIR OWN CHILD'S CLASS. bookClassSession() asks
//      "is this you?" then "do you hold booking:write?". It never asks
//      guardianCan(), so the `manage_enrolment` capability the federation
//      grants a guardian buys nothing at the one place a parent would use it.
//
//   4. NOTHING TELLS THE PARENT. ENTITLEMENT_ACTIVATED is absent from
//      NOTIFIABLE, and every audience that IS resolved resolves to the CHILD's
//      person id. The guardian's inbox stays empty through payment, activation,
//      booking and cancellation alike.
//
// ═════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═════════════════════════════════════════════════════════════════════════════
//
// Every name is fictional and every address is on the reserved .example domain.
// EVERY RUPEE FIGURE IN PART TWO IS A TEST FIXTURE AND IS NOT AN MMAKF FEE. The
// federation has published none; the numbers here exist only so that "the same
// code prices this once a framework exists" can be demonstrated at all, and
// they are chosen to look like nothing anybody would mistake for a real rate.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';

import * as s from '../src/db/schema';
import * as ops from '../src/db/operations.schema';
import * as sch from '../src/db/scheduling.schema';

import { createPerson, type AuditContext } from '../src/db/federation';
import {
  assertRelationship, decideRelationship, grantGuardianCapability,
  guardianCan, dependantsOf, guardiansOf, isMinor, ageOn,
} from '../src/db/identity';
import { findClubs, clubProfile } from '../src/db/clubs';
import {
  createSchedule, draftVersion, publishVersion,
  createClass, generateSessions, bookableSessions, bookClassSession,
  cancelSession, personalSchedule,
} from '../src/db/scheduling';
import {
  seedFeeCatalogue, feeFor, isPriced, isNotConfigured, requireAmountMinor,
  renderFee, FEE_NOTICE, FEE_CATALOGUE_SEED, FEE_NOT_CONFIGURED,
  type FeeResult, type UnpricedFee,
} from '../src/db/fee-catalogue';
import { feeAvailability, todayIsoForFees } from '../src/lib/training-fee-state';
import {
  createFramework, addRule, publishFramework, activeFramework, computeFee,
} from '../src/db/fees';
import {
  createOrder, beginPayment, confirmPayment, recordWebhook, markWebhookProcessed,
  requestRefund, completeRefund, issueInvoice, OrderError,
} from '../src/db/orders';
import {
  activateForOrder, configureTerm, revokeForRefund, subjectForLine,
  activationBacklog, entitlementsForOrder,
} from '../src/db/entitlements';
import {
  registerParticipant, scheduleSession, programStanding, resourceAccess,
} from '../src/db/activation';
import { recordAttendance, deliverSession, participantAttendance } from '../src/db/programme-lifecycle';
import { verifyCredential } from '../src/db/grading';
import { notifyForEvent, NOTIFIABLE } from '../src/lib/notifications';
import { PROPOSED_RULES } from '../src/data/proposed-fees';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';

// ─── The service the journey is about ───────────────────────────────────────

/** The federation's own catalogue code for parent-and-child training. */
const TRAINING = 'MMAKF-FEE-TRN-PARENT-CHILD';

/**
 * The shapes a student must never be charged.
 *
 * Applied to every order line description, every invoice snapshot line and
 * every fee code the journey touches. `registration` is here because it is the
 * one that always comes back wearing a different hat.
 */
const FORBIDDEN_CHARGE = /membership|subscription|registration\s*fee|joining\s*fee|platform\s*fee|account\s*fee|annual\s*fee/i;

/** Order line kinds that would be a student paying to exist. */
const FORBIDDEN_KINDS = ['membership', 'affiliation'];

/**
 * Narrow to the unpriced arm, or fail with the figure that was found.
 *
 * `expect(isNotConfigured(x)).toBe(true)` satisfies the runtime and tells the
 * COMPILER nothing, so `.notice` and `.reason` below would be reads against a
 * union that might be priced. This throws instead — and the message names the
 * amount, because "a fee appeared where the federation has published none" is
 * the failure a reader most needs spelled out.
 */
function unpriced(result: FeeResult): UnpricedFee {
  if (!isNotConfigured(result)) {
    throw new Error(
      `Expected no published fee for ${result.serviceCode}, and found ${result.amountMinor} paise ` +
      `from framework ${result.frameworkCode}.`
    );
  }
  return result;
}

let db: any;
let client: any;

let STATE: number, DISTRICT: number, CLUB: number, VENUE: number;
let PARENT: number, CHILD: number, COACH: number;
let STRANGER: number, STRANGER_CHILD: number;
let CLASS: number;
let SESSION_A: number, SESSION_B: number;
let RELATIONSHIP: number;
let PROGRAM: number;
let CERTIFICATE_NO: string;

// Carried between PART TWO's stages — the journey is one sequence, not twelve
// unrelated facts.
let ORDER: any;
let PAYMENT: any;
let INVOICE: any;
let ENTITLEMENT: any;
let PARTICIPANT: number;
let BOOKING_REF: string;
let FRAMEWORK: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** The club that actually runs the class. */
let clubAdmin: Principal;
/**
 * The parent, holding the PARENT role and NOTHING else.
 *
 * This is the principal the whole safeguarding half of the file turns on: every
 * refusal below has to come from the guardianship record, not from the role, so
 * the role deliberately carries no person:read_pii and no booking:write.
 */
let parentUser: Principal;
/** Another parent, of another child. Used to prove the negative. */
let strangerUser: Principal;

const ctx = (p: Principal = admin): AuditContext =>
  ({ principal: p, reason: 'parent-and-child journey test', authority: 'test' });

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

/** Rows in the register that would mean somebody was charged for existing. */
const memberships = () => db.select().from(s.memberships);
const orders = () => db.select().from(s.orders);
const orderLines = () => db.select().from(s.orderLines);
const entitlements = () => db.select().from(s.entitlements);
const invoices = () => db.select().from(s.invoices);
const payments = () => db.select().from(s.payments);
const bookings = () => db.select().from(s.bookings);
const notifications = () => db.select().from(s.notifications);

/**
 * THE ASSERTION THIS FILE EXISTS FOR, in one callable.
 *
 * Called at the end of EVERY stage. It walks the register rather than counting
 * it: a membership row, a membership entitlement, a membership order line and a
 * line merely DESCRIBED as a subscription are four different ways for the same
 * defect to arrive, and only the last one is invisible to a row count.
 */
async function assertNobodyWasAskedForAMembership(stage: string) {
  const mem = await memberships();
  expect(mem, `${stage}: a membership was issued to somebody on the training journey`).toEqual([]);

  const ents = await entitlements();
  expect(
    ents.filter((e: any) => e.subject === 'membership'),
    `${stage}: a membership entitlement was created`
  ).toEqual([]);

  const lines = await orderLines();
  for (const line of lines) {
    expect(
      FORBIDDEN_KINDS.includes(line.kind),
      `${stage}: order line ${line.id} is a ${line.kind} line`
    ).toBe(false);
    expect(
      FORBIDDEN_CHARGE.test(String(line.description ?? '')),
      `${stage}: order line ${line.id} is described as "${line.description}"`
    ).toBe(false);
    expect(
      FORBIDDEN_CHARGE.test(String(line.feeCode ?? '')),
      `${stage}: order line ${line.id} carries fee code "${line.feeCode}"`
    ).toBe(false);
  }

  // The receipts, too. An invoice freezes its own snapshot of the lines, and a
  // snapshot is what a family keeps — so the snapshot is checked, not just the
  // live rows it was taken from.
  for (const inv of await invoices()) {
    const snapshot = JSON.stringify(inv.snapshot ?? {});
    expect(
      FORBIDDEN_CHARGE.test(snapshot),
      `${stage}: invoice ${inv.invoiceNo} froze a snapshot naming a membership or registration fee`
    ).toBe(false);
  }
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // ── Geography, a club, a hall ────────────────────────────────────────────
  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand Association', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;

  const [dist] = await db.insert(s.districtUnits).values({
    code: 'MMAKF-DIST-JH-RMG', stateUnitId: STATE, district: 'Ramgarh',
    name: 'Ramgarh District', status: 'active',
  }).returning({ id: s.districtUnits.id });
  DISTRICT = dist.id;

  const [club] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-RMG-01', name: 'MMAKF Ramgarh Centre', slug: 'mmakf-ramgarh-centre',
    stateUnitId: STATE, districtUnitId: DISTRICT, city: 'Ramgarh', status: 'active',
  }).returning({ id: s.dojos.id });
  CLUB = club.id;

  const [venue] = await db.insert(ops.venues).values({
    code: 'V-RMG', name: 'Ramgarh training hall', kind: 'dojo', dojoId: CLUB,
    stateUnitId: STATE, districtUnitId: DISTRICT, timezone: 'Asia/Kolkata', slug: 'ramgarh-hall',
  }).returning({ id: ops.venues.id });
  VENUE = venue.id;

  // ── The family ───────────────────────────────────────────────────────────
  //
  // The child's date of birth is fixed rather than derived from today, so the
  // age assertions below mean the same thing in every future year this suite
  // runs. `asOf` is supplied wherever age is asked about.
  const parent = await createPerson(db, ctx(), {
    fullName: 'Anita Mahto', stateUnitId: STATE, districtUnitId: DISTRICT,
    dojoId: CLUB, dob: '1990-04-11', gender: 'female', status: 'active',
  });
  PARENT = parent.id;

  const child = await createPerson(db, ctx(), {
    fullName: 'Ishan Mahto', stateUnitId: STATE, districtUnitId: DISTRICT,
    dojoId: CLUB, dob: '2017-06-02', gender: 'male', status: 'active',
  });
  CHILD = child.id;

  const coach = await createPerson(db, ctx(), {
    fullName: 'Sensei Vikas Pathak', stateUnitId: STATE, districtUnitId: DISTRICT,
    dojoId: CLUB, dob: '1985-01-20', gender: 'male', status: 'active',
  });
  COACH = coach.id;

  const stranger = await createPerson(db, ctx(), {
    fullName: 'Rohit Kujur', stateUnitId: STATE, districtUnitId: DISTRICT,
    dojoId: CLUB, dob: '1988-09-30', gender: 'male', status: 'active',
  });
  STRANGER = stranger.id;

  const strangerChild = await createPerson(db, ctx(), {
    fullName: 'Meera Kujur', stateUnitId: STATE, districtUnitId: DISTRICT,
    dojoId: CLUB, dob: '2016-02-14', gender: 'female', status: 'active',
  });
  STRANGER_CHILD = strangerChild.id;

  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.example', status: 'active' },
    { id: 2, email: 'anita.mahto@example.com', status: 'active', personId: PARENT },
    { id: 3, email: 'club@mmakf.example', status: 'active' },
    { id: 4, email: 'rohit.kujur@example.com', status: 'active', personId: STRANGER },
  ]);

  clubAdmin = { userId: 3, label: 'club administrator', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB }] };
  parentUser = { userId: 2, label: 'a parent', bindings: [{ role: 'PARENT', scopeType: 'dojo', scopeId: CLUB }] };
  strangerUser = { userId: 4, label: 'another parent', bindings: [{ role: 'PARENT', scopeType: 'dojo', scopeId: CLUB }] };

  // ── Guardianship: asserted, decided, then granted one capability at a time ─
  const claim = await assertRelationship(db, ctx(), {
    holderPersonId: PARENT, subjectPersonId: CHILD, type: 'parent',
    evidence: { document: 'birth certificate', seenBy: 'club office' },
  });
  RELATIONSHIP = claim.id;
  await decideRelationship(db, ctx(), {
    relationshipId: RELATIONSHIP, decision: 'verified',
    reason: 'Birth certificate seen at the club office.',
  });
  for (const capability of ['view_profile', 'view_attendance', 'pay', 'manage_enrolment'] as const) {
    await grantGuardianCapability(db, ctx(), { relationshipId: RELATIONSHIP, capability });
  }

  // The other family, so "nobody else" has somebody to be.
  const otherClaim = await assertRelationship(db, ctx(), {
    holderPersonId: STRANGER, subjectPersonId: STRANGER_CHILD, type: 'parent',
  });
  await decideRelationship(db, ctx(), {
    relationshipId: otherClaim.id, decision: 'verified', reason: 'Birth certificate seen.',
  });
  await grantGuardianCapability(db, ctx(), { relationshipId: otherClaim.id, capability: 'view_attendance' });

  // ── The federation's service catalogue. Codes only; not one amount. ──────
  await seedFeeCatalogue(db, ctx());

  // ── The club's own timetable, published by the club ──────────────────────
  const hallSchedule = await createSchedule(db, ctx(clubAdmin), {
    name: 'Ramgarh hall hours', purpose: 'training',
    owner: { scope: 'dojo', id: CLUB }, venueId: VENUE,
  });
  const hallVersion = await draftVersion(db, ctx(clubAdmin), hallSchedule.id, {
    effectiveFrom: '2026-01-01',
    rules: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, opensAt: '06:00', closesAt: '21:00' })),
  });
  await publishVersion(db, ctx(clubAdmin), hallVersion.id, 'Opening hours agreed at the January committee');

  const klass = await createClass(db, ctx(clubAdmin), {
    name: 'Parent and child karate', slug: 'parent-and-child-karate',
    owner: { scope: 'dojo', id: CLUB }, venueId: VENUE, mode: 'at_dojo',
    summary: 'A weekly class a parent trains alongside their child in.',
    discipline: 'shotokan', level: 'beginner', audience: 'kids',
    ageMin: 5, ageMax: 12, capacity: 12,
    defaultCoachPersonId: COACH, requiresBooking: true, publicVisible: true, activate: true,
  });
  CLASS = klass.id;

  const classSchedule = await createSchedule(db, ctx(clubAdmin), {
    name: 'Parent and child times', purpose: 'class',
    owner: { scope: 'dojo', id: CLUB }, classId: CLASS,
  });
  const classVersion = await draftVersion(db, ctx(clubAdmin), classSchedule.id, {
    effectiveFrom: '2026-01-01',
    rules: [{ dayOfWeek: 1, opensAt: '17:30', closesAt: '18:30' }],
  });
  await publishVersion(db, ctx(clubAdmin), classVersion.id, 'Initial class times');

  // Far enough ahead that "that session has already started" can never fire, so
  // this suite does not rot into a skip the year it is left alone.
  await generateSessions(db, ctx(clubAdmin), CLASS, '2099-01-05', '2099-01-12');
  const generated = await db.select().from(sch.classSessions)
    .where(eq(sch.classSessions.classId, CLASS))
    .orderBy(sch.classSessions.startsAt);
  SESSION_A = generated[0].id;
  SESSION_B = generated[1].id;

  // ── The programme the training is delivered under ────────────────────────
  //
  // Created, NOT activated. Nothing may be registered, scheduled or delivered
  // against it until a verified payment says so — which is the whole point of
  // src/db/activation.ts, and is asserted in PART ONE.
  const [program] = await db.insert(s.trainingPrograms).values({
    code: 'MMAKF-PRG-2026-000001',
    title: 'Parent and child karate — Ramgarh, spring term',
    status: 'planned', mode: 'at_dojo',
    stateUnitId: STATE, districtUnitId: DISTRICT, venue: 'Ramgarh training hall',
    leadCoachPersonId: COACH, sessionsPlanned: 12,
  }).returning({ id: s.trainingPrograms.id });
  PROGRAM = program.id;
});

// ═══════════════════════════════════════════════════════════════════════════
// PART ONE — THE JOURNEY AS IT STANDS TODAY
//
// Twelve stages were specified. Five of them work. The sixth is a wall, and
// this half of the file is a description of exactly where the wall is.
// ═══════════════════════════════════════════════════════════════════════════

describe('PART ONE · a parent registers a child, and is charged nothing for it', () => {
  it('the child is on the register, is a minor, and owes the federation nothing', async () => {
    const [row] = await db.select().from(s.persons).where(eq(s.persons.id, CHILD));
    expect(row.fullName).toBe('Ishan Mahto');
    expect(row.federationId).toMatch(/^MMAKF-MEM-\d{4}-\d{6}$/);

    // A federation ID is an IDENTIFIER, not a membership. The register row and
    // the membership register are different tables for exactly this reason, and
    // the second one is empty.
    expect(isMinor(row.dob, new Date('2026-08-17'))).toBe(true);
    expect(ageOn(row.dob, new Date('2026-08-17'))).toBe(9);

    await assertNobodyWasAskedForAMembership('creating a child');
  });

  it('creating the child created no order, no invoice and no entitlement', async () => {
    expect(await orders()).toEqual([]);
    expect(await invoices()).toEqual([]);
    expect(await entitlements()).toEqual([]);
    expect(await payments()).toEqual([]);
  });

  it('the guardianship is VERIFIED, and it is free', async () => {
    expect(await guardianCan(db, {
      guardianPersonId: PARENT, subjectPersonId: CHILD, capability: 'manage_enrolment',
    })).toBe(true);

    // Nothing about attaching a parent to a child touched the money spine.
    expect(await orders()).toEqual([]);
    await assertNobodyWasAskedForAMembership('verifying guardianship');
  });
});

describe('PART ONE · the parent finds a club, and no membership is asked for', () => {
  it('the club directory answers a nine-year-old s parent', async () => {
    const clubs = await findClubs(db, { stateUnitId: STATE, age: 9, audience: 'kids' });
    expect(clubs.map((c: any) => c.slug)).toContain('mmakf-ramgarh-centre');

    const found = clubs.find((c: any) => c.slug === 'mmakf-ramgarh-centre')!;
    expect(found.standing).toBe('chartered');
    expect(found.classCount).toBe(1);

    await assertNobodyWasAskedForAMembership('finding a club');
  });

  it('the club profile lists the class, its ages and that it takes bookings', async () => {
    const profile = await clubProfile(db, 'mmakf-ramgarh-centre');
    expect(profile).toBeTruthy();
    const klass = profile!.classes.find((c: any) => c.slug === 'parent-and-child-karate')!;
    expect(klass.ageMin).toBe(5);
    expect(klass.ageMax).toBe(12);
    expect(klass.requiresBooking).toBe(true);

    await assertNobodyWasAskedForAMembership('reading a club profile');
  });

  it('the class has real, bookable occurrences — and they are visible to anyone', async () => {
    const slots = await bookableSessions(db, { classId: CLASS }, '2099-01-01', '2099-01-31');
    expect(slots.map((x: any) => `${x.localDate} ${x.localStart}`)).toEqual([
      '2099-01-05 17:30', '2099-01-12 17:30',
    ]);
    // No principal was passed to bookableSessions(). Finding out when a club
    // trains is not gated on anything, least of all on paying to be a member.
    await assertNobodyWasAskedForAMembership('listing bookable sessions');
  });
});

describe('PART ONE · the price is a refusal, and the refusal is honest', () => {
  it('there is NO published fee framework — the true state of this system', async () => {
    expect(await activeFramework(db, todayIsoForFees())).toBeNull();
    expect(await feeAvailability(db, todayIsoForFees())).toEqual({ state: 'not_published' });
  });

  it('a PARENT is answered with a quotation, never a number — published or not', async () => {
    const raw = await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'public' });
    const shown = unpriced(raw);

    expect(isPriced(raw)).toBe(false);
    expect(isNotConfigured(shown)).toBe(true);
    expect(shown.outcome).toBe(FEE_NOT_CONFIGURED);
    expect(shown.displayPolicy).toBe('request_quote');
    expect(shown.notice).toBe(FEE_NOTICE.request_quote);
    expect(renderFee(shown)).toBe('Request a quotation.');

    // The REASON a public viewer gets is display policy, not absence — and it
    // is checked before the framework is even read, so no figure is computed,
    // logged or sent. That stays true after PART TWO publishes one.
    expect(shown.reason).toBe('display_restricted');
  });

  it('and to STAFF, who prepare that quotation, the answer is "no framework"', async () => {
    const staff = unpriced(await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'staff' }));
    expect(staff.reason).toBe('no_framework');
    expect(staff.detail).toMatch(/No fee framework is in force/);
  });

  it('there is NO number to reach for — not zero, not NaN, not "—"', async () => {
    const shown = unpriced(await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'staff' }));

    // The absence is structural, not a convention.
    expect('amountMinor' in shown).toBe(false);
    expect(() => requireAmountMinor(shown)).toThrow(/Refusing to substitute a figure/);
    // Coercion is a thrown error rather than "[object Object]" or NaN, so a
    // total that quietly absorbed it cannot exist.
    expect(() => Number(shown as any)).toThrow(/not configured/);
    expect(() => `${shown as any}`).toThrow(/not configured/);
    expect(() => (shown as any) + 0).toThrow(/not configured/);
  });

  it('the service the parent is looking at is TRAINING, not membership', async () => {
    const entry = FEE_CATALOGUE_SEED.find((e) => e.code === TRAINING)!;
    expect(entry.category).toBe('training');
    expect(entry.audience).toBe('parent');
    expect(entry.unit).toBe('per_month');
    // Whatever a family ends up paying, they pay it for training delivered per
    // month. Nothing in the entry is annual, per-registration or per-account.
    expect(FORBIDDEN_CHARGE.test(entry.name)).toBe(false);
  });

  it('THE DRAFT FRAMEWORK CANNOT GENERATE A STUDENT MEMBERSHIP AT ALL', async () => {
    // Not "does not display one" — cannot produce one. The rules were DELETED
    // rather than commented out, so no seed, migration or careless clone of the
    // framework can bring them back.
    const student = PROPOSED_RULES.filter((r) =>
      /^MEM-/.test(r.code) &&
      /junior|athlete|student|kid|child|youth/i.test(`${r.code} ${r.label}`)
    );
    expect(student).toEqual([]);

    // And what DOES remain under MEM- is priced for people who act on the
    // federation's behalf rather than receive training from it.
    const remaining = PROPOSED_RULES.filter((r) => /^MEM-/.test(r.code)).map((r) => r.code);
    expect(remaining.length).toBeGreaterThan(0);
    for (const code of remaining) {
      expect(code).toMatch(/^MEM-(COACH|OFFICIAL|EXAMINER|CLUB|DOJO|ORGANISATION|SCHOOL|INSTITUTION)/);
    }
  });
});

describe('PART ONE · THE WALL — checkout cannot proceed, and says so', () => {
  it('createOrder REFUSES: the federation has published no fee for this', async () => {
    await expect(createOrder(db, ctx(parentUser), {
      personId: CHILD,
      buyerName: 'Anita Mahto',
      email: 'anita.mahto@example.com',
      lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        description: 'Parent and child karate — spring term',
      }],
    })).rejects.toThrow(OrderError);

    await expect(createOrder(db, ctx(parentUser), {
      personId: CHILD,
      lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        description: 'Parent and child karate — spring term',
      }],
    })).rejects.toThrow(/No published fee for MMAKF-FEE-TRN-PARENT-CHILD/);
  });

  it('NOTHING was written by the attempt — not a draft order, not a reservation', async () => {
    expect(await orders()).toEqual([]);
    expect(await orderLines()).toEqual([]);
    expect(await payments()).toEqual([]);
    expect(await invoices()).toEqual([]);
    expect(await entitlements()).toEqual([]);
  });

  it('and the quotation route has nothing to quote FROM', async () => {
    // issueQuote() takes a frameworkId. There is no published framework, so a
    // surface cannot choose one — the refusal is upstream of any authority
    // check, which is why it is asserted as a null rather than as a throw.
    expect(await activeFramework(db, todayIsoForFees())).toBeNull();
  });

  it('THE JOURNEY STOPS HERE. Everything downstream is unreachable today.', async () => {
    // The programme is not deliverable: no verified payment has activated it.
    const standing = await programStanding(db, PROGRAM);
    expect(standing.active).toBe(false);
    expect(standing.reason).toMatch(/No payment has activated this programme/);
    expect(standing.entitlementId).toBeNull();

    // And the resources a training entitlement would open are shut.
    const library = await resourceAccess(db, { personId: CHILD, kind: 'technical_library' });
    expect(library.allowed).toBe(false);
    expect(library.entitlementId).toBeNull();

    // No paid-but-unissued line is hiding in the backlog either — because
    // nothing was ever paid.
    expect(await activationBacklog(db, admin)).toEqual([]);

    await assertNobodyWasAskedForAMembership('the wall');
  });

  it('and the wall is a PRICE, not a membership check — the child holds none and needs none', async () => {
    // The distinction this whole codebase turns on. The journey stopped because
    // MMAKF has published no fee, NOT because the child is not a member. The
    // refusal message names a fee code and says nothing about membership.
    const [mem] = await memberships();
    expect(mem).toBeUndefined();

    try {
      await createOrder(db, null, {
        personId: CHILD,
        lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        description: 'Parent and child karate — spring term',
      }],
      });
      throw new Error('createOrder should have refused');
    } catch (err: any) {
      expect(err).toBeInstanceOf(OrderError);
      expect(err.code).toBe('fee_not_published');
      expect(err.message).not.toMatch(FORBIDDEN_CHARGE);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART TWO — THE SAME JOURNEY, WITH A FRAMEWORK PUBLISHED
//
// No source changes between PART ONE and here. What changes is three pieces of
// data an authorised person enters: a fee framework, a fee schedule row, and
// the entitlement term that says what the fee buys.
//
// That it takes THREE and not one is finding (1), and it is asserted rather
// than smoothed over.
// ═══════════════════════════════════════════════════════════════════════════

/** ₹1,234.00 in paise. A TEST FIXTURE. MMAKF has published no such figure. */
const FIXTURE_MONTHLY_PAISE = 123_400;

describe('PART TWO · publishing a framework makes the price appear', () => {
  it('an authorised person publishes a framework — this is data, not code', async () => {
    const fw = await createFramework(db, ctx(), {
      title: 'TEST FIXTURE framework — not an MMAKF fee', version: 1,
      effectiveFrom: '2026-01-01',
      notes: 'Written by tests/journey-parent-child.test.ts. Not a federation decision.',
    });
    FRAMEWORK = fw.id;

    await addRule(db, ctx(), FRAMEWORK, {
      code: 'TEST-TRN-PARENT-CHILD',
      label: 'Parent and child training, per month',
      kind: 'base',
      amountMinor: FIXTURE_MONTHLY_PAISE,
      conditions: { serviceCode: TRAINING },
      sortOrder: 10,
    });

    await publishFramework(db, ctx(), FRAMEWORK);
    expect((await activeFramework(db, todayIsoForFees()))?.id).toBe(FRAMEWORK);
    expect(await feeAvailability(db, todayIsoForFees()))
      .toEqual({ state: 'published', frameworkCode: 'MMAKF-FEE-V1' });
  });

  it('THE SAME feeFor() CALL now returns a figure — no code changed', async () => {
    const staff = await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'staff' });
    expect(isPriced(staff)).toBe(true);
    expect(requireAmountMinor(staff)).toBe(FIXTURE_MONTHLY_PAISE);
    expect(renderFee(staff)).toBe('₹1,234.00');
    expect((staff as any).frameworkCode).toBe('MMAKF-FEE-V1');
  });

  it('and the parent is STILL answered with a quotation, which is correct', async () => {
    const shown = unpriced(await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'public' }));
    expect(shown.reason).toBe('display_restricted');
    expect(shown.notice).toBe('Request a quotation.');
  });

  it('FINDING · a published framework does NOT open checkout — the figure a page shows and the figure an order charges come from two different registers', async () => {
    // feeFor() reads `fee_frameworks`/`fee_rules` through computeFee().
    // createOrder() reads `fee_schedule`. They are separate tables with separate
    // publication acts, and NOTHING joins them. A federation that publishes a
    // framework and expects families to be able to pay will find checkout still
    // refusing, with a message about a fee code rather than about the framework
    // it just published.
    const priced = await feeFor(db, TRAINING, { audience: 'parent' }, { viewer: 'staff' });
    expect(isPriced(priced)).toBe(true);

    await expect(createOrder(db, null, {
      personId: CHILD,
      lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        description: 'Parent and child karate — spring term',
      }],
    })).rejects.toThrow(/No published fee for MMAKF-FEE-TRN-PARENT-CHILD/);
  });

  it('FINDING · the quotation route reaches a payable order whose line entitles NOBODY', async () => {
    // createPaymentLink() raises its order line as kind 'other' with refType
    // 'quote_version'. Both are deliberate — see src/db/quote-to-order.ts — but
    // the consequence is that subjectForLine() maps it to null, so a fully paid
    // institutional quotation produces `not_entitling` and no training
    // entitlement at all. Asserted at the mapping rather than by driving the
    // whole quotation flow, because the mapping is where the gap is.
    expect(subjectForLine({ kind: 'other', refType: 'quote_version' })).toBeNull();
    // For contrast, the route this journey takes:
    expect(subjectForLine({ kind: 'program', refType: 'training_program' })).toBe('program');
  });
});

describe('PART TWO · the federation records what the fee buys, and checkout opens', () => {
  it('a fee schedule row and an entitlement term — the remaining two pieces of data', async () => {
    await db.insert(s.feeSchedule).values({
      code: TRAINING,
      label: 'Parent and child training, per month',
      kind: 'program',
      amountPaise: FIXTURE_MONTHLY_PAISE,
      effectiveFrom: '2026-01-01',
      approvedBy: 'TEST FIXTURE — not a federation decision',
      active: true,
    });

    // WHAT THE MONEY BUYS, stated. Without this the payment activates nothing
    // and the entitlement is blocked with a message naming the missing term —
    // the system refuses to invent a period, which is the same refusal as
    // refusing to invent an amount.
    await configureTerm(db, ctx(), {
      feeCode: TRAINING, subject: 'program', termMonths: 3,
      resources: [{ kind: 'technical_library' }],
      approvedBy: 'TEST FIXTURE', notes: 'Three months of parent-and-child training.',
    });

    const [row] = await db.select().from(s.entitlementTerms)
      .where(eq(s.entitlementTerms.feeCode, TRAINING));
    expect(row.subject).toBe('program');
    expect(row.termMonths).toBe(3);
    // AND IT IS NOT A MEMBERSHIP TERM. The column exists, and it is null.
    expect(row.membershipCategory).toBeNull();
  });

  it('the order is raised — and the SERVER priced it', async () => {
    ORDER = await createOrder(db, ctx(parentUser), {
      personId: CHILD,
      buyerName: 'Anita Mahto',
      email: 'anita.mahto@example.com',
      phone: '+91 98765 00099',
      lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        // A description is accepted; a PRICE is not. The line carries no
        // unitPricePaise and there is no parameter through which one could be
        // supplied for a fee-coded line.
        description: 'ignored — the label comes from the published fee',
      }],
    });

    expect(ORDER.totalPaise).toBe(FIXTURE_MONTHLY_PAISE);
    expect(ORDER.lines).toHaveLength(1);
    expect(ORDER.lines[0].unitPricePaise).toBe(FIXTURE_MONTHLY_PAISE);
    // The description came from the fee schedule, not from the caller.
    expect(ORDER.lines[0].description).toBe('Parent and child training, per month');
    expect(ORDER.status).toBe('awaiting_payment');
  });

  it('NOT ONE LINE ON THAT ORDER IS A MEMBERSHIP, A SUBSCRIPTION OR A REGISTRATION FEE', async () => {
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, ORDER.id));
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line.kind).toBe('program');
      expect(FORBIDDEN_KINDS).not.toContain(line.kind);
      expect(line.description).not.toMatch(FORBIDDEN_CHARGE);
      expect(line.feeCode).not.toMatch(FORBIDDEN_CHARGE);
      expect(line.refType).toBe('training_program');
    }
    await assertNobodyWasAskedForAMembership('raising the order');
  });

  it('the child still holds NO membership at the moment of checkout', async () => {
    expect(await memberships()).toEqual([]);
  });
});

describe('PART TWO · payment, verified webhook, capture', () => {
  it('the gateway callback is logged before anything acts on it', async () => {
    PAYMENT = await beginPayment(db, ORDER.id, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: ORDER.totalPaise,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(PAYMENT.status).toBe('created');

    const seen = await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_parent_child_0001',
      eventType: 'payment.captured', signatureValid: true,
      payload: { note: 'test fixture' },
    });
    expect(seen.fresh).toBe(true);
    await markWebhookProcessed(db, seen.id!);
  });

  it('a VERIFIED capture — never a browser claiming success — marks the order paid', async () => {
    const result = await confirmPayment(db, null, captured({
      providerOrderId: PAYMENT.providerOrderId,
      amountPaise: ORDER.totalPaise,
      feePaise: 2400,
    }));
    expect(result).toEqual({ orderId: ORDER.id, alreadyProcessed: false });

    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, ORDER.id));
    expect(order.status).toBe('paid');
    expect(order.paidAt).toBeTruthy();

    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, PAYMENT.id));
    expect(pay.status).toBe('captured');
    expect(pay.amountPaise).toBe(FIXTURE_MONTHLY_PAISE);
  });

  it('the receipt is issued, and it names training', async () => {
    INVOICE = await issueInvoice(db, ORDER.id);
    expect(INVOICE.invoiceNo).toMatch(/\d/);
    // The invoice carries no money column of its own — the frozen snapshot IS
    // the receipt, deliberately, so that a later catalogue or address edit
    // cannot restate a document already in a family's hands.
    expect((INVOICE.snapshot as any).totalPaise).toBe(FIXTURE_MONTHLY_PAISE);

    // EVERY LINE OF THE FROZEN SNAPSHOT, walked.
    const snapshot: any = INVOICE.snapshot ?? {};
    const lines: any[] = Array.isArray(snapshot.lines) ? snapshot.lines : [];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toMatch(FORBIDDEN_CHARGE);
    }
    await assertNobodyWasAskedForAMembership('issuing the receipt');
  });
});

describe('PART TWO · the training entitlement', () => {
  it('the capture activated a PROGRAM entitlement — and nothing else', async () => {
    const rows = await entitlementsForOrder(db, admin, ORDER.id);
    expect(rows).toHaveLength(1);
    ENTITLEMENT = rows[0];

    expect(ENTITLEMENT.subject).toBe('program');
    expect(ENTITLEMENT.status).toBe('active');
    expect(ENTITLEMENT.subjectId).toBe(PROGRAM);
    expect(ENTITLEMENT.paymentId).toBe(PAYMENT.id);
    expect(ENTITLEMENT.invoiceId).toBe(INVOICE.id);

    // A PERIOD, both ends, taken from the term the federation configured.
    expect(ENTITLEMENT.validFrom).toBeTruthy();
    expect(ENTITLEMENT.validTo).toBeTruthy();
    expect(String(ENTITLEMENT.validTo) > String(ENTITLEMENT.validFrom)).toBe(true);

    // THE ASSERTION THIS FILE EXISTS FOR: the thing the payment bought is
    // TRAINING. There is no membership entitlement beside it.
    expect(rows.filter((r: any) => r.subject === 'membership')).toEqual([]);
    await assertNobodyWasAskedForAMembership('activation');
  });

  it('the programme is now deliverable, and what it grants is open', async () => {
    const standing = await programStanding(db, PROGRAM);
    expect(standing.active).toBe(true);
    expect(standing.entitlementId).toBe(ENTITLEMENT.id);

    PARTICIPANT = (await registerParticipant(db, ctx(), {
      programId: PROGRAM, personId: CHILD, ageBand: 'under-12', joinedOn: ENTITLEMENT.validFrom,
    })).participantId;

    const library = await resourceAccess(db, { personId: CHILD, kind: 'technical_library' });
    expect(library.allowed).toBe(true);
    expect(library.entitlementId).toBe(ENTITLEMENT.id);
    // ACCESS CAME FROM THE PAYMENT, not from a membership the child does not have.
    expect(await memberships()).toEqual([]);
  });

  it('FINDING · nothing told the parent. ENTITLEMENT_ACTIVATED notifies nobody.', async () => {
    const [event] = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'ENTITLEMENT_ACTIVATED'));
    expect(event, 'the activation reached the event feed').toBeTruthy();

    // It reaches the FEED and no INBOX: the event type is absent from NOTIFIABLE
    // in src/lib/notifications.ts, which is the allow-list the fan-out consults.
    // This is the bug class the module's own header says the project has hit
    // twice, and the parent-and-child journey is a third instance of it: the
    // person who paid is told nothing at the moment the thing they paid for
    // starts working.
    expect(Object.keys(NOTIFIABLE)).not.toContain('ENTITLEMENT_ACTIVATED');
    const queued = await notifyForEvent(db, ctx(), {
      id: event.id, eventType: event.eventType, entityType: event.entityType,
      entityId: event.entityId, payload: event.payload,
    });
    expect(queued).toBe(0);
    expect(await notifications()).toEqual([]);
  });
});

describe('PART TWO · the class booking, the calendar and the notification', () => {
  it('FINDING · the PARENT cannot book their own child s class', async () => {
    // bookClassSession() asks two questions: "is this person you?" and "do you
    // hold booking:write over the club?". It never asks guardianCan(). So the
    // `manage_enrolment` capability the federation granted this parent — the
    // capability whose whole purpose is enrolling a child — buys nothing at the
    // one place a parent would use it, and the club office has to book instead.
    expect(await guardianCan(db, {
      guardianPersonId: PARENT, subjectPersonId: CHILD, capability: 'manage_enrolment',
    })).toBe(true);

    // And the refusal names the permission a CLUB OFFICER holds, not the
    // guardianship the parent does — which is the shape of the gap: the
    // question asked was never "are you this child's guardian?".
    await expect(bookClassSession(db, ctx(parentUser), SESSION_A, CHILD))
      .rejects.toThrow('Forbidden: booking:write');
  });

  it('the club books the place, and the seat count moves', async () => {
    const held = await bookClassSession(db, ctx(clubAdmin), SESSION_A, CHILD, {
      notes: 'Booked at the desk by the club office.',
    });
    BOOKING_REF = held.ref;
    expect(held.seatsRemaining).toBe(11);

    const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.ref, BOOKING_REF));
    expect(booking.status).toBe('confirmed');
    expect(booking.personId).toBe(CHILD);
    expect(booking.kind).toBe('class');

    // BOOKED WITHOUT A MEMBERSHIP. The seat was taken on the strength of a
    // training entitlement and nothing else.
    expect(await memberships()).toEqual([]);
    await assertNobodyWasAskedForAMembership('booking a class');
  });

  it('the booking appears on the child s calendar', async () => {
    const week = await personalSchedule(db, CHILD, '2099-01-01', '2099-01-31');
    const mine = week.find((x: any) => x.sessionId === SESSION_A)!;
    expect(mine).toBeTruthy();
    expect(mine.role).toBe('attending');
    expect(mine.bookingRef).toBe(BOOKING_REF);
    expect(mine.className).toBe('Parent and child karate');
    expect(mine.localStart).toBe('17:30');
    expect(mine.venueName).toBe('Ramgarh training hall');
  });

  it('a cancelled class DOES notify — and it reaches the child, not the parent', async () => {
    // The second occurrence, so the booking under test above survives.
    await bookClassSession(db, ctx(clubAdmin), SESSION_B, CHILD);
    await cancelSession(db, ctx(clubAdmin), SESSION_B, 'The hall is let for a district examination.');

    const [event] = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'CLASS_SESSION_CANCELLED'));
    expect(event).toBeTruthy();

    const queued = await notifyForEvent(db, ctx(clubAdmin), {
      id: event.id, eventType: event.eventType, entityType: event.entityType,
      entityId: event.entityId, payload: event.payload,
    });
    expect(queued).toBe(1);

    const notes = await notifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].personId).toBe(CHILD);
    expect(notes[0].title).toMatch(/cancelled/i);

    // FINDING, continued. The nine-year-old is the addressee; the guardian who
    // has to rearrange their Monday is not. resolveRecipients() has no audience
    // that walks person_relationships, so no notification in this system ever
    // reaches a guardian on a child's behalf.
    expect(notes.filter((n: any) => n.personId === PARENT)).toEqual([]);
  });
});

describe('PART TWO · attendance, and the receipt at the end', () => {
  it('a session is delivered inside the paid period, and the register is written', async () => {
    const start = new Date(`${ENTITLEMENT.validFrom}T11:00:00.000Z`);
    const end = new Date(`${ENTITLEMENT.validFrom}T12:00:00.000Z`);

    const session = await scheduleSession(db, ctx(), {
      programId: PROGRAM, startsAt: start, endsAt: end,
      title: 'Week one — kihon', coachPersonId: COACH,
    });

    const result = await recordAttendance(db, ctx(), {
      sessionId: session.id,
      marks: [{ participantId: PARTICIPANT, present: true, note: 'Attended with a parent.' }],
    });
    expect(result.recorded).toBe(1);

    // The session is recorded as DELIVERED, which is what makes it a
    // denominator: participantAttendance() counts delivered sessions only,
    // because a cancelled class is not an absence.
    await deliverSession(db, ctx(), { sessionId: session.id });

    const register = await participantAttendance(db, PROGRAM);
    const child = register.find((r: any) => r.participantId === PARTICIPANT)!;
    expect(child.present).toBe(1);
    expect(child.absent).toBe(0);
    expect(child.sessionsDelivered).toBe(1);
    expect(child.displayName).toBe('Ishan Mahto');

    await assertNobodyWasAskedForAMembership('recording attendance');
  });

  it('THE WHOLE JOURNEY, and not one membership anywhere in it', async () => {
    // Every order line the journey has produced, from the first stage to this
    // one, walked one at a time.
    const lines = await orderLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(FORBIDDEN_KINDS).not.toContain(line.kind);
      expect(`${line.description} ${line.feeCode}`).not.toMatch(FORBIDDEN_CHARGE);
    }

    // Every entitlement the journey has produced.
    const ents = await entitlements();
    expect(ents.map((e: any) => e.subject)).toEqual(['program']);

    // And the membership register, which is a different domain entirely and is
    // untouched by a family that trains.
    expect(await memberships()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART THREE — THE THINGS THAT GO WRONG
// ═══════════════════════════════════════════════════════════════════════════

describe('PART THREE · a duplicate webhook produces one payment and one entitlement', () => {
  it('the gateway s replay is refused at the event log', async () => {
    const again = await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_parent_child_0001',
      eventType: 'payment.captured', signatureValid: true,
      payload: { note: 'the same event, redelivered' },
    });
    expect(again.fresh).toBe(false);
    expect(again.id).toBeNull();

    const events = await db.select().from(s.paymentEvents)
      .where(eq(s.paymentEvents.eventId, 'evt_parent_child_0001'));
    expect(events).toHaveLength(1);
  });

  it('and confirming the same capture again issues nothing a second time', async () => {
    const before = await entitlements();

    const replay = await confirmPayment(db, null, captured({
      providerOrderId: PAYMENT.providerOrderId,
      amountPaise: ORDER.totalPaise,
    }));
    expect(replay).toEqual({ orderId: ORDER.id, alreadyProcessed: true });

    const forOrder = await db.select().from(s.payments).where(eq(s.payments.orderId, ORDER.id));
    expect(forOrder).toHaveLength(1);
    expect(forOrder[0].status).toBe('captured');

    const after = await entitlements();
    expect(after).toHaveLength(before.length);
    expect(after.filter((e: any) => e.orderId === ORDER.id)).toHaveLength(1);

    // One receipt, too.
    const inv = await db.select().from(s.invoices).where(eq(s.invoices.orderId, ORDER.id));
    expect(inv).toHaveLength(1);
  });
});

describe('PART THREE · a gateway amount that disagrees with the server blocks fulfilment', () => {
  let mismatchOrder: any;
  let mismatchPayment: any;

  it('the capture is REFUSED, and the payment is flagged for a human', async () => {
    mismatchOrder = await createOrder(db, null, {
      personId: CHILD,
      email: 'anita.mahto@example.com',
      lines: [{
        kind: 'program', feeCode: TRAINING,
        refType: 'training_program', refId: PROGRAM,
        description: 'Parent and child karate — spring term',
      }],
    });
    mismatchPayment = await beginPayment(db, mismatchOrder.id, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: mismatchOrder.totalPaise,
      idempotencyKey: crypto.randomUUID(),
    });

    // One rupee more than the server computed. A gateway is never believed over
    // the federation's own arithmetic.
    await expect(confirmPayment(db, null, captured({
      providerOrderId: mismatchPayment.providerOrderId,
      amountPaise: mismatchOrder.totalPaise + 100,
    }))).rejects.toThrow(/does not match the order total/);

    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, mismatchPayment.id));
    expect(pay.status).toBe('failed');
    expect(pay.failureReason).toMatch(/Amount or currency mismatch/);
  });

  it('NOTHING was fulfilled: the order is unpaid, no receipt, no entitlement', async () => {
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, mismatchOrder.id));
    expect(order.status).toBe('awaiting_payment');
    expect(order.paidAt).toBeNull();

    expect(await db.select().from(s.invoices).where(eq(s.invoices.orderId, mismatchOrder.id))).toEqual([]);
    expect(await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, mismatchOrder.id))).toEqual([]);

    // And activation cannot be reached round the side: it demands a capture
    // this system verified, and there is none.
    await expect(activateForOrder(db, null, mismatchOrder.id))
      .rejects.toThrow(/no payment this system has verified as captured/);
  });
});

describe('PART THREE · a refund reverses the entitlement and leaves the record intact', () => {
  let refundId: number;

  it('a completed refund revokes the training entitlement', async () => {
    const refund = await requestRefund(db, ctx(), {
      paymentId: PAYMENT.id,
      amountPaise: FIXTURE_MONTHLY_PAISE,
      reason: 'The family moved out of the district before the term began.',
    });
    refundId = refund.id;
    // completeRefund() reverses the entitlement itself, as the LAST step and
    // outside its own writes — so the reversal is part of recording that the
    // money actually left the account, not a second act somebody must remember.
    const done: any = await completeRefund(db, ctx(), { refundId, providerRefundId: 'rfnd_test_0001' });
    expect(done.alreadyCompleted).toBe(false);
    expect(done.fullyRefunded).toBe(true);
    expect(done.revocation.revoked).toBe(1);
    expect(done.revocation.outcomes[0].subject).toBe('program');

    // And reversing it again reverses nothing a second time.
    const again = await revokeForRefund(db, ctx(), refundId);
    expect(again.revoked).toBe(0);
    expect(again.outcomes).toEqual([]);

    const standing = await programStanding(db, PROGRAM);
    expect(standing.active).toBe(false);
    expect(standing.reason).toMatch(/revoked/i);

    // The doors it opened are shut, on the same date arithmetic.
    const library = await resourceAccess(db, { personId: CHILD, kind: 'technical_library' });
    expect(library.allowed).toBe(false);
  });

  it('NOTHING WAS DELETED — the entitlement, the order, the receipt and the ledger all stand', async () => {
    const [ent] = await db.select().from(s.entitlements).where(eq(s.entitlements.id, ENTITLEMENT.id));
    expect(ent).toBeTruthy();
    expect(ent.status).toBe('revoked');
    expect(ent.revokedAt).toBeTruthy();
    expect(ent.refundId).toBe(refundId);
    expect(ent.reason).toMatch(/moved out of the district/);
    // The history it carried is unchanged: same order, same payment, same
    // receipt, same period. A revoked entitlement is a record with an ending,
    // not an absence.
    expect(ent.orderId).toBe(ORDER.id);
    expect(ent.paymentId).toBe(PAYMENT.id);
    expect(ent.invoiceId).toBe(INVOICE.id);
    expect(ent.subjectId).toBe(PROGRAM);
    expect(ent.validFrom).toBe(ENTITLEMENT.validFrom);
    expect(ent.validTo).toBe(ENTITLEMENT.validTo);

    const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, INVOICE.id));
    expect((inv.snapshot as any).totalPaise).toBe(FIXTURE_MONTHLY_PAISE);

    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, ORDER.id));
    expect(['refunded', 'partially_refunded', 'paid']).toContain(order.status);

    // The original income postings are still on the ledger. A refund is a new
    // entry, never an edit of the one it reverses.
    const postings = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, ORDER.id));
    expect(postings.some((p: any) => p.account === 'income.program' && p.direction === 'credit')).toBe(true);
  });

  it('and the class booking the child already held is still on the record', async () => {
    const [booking] = await db.select().from(s.bookings).where(eq(s.bookings.ref, BOOKING_REF));
    expect(booking).toBeTruthy();
    expect(booking.personId).toBe(CHILD);
  });
});

describe('PART THREE · attendance and certificates survive the entitlement ending', () => {
  it('the entitlement is over — by revocation, and the register is untouched', async () => {
    const standing = await programStanding(db, PROGRAM);
    expect(standing.active).toBe(false);

    // The attendance recorded while the programme ran is EXACTLY as it was.
    const register = await participantAttendance(db, PROGRAM);
    const child = register.find((r: any) => r.participantId === PARTICIPANT)!;
    expect(child).toBeTruthy();
    expect(child.present).toBe(1);
    expect(child.sessionsDelivered).toBe(1);

    const rows = await db.select().from(ops.programAttendance)
      .where(eq(ops.programAttendance.participantId, PARTICIPANT));
    expect(rows).toHaveLength(1);
    expect(rows[0].present).toBe(true);
  });

  it('a certificate the child already holds is still valid and still verifiable', async () => {
    // A TEST FIXTURE certificate, standing in for one an examiner awarded. It is
    // inserted rather than earned because what is under test is that an ENDED
    // entitlement does not reach into the credential register — not how a
    // grading is passed.
    CERTIFICATE_NO = 'MMAKF-CERT-2026-000001';
    await db.insert(s.certificates).values({
      certificateNo: CERTIFICATE_NO,
      kind: 'kyu_grade',
      personId: CHILD,
      title: '9th Kyu',
      issuedOn: '2026-05-10',
      issuingAuthority: 'MMAKF Jharkhand Association',
      status: 'issued',
      verifyToken: crypto.randomBytes(16).toString('hex'),
      snapshot: { holder: 'Ishan Mahto', grade: '9th Kyu', provenance: 'examined', awardedOn: '2026-05-10' },
    });

    const result = await verifyCredential(db, { certificateNo: CERTIFICATE_NO });
    expect(result.status).toBe('valid');
    expect(result.holderName).toBe('Ishan Mahto');
    expect(result.grade).toBe('9th Kyu');

    // A CREDENTIAL IS NOT A SUBSCRIPTION. Ending the training does not withdraw
    // what the child earned while it ran, and nothing about the revocation
    // touched this row.
    const [cert] = await db.select().from(s.certificates)
      .where(eq(s.certificates.certificateNo, CERTIFICATE_NO));
    expect(cert.status).toBe('issued');
    expect(cert.revokedOn).toBeNull();
  });

  it('what DID stop is access to the material the payment opened, and only that', async () => {
    for (const kind of ['technical_library', 'live_classes'] as const) {
      const decision = await resourceAccess(db, { personId: CHILD, kind });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeTruthy();
    }
  });
});

describe('PART THREE · a minor s record is reachable by their guardian, and by nobody else', () => {
  it('the verified guardian may act, capability by capability', async () => {
    for (const capability of ['view_profile', 'view_attendance', 'pay', 'manage_enrolment'] as const) {
      expect(await guardianCan(db, {
        guardianPersonId: PARENT, subjectPersonId: CHILD, capability,
      }), `parent should hold ${capability}`).toBe(true);
    }

    const mine = await dependantsOf(db, PARENT);
    expect(mine.map((d: any) => d.personId)).toEqual([CHILD]);
    expect(mine[0].fullName).toBe('Ishan Mahto');
  });

  it('NOTHING was granted that was not granted one at a time', async () => {
    // The capability list is not a hierarchy, and holding four of eight confers
    // nothing about the other four. Medical and safeguarding are gated twice on
    // top of guardian:verify, which is why they are false here even though the
    // same office granted everything else.
    for (const capability of ['view_results', 'give_consent', 'view_medical', 'view_safeguarding'] as const) {
      expect(await guardianCan(db, {
        guardianPersonId: PARENT, subjectPersonId: CHILD, capability,
      }), `parent must NOT hold ${capability}`).toBe(false);
    }
  });

  it('another parent — verified guardian of another child — reaches nothing', async () => {
    expect(await guardianCan(db, {
      guardianPersonId: STRANGER, subjectPersonId: CHILD, capability: 'view_attendance',
    })).toBe(false);
    expect(await guardianCan(db, {
      guardianPersonId: PARENT, subjectPersonId: STRANGER_CHILD, capability: 'view_attendance',
    })).toBe(false);

    const theirs = await dependantsOf(db, STRANGER);
    expect(theirs.map((d: any) => d.personId)).toEqual([STRANGER_CHILD]);
  });

  it('AN ASSERTED RELATIONSHIP CONFERS NOTHING — a claim is not a guardianship', async () => {
    const claim = await assertRelationship(db, ctx(), {
      holderPersonId: STRANGER, subjectPersonId: CHILD, type: 'authorized_guardian',
      evidence: { note: 'claimed at the desk, not yet decided' },
    });
    expect(claim.created).toBe(true);

    // The claim is on the record and it is worth nothing. Capabilities cannot
    // even be granted against it.
    expect(await guardianCan(db, {
      guardianPersonId: STRANGER, subjectPersonId: CHILD, capability: 'view_attendance',
    })).toBe(false);
    await expect(grantGuardianCapability(db, ctx(), {
      relationshipId: claim.id, capability: 'view_attendance',
    })).rejects.toThrow(/An assertion confers nothing/);

    // And it does not appear on anybody's family list.
    const theirs = await dependantsOf(db, STRANGER);
    expect(theirs.map((d: any) => d.personId)).not.toContain(CHILD);
  });

  it('THE PARENT ROLE ITSELF OPENS NOTHING — the record does, or nobody does', async () => {
    // guardiansOf() is PII and is gated on person:read_pii, which the PARENT
    // role deliberately does not hold. A parent reaching a child's record does
    // so through guardianCan(), never through the role, so a signed-in "parent"
    // with no verified relationship reaches nothing at all.
    await expect(guardiansOf(db, parentUser, CHILD)).rejects.toThrow('Forbidden: person:read_pii');
    await expect(guardiansOf(db, strangerUser, CHILD)).rejects.toThrow('Forbidden: person:read_pii');

    // The office that holds the authority can read it, which is what makes the
    // refusal above a control rather than an outage.
    const holders = await guardiansOf(db, admin, CHILD);
    expect(holders.filter((h: any) => h.status === 'verified').map((h: any) => h.personId)).toEqual([PARENT]);
  });

  it('and a guardian cannot grant themselves anything', async () => {
    await expect(grantGuardianCapability(db, ctx(parentUser), {
      relationshipId: RELATIONSHIP, capability: 'view_medical',
    })).rejects.toThrow('Forbidden: guardian:verify');
    await expect(grantGuardianCapability(db, ctx(parentUser), {
      relationshipId: RELATIONSHIP, capability: 'view_results',
    })).rejects.toThrow('Forbidden: guardian:verify');

    expect(await guardianCan(db, {
      guardianPersonId: PARENT, subjectPersonId: CHILD, capability: 'view_medical',
    })).toBe(false);
  });
});

describe('THE CLOSING STATEMENT · the whole file, one assertion', () => {
  it('a child was registered, priced, paid for, entitled, booked, taught, refunded — and never charged a membership', async () => {
    await assertNobodyWasAskedForAMembership('the whole journey');

    // Said once more explicitly, because it is the sentence the federation gave:
    expect(await memberships()).toEqual([]);
    const ents = await entitlements();
    expect(ents.length).toBeGreaterThan(0);
    expect([...new Set(ents.map((e: any) => e.subject))]).toEqual(['program']);

    const codes = [...new Set((await orderLines()).map((l: any) => l.feeCode).filter(Boolean))];
    expect(codes).toEqual([TRAINING]);
  });
});
