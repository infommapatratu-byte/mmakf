// Sellers, listings, and the two gates between a seller and the public.
//
// The federation's instruction was: "If onboarded they can list their items
// after approval by our people in admin." Two decisions, not one — and the
// second is worthless unless editing an approved item takes it back off the
// site, which is the rule most likely to be quietly missing.
//
// So the centre of this file is not the happy path. It is:
//
//   · a seller who has applied but not been approved, trying to list;
//   · an approved seller editing an approved gi into something else;
//   · a suspended seller's shop, which must empty in the same instant without
//     a single row being deleted;
//   · the public query, which must exclude unapproved rows IN SQL — proved by
//     asking for one row and checking the right one comes back, which a
//     post-fetch filter cannot do.
//
// Against a real Postgres (PGlite) with every migration applied, because the
// public visibility rule is a SQL predicate and does not exist in a mock.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, rejectSeller, suspendSeller, reinstateSeller,
  withdrawFromSelling, mySellerAccount, sellerQueue, missingCommercialDetails,
  createListing, updateListing, setListingStock, submitListing, reviewListing,
  withdrawListing, delistListing, listingQueue, listingHistory,
  publicListings, publicListing, myListings, listingContentHash,
  LISTING_CATEGORIES, COMMISSION_NOT_SET, SELLER_REQUIREMENTS_NOT_SET,
  LISTING_REVIEW_TURNAROUND_NOT_SET, isMarketplaceError,
} from '../src/db/marketplace';
import type { CreateListingInput } from '../src/db/marketplace';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, BR: number;
let ADMIN: number, JH_ADMIN: number, BR_ADMIN: number;

const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const jhAdmin = (): Principal => ({
  userId: JH_ADMIN, label: 'jh', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
});
const brAdmin = (): Principal => ({
  userId: BR_ADMIN, label: 'br', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: BR }],
});

const ctxOf = (principal: Principal) => ({ principal });

let seq = 0;
/** A registered account with no authority — where every seller starts. */
async function account(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  return { userId: r.userId, principal: { userId: r.userId, label: r.email, bindings: [] } as Principal };
}

/** An account that has applied and been approved to sell, in a state. */
async function approvedSeller(tag: string, stateUnitId = JH) {
  const me = await account(tag);
  const applied = await applyToSell(db, ctxOf(me.principal), {
    tradingName: `${tag} Dojo Supplies`, contactEmail: `${tag}@shop.in`, stateUnitId,
  });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Identity and address confirmed at the state office.');
  return { ...me, sellerId: applied.sellerId, ref: applied.ref };
}

const GI: CreateListingInput = {
  title: 'Karate-Gi, medium weight',
  description: 'Plain white cotton gi, no federation marking.',
  category: 'uniform',
  priceMinor: 179900,                 // ₹1,799 in paise
  media: [{ url: 'https://cdn.example.in/gi-front.jpg', alt: 'Plain white karate-gi, front' }],
};

/** Take a listing all the way to publicly visible. */
async function publishedListing(seller: { principal: Principal }, overrides: Partial<CreateListingInput> = {}) {
  const created = await createListing(db, ctxOf(seller.principal), { ...GI, ...overrides, stockQty: 5 });
  await submitListing(db, ctxOf(seller.principal), created.listingId);
  await reviewListing(db, ctxOf(national()), created.listingId, {
    decision: 'approve', reason: 'Item, price and photographs seen and accepted.',
  });
  return created;
}

const refs = (rows: any[]) => rows.map((r: any) => r.ref);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const seeded = await db.insert(s.users).values([
    { email: 'admin@mmakf.in', status: 'active' },
    { email: 'jh@mmakf.in', status: 'active' },
    { email: 'br@mmakf.in', status: 'active' },
  ]).returning({ id: s.users.id });
  [ADMIN, JH_ADMIN, BR_ADMIN] = seeded.map((u: any) => u.id);

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id; BR = br.id;
});

// ─── RULE 5 ─────────────────────────────────────────────────────────────────

describe('RULE 5: TWO GATES — the seller, and then the item', () => {
  it('GATE ONE: an unapproved seller cannot create a listing at all', async () => {
    const me = await account('gate-one');
    const applied = await applyToSell(db, ctxOf(me.principal), { tradingName: 'Hopeful Supplies', stateUnitId: JH });
    expect(applied.status).toBe('applied');

    // Not even a draft. A listing that exists is a listing that can be
    // submitted, and the queue is not a waiting room for people MMAKF has not
    // accepted.
    await expect(createListing(db, ctxOf(me.principal), GI)).rejects.toThrow(/must be approved by MMAKF/);
    expect(await db.select().from(s.listings)).toEqual(expect.arrayContaining([]));

    const account_ = await mySellerAccount(db, me.principal);
    expect(account_!.mayCreateListings).toBe(false);
  });

  it('an account with no seller record at all is refused', async () => {
    const me = await account('not-a-seller');
    await expect(createListing(db, ctxOf(me.principal), GI)).rejects.toThrow(/no seller record/i);
    expect(await mySellerAccount(db, me.principal)).toBeNull();
    expect(await myListings(db, me.principal)).toEqual([]);
  });

  it('GATE TWO: an approved seller\'s listing is NOT public until the listing is approved', async () => {
    const seller = await approvedSeller('gate-two');
    const created = await createListing(db, ctxOf(seller.principal), { ...GI, stockQty: 3 });
    expect(created.status).toBe('draft');
    expect(refs(await publicListings(db))).not.toContain(created.ref);

    // Submitting is the seller asking. It is not the federation answering.
    await submitListing(db, ctxOf(seller.principal), created.listingId);
    expect(refs(await publicListings(db))).not.toContain(created.ref);
    expect(await publicListing(db, created.ref)).toBeNull();

    await reviewListing(db, ctxOf(national()), created.listingId, {
      decision: 'approve', reason: 'Plain gi, price and photograph accepted.',
    });
    expect(refs(await publicListings(db))).toContain(created.ref);
    expect((await publicListing(db, created.ref))!.title).toBe(GI.title);
  });

  it('a rejected listing never reaches the public, and carries the reason', async () => {
    const seller = await approvedSeller('rejected-item');
    const created = await createListing(db, ctxOf(seller.principal), GI);
    await submitListing(db, ctxOf(seller.principal), created.listingId);
    await reviewListing(db, ctxOf(national()), created.listingId, {
      decision: 'reject', reason: 'The photograph shows a competition gi; the title says medium weight.',
    });

    expect(refs(await publicListings(db))).not.toContain(created.ref);
    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, created.listingId));
    expect(row.status).toBe('rejected');
    expect(row.approvedContentHash).toBeNull();
    expect(row.decisionReason).toMatch(/competition gi/);
  });

  it('a listing cannot be approved for a seller the federation has not approved', async () => {
    // The dangerous ordering: the listing was submitted while the seller was in
    // good standing, and the seller is suspended before the reviewer gets to it.
    const seller = await approvedSeller('suspended-mid-review');
    const created = await createListing(db, ctxOf(seller.principal), GI);
    await submitListing(db, ctxOf(seller.principal), created.listingId);
    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Complaint under investigation.');

    await expect(
      reviewListing(db, ctxOf(national()), created.listingId, { decision: 'approve', reason: 'Looks fine.' })
    ).rejects.toThrow(/cannot be approved for a seller the federation has not approved/);
  });
});

// ─── RULE 6 ─────────────────────────────────────────────────────────────────

describe('RULE 6: EDITING AN APPROVED LISTING RETURNS IT TO REVIEW', () => {
  it('changing the title takes the item off the site immediately', async () => {
    const seller = await approvedSeller('edit-title');
    const item = await publishedListing(seller);
    expect(refs(await publicListings(db))).toContain(item.ref);

    const edited = await updateListing(db, ctxOf(seller.principal), item.listingId, {
      title: 'Competition Gi — WKF approved, limited edition',
    });

    expect(edited.contentChanged).toBe(true);
    expect(edited.returnedToReview).toBe(true);
    expect(edited.status).toBe('submitted');

    // THE PUBLIC QUERY STOPS RETURNING IT. This is the whole point.
    expect(refs(await publicListings(db))).not.toContain(item.ref);
    expect(await publicListing(db, item.ref)).toBeNull();
  });

  it('changing the PRICE returns it to review', async () => {
    const seller = await approvedSeller('edit-price');
    const item = await publishedListing(seller);
    const edited = await updateListing(db, ctxOf(seller.principal), item.listingId, { priceMinor: 999900 });
    expect(edited.returnedToReview).toBe(true);
    expect(refs(await publicListings(db))).not.toContain(item.ref);
  });

  it('changing the PHOTOGRAPHS returns it to review', async () => {
    // The version of this that gets missed: the words stay honest and the
    // pictures become something else.
    const seller = await approvedSeller('edit-media');
    const item = await publishedListing(seller);
    const edited = await updateListing(db, ctxOf(seller.principal), item.listingId, {
      media: [{ url: 'https://cdn.example.in/something-else.jpg', alt: 'A different item entirely' }],
    });
    expect(edited.returnedToReview).toBe(true);
    expect(refs(await publicListings(db))).not.toContain(item.ref);
  });

  it('clears the previous decision, so the queue does not display last week\'s approval', async () => {
    const seller = await approvedSeller('clears-decision');
    const item = await publishedListing(seller);
    await updateListing(db, ctxOf(seller.principal), item.listingId, { description: 'Now with a federation badge.' });

    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.status).toBe('submitted');
    expect(row.approvedContentHash).toBeNull();
    expect(row.reviewedByUserId).toBeNull();
    expect(row.decisionReason).toBeNull();
  });

  it('A NO-OP SAVE DOES NOT DISTURB THE APPROVAL', async () => {
    // If it did, sellers would learn that touching the form costs them their
    // place in the shop, and they would stop correcting mistakes.
    const seller = await approvedSeller('no-op-save');
    const item = await publishedListing(seller);

    const saved = await updateListing(db, ctxOf(seller.principal), item.listingId, {
      title: GI.title, description: GI.description, priceMinor: GI.priceMinor,
    });
    expect(saved.contentChanged).toBe(false);
    expect(saved.returnedToReview).toBe(false);
    expect(refs(await publicListings(db))).toContain(item.ref);
  });

  it('CHANGING STOCK DOES NOT return it to review', async () => {
    // Stock is not reviewable content. If it were, a seller who sold three gis
    // would push their listing back into the queue three times in a day, and an
    // unreadable queue approves everything.
    const seller = await approvedSeller('stock-change');
    const item = await publishedListing(seller);

    await setListingStock(db, ctxOf(seller.principal), item.listingId, 0);
    expect(refs(await publicListings(db))).toContain(item.ref);
    await setListingStock(db, ctxOf(seller.principal), item.listingId, 42);
    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.status).toBe('approved');
    expect(row.stockQty).toBe(42);
  });

  it('re-approval puts it back, and the record shows exactly what was approved each time', async () => {
    const seller = await approvedSeller('re-approval');
    const item = await publishedListing(seller);
    await updateListing(db, ctxOf(seller.principal), item.listingId, { priceMinor: 149900 });
    expect(refs(await publicListings(db))).not.toContain(item.ref);

    await reviewListing(db, ctxOf(national()), item.listingId, {
      decision: 'approve', reason: 'Price reduction confirmed with the seller.',
    });
    expect(refs(await publicListings(db))).toContain(item.ref);

    const history = await listingHistory(db, national(), item.listingId);
    const approvals = history.filter((h: any) => h.action === 'approved');
    expect(approvals.length).toBe(2);
    // Each approval is a frozen snapshot, so "what exactly did we approve?" is
    // answerable a year later, at both prices.
    expect(approvals[0].snapshot.priceMinor).toBe(GI.priceMinor);
    expect(approvals[1].snapshot.priceMinor).toBe(149900);
    expect(approvals[0].contentHash).not.toBe(approvals[1].contentHash);
  });

  it('the hash defends the rule even if the status is tampered with directly', async () => {
    // The belt-and-braces half. A refactor that dropped the status change would
    // reopen the whole hole; the public predicate compares hashes as well, so
    // the item still leaves the shop.
    const seller = await approvedSeller('hash-defence');
    const item = await publishedListing(seller);
    await updateListing(db, ctxOf(seller.principal), item.listingId, { title: 'Something MMAKF never saw' });

    // Force the status back by hand, as a careless migration or a bad refactor
    // might. The hashes still disagree.
    await db.update(s.listings).set({ status: 'approved' }).where(eq(s.listings.id, item.listingId));
    expect(refs(await publicListings(db))).not.toContain(item.ref);
    expect(await publicListing(db, item.ref)).toBeNull();
  });

  it('the content hash is stable under reordering and ignores stock', () => {
    const base = {
      title: 'Gi', description: 'x', category: 'uniform' as const,
      priceMinor: 100, currency: 'INR',
      media: [
        { url: 'b.jpg', alt: 'b', sortOrder: 1 },
        { url: 'a.jpg', alt: 'a', sortOrder: 0 },
      ],
    };
    const reordered = { ...base, media: [base.media[1], base.media[0]] };
    expect(listingContentHash(base)).toBe(listingContentHash(reordered));
    expect(listingContentHash({ ...base, priceMinor: 101 })).not.toBe(listingContentHash(base));
  });

  it('a suspended seller cannot edit, and their listings are untouched', async () => {
    const seller = await approvedSeller('suspended-editor');
    const item = await publishedListing(seller);
    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Under investigation.');

    await expect(
      updateListing(db, ctxOf(seller.principal), item.listingId, { title: 'Quick, change it' })
    ).rejects.toThrow(/cannot edit listings/);

    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.status).toBe('approved');
    expect(row.title).toBe(GI.title);
  });
});

// ─── RULE 7 ─────────────────────────────────────────────────────────────────

describe('RULE 7: THE PUBLIC QUERY FILTERS IN SQL', () => {
  it('a LIMIT proves the filter is in the query, not applied afterwards', async () => {
    // The discriminator. Every unapproved row here has a HIGHER id than the
    // approved one, and the ordering is newest first. A post-fetch filter with
    // limit:1 would take the newest row — an unapproved one — and then discard
    // it, returning nothing. A SQL filter returns the approved item.
    const seller = await approvedSeller('sql-filter');
    const item = await publishedListing(seller);

    for (let i = 0; i < 6; i++) {
      const noise = await createListing(db, ctxOf(seller.principal), { ...GI, title: `Unreviewed ${i}` });
      if (i % 2 === 0) await submitListing(db, ctxOf(seller.principal), noise.listingId);
    }

    const page = await publicListings(db, { limit: 1 });
    expect(page.length).toBe(1);
    expect(page[0].ref).toBe(item.ref);
    expect(page[0].title).toBe(GI.title);
  });

  it('never returns a draft, submitted, rejected, withdrawn or delisted row', async () => {
    const all = await publicListings(db, { limit: 100 });
    const ids = all.map((r: any) => r.id);
    if (ids.length) {
      const rows = await db.select().from(s.listings);
      const returned = rows.filter((r: any) => ids.includes(r.id));
      expect(returned.every((r: any) => r.status === 'approved')).toBe(true);
      expect(returned.every((r: any) => r.contentHash === r.approvedContentHash)).toBe(true);
    }
  });

  it('the visibility rule has exactly ONE definition in the source tree', () => {
    // Four copies of the public-event status list already taught this project
    // what a duplicated visibility rule costs. A comment saying "keep these in
    // sync" is not an enforcement mechanism; this is.
    const declaring = ['src/db/onboarding.schema.ts', 'src/db/marketplace.ts', 'src/db/onboarding.ts']
      .filter((f) => /export function publicListingPredicate/.test(readFileSync(f, 'utf8')));
    expect(declaring).toEqual(['src/db/onboarding.schema.ts']);

    // And the module that serves the public builds its WHERE from it rather
    // than restating the three conditions.
    const src = readFileSync('src/db/marketplace.ts', 'utf8');
    const publicFns = src.slice(src.indexOf('export async function publicListings'));
    expect(publicFns).toMatch(/publicListingPredicate\(\)/);
    // No JavaScript-side status comparison anywhere in the public path.
    expect(publicFns).not.toMatch(/\.filter\([^)]*status/);
    expect(publicFns).not.toMatch(/status\s*===\s*'approved'/);
  });

  it('takes no principal, so no caller can widen it', () => {
    // A principal parameter invites somebody to pass one, and then invites a
    // branch that treats an administrator's view as the public's.
    expect(publicListings.length).toBeLessThanOrEqual(2);
    const src = readFileSync('src/db/marketplace.ts', 'utf8');
    expect(src).toMatch(/export async function publicListings\(db: DB, opts: PublicListingsOptions/);
  });
});

// ─── RULE 8 ─────────────────────────────────────────────────────────────────

describe('RULE 8: SUSPENDING A SELLER WITHDRAWS THEIR LISTINGS IMMEDIATELY', () => {
  it('empties the shop without deleting anything, and reinstatement restores it', async () => {
    const seller = await approvedSeller('suspension');
    const a = await publishedListing(seller, { title: 'Belt, white' });
    const b = await publishedListing(seller, { title: 'Belt, brown' });

    let visible = refs(await publicListings(db, { limit: 100 }));
    expect(visible).toContain(a.ref);
    expect(visible).toContain(b.ref);

    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Two unresolved delivery complaints.');

    visible = refs(await publicListings(db, { limit: 100 }));
    expect(visible).not.toContain(a.ref);
    expect(visible).not.toContain(b.ref);

    // NOTHING WAS DELETED, and no listing row was even touched. One status
    // change on the seller withdrew an unbounded number of listings.
    const rows = await db.select().from(s.listings).where(eq(s.listings.sellerId, seller.sellerId));
    expect(rows.length).toBe(2);
    expect(rows.every((r: any) => r.status === 'approved')).toBe(true);
    expect(rows.every((r: any) => r.approvedContentHash !== null)).toBe(true);

    await reinstateSeller(db, ctxOf(national()), seller.sellerId, 'Complaints resolved; seller reinstated.');
    visible = refs(await publicListings(db, { limit: 100 }));
    expect(visible).toContain(a.ref);
    expect(visible).toContain(b.ref);
  });

  it('reinstatement brings back only what was approved, not what was pending', async () => {
    const seller = await approvedSeller('selective-reinstate');
    const approved = await publishedListing(seller, { title: 'Shin guards' });
    const pending = await createListing(db, ctxOf(seller.principal), { ...GI, title: 'Never reviewed' });
    await submitListing(db, ctxOf(seller.principal), pending.listingId);

    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Pending checks.');
    await reinstateSeller(db, ctxOf(national()), seller.sellerId, 'Checks complete.');

    const visible = refs(await publicListings(db, { limit: 100 }));
    expect(visible).toContain(approved.ref);
    expect(visible).not.toContain(pending.ref);
  });

  it('a suspension keeps its reason even after reinstatement', async () => {
    const seller = await approvedSeller('reason-survives');
    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Counterfeit goods reported.');
    await reinstateSeller(db, ctxOf(national()), seller.sellerId, 'Report withdrawn by the complainant.');

    const [row] = await db.select().from(s.sellers).where(eq(s.sellers.id, seller.sellerId));
    expect(row.status).toBe('approved');
    // A reinstated seller who was once suspended is a different record from one
    // who never was, and the federation may need to know which it is looking at.
    expect(row.suspendedReason).toBe('Counterfeit goods reported.');
    expect(row.suspendedAt).toBeTruthy();
  });

  it('a suspended seller cannot escape by applying again', async () => {
    const seller = await approvedSeller('no-escape');
    await suspendSeller(db, ctxOf(national()), seller.sellerId, 'Suspended.');
    await expect(
      applyToSell(db, ctxOf(seller.principal), { tradingName: 'A Totally New Shop', stateUnitId: JH })
    ).rejects.toThrow(/already has a seller record/);
  });
});

// ─── RULE 9 ─────────────────────────────────────────────────────────────────

describe('RULE 9: EVERY REFUSAL AND SUSPENSION CARRIES A RECORDED REASON', () => {
  it('refuses a listing rejection, a seller rejection, a suspension and a delisting with no reason', async () => {
    const seller = await approvedSeller('reasonless');
    const item = await publishedListing(seller);
    const other = await account('reasonless-applicant');
    const applied = await applyToSell(db, ctxOf(other.principal), { tradingName: 'X', stateUnitId: JH });

    await expect(delistListing(db, ctxOf(national()), item.listingId, '  ')).rejects.toThrow(/recorded reason/);
    await expect(suspendSeller(db, ctxOf(national()), seller.sellerId, '')).rejects.toThrow(/recorded reason/);
    await expect(rejectSeller(db, ctxOf(national()), applied.sellerId, '')).rejects.toThrow(/recorded reason/);

    const pending = await createListing(db, ctxOf(seller.principal), { ...GI, title: 'Needs a reason' });
    await submitListing(db, ctxOf(seller.principal), pending.listingId);
    await expect(
      reviewListing(db, ctxOf(national()), pending.listingId, { decision: 'reject', reason: '   ' })
    ).rejects.toThrow(/recorded reason/);
  });

  it('writes the reason to the row and to the audit trail', async () => {
    const seller = await approvedSeller('audited-reason');
    const item = await publishedListing(seller);
    const reason = 'Item withdrawn: the photograph is of a product MMAKF does not certify.';
    await delistListing(db, ctxOf(national()), item.listingId, reason);

    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.status).toBe('delisted');
    expect(row.decisionReason).toBe(reason);
    expect(refs(await publicListings(db, { limit: 100 }))).not.toContain(item.ref);

    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'listing'), eq(s.auditEvents.entityId, String(item.listingId))));
    expect(audit.some((a: any) => a.reason === reason)).toBe(true);
  });

  it('a delisted item can be corrected and resubmitted, but not simply re-listed', async () => {
    const seller = await approvedSeller('delist-recover');
    const item = await publishedListing(seller);
    await delistListing(db, ctxOf(national()), item.listingId, 'Misleading title.');

    await updateListing(db, ctxOf(seller.principal), item.listingId, { title: 'Karate-Gi, medium weight (plain)' });
    await submitListing(db, ctxOf(seller.principal), item.listingId);
    // Still not public: a human has to look again, which is what makes
    // delisting worth doing.
    expect(refs(await publicListings(db, { limit: 100 }))).not.toContain(item.ref);

    await reviewListing(db, ctxOf(national()), item.listingId, { decision: 'approve', reason: 'Title corrected.' });
    expect(refs(await publicListings(db, { limit: 100 }))).toContain(item.ref);
  });
});

// ─── RULE 10 ────────────────────────────────────────────────────────────────

describe('RULE 10: MONEY IS INTEGER PAISE', () => {
  it('refuses a float, a negative and a non-number', async () => {
    const seller = await approvedSeller('money');
    for (const priceMinor of [1799.99, 1799.5, -1, Number.NaN, Infinity, '179900' as any, null as any]) {
      await expect(
        createListing(db, ctxOf(seller.principal), { ...GI, priceMinor })
      ).rejects.toThrow(/integer number of paise|cannot be negative/);
    }
  });

  it('stores paise as an integer and never converts to rupees on the way in', async () => {
    const seller = await approvedSeller('paise');
    const item = await createListing(db, ctxOf(seller.principal), { ...GI, priceMinor: 249900 });
    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.priceMinor).toBe(249900);
    expect(Number.isInteger(row.priceMinor)).toBe(true);
    expect(row.currency).toBe('INR');
  });

  it('refuses an edit that would introduce a float', async () => {
    const seller = await approvedSeller('paise-edit');
    const item = await publishedListing(seller);
    await expect(
      updateListing(db, ctxOf(seller.principal), item.listingId, { priceMinor: 1499.99 })
    ).rejects.toThrow(/integer number of paise/);
    // And the approval survived the refused edit.
    expect(refs(await publicListings(db, { limit: 100 }))).toContain(item.ref);
  });
});

// ─── Ownership, scope and the things nobody has decided ─────────────────────

describe('a seller can reach only their own things', () => {
  it('myListings takes no seller id and returns only the caller\'s', async () => {
    const mine = await approvedSeller('mine');
    const theirs = await approvedSeller('theirs');
    const a = await publishedListing(mine, { title: 'Mine' });
    const b = await publishedListing(theirs, { title: 'Theirs' });

    const list = await myListings(db, mine.principal);
    expect(refs(list)).toContain(a.ref);
    expect(refs(list)).not.toContain(b.ref);
    // The signature itself is the guarantee: there is no parameter to abuse.
    expect(readFileSync('src/db/marketplace.ts', 'utf8'))
      .toMatch(/export async function myListings\(db: DB, principal: Principal/);
  });

  it('cannot edit, withdraw or restock somebody else\'s listing', async () => {
    const mine = await approvedSeller('attacker');
    const theirs = await approvedSeller('victim');
    const victim = await publishedListing(theirs, { title: 'Not yours' });

    for (const attempt of [
      () => updateListing(db, ctxOf(mine.principal), victim.listingId, { priceMinor: 1 }),
      () => withdrawListing(db, ctxOf(mine.principal), victim.listingId, 'mine now'),
      () => setListingStock(db, ctxOf(mine.principal), victim.listingId, 0),
      () => submitListing(db, ctxOf(mine.principal), victim.listingId),
    ]) {
      // NOT FOUND, not forbidden — the ownership is in the WHERE clause, so
      // there is nothing to leak, not even that the id exists.
      await expect(attempt()).rejects.toThrow(/No listing of yours/);
    }
    expect(refs(await publicListings(db, { limit: 100 }))).toContain(victim.ref);
  });

  it('reports the seller\'s public visibility from the same three conditions the shop uses', async () => {
    const seller = await approvedSeller('visibility-agrees');
    const item = await publishedListing(seller);
    let mine = await myListings(db, seller.principal);
    expect(mine.find((r: any) => r.ref === item.ref).publiclyVisible).toBe(true);

    await updateListing(db, ctxOf(seller.principal), item.listingId, { title: 'Edited' });
    mine = await myListings(db, seller.principal);
    // The seller's own screen and the public shop cannot disagree.
    expect(mine.find((r: any) => r.ref === item.ref).publiclyVisible).toBe(false);
  });

  it('never echoes a bank account number back, even to its owner', async () => {
    const me = await account('bank');
    await applyToSell(db, ctxOf(me.principal), {
      tradingName: 'Bank Test', stateUnitId: JH,
      bankAccountName: 'A Person', bankAccountNumber: '123456789012', bankIfsc: 'ABCD0123456',
    });
    const acct = await mySellerAccount(db, me.principal);
    expect(acct!.bankAccountNumber).toBe('••••9012');
    expect(JSON.stringify(acct)).not.toContain('123456789012');
  });

  it('a seller cannot decide their own record or their own listing', async () => {
    const seller = await approvedSeller('self-review');
    // Hand the seller full national authority. It still refuses.
    const armed: Principal = {
      userId: seller.userId, label: 'armed-seller',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    const item = await createListing(db, ctxOf(seller.principal), GI);
    await submitListing(db, ctxOf(seller.principal), item.listingId);

    await expect(
      reviewListing(db, ctxOf(armed), item.listingId, { decision: 'approve', reason: 'I vouch for myself.' })
    ).rejects.toThrow(/cannot review their own listing/);
    await expect(
      suspendSeller(db, ctxOf(armed), seller.sellerId, 'n/a')
    ).rejects.toThrow(/cannot decide their own seller record/);
  });
});

describe('scope: a state administrator sees and decides their own state only', () => {
  it('the seller queue is filtered in SQL by the reviewer\'s scope', async () => {
    const inJh = await account('scope-jh');
    const inBr = await account('scope-br');
    const jhApp = await applyToSell(db, ctxOf(inJh.principal), { tradingName: 'JH Shop', stateUnitId: JH });
    const brApp = await applyToSell(db, ctxOf(inBr.principal), { tradingName: 'BR Shop', stateUnitId: BR });

    const jhQueue = await sellerQueue(db, jhAdmin(), { limit: 100 });
    expect(refs(jhQueue.rows)).toContain(jhApp.ref);
    expect(refs(jhQueue.rows)).not.toContain(brApp.ref);
    expect(jhQueue.rows.every((r: any) => r.stateUnitId === JH)).toBe(true);

    const natQueue = await sellerQueue(db, national(), { limit: 100 });
    expect(refs(natQueue.rows)).toContain(brApp.ref);
  });

  it('cannot approve, suspend or delist across a state boundary', async () => {
    const inBr = await account('cross-state');
    const brApp = await applyToSell(db, ctxOf(inBr.principal), { tradingName: 'BR Only', stateUnitId: BR });

    await expect(
      approveSeller(db, ctxOf(jhAdmin()), brApp.sellerId, 'Known to me.')
    ).rejects.toThrow(/Forbidden/);
    // The Bihar administrator can.
    await approveSeller(db, ctxOf(brAdmin()), brApp.sellerId, 'Verified in Bihar.');

    const brSeller = { principal: inBr.principal, userId: inBr.userId, sellerId: brApp.sellerId, ref: brApp.ref };
    const item = await publishedListing(brSeller as any);
    await expect(delistListing(db, ctxOf(jhAdmin()), item.listingId, 'Not my state.')).rejects.toThrow(/Forbidden/);
  });

  it('an account with no marketplace authority cannot read either queue', async () => {
    const me = await account('no-authority');
    await expect(sellerQueue(db, me.principal)).rejects.toThrow(/marketplace:read/);
    await expect(listingQueue(db, me.principal)).rejects.toThrow(/marketplace:read/);
  });

  it('the listing queue is scoped by the SELLER\'s location', async () => {
    const inBr = await approvedSeller('queue-scope-br', BR);
    const created = await createListing(db, ctxOf(inBr.principal), { ...GI, title: 'Bihar item' });
    await submitListing(db, ctxOf(inBr.principal), created.listingId);

    const jhQ = await listingQueue(db, jhAdmin(), { limit: 100 });
    expect(refs(jhQ.rows)).not.toContain(created.ref);
    const brQ = await listingQueue(db, brAdmin(), { limit: 100 });
    expect(refs(brQ.rows)).toContain(created.ref);
  });
});

describe('what the federation has not decided is reported, never invented', () => {
  it('captures tax and payout details but refuses nobody for their absence', async () => {
    const me = await account('no-gst');
    const applied = await applyToSell(db, ctxOf(me.principal), { tradingName: 'No Paperwork Yet', stateUnitId: JH });
    // Accepted. Whether MMAKF requires a GSTIN is a decision nobody has made,
    // and refusing on it would encode a policy that does not exist.
    expect(applied.status).toBe('applied');
    expect(applied.missingCommercialDetails).toEqual(
      expect.arrayContaining(['gstin', 'pan', 'bankAccountName', 'bankAccountNumber', 'bankIfsc'])
    );

    // And an approval is possible with none of them supplied.
    await approveSeller(db, ctxOf(national()), applied.sellerId, 'Identity verified in person.');
    const [row] = await db.select().from(s.sellers).where(eq(s.sellers.id, applied.sellerId));
    expect(row.status).toBe('approved');
    expect(row.gstin).toBeNull();
  });

  it('reports the missing details to a reviewer rather than deciding for them', async () => {
    const report = missingCommercialDetails({ gstin: '29ABCDE1234F1Z5', pan: null, bankIfsc: '  ' });
    expect(report.missing).toContain('pan');
    expect(report.missing).toContain('bankIfsc');
    expect(report.missing).not.toContain('gstin');
    expect(report.note).toBe(SELLER_REQUIREMENTS_NOT_SET);
  });

  it('states that no commission and no turnaround has been set', async () => {
    expect(COMMISSION_NOT_SET).toMatch(/has not set a commission/);
    expect(LISTING_REVIEW_TURNAROUND_NOT_SET).toMatch(/has not set a review turnaround/);

    const me = await account('commission');
    await applyToSell(db, ctxOf(me.principal), { tradingName: 'Fee Curious', stateUnitId: JH });
    const acct = await mySellerAccount(db, me.principal);
    expect(acct!.commission).toBe(COMMISSION_NOT_SET);

    // No invented percentage anywhere in what a seller is shown.
    const shown = JSON.stringify(acct) + JSON.stringify(await sellerQueue(db, national(), { limit: 5 }));
    expect(shown).not.toMatch(/\b\d+(\.\d+)?%/);
    expect(shown).not.toMatch(/within \d+ (hours|days|working days)/i);
  });

  it('accepts only the four categories the site already uses', async () => {
    expect([...LISTING_CATEGORIES].sort()).toEqual(['accessories', 'equipment', 'merch', 'uniform']);
    const seller = await approvedSeller('categories');
    await expect(
      createListing(db, ctxOf(seller.principal), { ...GI, category: 'weapons' as any })
    ).rejects.toThrow(/Unknown category/);
    await expect(publicListings(db, { category: 'nutrition' as any })).rejects.toThrow(/Unknown category/);
  });

  it('records no rupee figure and no federation policy in the migration itself', () => {
    const file = readFileSync('drizzle/0009_onboarding_and_marketplace.sql', 'utf8');
    // Comments are prose and may legitimately say "no commission is set"; what
    // matters is the DDL. So the assertions look at column definitions only.
    const ddl = file.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

    // Every DEFAULT in the file is structural (0, 1, now(), 'INR', a status).
    // A default price, fee or rate would be the federation's policy, written by
    // an engineer, in a file nobody re-reads.
    expect(ddl).not.toMatch(/"[a-z_]*(price|fee|amount|rate)[a-z_]*"\s+integer\s+DEFAULT\s+[1-9]/i);
    // And no column exists for a split nobody has decided.
    expect(ddl).not.toMatch(/"[a-z_]*(commission|platform_fee|payout_split)[a-z_]*"/i);
    expect(ddl).not.toMatch(/₹|\brupee/i);
  });
});

describe('the ordinary paths', () => {
  it('a seller may withdraw, and cannot then list', async () => {
    const seller = await approvedSeller('withdrawer');
    await publishedListing(seller, { title: 'Last item' });
    const done = await withdrawFromSelling(db, ctxOf(seller.principal), 'Closing the shop.');
    expect(done.status).toBe('withdrawn');
    await expect(createListing(db, ctxOf(seller.principal), GI)).rejects.toThrow(/withdrawn/);
    // And the shop is empty, without a listing row being deleted.
    const rows = await db.select().from(s.listings).where(eq(s.listings.sellerId, seller.sellerId));
    expect(rows.length).toBe(1);
    expect(refs(await publicListings(db, { limit: 100 }))).not.toContain(rows[0].ref);
  });

  it('a seller withdrawing a listing surrenders its approval', async () => {
    const seller = await approvedSeller('item-withdrawer');
    const item = await publishedListing(seller);
    await withdrawListing(db, ctxOf(seller.principal), item.listingId, 'Out of stock indefinitely.');
    const [row] = await db.select().from(s.listings).where(eq(s.listings.id, item.listingId));
    expect(row.status).toBe('withdrawn');
    // "Withdraw and re-list" must not be a way to skip the queue.
    expect(row.approvedContentHash).toBeNull();
    expect(refs(await publicListings(db, { limit: 100 }))).not.toContain(item.ref);
  });

  it('a decided listing cannot be decided twice', async () => {
    const seller = await approvedSeller('twice');
    const item = await publishedListing(seller);
    await expect(
      reviewListing(db, ctxOf(national()), item.listingId, { decision: 'reject', reason: 'Actually no.' })
    ).rejects.toThrow(/Only a submitted listing/);
  });

  it('a rejected seller application can be reconsidered but a rejected seller cannot list meanwhile', async () => {
    const me = await account('reconsidered');
    const applied = await applyToSell(db, ctxOf(me.principal), { tradingName: 'Second Look', stateUnitId: JH });
    await rejectSeller(db, ctxOf(national()), applied.sellerId, 'Address could not be confirmed.');
    await expect(createListing(db, ctxOf(me.principal), GI)).rejects.toThrow(/rejected/);
    await approveSeller(db, ctxOf(national()), applied.sellerId, 'Address confirmed on a second visit.');
    const item = await createListing(db, ctxOf(me.principal), GI);
    expect(item.status).toBe('draft');
  });

  it('carries alt text through to the public payload rather than generating one', async () => {
    const seller = await approvedSeller('alt-text');
    const item = await publishedListing(seller);
    const one = await publicListing(db, item.ref);
    expect(one!.media[0].alt).toBe('Plain white karate-gi, front');

    // An absent alt stays absent. A generated "Product image 2" is the
    // accessibility failure docs/ACCESSIBILITY.md exists to stop.
    const bare = await publishedListing(seller, {
      title: 'No alt supplied', media: [{ url: 'https://cdn.example.in/bare.jpg' }],
    });
    const two = await publicListing(db, bare.ref);
    expect(two!.media[0].alt).toBeNull();
  });

  it('errors are identifiable by code across module boundaries', async () => {
    const me = await account('error-shape');
    try {
      await createListing(db, ctxOf(me.principal), GI);
      expect.unreachable();
    } catch (err) {
      expect(isMarketplaceError(err)).toBe(true);
      expect((err as any).code).toBe('not_a_seller');
    }
  });
});

describe('the revision history must record a repeated event, not refuse it', () => {
  it('a listing rejected and resubmitted UNCHANGED records both submissions', async () => {
    // The natural correction loop: a reviewer rejects with a note, the seller
    // disagrees or fixes something off-listing, and submits the same content
    // again. If the history table refuses the second 'submitted' row, the
    // resubmission throws and the seller is locked out of their own listing.
    const seller = await approvedSeller('resubmit-unchanged');
    const item = await createListing(db, ctxOf(seller.principal), { ...GI, title: 'Resubmitted twice' });
    await submitListing(db, ctxOf(seller.principal), item.listingId);
    await reviewListing(db, ctxOf(national()), item.listingId, {
      decision: 'reject', reason: 'Photograph is too dark to judge.',
    });

    await submitListing(db, ctxOf(seller.principal), item.listingId);

    const history = await listingHistory(db, national(), item.listingId);
    expect(history.filter((h: any) => h.action === 'submitted').length).toBe(2);
  });

  it('an approved listing withdrawn and submitted again records both', async () => {
    const seller = await approvedSeller('withdraw-resubmit');
    const item = await publishedListing(seller, { title: 'Back on sale later' });
    await withdrawListing(db, ctxOf(seller.principal), item.listingId, 'Out of stock.');
    await submitListing(db, ctxOf(seller.principal), item.listingId);

    const history = await listingHistory(db, national(), item.listingId);
    expect(history.filter((h: any) => h.action === 'submitted').length).toBe(2);
    expect(history.some((h: any) => h.action === 'withdrawn')).toBe(true);
  });
});
