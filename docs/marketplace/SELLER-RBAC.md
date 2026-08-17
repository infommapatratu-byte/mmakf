# Marketplace authorisation

**Who may do what, and how seller isolation is actually enforced.**

---

## Sellers are not in the role hierarchy

A seller holds **no role binding**. Selling is not authority over other people's
records — it confers no read of anybody's data — so making it a role would put a
shopkeeper inside the authorisation hierarchy.

Standing lives in its own table (`sellers`) with its own lifecycle. A seller's
authority over their own shop is proved by *owning the row*, resolved from their
signed-in user, never from an id in a request.

This is why "Seller A attempts: change commission — MUST FAIL" is not a check
anybody wrote. `createCommissionRule()` asserts `marketplace:commission`, and a
seller has no bindings at all, so `can()` denies by default.

---

## The eight marketplace actions

| Action | What it decides | Held by |
|---|---|---|
| `marketplace:read` | See sellers, listings, orders, settlements | national, STATE_ADMIN (scoped), FINANCE_OFFICER |
| `marketplace:review` | Approve a seller, approve a listing, grant a badge, set the taxonomy | national, STATE_ADMIN (scoped) |
| `marketplace:suspend` | Suspend, restrict, quarantine, uphold a counterfeit case | national, STATE_ADMIN (scoped) |
| `marketplace:verify` | Identity, business, GST, PAN, bank, address evidence | national, STATE_ADMIN (scoped) |
| `marketplace:brand` | Whether a seller may claim to be an authorised distributor | **national only** |
| `marketplace:commission` | What sellers are charged | national, FINANCE_OFFICER |
| `marketplace:settle` | Close, approve and pay out | national, FINANCE_OFFICER |
| `marketplace:dispute` | Decide between a buyer and a seller; order a refund | national only |

### Why each is separate

**`verify` is not `review`.** Reviewing whether a gi may be advertised is
editorial judgement. Verification is reading somebody's tax registration and the
last four digits of their bank account. A state officer who vets local traders
needs it; a content reviewer does not.

**`brand` is national only.** A letter from Adidas is not a Jharkhand fact, and
a counterfeit regime in which twelve state offices each recognise a different
set of authorisations is not a regime.

**`commission` is not `finance:write`.** `finance:write` is reconciliation and
reporting. Whoever reconciles the money must not also be able to change the rate
that produced it. It is also not `feeframework:*` — that prices what MMAKF sells
to its own members; this prices what MMAKF takes from other people's sales.

**`settle` is separate from `commission`** so that the person who sets the rate
and the person who pays out against it can be two people. That is the whole of
segregation of duties in a marketplace. Granting both to FINANCE_OFFICER matches
how the federation is staffed today; the split is available the day it is not.

**`dispute` is not `support:*`.** A support agent resolving a delivery query
should not be able to award ₹40,000 against a trader.

### What FINANCE_OFFICER deliberately does *not* hold

Not `marketplace:review`, and not `marketplace:suspend`. Whoever decides who may
trade should not also be the office that pays them — and a finance officer who
could suspend a seller could suspend the one whose settlement they had got
wrong.

---

## Isolation: filters in SQL, resolved from the session

Every seller-facing read filters on a column, in the `WHERE` clause, against a
seller id resolved from `principal.userId`:

| Module | Function | Filter |
|---|---|---|
| `seller-orders.ts` | `mySellerOrders`, `mySellerOrder` | `seller_orders.seller_id` **and** `order_lines.seller_id` |
| `inventory.ts` | `stockForSeller`, `movementsForVariant` | `stock_items.seller_id` |
| `catalogue.ts` | `ownListing` | join `listings → sellers` on `sellers.user_id` |
| `returns.ts` | `myReturns`, `decideReturn` | `return_requests.seller_id` |
| `marketplace-finance.ts` | `myAccount`, `myStatements` | `seller_settlements.seller_id` |

`seller_id` is **denormalised** onto `order_lines` and `stock_items`. It is
reachable through a join, but a check that needs a join is a check somebody
eventually writes without the join. The column makes the correct filter cheap
enough that nobody is tempted to skip it — and `mySellerOrders()` applies both,
so a future refactor that loosened one would still be caught by the other.

**Errors do not distinguish "belongs to somebody else" from "does not exist".**
`not_your_order`, `not_your_variant`, `not_your_listing` and `not_your_return`
all return the same message either way. Distinguishing them tells an attacker
which ids are real.

---

## The five attacks, and why each fails

From `tests/marketplace-platform.test.ts` — every one is an executing test.

| Attack | Why it fails |
|---|---|
| Seller A views Seller B's orders | `mySellerOrder()` takes no `sellerId`; the SQL filter is on the caller's own. Also asserted via the list view. |
| Seller A modifies Seller B's inventory | `ownVariant()` resolves the caller's seller and filters `listing_variants.seller_id`. B's stock is re-read and asserted unchanged. |
| Seller A sees Seller B's stock | `stockForSeller()` filters in SQL; B's variant is absent from A's result. |
| Seller A changes commission | `assertCan(principal, 'marketplace:commission')` — a seller has no bindings. |
| Seller A claims MMAKF authorisation | The tagline is written; `seller_badge_grants` is queried and is empty. A badge is a row in a table sellers cannot write. |
| Buyer changes price | `CartLine` has no price field. Extra properties are sent and the order totals the catalogue price. |

Two more, added because they are the same class:

| Attack | Why it fails |
|---|---|
| Buying a suspended seller's item by id | `checkout()` resolves against `publicListingPredicate()`, which requires the seller approved. |
| Buying a quarantined item by id | Same predicate, condition 4. |

---

## Self-review is refused

A reviewer deciding their own shop is the same failure as an applicant approving
their own application. `decideSeller()` and `decideVerification()` both refuse
when `principal.userId === seller.userId`, **whatever authority the caller
holds**.

---

## Scope

Scoped actions are checked against the seller's placement — `stateUnitId`,
`districtUnitId`, `dojoId` — through the same `assertCan(principal, action,
resource)` choke point as every other federation resource. A STATE_ADMIN reviews
the sellers of their own state and no other; an unlocated seller is reachable
only from a national binding, which is the fail-closed reading.

No page or endpoint re-implements any of this. `src/lib/rbac.ts` is the single
policy choke point.

---

## What a seller can never reach

- `commission_rules` / `commission_rule_versions` — no seller-facing write path
- `seller_badge_grants` — `marketplace:review` only, and the derived badges
  cannot be granted by hand at all
- `payout_adjustments` — `marketplace:settle` only
- `featured_placements` — no `sellerId` on the writer side; "featured" is not a
  boolean on the listing that a bulk import could set by accident
- another seller's `stock_items`, `seller_orders`, `return_requests`,
  `settlement_lines`, `marketplace_disputes`
- `brand_authorisations.status` — `claimBrandAuthorisation()` does not take a
  status; it always writes `'claimed'`
