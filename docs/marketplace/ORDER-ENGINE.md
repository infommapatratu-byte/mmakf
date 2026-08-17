# Order engine

**One checkout. One payment. Many sellers.** `src/db/seller-orders.ts`.

---

## The critical test

> Buyer purchases Product A from Seller A (₹1,000) and Product B from Seller B
> (₹2,000). The customer sees ONE CHECKOUT. The backend creates ONE CUSTOMER
> ORDER plus SELLER ORDER A plus SELLER ORDER B. Payment ₹3,000. Each seller
> receives its calculated amount. **Refunding Product A must NOT corrupt
> Product B.**

Implemented and asserted line by line in `tests/marketplace-platform.test.ts`,
including the last clause — every figure on Seller B is read before and after a
full refund of Seller A and compared for byte equality.

---

## `checkout()` — order of operations

Each step is where it is for a reason.

**1. Resolve every line against the public catalogue predicate.**
The same SQL the shop uses, not a re-implementation. A variant on an unapproved,
quarantined or suspended-seller listing is not purchasable, so an item that
cannot be seen cannot be bought by guessing its id.

**2. Group by seller and price each group.**
Every price comes from `listing_variants`. Tax from the listing's rate.

**3. Create the order, then the seller orders, then the lines.**

**4. Reserve stock per line.**
This can fail — and it must fail *here*, before a payment page has been opened,
not afterwards with an apology.

**5. Freeze the commission per line, or record a gap.**

Nothing is charged. The function produces an order `awaiting_payment`, which the
existing payment spine in `src/db/orders.ts` then handles.

---

## Buyer price tampering is unrepresentable

```ts
export interface CartLine {
  variantId: number;
  quantity: number;
}
```

That is the entire input type. There is no price field, no seller field, no tax
field, no discount field and no commission field — so there is nothing to
tamper with. The attack is not rejected; it has nowhere to go.

The test sends `{ variantId, quantity, unitPriceMinor: 1, priceMinor: 1,
totalMinor: 1 }` and asserts the order totals the catalogue price.

Repeated variants are folded into one line with a combined quantity, because two
reservations for the same line would collide on the reservation unique index and
produce a confusing constraint error instead of a sale.

---

## Carriage

Resolved **per seller**, from that seller's own zones and methods. A basket from
three sellers is three consignments and three carriage charges; presenting it as
one would be a discount MMAKF pays for without being asked.

A seller with no configured zones is charged nothing and their surface says so.
The alternative — refusing the sale — would take every existing seller off the
marketplace on the day 0029 shipped, because none of them had a zone yet.

A seller with zones that do not cover the address raises `not_serviceable`
rather than shipping anyway.

---

## Status: work, not money

`seller_order_status` has the fifteen values the brief names:

```
order_created → payment_pending → paid → seller_accepted → processing
  → packed → shipped → in_transit → delivered
                                       ↓
                        return_requested → returned → refund_pending → refunded
                                       ↓
                                   disputed
cancelled (from any pre-dispatch state)
```

This is deliberately **not** the existing `orderStatus`, which describes MONEY
(draft, awaiting_payment, paid, refunded). One order can be `paid` while one
seller order is `shipped` and another is still `seller_accepted`, and a single
enum cannot hold both facts.

Transitions are a **table**, not a chain of ifs, because the interesting
property is what is absent. There is no route from `paid` to `delivered`: a
seller cannot mark something delivered that they never said they had dispatched,
so the delivery date on a dispute is worth something.

Every transition writes a `seller_order_events` row with the actor role — buyer,
seller, federation or system — separately from the user id, because the same
person can act in two capacities and the seller's cancellation rate must count
only the ones they caused.

---

## Inventory: five buckets and a ledger

| Bucket | Meaning |
|---|---|
| `on_hand` | physically present |
| `reserved` | held for an order that has **not** been paid for |
| `committed` | paid, not yet dispatched — present, and absolutely not sellable |
| `damaged` | present and not sellable |
| `in_transit` | moving between the seller's own locations |

**`available` is derived**: `on_hand − reserved − committed − damaged`. It is
not a column, because two columns that must agree eventually disagree, and the
one that gets updated is never the one that gets read.

`listing_variants.availableQty` is a *cache* for listing pages, refreshed inside
the same transaction as the movement. Nothing sells against it.

### The lifecycle

```
checkout   → reservation   reserved +n
payment    → commit        reserved −n, committed +n     (on_hand unchanged)
dispatch   → dispatch      committed −n, on_hand −n
cancel     → release       reserved −n  (or committed −n)
expiry     → release       reserved −n
return in  → restock       on_hand +n           (inspected sellable)
           → damage        on_hand +n, damaged +n  (inspected damaged)
```

Paying moves a unit from `reserved` to `committed` and changes the total not at
all — which is why movements record a signed delta *per bucket* rather than one
quantity. A single quantity column would record that transfer as zero, and it is
exactly the movement an investigation is looking for.

### Every write leaves a movement

`move()` is the only write path. It updates the buckets and appends a
`stock_movements` row in the same statement sequence, inside the caller's
transaction, freezing `on_hand_after` so the ledger can be replayed and checked.

`adjustment`, `damage`, `write_off` and `count` require a reason. An unexplained
manual stock change is indistinguishable from a loss nobody reported.

### The oversell

`reserveForLine()` issues one conditional `UPDATE`:

```sql
update stock_items set reserved = reserved + n
where variant_id = ? and location_id = ?
  and on_hand - reserved - committed - damaged >= n
```

Two checkouts racing for the last gi both attempt it; the second matches **zero
rows**, and the caller is told so. Behind that, `stock_items_encumbrance_ck`
makes the over-reserved state unrepresentable even if a future caller bypasses
this function.

A read-then-write with a JavaScript `if` cannot do this and never could. It is
the most common defect in marketplace inventory code and it only ever reproduces
under load.

### Fulfilment source

Locations are ranked by `priority` ascending, then by id — a **stated** tiebreak
rather than whatever the planner returned, because a non-deterministic
fulfilment source produces bugs that cannot be reproduced.

A line is never split across locations. A split line is two consignments and two
carriage charges, and deciding that silently on a buyer's behalf is the seller's
call.

---

## Shipping and tracking

`shipments` is separate from `seller_orders` because one seller order can ship
in two parcels, and a tracking number belongs to a parcel. Flattening tracking
onto the seller order makes the second parcel unrepresentable — and the second
parcel is what a buyer rings about.

**Tracking is never fabricated.** `carrier`, `trackingNumber` and `trackingUrl`
are nullable and nothing generates them. A consignment with no tracking is shown
as a consignment with no tracking; a generated link that 404s at the carrier is
worse than nothing, because the buyer believes it and then distrusts everything
else on the page. `shipSellerOrder()` returns `trackingRecorded: false` so the
surface can say so plainly.

---

## SLA

`slaFor()` reads the seller's own override, else the marketplace default, else
returns **nulls**.

There is no fallback of 24 or 48 hours. `acceptBy` and `dispatchBy` are left
NULL when MMAKF has published no window, the `overdueDispatch()` index is
partial on `dispatch_by is not null`, and a seller with no configured SLA never
appears in the escalation queue because there is nothing they are late for.

An escalation fired against an invented deadline is an accusation the federation
cannot stand behind.

---

## Seller isolation

**No seller-facing function in this module takes a `sellerId`.** The caller's
seller record is resolved from their signed-in user and the filter is applied in
SQL, on `seller_orders.seller_id` and again on the denormalised
`order_lines.seller_id`.

A function that cannot be asked about another seller cannot be tricked into
answering about one. `mySellerOrder()` returns the same `not_your_order` message
whether the order belongs to somebody else or does not exist — distinguishing
them tells an attacker which ids are real.

See [SELLER-RBAC.md](SELLER-RBAC.md).
