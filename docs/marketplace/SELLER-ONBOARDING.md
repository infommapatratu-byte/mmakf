# Seller onboarding

**DISCOVER → APPLY → VERIFY → REVIEW → APPROVE → ONBOARD → STORE → LIST → PUBLISH → SELL.**

Registration confers nothing. Every step below is a decision somebody makes.

---

## The journey, and where each step lives

| Step | Function | Authority |
|---|---|---|
| Apply | `registerAsSeller()` — `src/db/seller-registry.ts` | the applicant, signed in |
| Risk screening | `detectRisk()`, automatic | none — it *flags*, it does not refuse |
| Verify | `decideVerification()` | `marketplace:verify` |
| Review + approve | `approveSeller()` — `src/db/marketplace.ts` | `marketplace:review` |
| Store created | automatic on first approval | — |
| Payout account | `payout_accounts` | seller submits, provider verifies |
| List | `createListing()` + `addVariant()` | the seller, once approved |
| Publish | `reviewListing()` | `marketplace:review` |

**No manual copying between systems.** The application creates the seller row,
the addresses, one verification row per check and the frozen submission in a
single call. Approval creates the storefront. The seller's first listing hangs
off the seller record that the application produced.

---

## What is collected

### Person
first name · middle name · last name · date of birth · email · phone ·
alternate phone · photo · identity verification.

### Business
legal name · brand name · business type · registration number · GSTIN · PAN ·
website · social profiles · description · years operating · category.

`seller_type` is one of: manufacturer, distributor, brand, retailer, dojo,
federation, institutional, individual, service_provider.

`business_type` is one of: individual, sole_proprietor, partnership,
private_company, public_company, llp, trust, society, federation, club, dojo,
other. It matters because it determines which registration documents can even
exist — asking a sole proprietor for a certificate of incorporation is how a
verification queue stalls on a document that was never going to arrive.

### Addresses — structured, and more than one

`seller_addresses.kind` ∈ registered · operating · warehouse · return · pickup.

Each carries country, state, district, city, locality, line1, line2, postcode,
and resolves against the federation's own geography where it can.

**Not one free-text field.** A district that exists only inside a string cannot
be matched against the federation's district units, so a reviewer in Ramgarh
cannot be shown the sellers in Ramgarh. A warehouse and a return address are
frequently different places, and astonishingly often neither is the registered
one.

---

## Verification: per-check, not per-seller

`seller_verifications` holds one row per (seller, check):

`identity` · `business` · `gst` · `pan` · `bank` · `address` ·
`brand_authorisation` · `manufacturer_authorisation` · `product_authorisation`

Status ∈ `not_started` · `submitted` · `under_review` · `documents_required` ·
`verified` · `rejected` · `suspended` · `expired`.

A single verified/unverified flag cannot express the ordinary real state of
affairs — identity confirmed, GST outstanding — and a reviewer forced to choose
between "verified" and "not" will choose "verified" and write the caveat in a
note nobody reads.

**`documents_required` earns its place**: it is the difference between "we are
still looking" and "we are waiting for you". A queue that cannot tell those
apart is a queue where every stalled application looks like the reviewer's
fault.

**`expired` earns its place too**: a GST verification is a fact about a date.
Recording expiry as `rejected` would say MMAKF refused the seller, which it did
not. `refreshCompliance()` maps it to `compliance_status = 'lapsed'`, which is
not a suspension, because nobody suspended anybody.

Every refusing status requires a reason. A refusal the applicant cannot act on
is an obstruction: they have no way to fix it and no way to argue.

`expiringVerifications()` lists what lapses within N days, because the ordinary
failure of every system like this is that it verifies once and never looks again.

---

## Bank details

**The federation does not store raw banking credentials.**

`payout_accounts` holds the *provider's* handle for an account the provider
holds, plus the holder's name, the bank name, the last four digits and an IFSC
prefix. That is what a payout call needs; four digits identify without enabling.

There is no column for the account number, and that is not an oversight to be
corrected by a later migration. The legacy columns on `sellers` are retired:
`redactSeller()` masks them on **every** read, at the source rather than at the
template, because a template is where a redaction gets forgotten.

`sellerDossier()` also withholds `providerAccountId` and every document's
`storageKey` from ordinary administrators. A document is fetched through
`src/lib/storage.ts`, which is the only thing that can refuse the request.

---

## Risk flags: flags, never decisions

`detectRisk()` raises `fraud_signals` rows at submission for:

- **shared contact details** — the same email or phone on another seller,
  flagged harder when that seller is suspended or rejected;
- **duplicate account** — the same GSTIN already registered;
- **federation impersonation** — the application text claiming MMAKF status.

Every one is a note for a human. Automatic refusal on a name match is how a
legitimate applicant with a common name is locked out with no appeal, and
nothing in this system reads `fraud_signals` and suspends anybody.

---

## The storefront

Created on **first** approval only. A seller who later closed their own shop and
was reinstated keeps it closed — reopening would override a decision they made
about their own business.

The slug is derived from the trading name and falls back to the seller's own ref
the instant there is any collision. Two shops at one address is a support
incident, and if the second is a copy of the first it is an impersonation with
the federation's badge sitting on whichever the query happened to return.

Deliberately not clever: no transliteration, no `-2` counter. An ugly-but-correct
slug can be changed by the seller; a suffix quietly attached to a legitimate
trader's name cannot be undone.

`publicStorefront()` returns a **deliberate allow-list**, not a redacted row —
adding a column to `sellers` must not publish it. Location is exposed at city
and state granularity; never the street, never the warehouse.

---

## Badges

Two sources, and no third.

**Derived** — computed on every read from current evidence:
- `verified_seller` requires a current `identity` **and** `business`
  verification. It disappears the moment either lapses, without anybody
  remembering to remove it.
- `verified_brand` requires a `brand_authorisations` row that is `verified`,
  unrevoked and within its validity dates.

**Granted** — `seller_badge_grants`, writable only under `marketplace:review`:
- `mmakf_official`, `mmakf_authorised`, `verified_product`.

`grantBadge()` **refuses** to grant the derived badges by hand. Granting
`verified_seller` would create a badge asserting a verification that never
happened — the exact forgery the module exists to prevent.

A seller writing "Official MMAKF Supplier" into their store tagline gets a store
tagline. The string and the badge are different things in different tables, and
only one of them renders as an endorsement. Asserted by
`tests/marketplace-platform.test.ts`.

---

## Suspension, restriction, termination

| State | Effect |
|---|---|
| `suspended` | Out entirely. Every listing leaves public view in the same instant via `publicListingPredicate()`, with no row deleted. Reversible. |
| `restricted` | Keeps trading in the categories they are trusted with; barred from the ones named in `restricted_categories`. |
| `terminated` | Ended. The record and every order attached to it remain. |
| store `closed_by_seller` | The seller's own decision. Not a governance record. |
| store `closed_by_federation` | Force-closed. The seller cannot reopen it. |

Restriction is separate from suspension because collapsing them would force
MMAKF to close a whole shop over one product line — which in practice means it
closes nothing, and the restriction is never applied at all.
