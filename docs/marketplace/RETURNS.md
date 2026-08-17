# Returns, refunds and disputes

`src/db/returns.ts`.

---

## Return ≠ refund

A **return** is goods coming back. A **refund** is money going back.

They usually travel together and they are not the same event: a
damaged-in-transit item is refunded without ever coming back, and a rejected
return comes back to the buyer with no refund at all. Keeping them apart is what
lets both happen.

---

## Two policies, one answer

> "Each seller must configure their return policy. But seller policy cannot
> violate mandatory platform/legal requirements."

`effectiveReturnPolicy()` takes the **more generous** of the seller's window and
the marketplace floor. A seller offering fourteen days when MMAKF mandates seven
gives fourteen; a seller offering three gives seven.

That is the only reading that actually protects a buyer: taking the seller's
number when it is larger honours their offer, and taking the floor when it is
larger enforces the requirement.

**The floor ships unset.** MMAKF has published no marketplace-wide minimum. Until
it does, the seller's own window stands and the surface says exactly that, via
`RETURN_FLOOR_NOT_SET`. A seven-day floor invented in code would be enforced
against sellers who never agreed to it and quoted to buyers as though the
federation had promised it.

`nonReturnable` is the one seller setting the floor does not override — some
goods genuinely cannot come back (a bespoke gi, a digital course). It carries a
**required reason**, so the buyer is told why before they buy rather than after
they ask.

---

## The engine

```
requested → seller_reviewing → approved/rejected → authorised (RMA issued)
   → in_transit → received → inspected → refund_pending → refunded → closed
```

**Against a seller order, never against the whole order.** Returning Seller A's
gi must leave Seller B's mitts untouched, and a return pointing at the order
would have to remember which parts of it it meant — the same bug as a shared
total, arriving through a different door.

### Eligibility is frozen

`eligibilityAtRequest` stores what the policy said **when the buyer asked**. A
seller who shortens their window on Tuesday must not thereby invalidate Monday's
request, and without the frozen copy the recomputation on Wednesday says the
request was never eligible in the first place.

Same discipline as the invoice tax snapshot and the commission freeze.

### Goods that never arrived are not a return

`requestReturn()` refuses when the seller order is not `delivered`, and says so:

> If they have not arrived, raise a dispute instead — a return of something the
> buyer never received is a different problem with a different remedy.

### Inspection

`inspectReturn()` takes, per item, `receivedQty`, `sellableQty`, `damagedQty`
and an outcome. It refuses when `sellable + damaged > received`: the arithmetic
has to add up before anything is restocked or refunded.

What the two quantities do **not** account for is the interesting remainder — an
item received and neither restocked nor written off is one somebody has to
explain.

| Outcome | Stock | Refund |
|---|---|---|
| `sellable` | `restock` → on_hand +n | full per-unit value |
| `damaged` | `damage` → on_hand +n, damaged +n | full per-unit value |
| `not_the_item` | none | **nothing** |
| `not_received` | none | **nothing** |
| `rejected` | none | **nothing** |
| `counterfeit` | none | opens an authenticity case, quarantines the listing |

A return that arrives as an empty box is received and refundable for nothing.
That is why the enum has five outcomes rather than a boolean.

A **counterfeit** finding on a return is the strongest evidence there is — the
item is in the federation's hands — so it opens a case rather than being filed
as a note nobody reads. (A seller inspecting their own return holds no
`marketplace:review`, so the case is raised by the federation's queue from the
recorded finding.)

### Refund

`refundReturn()` is separate from the inspection, because money leaving is a
different act from goods arriving.

It refuses to exceed the amount assessed at inspection:

> Raise an adjustment instead — an over-refund posted as a refund cannot be told
> from an error later.

`fundedBy` is `seller` or `platform`, and it decides whether the seller's
settlement is touched at all. See [SETTLEMENT.md](SETTLEMENT.md) — a
seller-funded refund also **returns the commission** taken on the refunded
goods, proportionally.

---

## Disputes

**`marketplace_disputes` is not `disputes`.** The existing `disputes` table in
`src/db/reconciliation.schema.ts` records a **chargeback** — the card network
telling MMAKF that a cardholder has gone to their bank. This one records a buyer
telling MMAKF that a seller has let them down.

Different parties, different evidence, different clocks, different outcomes. The
only thing they share is the word, and merging them would put a marketplace
complaint into the treasurer's reconciliation queue.

```
open → seller_responding → under_review → resolved
                                       ↘ escalated
```

Kinds: item not received · not as described · damaged on arrival · counterfeit ·
wrong item · missing parts · refund not received · seller conduct · delivery
dispute · other.

Outcomes: `buyer_upheld` · `seller_upheld` · `partial` · `no_fault`.

`decideDispute()` requires `marketplace:dispute`, a stated reason both parties
read, and — if a penalty is imposed — **its own separate reason**.

**No penalty is ever computed.** `penaltyMinor` is whatever the deciding officer
enters. What MMAKF charges a seller for a breach is a federation decision with a
contract behind it, and a schedule invented in code would be deducted from a
real person's settlement.

`marketplace_dispute_messages.visibleTo` matters: a reviewer's internal note
about a seller's history must not be readable by either party, and a system
without the column either publishes the note or forces the reviewer to keep it
somewhere the case file cannot reach.

---

## Buyer reports

`buyer_reports` is the lightweight channel — the first thing a buyer reaches
for. Wrong product, damaged product, missing delivery, counterfeit, refund
issue, seller issue. Every report links to an **order, a seller and (where the
buyer says which) a product**, as the brief requires.

Kept separate from disputes because most reports are resolved by the seller in a
day and should never become a formal case with a clock and an adjudication.
Forcing them to would make the dispute queue useless within a month, and a
useless queue is one nobody reads. A report escalates into a dispute by
reference (`escalatedToDisputeId`) rather than by conversion.

---

## Who may act

| Act | Who |
|---|---|
| Request a return, raise a dispute, report a problem | the **buyer**, matched on the person behind the signed-in account — never on an id in a URL |
| Decide a return, respond to a dispute | the **seller**, filtered in SQL on their own `seller_id` |
| Decide a dispute, order a refund, impose a penalty | `marketplace:dispute` — national |
| Set the marketplace return floor | `marketplace:review` |

A federation officer with `marketplace:dispute` may act on a buyer's behalf —
which is what a support desk is for — and the audit records which of the two it
was.
