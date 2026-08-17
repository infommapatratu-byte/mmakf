# Product moderation

**Being approved to sell is not permission to put something in front of the
public.** Two gates, and the second is worthless without the third rule below.

---

## The two gates

**Gate one — the seller.** *We know who this is; we are content for them to
trade under the federation's name.*

**Gate two — the listing.** *We have seen THIS item, at THIS price, with THESE
photographs.*

The first cannot stand in for the second, because an approved seller with an
unreviewed listing is precisely the shop MMAKF has not seen.

```
DRAFT → REVIEW → APPROVED → PUBLISHED
          ↓
       REJECTED / CHANGES REQUESTED
```

Admin can approve, reject, request changes, suspend, unpublish, archive,
quarantine. A seller can withdraw their own item; they cannot publish a
restricted category.

---

## The rule that gets forgotten

**EDITING AN APPROVED LISTING RETURNS IT TO REVIEW.**

Without it, listing approval is theatre: a plain karate-gi is approved on
Monday, and on Tuesday the title, the photographs and the price become something
MMAKF never saw, under an approval MMAKF gave to something else.

Implemented as a **content hash**, not as listing versions. A version model does
the opposite by construction — the public keeps seeing the last approved version
while the edit is pending, so the item never leaves the shop. That may be a
defensible product decision; it is not the one that was asked for.

Belt and braces: `publicListingPredicate()` requires
`content_hash = approved_content_hash`, so an edited listing leaves public view
**even if a future refactor drops the status change**. The rule survives the
refactor that would otherwise silently delete it.

### What feeds the hash

Title · description · category · price · currency · media (sorted) ·
**and, since 0029:** brand, catalogue category, specifications, materials,
dimensions, weight, country of origin, warranty, GTIN, sport, discipline,
Shotokan relevance, age suitability, safety classification, certification,
usage instructions, warning, HSN, tax rate, shipping class · **and every
variant's SKU, label, price and attributes**.

### What does not

**Stock.** A seller who sells three gis would otherwise push their listing into
the queue three times in a day; the queue would become unreadable, and an unread
queue approves everything. A stock count also cannot mislead anybody about what
the item *is*, which is the whole question review answers.

**Variant stock**, for the same reason — while variant *price* and *label* do
feed it. Adding a size or repricing one changes what MMAKF approved; selling
three of them does not.

### The v1/v2 compatibility rule

Adding twenty-three fields to a hash normally invalidates every hash already
stored — and under the public predicate an invalidated hash means the listing
**leaves public view**. Shipping 0029 naively would have emptied the shop on
deploy, with no error, no failing test, and a cause nobody would find because
nobody wrote it.

So the extended block is hashed **only when the seller has stated something in
it**. A pre-0029 listing has all fields null and one backfilled `Standard`
variant, contributes nothing, and hashes byte-for-byte as it did under v1.

`tests/marketplace-platform.test.ts` asserts that byte-identity directly. **Do
not "simplify" this by always hashing the extended block.**

---

## Product policy: the anti-bypass

> "Do not allow sellers to bypass marketplace policy by selecting a different
> category."

The naive implementation reads the chosen category's own policy and stops. That
*is* the bypass: MMAKF marks `weapons` prohibited, a seller files a nunchaku
under `training-equipment`, and the control is silent.

`effectivePolicyFor()` walks the **ancestry** and takes the **strictest** policy
found. The requirement flags are the **union** of every ancestor's — so
`protective-equipment` requiring a safety classification and `headgear`
requiring an age statement require both, where a nearest-wins rule would drop
the parent's the moment a child set any flag.

Policy is never copied down the tree on write. A copied value is stale the
moment a parent changes, and the staleness is invisible: the child still says
`allowed` and nobody can see it is answering a question from last year.

| Policy | Meaning |
|---|---|
| `allowed` | Ordinary review queue |
| `requires_review` | The same, and may **never** be auto-approved by any future fast-track. A distinct value rather than a flag, because "we will add fast-tracking later" is when this gets lost. |
| `restricted` | Additionally requires an authorisation, a certificate, or an age statement |
| `prohibited` | May not be listed. Kept as a *category* rather than an absence, so a seller gets a reason instead of a shrug. |

### `checkListingAgainstPolicy()` reports everything

It returns `blocking[]` and `reviewerMustConfirm[]` rather than throwing on the
first fault. A seller told one fault at a time submits five times and gives up on
the fourth; a reviewer who sees only the first fault approves an item with four
others.

**A listing with no category does not skip the brand checks.** That was a real
defect — an early-return on a null policy — caught by the test suite. The
category gate and the brand gate are independent controls and neither may be
conditional on the other.

### Age is not a default

`ageMinYears` nullable means **UNSTATED**, not "suitable for everyone". A null
read as "all ages" on a piece of protective equipment is the exact shape of a
harm this system exists to prevent, so a category requiring an age statement
blocks on absence.

---

## Brand and counterfeit protection

> A seller claiming "Authorized Adidas Distributor" must not automatically
> receive an authorised-brand badge.

`brand_authorisations` records the brand, the seller, the relationship, the
scope, the issuer, the document, the validity dates and the verification status.
`claimBrandAuthorisation()` — the only path a seller can reach — does not take a
status and always writes `'claimed'`.

A **claim** unlocks nothing. `verifiedBrandAuthorisation()` requires
`status = 'verified'`, unrevoked, and **within its validity dates**, checked on
every read. An authorisation that expired last month stops working without
anybody revoking it — asserted by test.

`brands.requiresAuthorisation` and `brands.status = 'restricted'` are the
per-brand enforcement points. Not every brand: MMAKF cannot reasonably demand a
letter for a generic white gi, and a control that blocks everything is turned
off within a week.

### Authenticity cases

A formal investigation — not a flag with a longer name. A case reaches the
*seller*, may cover several listings, involves a brand owner as a third party,
and ends in a decision that has to be defensible. It carries the seller's right
to respond and a response deadline.

**Quarantine can be applied the moment a case opens, before any finding.**
Withdrawing an item while it is investigated is a precaution; requiring a
finding first would mean suspected counterfeits stay on sale for the length of
the investigation.

A **dismissed** case lifts the precautionary quarantine it caused. An **upheld**
one does not — the item stays off the marketplace until somebody decides
separately what happens to it, and that is a different decision.

---

## Quarantine

A **third axis**, deliberately not a value of `listing_status`.

A quarantined listing has to remember what it was — approved, submitted, already
delisted — because quarantine is lifted as often as it is upheld, and a status
that overwrote the previous one would leave the federation with no idea what to
restore the item to.

One column (`quarantined_at`) removes the item from every public surface at
once, via `publicListingPredicate()`, while every order, review and revision
attached to it survives. Both quarantining and lifting require a reason; the
reason is kept after lifting, because an item that was once quarantined is a
different record from one that never was.

---

## Moderation flags

`listing_flags` records a concern — raised by a reviewer, an automated check, a
buyer or a brand — separately from the review decision.

A rejection is a decision about a submission; a flag is a concern about an item
that may already be live and may turn out to be nothing. Folding them together
means the only way to record a suspicion is to reject the listing, so suspicions
go unrecorded until somebody is sure — which is exactly when the pattern across
several sellers stops being visible.

Kinds are the brief's own list: duplicate · wrong image · wrong category ·
misleading claim · incorrect brand · unsupported affiliation · false
certification · **false official claim** · prohibited item · unsafe item · price
manipulation.

`false_official_claim` is deliberately not folded into `misleading_claim`: a
seller implying MMAKF endorsement is an attack on the federation's own
authority, not a marketing exaggeration, and it needs to be separately
reportable to the people who decide about badges.

`raisedBySystem` marks the automated ones. **AI may flag; only a human upholds.**

---

## Bulk import

> "Never directly import into production catalogue."

`product_imports` and `product_import_rows` stage the pipeline:

```
UPLOAD → VALIDATE → PREVIEW → DUPLICATE CHECK → CATEGORY MAP
       → TAX VALIDATION → MODERATION → APPROVAL → PUBLISH
```

Rows are validated, deduplicated and category-mapped **in the staging table**. A
listing is created only when the import is submitted, and it is created as a
**draft** that goes through the same moderation queue as a hand-typed one.

The alternative — writing listings and marking them pending — looks equivalent
and is not: it puts five hundred unreviewed rows into the table the public query
reads from, and leaves the whole marketplace one forgotten predicate away from
publishing them.
