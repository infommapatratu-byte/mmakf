# Implementation queue

What to build next, in order, and why that order. **Updated 14 August 2026.**

Read [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) first — it says what
exists. This file says what does not, and what each item unblocks.

---

## What came off this queue

Six of the eight items on the previous version have shipped. They are recorded
here rather than deleted, because a queue that quietly loses its history cannot
be checked against what was promised.

| Was | Now |
|---|---|
| 2 — Institution client portal | **Built.** `/learn/portal`, institution resolved from the caller's binding and never from a query parameter. |
| 3 — Quotes and proposals | **Built.** `/admin/fees` authors and publishes a framework; `/admin/quotes` issues, and as of 14 August approves — by somebody other than the issuer. |
| 4 — Bookings, calendar, attendance | **Built.** `/admin/bookings`, `/admin/venues`, `/admin/attendance` with the correction trail. The coach's own calendar on the learn surface is **not** built. |
| 5 — CRM and programme surfaces | **Built, partially.** `/admin/leads` exists and is read-only; `/admin/programs` has the full template lifecycle. |
| 6 — Workflow inspection | **Built, read-only.** `/admin/workflows` shows definitions, runs, steps and failures. It cannot retry, cancel or disable anything. |

Item 1 (the coach application form) has **not** shipped and is still first.

---

## Ordering principle, restated

**Surfaces before new domains** still holds, but the balance has shifted. The
large remaining gaps are no longer un-surfaced domain modules — they are
*half-built* capabilities where a page exists and cannot write, or an engine
exists and nothing calls it. Those are worse than an absent feature, because
they read as done.

So the order below is: **finish what looks finished, then build what is
missing.**

---

## 0a — A registration step that collects a structured address

**Added 17 August 2026, and placed above the coach form because it is the same
defect one layer down.**

`src/db/geography.ts` and `src/db/identity.ts` exist, are gated, audited and
covered by 99 tests, and **nothing in `src/pages` calls either.** Registration
still collects a free-text city. Every member entered between now and this item
shipping is a member whose address has to be re-resolved later.

- `resolveArea()` behind a step in the membership form — country → state →
  district, each narrowing the next through `within`
- the ambiguity case rendered as a CHOICE, not silently resolved
- `setPersonAddress()` on submission, and `addContact()` for email and phone

**Unblocks:** coach matching by travel radius, geographic dashboards, the India
map, state and district reporting — all of which currently have no civil
geography to read.

---

## 0b — The identity queues need screens

`duplicateQueue()` and `profileChangeQueue()` are written, scope-filtered in SQL
and tested. Neither has a page, so a duplicate raised at registration is raised
into a table nobody opens.

- `/admin/duplicates` — the pair, the signals that fired, and the three
  decisions. It must show WHICH signals, not just the score.
- `/admin/profile-changes` — the request, the evidence, and the refusal when the
  record moved underneath it
- both gated on `duplicate:review` / `profilechange:decide`

---

## 0c — Guardian and parent surfaces

`guardianCan()` is the single question every parent-facing screen must ask, and
there is no parent-facing screen. The `PARENT` role has existed in `rbac.ts`
since before this wave and has never had anywhere to go.

- a guardian's dependants list, built from `dependantsOf()`
- the capability grants visible to the guardian, so they can see what they hold
- **every read gated on `guardianCan()`**, never on the `PARENT` role alone —
  that is the whole point of the capability table

---

## 1 — Coach application form

`applyAsCoach()` and `applyAsCoachWithAutomation()` exist, are tested, and
create the candidate record, the screening task and the acknowledgement.
Nothing calls them from a page.

- `/learn/coaches` — the audience page
- `/learn/coaches/apply` — the form
- `POST /api/learn/coach-application` — following the two-callers-one-core
  pattern in `api/learn/application.ts` so it works without JavaScript

**Unblocks:** the entire recruitment pipeline, which has an admin screen, an
assignment engine, safeguarding exclusion and collision detection — and no way
for anybody to enter it.

---

## 2 — Notifications: a surface, and a consumer

The biggest gap between tested and usable in the system. See
[domains/notifications.md](domains/notifications.md) §7.

- **A notification centre.** `myNotifications()` and `markRead()` are written,
  authorised by construction (they take no id and read the caller's own), and
  have no page. A member cannot read an in-app notification today.
- **A consumer for the event feed** that calls `notifyForEvent()`. Without it,
  the twelve-event allow-list describes what *would* be sent.
- **A line in `/api/cron/reconcile`** calling `deliverQueued()`.
- `queueHealth()` on an admin page, so a growing backlog is visible.

**Unblocks:** every "the federation will tell you" promise in the system.
**Blocked on the federation** only for email and SMS *delivery* — the in-app
channel needs nothing but the pages above.

---

## 3 — Write actions on the read-only surfaces

Four screens read and cannot write. Each is a small, well-scoped addition to a
module that already exists.

| Surface | Missing | Needs |
|---|---|---|
| `/admin/leads` | Status transition, owner assignment, notes | `engagement:write` and a POST endpoint |
| `/admin/workflows` | Retry a run, disable a definition | `sweepRetries()` exists; `workflow_definitions.active` is a column nothing writes |
| `/admin/audit` | Export for an external auditor | A CSV or signed-extract route |
| `/admin/fees` | Edit or delete a draft rule | `fees.ts` exposes no `updateRule` |

**Unblocks:** the federation acting on what it can already see.

---

## 4 — Web push, wired up

`src/lib/push.ts` is 1,386 lines of correct, tested RFC 8291 and RFC 8292 with
**zero callers**. The remaining work is entirely integration:

- a subscribe/unsubscribe API route
- a device and preference page (the preference model already exists)
- a `push` event handler in `public/sw.js`, which today handles caching only
- `deliverPushForNotifications()` on the cron

**Blocked on the federation:** VAPID keys — though
`generateVapidKeys()` exists for an operator to run once.

Ranked below item 2 deliberately: push is a *channel*, and a channel is worth
less than the notification centre it would be pushing people towards.

---

## 5 — The rest of the SEO landing pages

Three exist (`/karate-for-schools`, `/karate-for-corporates`,
`/karate-for-universities`). The directive lists twenty-two.

**Build only those where MMAKF genuinely provides the service**, each with
substantive content. `/karate-training`, `/karate-grading`,
`/karate-certification`, `/womens-self-defense`, `/childrens-karate` and
`/karate-seminars` are defensible.

**City pages are not**, until the federation confirms where it operates. PART BA
calls a page built to capture a keyword rather than to inform a reader a doorway
page, and `activityLocationGraph()` already refuses to emit location markup for
a unit that is not currently affiliated. Building city pages the schema builder
would refuse to describe would be the site contradicting itself.

See [domains/seo.md](domains/seo.md).

---

## 6 — Contracts

`contracts` is modelled. The quote → contract transition does not exist, and
neither does a surface. This is now the last fully-scaffolded domain with no
page in front of it, which is why it moves up.

---

## 7 — External calendar sync

`calendarConnections`, `calendarEvents` and `calendarSyncLog` exist. Needs
Google and Microsoft OAuth. MMAKF stays the system of record for MMAKF bookings;
external calendars mirror.

---

## 8 — The design system applied backwards

The tokens and components exist and the pages predating them do not use them.
This is now a defined piece of work rather than "a rebuild": the public pages
carry per-page `<style>` blocks and hard-coded values that the
[token scale](domains/design-system.md#1-the-tokens) now covers.

Still last, for the reason it was last before: every item above is a capability
the federation does not currently have, and pages that merely look dated come
after pages that do not exist.

---

## 9 — Seed the video register into the review queue — **SHIPPED 17 August 2026**

Recorded rather than deleted, because the shape of the miss is worth keeping.

**The seeder was never the missing part.** `seedTechnicalLibrary()` in
`src/db/library-seed.ts` was complete, idempotent and covered by
`tests/technical-library.test.ts` — and **nothing outside the test suite called
it.** No npm script, no route, no cron. The only process that had ever run it
was vitest, against a throwaway PGlite database deleted at the end of the run.

So the capability existed and the outcome did not: an operator could apply every
migration, deploy, open `/admin/technical-library`, find an empty queue, and have
nothing anywhere tell them which command they had missed. A seeder nobody can run
is a seeder that does not exist, however well tested it is — the same class of
defect as a page linked from nowhere, which this project has shipped before and
now checks for.

`scripts/seed-technical-library.mjs` closes it:

```
# The tables must exist first. The seed refuses an unmigrated database.
npm run db:migrate

# Count what is there. Writes nothing.
npm run library:status

# Apply the seed. Idempotent — safe to re-run.
npm run library:seed
```

Every line above is safe to paste as-is. An earlier version of this block put the
explanation on the same line as the command, and PowerShell duly tried to run the
explanation — reporting `writes` as an unknown cmdlet.

Verified against a **real Postgres over TCP**, not PGlite inside vitest:

| | |
|---|---|
| kata | 26 |
| techniques | 42 |
| kumite forms | 6 |
| technique/kata appearances | 145 |
| terms / aliases | 125 / 625 |
| citations | 95 |
| **media assets** | **121** |
| **review-queue links** | **59** |
| reference curriculum items | 123 |
| sport kumite provisions | 14 |

A second run produced **zero deltas on every table.**

It refuses two things rather than guessing: an unset `DATABASE_URL`, and an
unmigrated database — seeding an empty schema produces a wall of driver errors
that reads as a broken seeder rather than as a missing step.

**It carries a resolve hook, which is worth knowing before writing another
script like it.** `library-seed.ts` imports through the `@/` tsconfig alias, and
`src/db/schema.ts` re-exports with extensionless relative specifiers. Vite and
vitest resolve both; plain node resolves neither, and the failure names the
imported file rather than the missing resolver.

Post-seed state, which is the honest one: **121 assets at `rights = unknown`, 59
links at state `new`, 0 published.** Nothing reaches a learner until a named
reviewer decides both its rights and its technique.

---

## 10 — Rights decisions on the 51 held recordings

Not an engineering task. The complete 26-kata collection on skif.co.nz and the
Enoeda/Ohta demonstrations on colchesterjka.co.uk are the best technical
material the discovery pass found, and every one of them is a third-party
upload. The technical committee decides whether MMAKF cites them, embeds them,
or approaches the rights holders.

Queued here so it does not sit as an unowned data state forever. See
[technical/VIDEO-RIGHTS.md](technical/VIDEO-RIGHTS.md).

---

## Not queued, and why

| | |
|---|---|
| **HR module** | `hr:*` actions and `HR_OFFICER` exist; no tables. Needs the federation to say what it wants recorded before anything is designed. |
| **Participant and parent portals** | The institution portal now exists, so this is unblocked in principle — but it needs the federation to decide what a parent may see about a child, which is a privacy decision and not an engineering one. |
| **Network map / data visualisation** | Cosmetic until the register holds more than seven entries. |
| **Data export (CSV/XLSX/PDF)** | **In progress on another track at the time of writing** — `src/lib/export.ts`, `src/pages/api/export/[kind].ts` and two test files were in the working tree, uncommitted, on 14 August. The shape is the right one: a registry of kinds rather than a function per table, so permission, scope predicate and audit write cannot be forgotten on the seventh. **Not verified by this document** — when it lands, record it in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) with what it does not do (XLSX and PDF both need a dependency this codebase does not add). |
| **Visual regression testing** | There is none. `tests/accessibility.test.ts` and `tests/layout-guards.test.ts` analyse templates and stylesheets statically; nothing renders a page and compares pixels. Worth knowing before trusting a green suite about a layout. |

---

## Standing debt

- `drizzle.config.ts` points at `src/db/schema.ts` alone, so `drizzle-kit
  generate` sees one of ten schema files and would emit `DROP TABLE` for the
  other 117. Migrations are hand-written because of this. Either point it at all
  schema files or document the prohibition in the config itself.
- `drizzle/meta/*_snapshot.json` exists for 6 of 12 migrations. Harmless today
  (the runner sorts by filename and ignores the journal) but it means the
  drizzle tooling cannot be trusted here at all.
- **No email transport.** Messages render and queue correctly; nothing sends
  them.
- **`organizationGraph()` is not the single source of the organisation graph.**
  `src/layouts/Base.astro` emits its own copy on every page. The builder is
  tested and unused; two definitions can drift.
- **`DESIGN-SYSTEM.md` is stale on token values** — it records `--radius: 2px`
  against a current `10px`. Superseded by
  [domains/design-system.md](domains/design-system.md), but not yet corrected or
  withdrawn.
- **Two scratch scripts are committed at the repository root** —
  `scratch-clean.mjs` and `scratch-seed.mjs` are tracked by git
  (`review-seed.tmp.mjs` is correctly ignored by the `*.tmp.mjs` rule). They are
  outside `src/pages`, so they are not routes and `tests/layout-guards.test.ts`
  does not fail on them, but they are not part of the product either. Either
  move them under `scripts/` with a purpose stated, or delete them.

---

# Addendum — the marketplace queue

Added 17 August 2026, after migration 0029. Read the addendum in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) first: the marketplace
engine is built and tested, and **no surface was added**. That is the shape of
everything below.

Order matters. Each item unblocks the next.

## 1 — `/seller/apply` and the seller portal

**Why first.** `registerAsSeller()` is built, tested and unreachable. Until
there is a form, the marketplace has no sellers, and every item below has
nothing to operate on.

Needs: `/seller/apply`, then `/portal/seller/` — dashboard, products (with
variants), inventory, orders, returns, settlements, store profile, documents.
Every function is named in `docs/marketplace/`.

**Unblocks:** everything.

## 2 — The admin marketplace console

`sellerDossier()` returns the whole Seller 360 and nothing renders it.

Needs: `/admin/marketplace` (hub), `/marketplace/sellers`, `/sellers/[id]`
(the 360), `/commissions`, `/settlements`, `/disputes`, `/brands`,
`/moderation`.

**Unblocks:** approval, verification and every federation control. Without this
the federation cannot govern the marketplace at all, whatever the engine does.

## 3 — Commission configuration, then the first settlement

Once (2) exists: adopt the taxonomy, publish a commission schedule, set the SLA
windows, publish the seller agreement. Until then **every sale accrues a
`commission_gaps` row and no settlement can close** — which is correct, and
which is also a growing backlog.

See [MARKETPLACE-POLICY.md](marketplace/MARKETPLACE-POLICY.md) — ten decisions,
each with the exact function that records it.

## 4 — Public storefront and category routes

`publicStorefront()` and `publicListings()` are built. Needs
`/shop/seller/[slug]`, `/shop/category/[...path]`, `/shop/brand/[slug]`,
`/shop/product/[ref]`, with structured data and canonical URLs. Draft, rejected
and quarantined items must not be indexed — the predicate already excludes them
from the query, so this is a routing and metadata task, not a filtering one.

## 5 — Shipping configuration

Zones and methods exist and `checkout()` reads them. With no surface, every
seller resolves to **zero carriage** — they are absorbing it silently. This is
the highest-priority item that is quietly costing sellers money.

## 6 — Trust computation

`marketplace-trust.schema.ts` has the tables. Needs: review moderation queue,
`computeSellerPerformance()` writing snapshots, and the seller/product rating
roll-ups onto `sellers.ratingAvgBps`.

Note the constraint already in the schema: a score is **null** below a minimum
order count. A seller with two orders and one return does not have a 50% return
rate in any sense a human would defend.

## 7 — Payout provider adapter

`createPayout()` writes the instruction with a database-enforced idempotency
key; `markPayoutPaid()` is currently operated by hand. A provider adapter goes
behind the same abstraction as `src/lib/payments/`.

## 8 — Bulk product import pipeline

Staging tables exist. Needs the validate → preview → dedupe → category-map →
moderate → publish pipeline. Deliberately after (1) and (2): importing five
hundred products into a marketplace with no moderation console is how five
hundred unreviewed listings go live.

## 9 — Returns test coverage

`src/db/returns.ts` is the one module in 0029 with no test file. The inspection
arithmetic, the frozen eligibility and the refund ceiling are all enforced in
code and none is asserted. Should arrive with (1), since the flows become
reachable then.

## Deferred deliberately

**Seller API and webhooks.** The brief says "eventually support". Building a
catalogue/inventory/order API before any seller has used the portal would be
designing an integration surface against no usage at all.
