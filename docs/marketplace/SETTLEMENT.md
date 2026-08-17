# Commission, settlement and payout

`src/db/marketplace-finance.ts`. Money is integer minor units; rates are basis
points. 1250 bps = 12.5%.

---

## The refusal at the centre

`resolveCommission()` returns **either** a resolved figure with the rule version
that produced it, **or** a gap saying why it could not.

It never returns a rate. There is no fallback, no default, no `?? 0` and no
`?? 1000` — every one of those is a decision about other people's money that
nobody at MMAKF made.

- **Zero** would say the federation takes nothing from this sale. Nobody said
  that, and the shortfall surfaces at the end of the quarter.
- **10%** would take a tenth of a real person's money on an engineer's say-so.

So when no published rule matches:

- `order_line_commissions` gets **no row**;
- `commission_gaps` gets one, naming the reason and the amount at risk;
- `seller_orders.commission_minor` stays **NULL** — not 0;
- `commission_resolved` is false, and **settlement is blocked**.

The sale still completes. The buyer buys, the seller ships, the money is
captured and reconciled. Only the payout waits. Refusing the sale would punish a
seller for an administrative gap; settling at an invented rate would take money
that was never agreed.

`heldForCommission()` lists the held sales for `/admin/marketplace/commissions`.
`reresolveCommissionGaps()` clears them once a rule is published, turning "we
forgot to set a rate for headgear" from a permanent hole into a five-minute
correction.

---

## Three failures the versioning prevents

1. **A rate typed into code.** Obvious, and the one everybody fixes.
2. **A rate in a table that somebody edits.** MMAKF changes commission from 8%
   to 10% in June, and every statement for January through May silently
   reprints at 10%. Neither party can prove which figure is right.
3. **A rate merely *looked up* at settlement time.** The same failure, arriving
   later and harder to see.

Hence: `commission_rules` names **who and what**; `commission_rule_versions`
holds the **rate** with effective dates and is never edited once published; and
`order_line_commissions` **freezes** the resolved figures onto the line at
checkout and is never recomputed.

`ruleVersionId` is provenance — "this figure came from that version". It is
never read back to recompute an amount, exactly as `invoices.fxRateId` is never
read back to recompute a total.

---

## How a rule is chosen

Candidates are rules whose every **pinned** axis matches the sale. A NULL axis
does not constrain. The axes are the ones the brief names: seller, seller tier,
seller type, category (with subtree matching by materialised path), listing,
campaign, contract.

Among candidates the winner is, in order:

1. highest `priority`;
2. then **most specific** — the count of axes it pins;
3. then lowest id.

All three are in the `ORDER BY`. A commission that depended on the planner's row
order would change after a `VACUUM`, and the seller would have no way to know
why last month's rate was different.

Each axis is matched with an **explicit conditional**, not `eq(col, value ?? '')`.
The sentinel shorthand is wrong twice: it makes a rule pinned to the empty
string match a sale with no tier at all, and it compares NULL to a value in SQL
— which is neither true nor false but NULL, so the rule silently drops out of
the candidate set rather than being excluded for a stated reason.

---

## Draft, then publish

`draftCommissionVersion()` creates a rate. `publishCommissionVersion()` releases
it. The resolver filters on `published_at IS NOT NULL` **in SQL**, so a draft
cannot reach a live checkout half-finished.

Two inputs are **required with no default**:

- `chargedOnShipping`
- `chargedOnTax`

They are the single most common source of dispute between a marketplace and its
sellers, they differ by real money on every order, and there is no answer that
is right for everyone — so there is no answer in the code.

Publication additionally requires a stated `authority` — the resolution, meeting
or contract behind the rate. A rate nobody can point at the decision for is a
rate the federation cannot defend when a seller asks, and every seller asks.

`minMinor` and `maxMinor` cap the result: a percentage with no floor takes
eleven paise on a keyring, and with no ceiling it takes ₹4,000 on a competition
mat. Commission is finally clamped to at most the seller's gross, because the
alternative is a negative payable — the federation invoicing a seller for
having made a sale.

---

## Settlement

```
GROSS SALES
  − COMMISSION
  − TAX ON COMMISSION
  − REFUNDS
  ± ADJUSTMENTS
  = NET PAYABLE
```

Stored on `seller_settlements`, not derived, because a statement is a document.
Recomputing from live tables means last quarter's statement changes when a
refund is processed today, and a seller who printed it in April cannot reconcile
it in July.

`settlement_lines` are **signed**. Sales are positive; commission, refunds and
penalties negative. The total is `sum(amount_minor)` and cannot disagree with
the lines it is made of — which is precisely the failure the brief describes
when it says every seller must be able to follow
`order → revenue → commission → deductions → net → payout`.

### Accrual

`accrueSellerOrder()` posts at **delivery**, not payment. Accruing at payment
would put money on a seller's statement for goods still in a warehouse, and
every cancellation would be a reversal. A partial unique index on
`(seller_order_id, kind, order_line_id)` makes the job idempotent — and it will
be run twice, by a cron that overlaps itself.

### Refunds return the commission

`accrueRefund()` posts a negative `refund` line **and** a positive
`refund_commission_reversal` line, proportional to the refunded share of goods.
A marketplace that keeps its commission on refunded goods is one a seller stops
trusting the first time they notice, and they always notice.

A **platform-funded** refund posts nothing against the seller. MMAKF absorbs it,
and the seller's statement must not show a deduction they did not incur.

### Open → closed → approved → paying → paid

`closeSettlement()` **refuses** while `has_unresolved_commission` is true. A
statement containing a sale whose commission nobody has set is a statement that
cannot be right, and closing it would make a wrong figure final.

Anything arriving after closure — a late refund, a dispute award — lands in the
*next* period as an adjustment naming the settlement it relates to. That is how
real ledgers handle it, and the only way a closed statement stays closed.

`approveSettlement()` is a **second act** from closing: one seals the figures,
the other releases them for payment. Both take `marketplace:settle`, so MMAKF
can split them across two officers by appointing a second one — the audit trail
records which of them did which either way.

---

## Payout

`createPayout()` creates the **instruction**; it does not move money. A provider
adapter marks it paid. Separating the two is what makes a retry safe.

- `idempotency_key` is `settlement:<id>` — deterministic, unique, and enforced
  by the database. A retried request collides on the index instead of sending a
  second transfer. A payout is the one operation here that a status change
  cannot undo, so the duplicate is *prevented*, not detected.
- It **refuses** without a verified `payout_accounts` row. Money is not sent to
  an account nobody has checked.
- It refuses a zero or negative net. A zero payout is a carry-forward, and
  recording it as a payment makes the statement lie.

### Adjustments

`adjustPayable()` requires a reason and records an approver. This is the
function through which a person's income is reduced; an unattributed row is
indistinguishable from an error and from theft, and the seller is entitled to
know who decided.

Kinds: `hold` · `release` · `penalty` · `correction` · `chargeback` ·
`goodwill` · `recovery`.

**No penalty is ever computed.** What MMAKF charges for a breach is a federation
decision with a contract behind it; a schedule invented in code would be
deducted from a real person's settlement.

---

## Statements

`generateStatement()` snapshots every line into `seller_statements`, so the
March statement does not change in April. Daily, weekly or monthly, as MMAKF
chooses per seller.

Totals are `bigint` because a statement can aggregate a year, and an `integer`
of paise runs out at roughly ₹21 crore — a ceiling a large distributor could
reach, and one that would fail as a silent wrap rather than an error.

`myAccount()` gives a seller their own arithmetic with its working shown, and
reports `heldForCommission` plainly when the federation has not set a rate.

---

## Reconciliation

MMAKF's internal ledger is the operational accounting source. The gateway
dashboard is evidence, not the record.

`seller_order_payments` allocates one capture across several seller orders — the
whole point of a single checkout — and stores the allocated amount rather than
deriving it, so the arithmetic that split ₹3,000 into ₹1,000 and ₹2,000 is a
record, not a recomputation that could come out differently after a rounding
change. `gatewayFeeShareMinor` carries the apportioned provider charge, because
gross received is never what lands in the bank.
