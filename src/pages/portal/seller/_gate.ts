// Shared gate for the seller portal pages.
//
// Underscore-prefixed so Astro does not route it, and a .ts rather than an
// .astro partial so tests/accessibility.test.ts is not asked to find an <h1> in
// a fragment — the same reasoning as portal/_lib.ts.
//
// ─── WHAT THIS FILE IS, AND WHAT IT IS EMPHATICALLY NOT ─────────────────────
//
// It is the answer to "is there anybody here, and do they have a shop?" — the
// five states every seller page has to render differently, resolved once so the
// five pages cannot disagree about them.
//
// IT IS NOT AN AUTHORISATION SYSTEM. Nothing here decides whether an act is
// permitted. Every write goes to /api/marketplace/..., and the module behind it
// resolves the seller from the session inside its own SQL and refuses on its
// own terms. If this file were deleted the pages would render badly and NOT ONE
// permission would change, which is the property that makes it safe to have.

import { identify } from '@/lib/session';
import { isConfigured, db } from '@/db';
import { isMarketplaceError } from '@/db/marketplace';
import { mySellerProfile } from '@/db/seller-registry';

export type SellerGate =
  | 'no_database'
  | 'signed_out'
  | 'shared_credential'
  | 'no_seller'
  | 'seller';

export interface SellerContext {
  gate: SellerGate;
  identity: Awaited<ReturnType<typeof identify>>;
  /** The caller's own seller row, redacted. Null unless gate === 'seller'. */
  profile: Awaited<ReturnType<typeof mySellerProfile>>;
  seller: any | null;
  approved: boolean;
  loadError: string | null;
}

/**
 * Resolve the caller's seller standing.
 *
 * TAKES NO IDENTIFIER — not a sellerId, not a userId, not a query parameter.
 * `mySellerProfile()` reads the caller's own row from the session inside its
 * own query and has no parameter to be asked about somebody else's. A surface
 * that accepts "whose shop?" as input is a surface that will eventually be sent
 * somebody else's, and no amount of checking afterwards undoes that shape.
 */
export async function sellerContext(cookie: string | null): Promise<SellerContext> {
  const configured = isConfigured();
  if (!configured) {
    return { gate: 'no_database', identity: null, profile: null, seller: null, approved: false, loadError: null };
  }

  const identity = await identify(cookie);
  if (!identity) {
    return { gate: 'signed_out', identity: null, profile: null, seller: null, approved: false, loadError: null };
  }
  if (identity.userId == null) {
    // A shared office credential is attributable to no person, so it cannot
    // hold a seller record — there is nothing here for it to show.
    return { gate: 'shared_credential', identity, profile: null, seller: null, approved: false, loadError: null };
  }

  try {
    const profile = await mySellerProfile(db(), identity.principal);
    if (!profile) {
      return { gate: 'no_seller', identity, profile: null, seller: null, approved: false, loadError: null };
    }
    return {
      gate: 'seller',
      identity,
      profile,
      seller: profile.seller,
      approved: profile.seller.status === 'approved',
      loadError: null,
    };
  } catch (err: any) {
    return {
      gate: 'seller',
      identity,
      profile: null,
      seller: null,
      approved: false,
      loadError: readableError(err, 'Your seller record'),
    };
  }
}

/**
 * What a seller may be told about a failure.
 *
 * The marketplace modules write their refusals to be read by the person who hit
 * them, so those are printed verbatim. Anything else is a fact about the
 * server, not about the caller, and `err.message` on a page is how a connection
 * string reaches a stranger.
 */
export function readableError(err: any, context: string): string {
  if (isMarketplaceError(err)) return String(err.message);
  console.error(`[portal/seller] ${context}`, err);
  return `${context} could not be read. The fault has been logged for the federation office; nothing has been changed.`;
}

/** Integer minor units to a displayable rupee amount. Display only. */
export function money(minor: number | null | undefined, currency = 'INR'): string {
  if (minor == null) return '—';
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
  return `${sign}${currency === 'INR' ? '₹' : `${currency} `}${rupees}.${String(abs % 100).padStart(2, '0')}`;
}

export function fmtDate(v: unknown): string {
  if (v == null || v === '') return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v: unknown): string {
  if (v == null || v === '') return '—';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const titleCase = (v: unknown): string =>
  String(v ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The seller-portal tab strip, so five pages cannot describe it five ways. */
export const SELLER_TABS = [
  { href: '/portal/seller', label: 'Overview' },
  { href: '/portal/seller/products', label: 'Products' },
  { href: '/portal/seller/orders', label: 'Orders' },
  { href: '/portal/seller/money', label: 'Money' },
];

/**
 * The sentence a seller reads about their own standing.
 *
 * Five states, not two, because a seller who has been refused and a seller who
 * is merely waiting are in completely different positions, and telling them the
 * same thing wastes the time of whichever one was owed a different answer.
 * None of these invents a turnaround, a requirement or a next step MMAKF has
 * not stated.
 */
export const SELLER_STANDING: Record<string, { label: string; tone: 'good' | 'wait' | 'bad'; body: string }> = {
  applied: {
    label: 'Awaiting review',
    tone: 'wait',
    body: 'Your application is with MMAKF. Until somebody at the federation approves it you cannot create a listing — not a draft, and not a hidden one.',
  },
  approved: {
    label: 'Approved to sell',
    tone: 'good',
    body: 'MMAKF has approved this account as a seller. That is the first of two decisions: each item you list is reviewed separately before the public can see it.',
  },
  rejected: {
    label: 'Not approved',
    tone: 'bad',
    body: 'MMAKF did not approve this account as a seller. The reason the federation recorded is below.',
  },
  suspended: {
    label: 'Suspended',
    tone: 'bad',
    body: 'MMAKF has suspended this seller account. Every one of your listings has left public view, in the same instant and without anything being deleted. A suspension can be lifted; deletion could not be undone.',
  },
  withdrawn: {
    label: 'Withdrawn',
    tone: 'bad',
    body: 'You withdrew this account from selling. Your listings are no longer public. Nothing has been deleted.',
  },
};
