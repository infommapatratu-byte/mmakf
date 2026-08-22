# Marketplace policy

**What MMAKF has not decided, and where each decision lands.**

This file is the register of gaps. Every entry is a real hole with a real place
for the answer to go — not a limitation, and not a TODO. The marketplace works
without them; it simply refuses to invent them.

---

## Why this file exists

A seeded 10% commission is indistinguishable, six months later, from a rate the
federation approved. It would be deducted from real people's money, quoted back
at them in disputes, and defended by staff who assumed somebody had decided it.

So nothing here ships with a number. The system reports what is unset and, where
money is involved, **stops** rather than guessing.

---

## Decisions awaiting the federation

### 1. Commission

**Nothing is published.** No rate, no flat fee, no tier schedule.

**Effect today:** every sale produces a `commission_gaps` row, `commissionMinor`
stays NULL (not 0), and **settlement is blocked** for that seller order. The
sale completes; the seller ships; the payout waits.

**Where the answer goes:** `/admin/marketplace/commissions` →
`createCommissionRule()` + `draftCommissionVersion()` +
`publishCommissionVersion()`. Publication requires a stated authority.

**What must be decided, not just the percentage:**
- the rate itself, per category / seller / tier / campaign as MMAKF wishes;
- **whether commission is charged on shipping** — required, no default;
- **whether commission is charged on tax** — required, no default;
- any floor and ceiling per order;
- any tax MMAKF must charge on its own commission.

The middle two are the single most common source of dispute between a
marketplace and its sellers.

---

### 2. Seller requirements

**Undecided:** whether GSTIN, PAN, bank verification, identity verification or
an address check is *mandatory* before somebody may sell.

**Effect today:** `seller_verifications` records what has and has not been
checked; `sellerDossier()` reports what is absent so a reviewer can ask.
**Nothing refuses an applicant on a rule the federation has not made.**

**Where the answer goes:** the required set becomes a check in
`approveSeller()`. Until then, `VERIFICATION_REQUIREMENTS_NOT_SET` is displayed.

---

### 3. Service levels

**Nothing is published.** No acceptance window, no dispatch window, no return
response window, no support or dispute response window.

**Effect today:** `seller_orders.acceptBy` and `dispatchBy` are **NULL**. The
`overdueDispatch()` index is partial on `dispatch_by is not null`, so a seller
with no SLA never appears in an escalation queue — there is nothing they are
late for.

**Where the answer goes:** `seller_sla_configs`. One row with `seller_id` NULL is
the marketplace default; a row with a `seller_id` overrides it for one seller,
which is how a contract with a large distributor is represented.

An escalation fired against an invented deadline is an accusation the federation
cannot stand behind.

---

### 4. Return window floor

**Nothing is published.**

**Effect today:** each seller's own window stands, and the surface says it is
theirs and not the federation's (`RETURN_FLOOR_NOT_SET`). Where a seller has
published nothing either, a request is decided on its facts.

**Where the answer goes:** `setReturnPolicy({ marketplaceFloor: true })` under
`marketplace:review`. Once set, `effectiveReturnPolicy()` gives every buyer the
more generous of the two.

---

### 5. Penalties

**Nothing is published.** No schedule for late dispatch, upheld disputes,
counterfeit findings or SLA breach.

**Effect today:** `marketplace_disputes.penaltyMinor` and `payout_adjustments`
take whatever the deciding officer enters, with a separately stated reason. No
figure is computed.

**Where the answer goes:** a published penalty schedule, referenced by
`payout_adjustments.authority`.

---

### 6. Product taxonomy

**Proposed, not adopted.** `PROPOSED_TAXONOMY` in `src/db/catalogue.ts` is the
brief's own category list in MMAKF's own words. Adopting it is one call —
`adoptProposedTaxonomy()` under `marketplace:review`.

Every adopted category arrives as `requires_review`. **Nothing is proposed as
`allowed`, and nothing as `prohibited`.**

Adoption accepts a list of names; it does not decide that anything on the list
may be sold unexamined.

**The specific open question: WEAPONS.** The brief permits the category "where
legally and policy-appropriately allowed". MMAKF has not made that
determination, so `weapons` arrives requiring **federation approval per
listing**, with the qualification recorded in `policyReason`. It is not
prohibited, because the brief did not prohibit it. It is not allowed, because
the brief did not allow it. This has legal weight in twelve states and is not an
engineering decision.

---

### 7. Policy documents

**All ship empty.** `marketplace_policies` and `policy_versions` are created and
carry no text:

- Seller Agreement
- Marketplace Terms
- Return Policy
- Shipping Policy
- Privacy Policy
- Prohibited Products Policy
- Counterfeit Policy
- Commission Schedule

A plausible-looking seeded seller agreement is exactly the fabrication this
codebase treats as its worst defect — it would be quoted back at a seller as
though the federation had approved it.

**Where the answer goes:** publish a `policy_versions` row. Acceptance is
recorded against the **version**, with the body hash carried onto the acceptance
so it can be verified even if somebody later edits the version row.

---

### 8. Settlement cadence

**Undecided:** daily, weekly or monthly, and per seller or uniformly.

**Effect today:** `openSettlementFor()` opens one settlement per seller and
accrues into it. `cadence` is nullable and statements are generated on demand.

---

### 9. Brand restriction list

**Undecided:** which brands require a verified authorisation.

**Effect today:** `brands.requiresAuthorisation` defaults to **false**. Turning
it on for every brand would block the ordinary unbranded stock the federation's
dojos actually sell, and a control that blocks everything is turned off within a
week.

**Where the answer goes:** set `requiresAuthorisation` per brand, or
`status = 'restricted'`.

---

### 10. Seller tiers

**Undecided.** `sellers.tier` is nullable text and **carries no rate**. A tier is
a label a commission rule may match on; it is not itself a percentage, because a
percentage in the row that gets paid is a commission MMAKF never approved,
sitting exactly where nobody would look for it.

---

### 11. What happens to a seller who has published no shipping zone

**Undecided.** Today they are quoted no carriage and absorb it themselves.

**Effect today:** `quoteCarriage()` returns zero with `absorbed: true`, and
`/portal/seller/shipping` tells the seller how many orders that has applied to.
It reports **no rupee figure** for what it cost them — what a parcel costs to
send is a fact about their carrier that MMAKF does not hold, and inventing one
would be the same fabrication this whole register exists to prevent.

The alternative — refusing the sale — would take every seller who has not yet
configured a zone off the marketplace. Neither is chosen in code;
`UNZONED_SELLER_POLICY_NOT_SET` in `src/db/shipping.ts` reports it.

---

### 12. Which documents a seller must supply

**Undecided.** `missingDocuments()` reports what is absent so a reviewer can
ask; nothing refuses an applicant for a document the federation has not
required. `DOCUMENT_REQUIREMENTS_NOT_SET` in `src/db/seller-documents.ts`.

**Blocked on infrastructure, not policy:** `UPLOAD_STORAGE_URL` is unset, so no
document can be attached anywhere on the platform. `/portal/seller/documents`
shows **no upload control** rather than one that would accept the bytes and drop
them — a seller who uploaded a PAN card, saw "uploaded", and was then refused
for a missing PAN card is the worst outcome that page could produce.

This one is an operator action, not a federation decision: set
`UPLOAD_STORAGE_URL` (and ideally `MALWARE_SCAN_URL`) and the control appears.

---

### 13. Which policies sellers must accept

**Undecided, and every document is empty.** The eight policy records exist as
names; `mandatoryForSellers` is false on all of them, and none has a published
version.

**Where the answer goes:** `policy/draft` with the federation's own text, then
`policy/publish`, then `policy/mandatory`. Making a document mandatory before
publishing it is **refused** — there would be nothing for a seller to accept.

Acceptance is recorded against a **version**, and the version's body hash is
stored a second time on the acceptance itself. A published body edited in place
is therefore detectable: `acceptanceStillValid` goes false rather than the
discrepancy passing unnoticed.

---

## Prohibited and restricted products

The policy engine exists and is enforced; the *contents* are MMAKF's.

| Level | Enforcement |
|---|---|
| `allowed` | ordinary review |
| `requires_review` | may never be auto-approved by any future fast-track |
| `restricted` | plus brand authorisation / certification / age statement, as the category's flags say |
| `prohibited` | refused at submission, with the reason |

Policy is inherited by **strictest ancestor**, so a seller cannot evade it by
filing an item under a different category. Requirement flags are the **union** of
the ancestry. See [PRODUCT-MODERATION.md](PRODUCT-MODERATION.md).

---

## Federation control, in one place

MMAKF controls, and only MMAKF:

seller approval · seller suspension and restriction · product approval ·
the taxonomy and its policy · brand authorisation · commission · the badges ·
featured placement · prohibited products · refund and dispute escalation ·
settlement closure and payout release.

A seller controls their own scope and nothing else: their catalogue, their
stock, their orders, their carriage, their return policy within the floor, their
storefront copy, and their own shop's opening.

---

## Trust claims are data-backed or they do not render

`MMAKF OFFICIAL` · `MMAKF AUTHORISED` · `VERIFIED SELLER` · `VERIFIED BRAND` ·
`VERIFIED PRODUCT`

Two are granted by MMAKF and recorded with a name, a date and an authority.
Three are derived from verification records and disappear the moment the
evidence lapses.

A seller typing "Official MMAKF Supplier" into their profile gets a profile
field. The string and the badge are different things in different tables, and
only one of them renders as an endorsement.
