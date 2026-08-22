// Seller verification documents: attaching them, and refusing to publish them.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ONE RULE THIS MODULE EXISTS TO HOLD
// ═════════════════════════════════════════════════════════════════════════════
//
// `storage_key` NEVER LEAVES THIS MODULE except through `documentDownloadRef()`,
// which asks for authority first.
//
// A key is not a secret in the sense a password is — it is a filename. That is
// exactly why it must not be listed: a PAN card at a guessable path is a PAN
// card that has been published, and every list response is a place a path could
// be guessed from. `sellerDossier()` in src/db/seller-registry.ts already omits
// it deliberately, and this module preserves that property rather than assuming
// it.
//
// So there are two shapes of read here, and they are different types:
//
//   · LISTINGS — what exists, what it is, when it arrived, whether it was
//     superseded. No key. Safe for a page.
//   · RESOLUTION — one document, one caller, one authority check, one key.
//
// A function that returned the key in a list and trusted every caller not to
// render it is one careless template away from publishing a trader's tax
// documents.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND THE DECISION IT REFUSES TO MAKE
// ═════════════════════════════════════════════════════════════════════════════
//
// WHICH DOCUMENTS MMAKF REQUIRES. Nothing here refuses an application, a
// verification or a listing for a missing document. `missingDocuments()` reports
// what is absent so a reviewer can ask; whether a GST certificate is mandatory
// before somebody may sell is a federation decision that has not been made.

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';
import { ownSellerRecord } from '@/db/seller-orders';

type DB = any;

export const DOCUMENT_REQUIREMENTS_NOT_SET =
  'MMAKF has not decided which documents a seller must supply before trading. ' +
  'What is missing is reported so a reviewer can ask for it; nothing here ' +
  'refuses anybody for a document the federation has not required.';

/**
 * The kinds a seller can attach, and which verification check each speaks to.
 *
 * A MAP RATHER THAN A FREE-TEXT FIELD, because the whole value of a document is
 * that a reviewer working the `gst` check can see the GST certificate without
 * reading every file the seller has ever uploaded. `check` is null where a
 * document supports the application generally rather than one determination.
 */
export const DOCUMENT_KINDS = [
  { kind: 'identity_proof', label: 'Identity document', check: 'identity' },
  { kind: 'registration_certificate', label: 'Business registration', check: 'business' },
  { kind: 'gst_certificate', label: 'GST certificate', check: 'gst' },
  { kind: 'pan_card', label: 'PAN', check: 'pan' },
  { kind: 'bank_proof', label: 'Bank proof — a cancelled cheque or statement header', check: 'bank' },
  { kind: 'address_proof', label: 'Proof of address', check: 'address' },
  { kind: 'brand_letter', label: 'Letter of brand authorisation', check: 'brand_authorisation' },
  { kind: 'manufacturer_letter', label: 'Manufacturer authorisation', check: 'manufacturer_authorisation' },
  { kind: 'product_certificate', label: 'Product certification', check: 'product_authorisation' },
  { kind: 'other', label: 'Something else', check: null },
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]['kind'];

const KIND_SET = new Set<string>(DOCUMENT_KINDS.map((d) => d.kind));
const CHECK_FOR = new Map<string, string | null>(DOCUMENT_KINDS.map((d) => [d.kind, d.check]));

// ─── Attaching ──────────────────────────────────────────────────────────────

export interface UploadInput {
  kind: DocumentKind;
  label?: string | null;
  /** A key into src/lib/storage.ts. NEVER a public URL. */
  storageKey: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

/**
 * Attach a document to the caller's own seller record.
 *
 * SUPERSEDES, NEVER REPLACES. Re-uploading a GST certificate marks the previous
 * one superseded and keeps it. The reason is not sentiment about data: a
 * verification decision was made against a specific document, and deleting it
 * leaves an approval pointing at nothing. After a dispute the question is always
 * "what did the reviewer actually see?", and only the superseded row can answer
 * it.
 *
 * The upload itself — the bytes, the type sniffing, the size limit, the malware
 * scan — is src/lib/uploads.ts's job and has already happened by the time this
 * is called. This function records that it happened.
 */
export async function attachDocument(db: DB, ctx: AuditContext, input: UploadInput) {
  const seller = await ownSellerRecord(db, ctx.principal);

  if (!KIND_SET.has(String(input?.kind))) {
    throw new MarketplaceError(
      'unknown_kind',
      `"${input?.kind}" is not a document kind this marketplace recognises. ` +
      `Choose one of: ${DOCUMENT_KINDS.map((d) => d.kind).join(', ')}.`
    );
  }
  const storageKey = String(input?.storageKey ?? '').trim();
  if (!storageKey) {
    throw new MarketplaceError('no_key', 'A document must name where it was stored.');
  }
  // A storage key that looks like a URL means somebody has put the file
  // somewhere the storage layer does not mediate — which is the one thing this
  // module exists to prevent, so it is refused rather than recorded.
  if (/^https?:\/\//i.test(storageKey)) {
    throw new MarketplaceError(
      'not_a_key',
      'A document is referenced by its storage key, not by a URL. A file at a URL is a file ' +
      'nothing can refuse to serve.'
    );
  }

  const check = CHECK_FOR.get(input.kind) ?? null;

  // The verification row this document speaks to, if any. Resolved here rather
  // than taken from the caller: a seller could otherwise attach a photograph of
  // a cat to the `bank` check and a reviewer would be looking for it there.
  let verificationId: number | null = null;
  if (check) {
    const v = (await db.select({ id: s.sellerVerifications.id })
      .from(s.sellerVerifications)
      .where(and(
        eq(s.sellerVerifications.sellerId, seller.id),
        eq(s.sellerVerifications.check, check as any),
      )).limit(1))[0];
    verificationId = v?.id ?? null;
  }

  // Supersede the previous live document of this kind, in SQL, before inserting
  // — so two uploads racing cannot both end up live.
  await db.update(s.sellerDocuments)
    .set({ supersededAt: new Date() })
    .where(and(
      eq(s.sellerDocuments.sellerId, seller.id),
      eq(s.sellerDocuments.kind, input.kind),
      isNull(s.sellerDocuments.supersededAt),
    ));

  const [row] = await db.insert(s.sellerDocuments).values({
    sellerId: seller.id,
    verificationId,
    kind: input.kind,
    label: input.label?.trim() || null,
    storageKey,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    uploadedByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.sellerDocuments.id });

  // A document arriving against a check that was waiting for one moves it back
  // into the queue. Without this the seller supplies what was asked for and
  // nothing tells the reviewer, so the application sits.
  if (verificationId) {
    await db.update(s.sellerVerifications).set({
      status: 'submitted',
      submittedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(s.sellerVerifications.id, verificationId),
      // ONLY from a waiting state. A document uploaded after a check was
      // verified must not un-verify it, and one uploaded after a rejection
      // must not quietly reopen a decision somebody made.
      sql`${s.sellerVerifications.status} in ('not_started', 'documents_required')`,
    ));
  }

  await writeAudit(db, ctx, {
    entityType: 'seller_document', entityId: row.id, action: 'create',
    // The KEY IS NOT AUDITED. An audit row is read far more widely than this
    // table, and a key in it would defeat the whole arrangement.
    newValue: { sellerId: seller.id, kind: input.kind, check, mimeType: input.mimeType ?? null },
  });

  return { documentId: row.id, kind: input.kind, check, supersededPrevious: true };
}

// ─── Reading: the two shapes ────────────────────────────────────────────────

/** What a document IS. Deliberately without its key. */
export interface DocumentSummary {
  id: number;
  kind: string;
  label: string | null;
  check: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: Date | string;
  supersededAt: Date | string | null;
}

const SUMMARY_COLUMNS = {
  id: s.sellerDocuments.id,
  kind: s.sellerDocuments.kind,
  label: s.sellerDocuments.label,
  mimeType: s.sellerDocuments.mimeType,
  sizeBytes: s.sellerDocuments.sizeBytes,
  uploadedAt: s.sellerDocuments.uploadedAt,
  supersededAt: s.sellerDocuments.supersededAt,
  verificationId: s.sellerDocuments.verificationId,
  // storageKey IS ABSENT, and its absence is the point. A `select()` with no
  // argument would include it, which is why every read here names its columns.
};

/** The caller's own documents. No sellerId parameter. */
export async function myDocuments(db: DB, principal: Principal): Promise<DocumentSummary[]> {
  const seller = await ownSellerRecord(db, principal);
  const rows = await db.select(SUMMARY_COLUMNS).from(s.sellerDocuments)
    .where(eq(s.sellerDocuments.sellerId, seller.id))
    .orderBy(desc(s.sellerDocuments.uploadedAt));
  return rows.map(withCheck);
}

/**
 * A seller's documents, for a reviewer.
 *
 * `marketplace:verify` AND the seller's own scope — the same authority that
 * decides the verification, because the documents are what the decision is made
 * against. `marketplace:read` is deliberately not enough: an administrator who
 * can see that a seller exists has no need of their PAN card.
 */
export async function documentsForSeller(
  db: DB, principal: Principal, sellerId: number
): Promise<DocumentSummary[]> {
  const seller = (await db.select().from(s.sellers).where(eq(s.sellers.id, sellerId)).limit(1))[0];
  if (!seller) throw new MarketplaceError('unknown_seller', 'No such seller.');

  assertCan(principal, 'marketplace:verify', {
    stateUnitId: seller.stateUnitId ?? null,
    districtUnitId: seller.districtUnitId ?? null,
    dojoId: seller.dojoId ?? null,
  });

  const rows = await db.select(SUMMARY_COLUMNS).from(s.sellerDocuments)
    .where(eq(s.sellerDocuments.sellerId, sellerId))
    .orderBy(desc(s.sellerDocuments.uploadedAt));
  return rows.map(withCheck);
}

function withCheck(r: any): DocumentSummary {
  return { ...r, check: CHECK_FOR.get(r.kind) ?? null };
}

/**
 * THE ONLY FUNCTION THAT RESOLVES A STORAGE KEY.
 *
 * Authorised two ways and no third: the document's own seller, or a reviewer
 * holding `marketplace:verify` in that seller's scope. Every read is audited,
 * because reading somebody's tax documents is an act the federation should be
 * able to account for afterwards — the audit trail is what makes an
 * over-broad grant visible.
 *
 * Returns the key, and the caller hands it to src/lib/storage.ts. It does NOT
 * return a URL: minting one here would create an address that outlives this
 * check.
 */
export async function documentDownloadRef(
  db: DB, ctx: AuditContext, documentId: number
): Promise<{ storageKey: string; kind: string; mimeType: string | null }> {
  const rows = await db.select({ doc: s.sellerDocuments, seller: s.sellers })
    .from(s.sellerDocuments)
    .innerJoin(s.sellers, eq(s.sellerDocuments.sellerId, s.sellers.id))
    .where(eq(s.sellerDocuments.id, documentId)).limit(1);

  if (!rows.length) throw new MarketplaceError('unknown_document', 'No such document.');
  const { doc, seller } = rows[0];

  const isOwner = ctx.principal?.userId != null && seller.userId === ctx.principal.userId;
  if (!isOwner) {
    assertCan(ctx.principal, 'marketplace:verify', {
      stateUnitId: seller.stateUnitId ?? null,
      districtUnitId: seller.districtUnitId ?? null,
      dojoId: seller.dojoId ?? null,
    });
  }

  await writeAudit(db, ctx, {
    entityType: 'seller_document', entityId: documentId, action: 'export',
    newValue: { kind: doc.kind, sellerId: seller.id, as: isOwner ? 'owner' : 'reviewer' },
  });

  return { storageKey: doc.storageKey, kind: doc.kind, mimeType: doc.mimeType ?? null };
}

// ─── What is missing, and what was asked for ────────────────────────────────

export interface DocumentPosition {
  kind: string;
  label: string;
  check: string | null;
  /** The live document of this kind, if any. */
  current: DocumentSummary | null;
  supersededCount: number;
  /** The verification this speaks to, and what a reviewer said about it. */
  verificationStatus: string | null;
  /** Set when a reviewer has asked for this specific document. */
  requestedReason: string | null;
}

/**
 * Every document kind, what the seller has supplied, and what a reviewer has
 * asked for.
 *
 * `requestedReason` is the whole point of the seller's page. A verification in
 * `documents_required` carries the reviewer's own words; a seller who has been
 * asked for something and cannot see WHAT will supply the wrong thing, or
 * nothing, and the queue stalls on both sides believing it is waiting for the
 * other.
 */
export async function documentPositions(db: DB, principal: Principal): Promise<DocumentPosition[]> {
  const seller = await ownSellerRecord(db, principal);
  return positionsFor(db, seller.id);
}

/** The same view, for a reviewer. Authority checked as documentsForSeller(). */
export async function documentPositionsForSeller(
  db: DB, principal: Principal, sellerId: number
): Promise<DocumentPosition[]> {
  await documentsForSeller(db, principal, sellerId);   // asserts authority
  return positionsFor(db, sellerId);
}

async function positionsFor(db: DB, sellerId: number): Promise<DocumentPosition[]> {
  const docs = (await db.select(SUMMARY_COLUMNS).from(s.sellerDocuments)
    .where(eq(s.sellerDocuments.sellerId, sellerId))
    .orderBy(desc(s.sellerDocuments.uploadedAt))).map(withCheck);

  const verifications = await db.select().from(s.sellerVerifications)
    .where(eq(s.sellerVerifications.sellerId, sellerId));

  return DOCUMENT_KINDS.map((d) => {
    const ofKind = docs.filter((x: DocumentSummary) => x.kind === d.kind);
    const v = d.check ? verifications.find((x: any) => x.check === d.check) : null;
    return {
      kind: d.kind,
      label: d.label,
      check: d.check,
      current: ofKind.find((x: DocumentSummary) => !x.supersededAt) ?? null,
      supersededCount: ofKind.filter((x: DocumentSummary) => !!x.supersededAt).length,
      verificationStatus: v?.status ?? null,
      // Only when a reviewer is actually waiting. A rejection reason is shown
      // by the overview page as a decision, not here as a request.
      requestedReason: v?.status === 'documents_required' ? (v?.reason ?? null) : null,
    };
  });
}

/**
 * Which documents are absent. REPORTS, NEVER REFUSES.
 *
 * See DOCUMENT_REQUIREMENTS_NOT_SET: whether MMAKF demands any of these before
 * somebody may sell is a federation decision that has not been made, and a hard
 * requirement here would encode a policy nobody set — and turn away the sellers
 * the federation wanted.
 */
export async function missingDocuments(db: DB, principal: Principal) {
  const positions = await documentPositions(db, principal);
  return {
    missing: positions.filter((p) => !p.current && p.kind !== 'other').map((p) => p.kind),
    requested: positions.filter((p) => p.requestedReason).map((p) => ({ kind: p.kind, reason: p.requestedReason })),
    note: DOCUMENT_REQUIREMENTS_NOT_SET,
  };
}
