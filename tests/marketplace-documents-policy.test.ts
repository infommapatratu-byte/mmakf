// Verification documents and marketplace policy.
//
// TWO SLICES, ONE SUITE, because they share a shape: both hold material that
// must not leak, and both refuse to invent a federation decision.
//
// WHAT IS ASSERTED:
//
//   Documents — the storage key never appears in a list, a reviewer needs
//   `marketplace:verify` and not merely `marketplace:read`, a re-upload
//   supersedes rather than deletes, and supplying a requested document puts the
//   check back in the queue without un-verifying anything already decided.
//
//   Policy — nothing ships with text, an acceptance names a VERSION, the hash
//   is stored twice so a tampered body is detectable, a published body cannot
//   be edited, and a seller who accepted v2 of a document now on v3 is
//   outstanding again.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller } from '../src/db/marketplace';
import { decideVerification } from '../src/db/seller-registry';
import {
  attachDocument, myDocuments, documentsForSeller, documentDownloadRef,
  documentPositions, missingDocuments, DOCUMENT_KINDS, DOCUMENT_REQUIREMENTS_NOT_SET,
} from '../src/db/seller-documents';
import {
  registerPolicies, policyRegister, draftPolicyVersion, publishPolicyVersion,
  setPolicyMandatory, currentVersion, acceptPolicy, outstandingAcceptances,
  policiesForSeller, acceptanceRegister, bodyHash,
  POLICY_REGISTER, POLICY_NOT_PUBLISHED, NO_MANDATORY_POLICIES,
} from '../src/db/marketplace-policy';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, ADMIN: number, READER: number;
const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
/** Holds marketplace:read and NOT marketplace:verify — the interesting case. */
const financeOnly = (): Principal => ({
  userId: READER, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let seq = 0;

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  return { principal, sellerId: applied.sellerId, userId: r.userId };
}

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' }).returning();
  JH = jh.id;
  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
  READER = (await registerAccount(db, { email: 'treasurer@mmakf.in', password: PW })).userId;
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('DOCUMENTS — the key never leaves', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a list response carries no storage key at all', async () => {
    const sc = await seller('keyless');
    await attachDocument(db, ctxOf(sc.principal), {
      kind: 'gst_certificate', storageKey: 'seller/1/gst.pdf', mimeType: 'application/pdf', sizeBytes: 1234,
    });

    const mine = await myDocuments(db, sc.principal);
    expect(mine).toHaveLength(1);
    // The property this module exists to hold.
    expect(Object.keys(mine[0])).not.toContain('storageKey');
    expect(JSON.stringify(mine)).not.toContain('gst.pdf');

    const reviewer = await documentsForSeller(db, national(), sc.sellerId);
    expect(JSON.stringify(reviewer)).not.toContain('gst.pdf');
  });

  it('resolving a key needs marketplace:verify — marketplace:read is not enough', async () => {
    const sc = await seller('gated');
    const d = await attachDocument(db, ctxOf(sc.principal), {
      kind: 'pan_card', storageKey: 'seller/2/pan.pdf',
    });

    // A finance officer holds marketplace:read and no verify. They can see the
    // seller and must not be able to read their PAN card.
    await expect(documentsForSeller(db, financeOnly(), sc.sellerId))
      .rejects.toThrow(/permission|denied|forbidden|not permitted/i);
    await expect(documentDownloadRef(db, ctxOf(financeOnly()), d.documentId))
      .rejects.toThrow(/permission|denied|forbidden|not permitted/i);

    // The owner may read their own.
    const own = await documentDownloadRef(db, ctxOf(sc.principal), d.documentId);
    expect(own.storageKey).toBe('seller/2/pan.pdf');

    // And so may a reviewer who holds verify.
    const byReviewer = await documentDownloadRef(db, ctxOf(national()), d.documentId);
    expect(byReviewer.storageKey).toBe('seller/2/pan.pdf');
  });

  it('every key resolution is audited, and the key is NOT in the audit row', async () => {
    const sc = await seller('audited-doc');
    const d = await attachDocument(db, ctxOf(sc.principal), {
      kind: 'address_proof', storageKey: 'seller/3/address.pdf',
    });
    await documentDownloadRef(db, ctxOf(national()), d.documentId);

    const rows = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'seller_document'), eq(s.auditEvents.action, 'export')));
    expect(rows.length).toBeGreaterThan(0);
    // An audit row is read far more widely than the documents table.
    expect(JSON.stringify(rows)).not.toContain('address.pdf');
  });

  it('another seller cannot resolve a key', async () => {
    const owner = await seller('doc-owner');
    const other = await seller('doc-interloper');
    const d = await attachDocument(db, ctxOf(owner.principal), {
      kind: 'identity_proof', storageKey: 'seller/4/id.pdf',
    });
    await expect(documentDownloadRef(db, ctxOf(other.principal), d.documentId))
      .rejects.toThrow(/permission|denied|forbidden|not permitted/i);
  });

  it('a URL is refused as a storage key', async () => {
    const sc = await seller('urlkey');
    await expect(attachDocument(db, ctxOf(sc.principal), {
      kind: 'gst_certificate', storageKey: 'https://cdn.example.in/gst.pdf',
    })).rejects.toMatchObject({ code: 'not_a_key' });
  });

  it('re-uploading supersedes and keeps the old one', async () => {
    const sc = await seller('superseder');
    await attachDocument(db, ctxOf(sc.principal), { kind: 'gst_certificate', storageKey: 'a.pdf' });
    await attachDocument(db, ctxOf(sc.principal), { kind: 'gst_certificate', storageKey: 'b.pdf' });

    const mine = await myDocuments(db, sc.principal);
    expect(mine).toHaveLength(2);
    // A verification decision was made against a specific document; deleting it
    // leaves an approval pointing at nothing.
    expect(mine.filter((d: any) => d.supersededAt).length).toBe(1);
    expect(mine.filter((d: any) => !d.supersededAt).length).toBe(1);
  });

  it('supplying a requested document puts the check back in the queue', async () => {
    const sc = await seller('requested');
    await decideVerification(db, ctxOf(national()), {
      sellerId: sc.sellerId, check: 'gst', status: 'documents_required',
      reason: 'Please send the GST certificate showing the registered address.',
    });

    const before = await documentPositions(db, sc.principal);
    const gstBefore = before.find((p: any) => p.kind === 'gst_certificate')!;
    // The whole point of the seller's page: they can see WHAT was asked for.
    expect(gstBefore.requestedReason).toMatch(/registered address/);

    await attachDocument(db, ctxOf(sc.principal), { kind: 'gst_certificate', storageKey: 'gst-2.pdf' });

    const v = (await db.select().from(s.sellerVerifications).where(and(
      eq(s.sellerVerifications.sellerId, sc.sellerId), eq(s.sellerVerifications.check, 'gst'),
    )))[0];
    expect(v.status).toBe('submitted');
  });

  it('a document uploaded after a decision does NOT reopen it', async () => {
    const sc = await seller('decided');
    await decideVerification(db, ctxOf(national()), {
      sellerId: sc.sellerId, check: 'pan', status: 'verified',
    });
    await attachDocument(db, ctxOf(sc.principal), { kind: 'pan_card', storageKey: 'pan-extra.pdf' });

    const v = (await db.select().from(s.sellerVerifications).where(and(
      eq(s.sellerVerifications.sellerId, sc.sellerId), eq(s.sellerVerifications.check, 'pan'),
    )))[0];
    // Uploading must not un-verify what somebody decided.
    expect(v.status).toBe('verified');
  });

  it('reports what is missing and refuses nobody for it', async () => {
    const sc = await seller('incomplete-docs');
    const result = await missingDocuments(db, sc.principal);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.note).toBe(DOCUMENT_REQUIREMENTS_NOT_SET);
    // The seller is still approved and nothing refused them.
    const row = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];
    expect(row.status).toBe('approved');
  });

  it('refuses a document kind it does not recognise', async () => {
    const sc = await seller('unknown-kind');
    await expect(attachDocument(db, ctxOf(sc.principal), {
      kind: 'a_photo_of_my_cat' as any, storageKey: 'cat.jpg',
    })).rejects.toMatchObject({ code: 'unknown_kind' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('POLICY — no text, versioned acceptance', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('registers eight NAMES and not one word of policy', async () => {
    const result = await registerPolicies(db, ctxOf(national()));
    expect(result.added.length).toBe(POLICY_REGISTER.length);

    const rows = await db.select().from(s.marketplacePolicies);
    expect(rows.length).toBe(POLICY_REGISTER.length);
    // No body, no summary, and nothing mandatory. A seeded seller agreement is
    // the single worst thing this codebase could produce.
    expect(rows.every((r: any) => r.summary == null)).toBe(true);
    expect(rows.every((r: any) => r.mandatoryForSellers === false)).toBe(true);

    const versions = await db.select().from(s.policyVersions);
    expect(versions).toHaveLength(0);
  });

  it('is idempotent and does not undo a federation decision on re-run', async () => {
    const again = await registerPolicies(db, ctxOf(national()));
    expect(again.added).toEqual([]);
    expect(again.alreadyPresent).toBe(POLICY_REGISTER.length);
  });

  it('reports an unpublished document as unpublished rather than empty', async () => {
    const register = await policyRegister(db, national());
    const agreement = register.find((p: any) => p.code === 'marketplace.seller_agreement');
    expect(agreement.published).toBe(false);
    expect(agreement.note).toBe(POLICY_NOT_PUBLISHED);
    expect(await currentVersion(db, 'marketplace.seller_agreement')).toBeNull();
  });

  it('refuses a version with no text', async () => {
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.terms');
    await expect(draftPolicyVersion(db, ctxOf(national()), {
      policyId: p.id, body: '   ', effectiveFrom: '2026-01-01',
    })).rejects.toMatchObject({ code: 'empty_body' });
  });

  it('a DRAFT is not current, and publishing makes it so', async () => {
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.seller_agreement');

    const v1 = await draftPolicyVersion(db, ctxOf(national()), {
      policyId: p.id, body: 'The federation’s own words, version one.', effectiveFrom: '2020-01-01',
    });
    expect(await currentVersion(db, 'marketplace.seller_agreement')).toBeNull();

    await publishPolicyVersion(db, ctxOf(national()), v1.versionId);
    const current = await currentVersion(db, 'marketplace.seller_agreement');
    expect(current.version.id).toBe(v1.versionId);
  });

  it('publishing twice is refused', async () => {
    const current = await currentVersion(db, 'marketplace.seller_agreement');
    await expect(publishPolicyVersion(db, ctxOf(national()), current.version.id))
      .rejects.toMatchObject({ code: 'already_published' });
  });

  it('a seller cannot draft or publish a policy', async () => {
    const sc = await seller('policy-overreach');
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.terms');
    await expect(draftPolicyVersion(db, ctxOf(sc.principal), {
      policyId: p.id, body: 'I write the rules now.', effectiveFrom: '2020-01-01',
    })).rejects.toThrow(/permission|denied|forbidden|not permitted/i);
  });

  it('a document cannot be made mandatory before it is published', async () => {
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.counterfeit');
    await expect(setPolicyMandatory(db, ctxOf(national()), p.id, true, 'Required of everyone.'))
      .rejects.toMatchObject({ code: 'nothing_to_accept' });
  });

  it('an acceptance names a version and freezes its hash', async () => {
    const sc = await seller('acceptor');
    const current = await currentVersion(db, 'marketplace.seller_agreement');

    const a = await acceptPolicy(db, ctxOf(sc.principal), current.version.id, '203.0.113.9');
    expect(a.alreadyAccepted).toBe(false);

    const row = (await db.select().from(s.sellerPolicyAcceptances)
      .where(eq(s.sellerPolicyAcceptances.id, a.acceptanceId!)))[0];
    expect(row.policyVersionId).toBe(current.version.id);
    // The hash, stored a second time on the acceptance itself.
    expect(row.bodyHash).toBe(current.version.bodyHash);
    // The IP is HASHED, never stored.
    expect(row.ipHash).toBeTruthy();
    expect(row.ipHash).not.toContain('203.0.113');
  });

  it('accepting twice is a double click, not an error', async () => {
    const sc = await seller('double-clicker');
    const current = await currentVersion(db, 'marketplace.seller_agreement');
    await acceptPolicy(db, ctxOf(sc.principal), current.version.id);
    const again = await acceptPolicy(db, ctxOf(sc.principal), current.version.id);
    expect(again.alreadyAccepted).toBe(true);
  });

  it('a DRAFT cannot be accepted', async () => {
    const sc = await seller('draft-acceptor');
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.privacy');
    const draft = await draftPolicyVersion(db, ctxOf(national()), {
      policyId: p.id, body: 'Not published yet.', effectiveFrom: '2020-01-01',
    });
    await expect(acceptPolicy(db, ctxOf(sc.principal), draft.versionId))
      .rejects.toMatchObject({ code: 'not_published' });
  });

  it('a tampered published body makes the acceptance detectably invalid', async () => {
    const sc = await seller('tamper-detector');
    const current = await currentVersion(db, 'marketplace.seller_agreement');
    await acceptPolicy(db, ctxOf(sc.principal), current.version.id);

    // Simulate somebody editing a published version in place — which the module
    // provides no function for, and which the second stored hash exists to catch.
    await db.update(s.policyVersions)
      .set({ body: 'Quietly different terms.', bodyHash: bodyHash('Quietly different terms.') })
      .where(eq(s.policyVersions.id, current.version.id));

    const view = await policiesForSeller(db, sc.principal);
    const agreement = view.find((v: any) => v.code === 'marketplace.seller_agreement');
    expect(agreement.acceptanceStillValid).toBe(false);

    // Put it back so later tests see the real document.
    await db.update(s.policyVersions)
      .set({ body: current.version.body, bodyHash: current.version.bodyHash })
      .where(eq(s.policyVersions.id, current.version.id));
  });

  it('reports no mandatory policies when MMAKF has required none', async () => {
    const sc = await seller('nothing-required');
    const result = await outstandingAcceptances(db, sc.principal);
    expect(result.outstanding).toEqual([]);
    expect(result.note).toBe(NO_MANDATORY_POLICIES);
  });

  it('a seller who accepted v1 of a now-v2 document is outstanding again', async () => {
    const sc = await seller('stale-acceptance');
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.seller_agreement');

    // Accept what is current.
    const v1 = await currentVersion(db, 'marketplace.seller_agreement');
    await acceptPolicy(db, ctxOf(sc.principal), v1.version.id);
    await setPolicyMandatory(db, ctxOf(national()), p.id, true, 'Every seller must agree to trade.');

    let outstanding = await outstandingAcceptances(db, sc.principal);
    expect(outstanding.outstanding).toHaveLength(0);

    // MMAKF publishes a new version.
    const v2 = await draftPolicyVersion(db, ctxOf(national()), {
      policyId: p.id, body: 'Version two, with an added clause.', effectiveFrom: '2020-06-01',
    });
    await publishPolicyVersion(db, ctxOf(national()), v2.versionId);

    outstanding = await outstandingAcceptances(db, sc.principal);
    // Treating an old acceptance as covering a new document is how a seller
    // ends up bound by terms they never saw.
    expect(outstanding.outstanding).toHaveLength(1);
    expect(outstanding.outstanding[0].versionId).toBe(v2.versionId);
  });

  it('the acceptance register names who agreed to which version', async () => {
    const register = await policyRegister(db, national());
    const p = register.find((x: any) => x.code === 'marketplace.seller_agreement');
    const rows = await acceptanceRegister(db, national(), p.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('tradingName');
    expect(rows[0]).toHaveProperty('version');
  });
});
