# Marketplace architecture

**The MMAKF marketplace, and why it is shaped this way.** Migration 0029.

---

## What this is, and what it replaced

Before migration 0029 the federation had a shop with tenants. It had `sellers`,
it had `listings`, and it had the two review gates that matter — a seller is
approved separately from each of their items, and editing an approved item
returns it to review. Those gates are good and 0029 does not touch them.

What it did not have was any of the machinery that makes a multi-seller
marketplace different from a shop:

| Missing | Consequence |
|---|---|
| Variants | A listing had one price and one stock number. The last 170cm gi and the last 190cm gi were the same number, and two buyers could have it. |
| Seller orders | A basket from two sellers produced one undifferentiated order. Nothing to accept, dispatch, settle or refund without touching the other seller's money. |
| Commission | Not a wrong rate — *none*. A payment cleared and the whole basket total sat in the federation's account with no record of what any seller was owed. |
| Verification | A seller was a trading name and five nullable fields. Nothing recorded what had been checked, by whom, against which document, or when it expires. |
| Brand authorisation | "Authorized Adidas Distributor" was a string a seller could type. |

0029 adds 54 tables and 64 columns on three existing ones.

---

## The spine

```
BUYER
  ↓
orders                  one buyer transaction · one payment · one receipt
  ↓
seller_orders           the unit of WORK, MONEY and ACCOUNTABILITY
  ↓
order_lines             attributed to a seller, a listing and a variant
  ↓
payments (existing)     one capture across the whole basket
  ↓
stock_reservations      held → committed → dispatched
  ↓
order_line_commissions  frozen at checkout, never recomputed
  ↓
settlement_lines        signed, one per movement
  ↓
seller_settlements      GROSS − COMMISSION − TAX − REFUNDS − ADJUSTMENTS = PAYABLE
  ↓
seller_payouts          idempotency-keyed; the transfer, not the account
```

**The buyer's `orders` row records what was charged and is never rewritten.**
Refunds, disputes and adjustments post *against* it; they do not edit it. What
was charged does not change.

---

## Why `seller_orders` exists

The brief's critical test ends: *"Refunding Product A must NOT corrupt Product
B."* That clause dictates the whole design.

If status lived on the order, "shipped" would be a lie the moment one of two
sellers had shipped, and a refund would have to reach into a shared total and
hope. With a seller order, a refund touches Seller A's row, Seller A's lines,
Seller A's commission and Seller A's settlement.

There is no shared mutable figure for it to corrupt. Corrupting Seller B is not
a bug that has been carefully avoided — **it is a write that does not exist**.

Proved by `tests/marketplace-platform.test.ts`, which reads every figure on
Seller B before and after a full refund of Seller A and asserts byte equality.

---

## The module map

| Module | Owns |
|---|---|
| `src/db/marketplace.ts` | Sellers, listings, the two review gates, the content hash, the public shop query |
| `src/db/seller-registry.ts` | Registration, verification, brand authorisation, badges, the admin 360, restriction |
| `src/db/catalogue.ts` | The governed taxonomy, product policy, variants, quarantine, moderation flags, authenticity cases |
| `src/db/inventory.ts` | Locations, the five buckets, the movement ledger, reservations |
| `src/db/seller-orders.ts` | Checkout and the seller split, the fulfilment lifecycle, shipments, seller isolation |
| `src/db/marketplace-finance.ts` | Commission resolution, settlement accrual, payouts, statements, adjustments |
| `src/db/returns.ts` | Return policy reconciliation, the return engine, refunds, disputes, buyer reports |
| `src/db/marketplace-trust.ts` | Reviews, performance snapshots, fraud signals *(schema shipped; computation is queued — see IMPLEMENTATION-QUEUE.md)* |

---

## Rules the database enforces, rather than promises

Application code can be refactored around. These cannot.

| Rule | Mechanism |
|---|---|
| Stock cannot be oversold | `CHECK (reserved + committed + damaged <= on_hand)` on `stock_items` |
| One seller order per (order, seller) | `UNIQUE (order_id, seller_id)` |
| One commission per order line | `UNIQUE (order_line_id)` on `order_line_commissions` |
| One review per purchase | `UNIQUE NOT NULL (order_line_id)` / `(seller_order_id)` |
| One payout per instruction | `UNIQUE (idempotency_key)` on `seller_payouts` |
| One live reservation per line per location | Partial `UNIQUE` where status in (held, committed) |
| One open settlement per seller | Partial `UNIQUE` where status = 'open' |
| One storefront per URL | Partial `UNIQUE` on `store_slug` where not null |
| A badge names a seller *or* a listing | `CHECK ((seller_id IS NOT NULL) <> (listing_id IS NOT NULL))` |
| Ratings are 1–5 | `CHECK (rating BETWEEN 1 AND 5)` |

The oversell guard is the one to understand. `reserveForLine()` issues a single
conditional `UPDATE` whose predicate the engine re-evaluates at write time, so a
stale read cannot cause an oversell — only a zero-row match, which is detected
and reported. Behind that, the CHECK makes the bad state unrepresentable even if
a future caller bypasses the function entirely.

**If a test fails against `stock_items_encumbrance_ck`, the test has found the
bug.** Do not relax the constraint.

---

## Public visibility: one definition, five conditions, all in SQL

`publicListingPredicate()` in `src/db/onboarding.schema.ts` is the only
definition of what the public may see:

1. the listing is approved;
2. the seller is currently approved — so suspending a seller withdraws every
   listing in the same instant, without deleting a row;
3. the approved content hash still equals the current one — so an edit removes
   the item even if a future refactor drops the status change;
4. the listing is not quarantined *(0029)* — one column withdraws an item from
   every public surface during an investigation, while its orders, reviews and
   revisions survive;
5. the seller's store is open *(0029)* — a seller closing for a fortnight must
   not have to be suspended to stop selling.

`checkout()` resolves the cart against **this same predicate**, not a
re-implementation of it. An item that cannot be seen cannot be bought by
guessing its id, and the two rules cannot drift apart because there is only one
of them.

---

## What ships empty, and why that is the point

Not one commission rate. Not one SLA window. Not one return period. Not one
penalty. Not one line of a seller agreement.

A seeded 10% commission is indistinguishable, six months later, from a rate the
federation approved — and it would be deducted from real people's money. So an
unconfigured commission produces a `commission_gaps` row and **blocks
settlement**: the sale completes, the seller ships, and the money waits for a
decision.

The one exception is the taxonomy. `PROPOSED_TAXONOMY` in `src/db/catalogue.ts`
is the brief's own category list in MMAKF's own words, adopted by running
`adoptProposedTaxonomy()`. Quoting is not inventing; adoption is one call; and
every adopted category arrives as `requires_review`, never as `allowed`.

See [MARKETPLACE-POLICY.md](MARKETPLACE-POLICY.md) for the full list of
decisions awaiting the federation.

---

## Related

- [SELLER-ONBOARDING.md](SELLER-ONBOARDING.md) — apply → verify → approve → store
- [PRODUCT-MODERATION.md](PRODUCT-MODERATION.md) — the two gates, quarantine, counterfeit
- [ORDER-ENGINE.md](ORDER-ENGINE.md) — checkout, the split, fulfilment, inventory
- [SETTLEMENT.md](SETTLEMENT.md) — commission, settlement, payout
- [RETURNS.md](RETURNS.md) — returns, refunds, disputes
- [SELLER-RBAC.md](SELLER-RBAC.md) — who may do what, and the isolation proofs
- [MARKETPLACE-POLICY.md](MARKETPLACE-POLICY.md) — what MMAKF has not decided
