// The training product, the training plan, and the right to train.
//
// THE RULE THIS SUITE EXISTS TO KEEP TRUE:
//
//   A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT. Access is
//   decided by a valid TRAINING ENTITLEMENT and never by membership.
//
// It is asserted twice and in two different ways, because one of them alone
// would rot. Behaviourally: a person with NO membership row at all trains, and a
// person with a flawless active membership and no entitlement does not.
// Statically: the source text of src/db/training-products.ts is read from disk
// and must contain no reference to the membership register. The behavioural test
// would keep passing the day somebody added `if (!membership) deny` behind a
// feature flag; the static one would not.
//
// The rest are the properties the federation asked for by name:
//
//   · a product carries NO amount, and a caller cannot smuggle one in;
//   · with no framework published, nothing is priced and nothing is invented;
//   · a verified capture grants training AND records the PRICE VERSION;
//   · a replayed webhook grants it ONCE;
//   · an entitlement stops granting access AT THE MOMENT it expires;
//   · expiry deletes nothing;
//   · one person may hold entitlements at several clubs;
//   · a transfer moves the enrolment, keeps the history, and does not duplicate
//     the person or rewrite what was bought.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import { createOrder, beginPayment, confirmPayment } from '../src/db/orders';
import { createFramework, addRule, publishFramework } from '../src/db/fees';
import {
  defineTrainingProduct, publishTrainingProduct, withdrawTrainingProduct,
  openTrainingPlan, activateTrainingForOrder, trainingAccess, assertTrainingAccess,
  renewTraining, revokeTraining, enrol, transferEnrolment, clubsForPerson,
  trainingHistory, blockedTraining, priceTrainingProduct, publishedProducts,
  productValidity, trainingTermEndsOn, normaliseDiscipline, expiringTraining,
  isTrainingProductError,
} from '../src/db/training-products';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/db/../lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let client: PGlite;
let STATE: number, CLUB_A: number, CLUB_B: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 2, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const ctx = (p: Principal = admin): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

const FEE_CODE = 'MMAKF-FEE-TRN-SHOTOKAN-MONTHLY';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const today = iso(new Date());

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

async function makePerson(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
    fullName: name, status: 'active', dob: '2014-05-05', gender: 'female',
    stateUnitId: STATE, dojoId: CLUB_A,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** The whole money path, honestly: order → attempt → server-verified capture. */
async function payFor(lines: any[], personId: number | null) {
  const order = await createOrder(db, null, { personId, email: 'payer@example.in', lines });
  const attempt = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  await confirmPayment(db, null, captured({
    providerOrderId: attempt.providerOrderId, amountPaise: order.totalPaise,
  }));
  return order;
}

/** A published framework, so there is a PRICE VERSION to record. */
async function publishAFramework(version: number) {
  const fw = await createFramework(db, ctx(), {
    title: `Test framework v${version}`, version, effectiveFrom: '2020-01-01',
  });
  await addRule(db, ctx(), fw.id, {
    code: `TRN-BASE-V${version}`, label: 'Training', kind: 'base', amountMinor: 120000,
  });
  await publishFramework(db, ctx(), fw.id);
  return fw;
}

/** A published product, ready to sell. */
async function makeProduct(over: Record<string, any> = {}) {
  const n = crypto.randomBytes(4).toString('hex');
  const p = await defineTrainingProduct(db, ctx(), {
    code: `MMAKF-TRN-${n}`,
    slug: `trn-${n}`,
    title: 'Shotokan juniors, monthly',
    discipline: 'Shotokan Karate-do',
    programme: 'Junior foundation',
    period: 'monthly',
    feeCode: FEE_CODE,
    clubId: CLUB_A,
    ageGroupLabel: 'Juniors (7–12)',
    ageMinYears: 7,
    ageMaxYears: 12,
    sessionsPerPeriod: 8,
    sessionDurationMinutes: 60,
    capacity: 24,
    ...over,
  });
  if (over.status !== 'draft') await publishTrainingProduct(db, ctx(), p.id);
  return (await db.select().from(s.trainingProducts).where(eq(s.trainingProducts.id, p.id)))[0];
}

/** plan → order → capture → entitlement, the whole way through. */
async function buyTraining(personId: number, product: any, opts: { startsOn?: string } = {}) {
  const plan = await openTrainingPlan(db, ctx(), {
    personId, productId: product.id, clubId: product.clubId,
    startsOn: opts.startsOn ?? today, renewalMode: 'renewing',
  });
  const order = await payFor([{
    kind: 'training', description: product.title, feeCode: FEE_CODE,
    refType: 'training_plan', refId: plan.id,
  }], personId);
  // confirmPayment() now issues the right to train itself — see activate() in
  // src/db/orders.ts. Until it did, a fully confirmed payment for a child's
  // classes wrote NO row at all, so this call is now the idempotent REPLAY
  // rather than the grant, and it reports `replayed` where it once said
  // `active`. The entitlement is read back from the database because that, and
  // not the shape of a second call's report, is what the tests are about.
  const report = await activateTrainingForOrder(db, null, order.id);
  const [entitlement] = await db.select().from(s.trainingEntitlements)
    .where(eq(s.trainingEntitlements.orderLineId, report.outcomes[0].orderLineId));
  return { plan, order, report, entitlement };
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;

  const [a] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-A', name: 'Ramgarh Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  CLUB_A = a.id;
  const [b] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-B', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  CLUB_B = b.id;

  // The two accounts the audit trail and the framework rows point at.
  await db.insert(s.users).values([
    { email: 'admin@example.in' },
    { email: 'treasurer@example.in' },
  ]);

  // The chargeable service exists in the catalogue and carries NO amount.
  await db.insert(s.feeCatalogueEntries).values({
    code: FEE_CODE, slug: 'training-shotokan-monthly', name: 'Shotokan training, monthly',
    category: 'training', audience: 'athlete', unit: 'per_month', frequency: 'monthly',
    displayPolicy: 'public', status: 'published',
  });
  // The legacy fee schedule prices the ORDER LINE. Separate from the fee
  // framework, which is what records the PRICE VERSION on the entitlement.
  await db.insert(s.feeSchedule).values({
    code: FEE_CODE, label: 'Shotokan training, monthly', kind: 'training',
    amountPaise: 120000, effectiveFrom: '2020-01-01', active: true,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('THE RULE — access is decided by the entitlement, never by membership', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('a person with NO membership at all trains, on the strength of an entitlement alone', async () => {
    await publishAFramework(101);
    const product = await makeProduct();
    const person = await makePerson('A child who is not a member');

    // Stated rather than assumed: this person holds no membership row.
    const memberships = await db.select().from(s.memberships).where(eq(s.memberships.personId, person));
    expect(memberships).toHaveLength(0);

    const { entitlement } = await buyTraining(person, product);
    expect(entitlement.status).toBe('active');

    const decision = await trainingAccess(db, { personId: person });
    expect(decision.allowed).toBe(true);
    expect(decision.grants).toHaveLength(1);
  });

  it('an immaculate active membership grants NO training on its own', async () => {
    const person = await makePerson('A member who has not paid for training');
    await db.insert(s.memberships).values({
      personId: person, category: 'athlete', status: 'active',
      memberNo: `MMAKF-M-${crypto.randomBytes(3).toString('hex')}`,
      validFrom: shift(-30), validTo: shift(300),
    });

    const decision = await trainingAccess(db, { personId: person });
    expect(decision.allowed).toBe(false);
    // And the refusal says what is actually missing — not "your membership".
    expect(decision.reason).toMatch(/no training entitlement/i);
    expect(decision.reason).toMatch(/no membership fee for being a student/i);
  });

  it('the module contains no membership check, in its source text', () => {
    const src = readFileSync('src/db/training-products.ts', 'utf8');
    // The comments discuss membership at length; the CODE must not touch it.
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/s\.memberships/);
    expect(code).not.toMatch(/from '\.\/membership'/);
    expect(code).not.toMatch(/\bmembershipStatus\b/);
    expect(code).not.toMatch(/\bstanding\(/);
  });

  it('the schema has no foreign key between training and memberships, in either direction', async () => {
    const r = await client.query(`
      select tc.table_name, ccu.table_name as ref
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and (
          (tc.table_name like 'training\\_%' and ccu.table_name = 'memberships')
          or (tc.table_name = 'memberships' and ccu.table_name like 'training\\_%')
        )
    `);
    expect(r.rows).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a product carries no price', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('has no column that could hold money', async () => {
    const r = await client.query(`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'training_products'
    `);
    const suspicious = (r.rows as any[]).filter((c) =>
      /price|amount|paise|minor|cost|fee_?(total|amount)|mrp|rupee/i.test(c.column_name)
      && c.column_name !== 'fee_code');
    expect(suspicious).toEqual([]);
    // And nothing numeric that a price could hide in under an innocent name.
    const money = (r.rows as any[]).filter((c) => c.data_type === 'money' || c.data_type === 'numeric');
    expect(money).toEqual([]);
  });

  it('refuses an input that carries a price, by name, rather than dropping it', async () => {
    await expect(defineTrainingProduct(db, ctx(), {
      code: 'MMAKF-TRN-PRICED', slug: 'trn-priced', title: 'Priced',
      discipline: 'Shotokan', programme: 'Junior', period: 'monthly', feeCode: FEE_CODE,
      priceMinor: 120000,
    } as any)).rejects.toThrow(/carries no amount/i);
  });

  it('refuses a period whose length the federation has not stated', async () => {
    await expect(defineTrainingProduct(db, ctx(), {
      code: 'MMAKF-TRN-CAMP', slug: 'trn-camp', title: 'Summer camp',
      discipline: 'Shotokan', programme: 'Camps', period: 'camp', feeCode: FEE_CODE,
    })).rejects.toThrow(/records no validity in days/i);
  });

  it('refuses two lengths for one period', async () => {
    await expect(defineTrainingProduct(db, ctx(), {
      code: 'MMAKF-TRN-BOTH', slug: 'trn-both', title: 'Confused',
      discipline: 'Shotokan', programme: 'Junior', period: 'monthly',
      feeCode: FEE_CODE, validityDays: 30,
    })).rejects.toThrow(/also states a validity in days/i);
  });

  it('refuses to publish a product whose fee code nothing recognises', async () => {
    const p = await defineTrainingProduct(db, ctx(), {
      code: 'MMAKF-TRN-ORPHAN', slug: 'trn-orphan', title: 'Orphan',
      discipline: 'Shotokan', programme: 'Junior', period: 'monthly',
      feeCode: 'MMAKF-FEE-DOES-NOT-EXIST',
    });
    await expect(publishTrainingProduct(db, ctx(), p.id))
      .rejects.toThrow(/not in the fee catalogue/i);
  });

  it('derives the period arithmetically and refuses to guess the rest', () => {
    expect(productValidity({ period: 'monthly', validityDays: null }, '2026-01-01'))
      .toEqual({ ok: true, validFrom: '2026-01-01', validUntil: '2026-01-31', basis: expect.any(String) });
    expect(productValidity({ period: 'annual', validityDays: null }, '2026-01-01').ok).toBe(true);
    expect((productValidity({ period: 'annual', validityDays: null }, '2026-01-01') as any).validUntil)
      .toBe('2026-12-31');
    // The month-end clamp: 31 January + one month is 28/29 February, not 3 March.
    expect(trainingTermEndsOn('2026-01-31', 1)).toBe('2026-02-27');
    const camp = productValidity({ period: 'camp', validityDays: null, code: 'X' }, '2026-01-01');
    expect(camp.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('with no framework published, nothing is priced and nothing is invented', () => {
// ═══════════════════════════════════════════════════════════════════════════

  let bare: any;
  let bareDb: any;

  beforeAll(async () => {
    // A SECOND, EMPTY DATABASE — the state the federation is actually in today.
    bare = new PGlite();
    bareDb = drizzle(bare, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await bare.exec(st.trim());
      }
    }
    const [u] = await bareDb.insert(s.stateUnits).values({
      code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'JH', status: 'active',
    }).returning({ id: s.stateUnits.id });
    const [d] = await bareDb.insert(s.dojos).values({
      code: 'MMAKF-DOJO-A', name: 'A', stateUnitId: u.id, status: 'active',
    }).returning({ id: s.dojos.id });
    await bareDb.insert(s.users).values([
      { email: 'admin@example.in' },
      { email: 'treasurer@example.in' },
    ]);
    await bareDb.insert(s.feeCatalogueEntries).values({
      code: FEE_CODE, slug: 'training-shotokan-monthly', name: 'Shotokan training, monthly',
      category: 'training', audience: 'athlete', unit: 'per_month', frequency: 'monthly',
      displayPolicy: 'public', status: 'published',
    });
    await bareDb.insert(s.feeSchedule).values({
      code: FEE_CODE, label: 'Shotokan training, monthly', kind: 'training',
      amountPaise: 120000, effectiveFrom: '2020-01-01', active: true,
    });
    const p = await defineTrainingProduct(bareDb, ctx(), {
      code: 'MMAKF-TRN-BARE', slug: 'trn-bare', title: 'Shotokan juniors, monthly',
      discipline: 'Shotokan', programme: 'Junior', period: 'monthly',
      feeCode: FEE_CODE, clubId: d.id,
    });
    await publishTrainingProduct(bareDb, ctx(), p.id);
  });

  it('returns no figure at all — not zero, not a benchmark', async () => {
    const [p] = await bareDb.select().from(s.trainingProducts);
    const price = await priceTrainingProduct(bareDb, p.id);
    expect(price.priced).toBe(false);
    expect(price).not.toHaveProperty('totalMinor');
    expect((price as any).reason).toMatch(/has not published a fee framework/i);
    expect((price as any).reason).toMatch(/not zero and it is not free/i);
  });

  it('blocks the grant rather than granting one with no price version, and keeps the money visible', async () => {
    const [p] = await bareDb.select().from(s.trainingProducts);
    const [person] = await bareDb.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-777777', fullName: 'Unpriced child', status: 'active',
      dob: '2014-01-01', gender: 'male', stateUnitId: 1, dojoId: p.clubId,
    }).returning({ id: s.persons.id });

    const plan = await openTrainingPlan(bareDb, ctx(), {
      personId: person.id, productId: p.id, clubId: p.clubId, startsOn: today,
    });
    const order = await createOrder(bareDb, null, {
      personId: person.id, email: 'x@example.in',
      lines: [{ kind: 'training', description: 'Training', feeCode: FEE_CODE, refType: 'training_plan', refId: plan.id }],
    });
    const attempt = await beginPayment(bareDb, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(bareDb, null, captured({
      providerOrderId: attempt.providerOrderId, amountPaise: order.totalPaise,
    }));

    const report = await activateTrainingForOrder(bareDb, null, order.id);
    expect(report.granted).toBe(0);
    expect(report.blocked).toBe(1);
    expect(report.outcomes[0].reason).toMatch(/no fee framework in force/i);

    // The money is not lost. It is on a queue, with the reason.
    const queue = await blockedTraining(bareDb, finance);
    expect(queue).toHaveLength(1);
    expect(queue[0].amountPaidMinor).toBe(order.totalPaise);

    // And it grants nothing.
    const decision = await trainingAccess(bareDb, { personId: person.id });
    expect(decision.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('a verified capture grants training, once, at a recorded price version', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('records the framework id, code and version it was bought under', async () => {
    const fw = await publishAFramework(201);
    const product = await makeProduct();
    const person = await makePerson('Priced child');
    const { entitlement: ent } = await buyTraining(person, product);

    expect(ent.priceFrameworkId).toBe(fw.id);
    expect(ent.priceFrameworkCode).toBe(fw.code);
    expect(ent.priceFrameworkVersion).toBe(201);
    expect(ent.status).toBe('active');
    expect(ent.paymentId).not.toBeNull();
    // And the descriptors are FROZEN, not joined.
    expect(ent.discipline).toBe(normaliseDiscipline('Shotokan Karate-do'));
    expect(ent.programme).toBe('Junior foundation');
  });

  it('a framework published LATER does not re-version an entitlement already sold', async () => {
    await publishAFramework(301);
    const product = await makeProduct();
    const person = await makePerson('Bought under v301');
    const { report } = await buyTraining(person, product);
    const id = report.outcomes[0].entitlementId!;

    await publishAFramework(302);

    const [ent] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.id, id));
    expect(ent.priceFrameworkVersion).toBe(301);
  });

  it('a replayed activation grants nothing a second time', async () => {
    await publishAFramework(401);
    const product = await makeProduct();
    const person = await makePerson('Double-clicked');
    const { order, report } = await buyTraining(person, product);

    const again = await activateTrainingForOrder(db, null, order.id);
    expect(again.granted).toBe(0);
    expect(again.replayed).toBe(1);
    expect(again.outcomes[0].entitlementId).toBe(report.outcomes[0].entitlementId);

    const rows = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, person));
    expect(rows).toHaveLength(1);
  });

  it('a browser asserting success, with no captured payment, grants nothing', async () => {
    await publishAFramework(501);
    const product = await makeProduct();
    const person = await makePerson('Unpaid');
    const plan = await openTrainingPlan(db, ctx(), {
      personId: person, productId: product.id, clubId: product.clubId, startsOn: today,
    });
    const order = await createOrder(db, null, {
      personId: person, email: 'x@example.in',
      lines: [{ kind: 'training', description: 'Training', feeCode: FEE_CODE, refType: 'training_plan', refId: plan.id }],
    });
    // No beginPayment, no confirmPayment. Nothing was verified.
    await expect(activateTrainingForOrder(db, null, order.id))
      .rejects.toThrow(/server-verified capture/i);

    const rows = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, person));
    expect(rows).toHaveLength(0);
  });

  it('a non-training line on the same order is reported, not silently skipped', async () => {
    await publishAFramework(601);
    const product = await makeProduct();
    const person = await makePerson('Mixed basket');
    const plan = await openTrainingPlan(db, ctx(), {
      personId: person, productId: product.id, clubId: product.clubId, startsOn: today,
    });
    await db.insert(s.feeSchedule).values({
      code: 'grading.kyu', label: 'Kyu grading', kind: 'grading',
      amountPaise: 50000, effectiveFrom: '2020-01-01', active: true,
    });
    const order = await payFor([
      { kind: 'training', description: 'Training', feeCode: FEE_CODE, refType: 'training_plan', refId: plan.id },
      { kind: 'grading', description: 'Grading', feeCode: 'grading.kyu' },
    ], person);
    const report = await activateTrainingForOrder(db, null, order.id);
    // The training line was granted by the payment path, so this run replays it.
    // The GRADING line is the point: it is REPORTED as somebody else's job, not
    // skipped in silence.
    expect(report.outcomes.filter((o) => o.status === 'not_training')).toHaveLength(1);
    const granted = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.orderId, order.id));
    expect(granted).toHaveLength(1);
    expect(granted[0].status).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('expiry happens at the moment it happens, and deletes nothing', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('an entitlement that ended yesterday grants nothing today — with no sweep having run', async () => {
    await publishAFramework(701);
    const product = await makeProduct();
    const person = await makePerson('Lapsed');
    const { report } = await buyTraining(person, product, { startsOn: shift(-90) });
    const id = report.outcomes[0].entitlementId!;

    const [ent] = await db.select().from(s.trainingEntitlements).where(eq(s.trainingEntitlements.id, id));
    expect(ent.validUntil < today).toBe(true);
    // Its STATUS is still 'active'. Nothing expired it, because nothing has to.
    expect(ent.status).toBe('active');

    const decision = await trainingAccess(db, { personId: person });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/ended on/i);
    expect(decision.reason).toMatch(/record of having trained is kept/i);
  });

  it('access flips on the day boundary and not on a cron run', async () => {
    await publishAFramework(801);
    const product = await makeProduct();
    const person = await makePerson('On the boundary');
    const { report } = await buyTraining(person, product, { startsOn: today });
    const [ent] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.id, report.outcomes[0].entitlementId!));

    // The last valid day: allowed. The next day: not. Same row, same status.
    expect((await trainingAccess(db, { personId: person, at: ent.validUntil })).allowed).toBe(true);
    const dayAfter = new Date(`${ent.validUntil}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect((await trainingAccess(db, { personId: person, at: iso(dayAfter) })).allowed).toBe(false);
  });

  it('a lapsed entitlement keeps its whole record, and so does the person', async () => {
    await publishAFramework(901);
    const product = await makeProduct();
    const person = await makePerson('Still on the books');
    await buyTraining(person, product, { startsOn: shift(-400) });

    const history = await trainingHistory(db, admin, person);
    expect(history).toHaveLength(1);
    expect(history[0].current).toBe(false);
    // Everything that makes the charge defensible is still there.
    expect(history[0].validFrom).toBeTruthy();
    expect(history[0].validUntil).toBeTruthy();
    expect(history[0].priceFrameworkCode).toBeTruthy();
    expect(history[0].priceFrameworkVersion).toBe(901);
    expect(history[0].paidFormatted).toMatch(/₹/);

    // And the person is not deleted, suspended or otherwise touched.
    const [p] = await db.select().from(s.persons).where(eq(s.persons.id, person));
    expect(p.status).toBe('active');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('renewal — a training renewal, and never a subscription cycle', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('starts the day after the previous term ends, and chains to it', async () => {
    await publishAFramework(1001);
    const product = await makeProduct();
    const person = await makePerson('Renewing');
    const { entitlement: firstRow } = await buyTraining(person, product, { startsOn: today });
    const first = firstRow.id;

    // THE SECOND MONTH, PAID FOR THE ORDINARY WAY. Now that confirmPayment()
    // issues training, the renewal arrives through the payment path rather than
    // through renewTraining(), and it has to be dated as a renewal there — a
    // second term starting on the day the plan first began would overlap the
    // first almost entirely and lose a month somebody paid for.
    const order = await payFor([{
      kind: 'training', description: 'Renewal', feeCode: FEE_CODE,
      refType: 'training_product', refId: product.id,
    }], person);
    const [next] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.orderId, order.id));

    const dayAfter = new Date(`${firstRow.validUntil}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect(next.validFrom).toBe(iso(dayAfter));
    expect(next.renewedFromEntitlementId).toBe(first);
    expect(next.renewalSequence).toBe(2);

    // No gap and no overlap: the two terms are adjacent.
    expect(firstRow.validUntil < next.validFrom).toBe(true);
  });

  it('a retried renewal extends the term once, not twice', async () => {
    await publishAFramework(1101);
    const product = await makeProduct();
    const person = await makePerson('Retried renewal');
    const { entitlement } = await buyTraining(person, product);
    const first = entitlement.id;

    const order = await payFor([{
      kind: 'training', description: 'Renewal', feeCode: FEE_CODE,
      refType: 'training_product', refId: product.id,
    }], person);
    const [line] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));

    // The payment path already extended the term once. Re-running the
    // activation and calling renewTraining() on the same line both refuse to
    // extend it a second time.
    await activateTrainingForOrder(db, null, order.id);
    await expect(renewTraining(db, ctx(), { previousEntitlementId: first, orderLineId: line.id }))
      .rejects.toThrow(/already been renewed|already granted|order line/i);

    const chain = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.renewedFromEntitlementId, first));
    expect(chain).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('revocation keeps the record', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('a revoked entitlement stops granting access and keeps every column', async () => {
    await publishAFramework(1201);
    const product = await makeProduct();
    const person = await makePerson('Refunded');
    const { report } = await buyTraining(person, product);
    const id = report.outcomes[0].entitlementId!;

    await revokeTraining(db, ctx(), { entitlementId: id, reason: 'Refunded at the family\'s request.' });

    const [ent] = await db.select().from(s.trainingEntitlements).where(eq(s.trainingEntitlements.id, id));
    expect(ent.status).toBe('revoked');
    expect(ent.revokedAt).toBeTruthy();
    expect(ent.reason).toMatch(/family/);
    // Nothing was erased.
    expect(ent.validFrom).toBeTruthy();
    expect(ent.priceFrameworkCode).toBeTruthy();
    expect(ent.amountPaidMinor).toBeGreaterThan(0);

    expect((await trainingAccess(db, { personId: person })).allowed).toBe(false);
    await expect(assertTrainingAccess(db, { personId: person })).rejects.toThrow();
  });

  it('a revocation must say why', async () => {
    await publishAFramework(1301);
    const product = await makeProduct();
    const person = await makePerson('No reason given');
    const { report } = await buyTraining(person, product);
    await expect(revokeTraining(db, ctx(), {
      entitlementId: report.outcomes[0].entitlementId!, reason: '',
    })).rejects.toThrow(/must say why/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('several clubs, and a transfer that keeps the history', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('one person holds live enrolments at more than one club', async () => {
    const person = await makePerson('Two clubs');
    await enrol(db, ctx(), { personId: person, clubId: CLUB_A });
    await enrol(db, ctx(), { personId: person, clubId: CLUB_B });

    const clubs = await clubsForPerson(db, person);
    expect(clubs.map((c: any) => c.clubId).sort()).toEqual([CLUB_A, CLUB_B].sort());
  });

  it('enrolling twice at the same club is refused', async () => {
    const person = await makePerson('Duplicate roll');
    await enrol(db, ctx(), { personId: person, clubId: CLUB_A });
    await expect(enrol(db, ctx(), { personId: person, clubId: CLUB_A }))
      .rejects.toThrow(/already on that club/i);
  });

  it('a transfer moves the enrolment, keeps both rows, and never duplicates the person', async () => {
    await publishAFramework(1401);
    const product = await makeProduct();
    const person = await makePerson('Moving town');
    const before = await db.select().from(s.persons).where(eq(s.persons.id, person));

    const { report } = await buyTraining(person, product);
    const entId = report.outcomes[0].entitlementId!;
    const from = await enrol(db, ctx(), { personId: person, clubId: CLUB_A });

    const moved = await transferEnrolment(db, ctx(), {
      enrolmentId: from.id, toClubId: CLUB_B, reason: 'The family moved to Ranchi.',
    });
    expect(moved.entitlementsMoved).toBe(1);

    const rows = await db.select().from(s.trainingEnrolments)
      .where(eq(s.trainingEnrolments.personId, person));
    expect(rows).toHaveLength(2);
    const old = rows.find((r: any) => r.id === from.id)!;
    const neu = rows.find((r: any) => r.id === moved.to)!;
    expect(old.status).toBe('transferred');
    expect(old.endedOn).toBeTruthy();
    expect(old.transferredToId).toBe(neu.id);
    expect(neu.transferredFromId).toBe(old.id);
    // ONE PERSON, TWO ENROLMENTS. Not two people.
    expect(neu.personId).toBe(old.personId);
    const after = await db.select().from(s.persons).where(eq(s.persons.id, person));
    expect(after).toHaveLength(1);
    expect(after[0].fullName).toBe(before[0].fullName);
  });

  it('a transfer does not rewrite what was bought, and access follows the student', async () => {
    await publishAFramework(1501);
    const product = await makeProduct();
    const person = await makePerson('Transferred training');
    const { report } = await buyTraining(person, product);
    const entId = report.outcomes[0].entitlementId!;
    const from = await enrol(db, ctx(), { personId: person, clubId: CLUB_A });

    expect((await trainingAccess(db, { personId: person, clubId: CLUB_A })).allowed).toBe(true);
    expect((await trainingAccess(db, { personId: person, clubId: CLUB_B })).allowed).toBe(false);

    await transferEnrolment(db, ctx(), {
      enrolmentId: from.id, toClubId: CLUB_B, reason: 'Transferred for the school year.',
    });

    const [ent] = await db.select().from(s.trainingEntitlements).where(eq(s.trainingEntitlements.id, entId));
    // THE HISTORICAL FACT IS UNTOUCHED: it was bought at club A.
    expect(ent.clubId).toBe(CLUB_A);
    // And delivery moved.
    expect(ent.servicedByClubId).toBe(CLUB_B);

    expect((await trainingAccess(db, { personId: person, clubId: CLUB_B })).allowed).toBe(true);
    expect((await trainingAccess(db, { personId: person, clubId: CLUB_A })).allowed).toBe(false);

    const decision = await trainingAccess(db, { personId: person, clubId: CLUB_B });
    expect(decision.grants[0].purchasedAtClubId).toBe(CLUB_A);
    expect(decision.grants[0].clubId).toBe(CLUB_B);
  });

  it('a transfer must say why', async () => {
    const person = await makePerson('Silent transfer');
    const from = await enrol(db, ctx(), { personId: person, clubId: CLUB_A });
    await expect(transferEnrolment(db, ctx(), { enrolmentId: from.id, toClubId: CLUB_B, reason: '' }))
      .rejects.toThrow(/must say why/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the surfaces around it', () => {
// ═══════════════════════════════════════════════════════════════════════════

  it('publishedProducts excludes drafts and withdrawn products', async () => {
    const live = await makeProduct();
    const draft = await makeProduct({ status: 'draft' });
    const gone = await makeProduct();
    await withdrawTrainingProduct(db, ctx(), gone.id, 'No longer offered at this club.');

    const listed = await publishedProducts(db, {});
    const ids = listed.map((p: any) => p.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(gone.id);
  });

  it('withdrawing a product does not touch the training already sold under it', async () => {
    await publishAFramework(1601);
    const product = await makeProduct();
    const person = await makePerson('Bought before withdrawal');
    await buyTraining(person, product);

    await withdrawTrainingProduct(db, ctx(), product.id, 'Replaced by a new timetable.');

    expect((await trainingAccess(db, { personId: person })).allowed).toBe(true);
  });

  it('the renewal window is an argument and has no default', async () => {
    await expect(expiringTraining(db, admin, undefined as any))
      .rejects.toThrow(/State the renewal window/i);
    await expect(expiringTraining(db, admin, -1)).rejects.toThrow(/State the renewal window/i);
    // With a window stated, it answers.
    const rows = await expiringTraining(db, admin, 30);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('discipline is compared as a value and not as a typist\'s spacing', async () => {
    await publishAFramework(1701);
    const product = await makeProduct({ discipline: '  Shotokan   Karate-do ' });
    const person = await makePerson('Spacing');
    await buyTraining(person, product);

    expect((await trainingAccess(db, { personId: person, discipline: 'SHOTOKAN karate-do' })).allowed).toBe(true);
    expect((await trainingAccess(db, { personId: person, discipline: 'kobudo' })).allowed).toBe(false);
  });

  it('a second live plan for the same product at the same club is refused', async () => {
    await publishAFramework(1801);
    const product = await makeProduct();
    const person = await makePerson('Duplicate plan');
    await openTrainingPlan(db, ctx(), {
      personId: person, productId: product.id, clubId: product.clubId, startsOn: today,
    });
    await expect(openTrainingPlan(db, ctx(), {
      personId: person, productId: product.id, clubId: product.clubId, startsOn: today,
    })).rejects.toThrow(/already holds a live plan/i);
  });
});
