# Implementation queue

What to build next, in order, and why that order. **Updated 5 September 2026.**

Read [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) first — it says what
exists. This file says what does not, and what each item unblocks.

> **A warning about this file, earned on 5 September 2026.** It had drifted in
> BOTH directions. Item 1 was recorded as unbuilt and had shipped; item 3 named
> four missing capabilities of which two existed already, one of them complete
> and merely unreachable; item 2's last bullet asked for a function that had been
> superseded and should not be surfaced. Work was nearly done twice and a real
> defect sat inside an entry that read as a small addition.
>
> **Verify every claim here against the source before acting on it.** Where an
> entry has been checked, the check is now recorded in it.


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

Item 1 (the coach application form) **has since shipped** — see the entry
below, which was stale until 5 September 2026.

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

## 0a, 0b, 0c — SHIPPED 17 August 2026

All three identity surfaces are built. Recorded here rather than deleted,
because a queue that quietly loses its history cannot be checked against what it
promised.

| Was | Now |
|---|---|
| 0a — a registration step collecting a structured address | **Built.** `LOCATION_FIELDS` in `lib/registration.ts`, rendered through `isOffered()` so an empty register produces no empty select, and `/api/geography/resolve` behind the cascade. Ambiguity is returned to the form as a CHOICE (`locality_ambiguous`), never resolved silently. |
| 0b — screens for the identity queues | **Built.** `/admin/duplicates` and `/admin/profile-changes`, both scope-filtered in SQL, both demanding a reason, both surfacing the module's refusals as sentences rather than 500s. |
| 0c — guardian and parent surfaces | **Built.** `/my/family`, which takes no identifier and puts every field behind its own `guardianCan()` call. |

Plus, unqueued but in the same wave: twelve domain event types and their
producers, closing the EVENT link `SYSTEM-WIRING-MATRIX.md` §2.22 recorded as
absent.

---

## 0d, 0e — SHIPPED 17 August 2026

| Was | Now |
|---|---|
| 0d — registration must actually create a person | **Built.** `src/db/provisioning.ts` → `provisionFromRegistration()`, called from the approval path in `api/queue/decide.ts`. Person, address, contacts, consent, guardian claim and duplicate detection, all idempotent. 26 tests. |
| 0e — granting a guardian capability has no screen | **Built.** `/admin/guardianships`, gated on `guardian:verify`, with the double gate on the medical and safeguarding capabilities both enforced and *stated*. 21 tests. |

### Two things 0d turned up that were worse than the gap itself

- **`DecisionResult` never had a `record` field.** `api/queue/decide.ts` had been
  reading `(result as any).record` to find the person a membership should be
  issued to since the day it was written. It was `undefined` on every request, so
  the approval path always took its *"this application carries no linked person
  record — link it to a person and re-run"* branch. **No membership had ever been
  issued by that route**, and the message told the office to perform an action
  nothing in the system could perform. `src/lib/queue.ts` now returns the decided
  row, and `decide.ts` destructures it out of the response — it is the
  applicant's name, date of birth, email and address, and three response bodies
  were built by spreading that object.
- **Consent needed a version and MMAKF has published no policy.**
  `consent_records.policy_version` is NOT NULL. Writing `'1.0'` would have minted
  a federation instrument in a migration. It records
  `wording:<digest of the sentence the applicant saw>` instead, prefixed so
  nobody mistakes it for a published policy reference, and derived from the
  `CONSENTS` array so the wording and the version cannot drift.

Also: a minor's guardian consent is recorded with capacity **`staff`**, not
`guardian`. `recordConsent()` checks `guardianCan('give_consent')` and would
refuse — correctly, since the relationship is only asserted. What actually
happened is that the office recorded a ticked box in which somebody *claimed* to
be the guardian, and that is what the row says, with the claim kept as evidence.

---

## 0f — What 0d exposed next: nothing consumes the events, and no fee is charged

Registration now reaches the register. Two joints downstream are still open, and
neither is a defect in this wave so much as the next link in the chain:

- **No consumer reacts to the twelve identity events.** They are published and
  nothing walks the feed. Same gap as queue item 2, now with more producers.
- **An approved registration issues a membership only for the three issuable
  categories** (`instructor`, `dojo`, `official`) and takes no money at any
  point. Whether registration should cost anything is a federation decision, and
  the fee framework ships empty — so this is correct today and will need revisiting
  the day MMAKF publishes a fee.
- **`verifyContact()` has no caller.** Contacts are created unverified, as they
  should be, and there is no email or SMS transport to verify them through. Until
  there is, every contact in the register stays honestly unproven.

---

## What 0d and 0e said before they shipped

Kept verbatim rather than deleted, because a queue that loses its history
cannot be checked against what it promised — and because the 0d entry is the
clearest statement of the break that had made the whole identity foundation
unreachable.

> **0d — Registration must actually create a person.**
> `src/pages/api/register.ts` queues an application to a Redis list.
> `createPersonForSource()` in `src/db/federation.ts` is written, tested, and
> has **no caller anywhere in `src/`**. So no membership application has ever
> become a `persons` row by any automatic path. The structured address and the
> contacts are captured onto the application record and stop there, because
> there is no person to hang a `person_addresses` or `person_contacts` row
> from. The same is true of `detectPersonDuplicates()`, which takes a
> `personId`.
>
> **0e — Granting a guardian capability has no screen.**
> `/my/family` reads `guardianCan()` correctly and will show a verified
> guardianship holding **nothing**, because `grantGuardianCapability()` is
> gated on `guardian:verify` and no admin surface calls it.

Both shipped on 17 August 2026 — see the entries above for what was built, and
for the two defects 0d turned up that were worse than the gap itself.

---

## 1 — Coach application form — **SHIPPED**, and this entry was stale

Verified against the source on 5 September 2026, not against this document.

`src/pages/learn/coaches.astro` carries the audience page **and** the form, with
its own POST handler, and `src/pages/api/learn/coach-application.ts` follows the
two-callers-one-core pattern the entry asked for — `submitCoachApplication()` is
the core, and both the JSON route and the page's form post reach it, so it works
with scripting off.

It is linked from `src/lib/surface.ts` (the learn navigation), `/learn`, `/start`
and the command palette, so all three legs are landed: the code exists,
something calls it, and a person can reach it.

**One deviation from the entry, and it is the better shape.** There is no
separate `/learn/coaches/apply`. The form is a section of the audience page, so
somebody reading what applying involves does not have to navigate to do it.

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
- ~~`queueHealth()` on an admin page~~ — **withdrawn.** Superseded by
  `deliveryOverview()`, which `/admin/notifications` already calls and which is
  scope-aware where `queueHealth()` is not. See the note below item 4.

**Unblocks:** every "the federation will tell you" promise in the system.
**Blocked on the federation** only for email and SMS *delivery* — the in-app
channel needs nothing but the pages above.

---

## 3 — Write actions on the read-only surfaces — **SHIPPED 5 September 2026**

Recorded rather than deleted, on this file's own rule. **Only two of the four
were the thing this entry said they were**, and the gap between the entry and
the source is the most useful part of the record.

| Was | What was actually there | Now |
|---|---|---|
| `/admin/leads` — status transition, owner assignment, notes | Correct, and worse than stated: the page had **no POST handler at all**, and `src/db/engagement.ts` exposed **no function that could move a lead**. `captureLead()` set the status on the way in and `identifyLead()` nudged `new` → `qualifying` as a side effect; that was the whole of it. The nine-column pipeline strip was, in practice, one column. | **Built.** `setLeadStatus()`, `assignLeadOwner()`, `addLeadActivity()` in `engagement.ts`, and the acts on the page. |
| `/admin/workflows` — retry a run, disable a definition | Correct. The POST handled `install-standard` and nothing else. | **Built.** `requeueRun()` and `setDefinitionActive()` in `src/lib/workflow.ts`. |
| `/admin/audit` — export for an external auditor | **Wrong.** `audit-events` had been a registered kind in `src/lib/export.ts` since the registry was written — gated, column-listed, with `actor_ip_hash` deliberately withheld — and served at `/api/export/audit-events`. Nothing was missing except **a link**. | **Reachable.** The page now offers CSV and JSON. |
| `/admin/fees` — edit or delete a draft rule | **Wrong, and it mattered.** Both acts were implemented INLINE on the page, with a correctly correlated draft-only condition. `fees.ts` exposing no `updateRule` was true and was not the defect. See below. | **Moved into the module, and a hole closed.** |

### The fee-rule edit could be used to walk around the student-charge refusal

The one finding here that was not a missing feature.

`addRule()` refuses a rule that charges a student for being a student, and its
own comment states the reasoning: *"a rule that cannot be created cannot be
displayed, exported, cloned, quoted, invoiced or seeded"*. The clone path was
routed through `addRule()` precisely so that a clone could not smuggle one
across.

**The edit path was not.** `/admin/fees` wrote the row itself with
`db().update()` and called `classifyFeeRule()` nowhere. So the refusal could be
walked around in two steps: add a legitimate rule, then edit it into a student
charge. Nothing anywhere refused the second act.

`updateRule()` classifies the **merged** row — the stored rule with the patch
applied — rather than the fields that arrived, because the offending
combination is routinely spread across the two. `tests/admin-write-actions.test.ts`
proves this with a split where the stored row is permitted, the patch is
permitted, and the merge is refused; a classifier seeing only the patch would
allow it.

Two smaller things came with it. `code` is no longer editable, because a quote
line records `ruleCode` as text beside `ruleId` and renaming makes an issued
quotation disagree with itself. And `deleteRule()` refuses a rule any quote line
was computed from — impossible while the framework is a draft, which is an
argument about the rest of the system rather than a constraint, and without the
check the day it is wrong produces a driver's foreign-key violation rendered as
a 500.

Both module functions carry the draft-only condition **inside the write
statement**, not only in a prior read: the classifier forces a read-before-write,
and `/admin/fees` can publish the framework from another tab in between.

43 tests in `tests/admin-write-actions.test.ts`.

### Still open on these four

- `identifyLead()` asserts `engagement:write` with an **empty scope object**, so
  it checks only that the caller holds the action somewhere — a district
  administrator can identify a lead belonging to another district. The three new
  functions re-derive scope from the stored lead, as `leadDetail()` does. The old
  behaviour is left alone rather than narrowed silently, because changing it
  changes who can do something that has been permitted since it was written.
  **A decision, not an oversight to fix in passing.**
- The audit extract is national-only, and correctly: the kind declares an empty
  scope map because an audit row records who did what and not where the subject
  sat. A scoped holder is refused by name rather than handed a file filtered to
  nothing.

---

## 4 — Web push, wired up — **SHIPPED 5 September 2026**

The entry said "zero callers". That was nearly right: `pushStatus()` was
imported by `/admin/notifications` and `deliverQueuedPush()` by the reconcile
cron, and **nothing else in 1,386 tested lines was reachable by anybody**. The
federation had a push transport that could deliver to nobody, because no page
let a member register a device.

| Was | Now |
|---|---|
| a subscribe/unsubscribe API route | **Built.** `src/pages/api/push/[...action].ts` — `subscribe`, `unsubscribe`, `preference`, `test`, plus `config`, `devices`, `preferences` reads. Every action is one call into the module; no authorisation, preference logic or topic list is restated at the edge. |
| a device and preference page | **Built.** `/my/devices`, linked from `/my`, from the inbox, and from the command palette. |
| a `push` event handler in `public/sw.js` | **Built**, with `notificationclick` and `pushsubscriptionchange`. |
| `deliverPushForNotifications()` on the cron | **Already there** — step 6 of `/api/cron/reconcile`, closed by the scheduling wave. |

**No migration.** `push_devices` and `notification_preferences` were already in
`src/db/engagement.schema.ts`. The whole item was wiring.

### The half that is not about push at all

`notification_preferences` governs **four** channels, and in-app and email both
work today. Until `/my/devices` existed no member could see or change any of
them, so every member was held to whatever the column defaults happened to be.
That half needs no VAPID key and is live now.

### What is still true about the keys

`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are unset, so `pushStatus().configured`
is false and `vapidPublicKey()` returns null. The page therefore ships with **no
subscribe control at all** — absent, not disabled, the same posture as
`/portal/seller/documents` under an unset `UPLOAD_STORAGE_URL`. `generateVapidKeys()`
exists for an operator to run once; the day both variables are set, the control
appears with no code change.

The device half is the one piece of this codebase that is **deliberately
JavaScript-only**, against the house rule that a form posts to its page so it
works with scripting off. A subscription is created by `PushManager.subscribe()`,
which is where the endpoint and the two encryption keys come from; a no-JS
fallback would be a form that could only ever submit nothing. Preferences post
to the page as an ordinary form and are unaffected.

`tests/push-surface.test.ts` (25) asserts the **wiring** rather than the
behaviour — `tests/push.test.ts` owns the cryptography. It exists because the
unit tests passed the whole time the capability was unreachable: a unit test
calls the function directly, which is exactly what the product could not do.

---

## 2 — the last line of it was wrong

`queueHealth()` on an admin page is **not work**, and the line should not have
survived this long. `deliveryOverview()` in `src/db/notifications-inbox.ts` is a
scope-aware superset of it — same status counts, same `oldestQueued`, plus
failures and reach — and `/admin/notifications` has called it for some time.

`queueHealth()` asserts `content:read` and applies **no scope predicate at all**,
so wiring it into a page would put a second backlog readout on the admin surface
that discloses one institution's counts to another. `SYSTEM-WIRING-MATRIX.md`
already records it under *"Superseded and now unused"*; this file did not.
Retire it or leave it, but do not surface it.

The rest of item 2 shipped earlier: `/my/notifications` exists, and
`/api/cron/reconcile` calls `notifyForEvent()`, `deliverQueued()` and
`deliverQueuedPush()`.

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

Updated 23 August 2026. The first version of this addendum listed nine items and
the second listed seven more; **all of them have now shipped**, and every one is
recorded below rather than deleted, because a queue that quietly loses its
history cannot be checked against what was promised.

What remains open is not engineering. It is the list of decisions only the
federation can make — commission rates, SLA windows, return periods, the text of
a seller agreement — which is
[marketplace/MARKETPLACE-POLICY.md](marketplace/MARKETPLACE-POLICY.md), plus the
one deployment gap named under item 7.

| Was | Now |
|---|---|
| 1 — `/seller/apply` and the seller portal | **Built.** `/seller/apply`, and `/portal/seller` × 4 pages. |
| 2 — The admin marketplace console | **Built.** `/admin/marketplace` with six queues, `/[id]` Seller 360, commissions, settlements. |
| 4 — Public storefront | **Built.** `/shop/seller/[slug]`, `/shop/product/[ref]`, `/shop/category/[...path]` and `/shop/brand/[slug]`. |
| 6 — Trust computation | **Built.** `src/db/marketplace-trust.ts` — reviews, moderation, rating roll-ups, performance snapshots, fraud review. |
| 9 — Returns test coverage | **Built.** `tests/marketplace-returns.test.ts`, 27 tests. |
| 3 — Commission configuration | **Reachable.** The screens exist; the DECISIONS remain MMAKF's. See [MARKETPLACE-POLICY.md](marketplace/MARKETPLACE-POLICY.md). |

---

## CLOSED — items 1 to 7, 23 August 2026

All seven shipped. Recorded rather than deleted, because the reason each existed
is the reason it must not come back.

- **1. Shipping zone configuration** — CLOSED. `src/db/shipping.ts` and
  `/portal/seller/shipping`. `matchZone()` / `priceMethod()` / `quoteCarriage()`
  are **one implementation** used by both the seller's preview and `checkout()`,
  so a seller cannot be quoted one figure and charged another. A seller with no
  zone still absorbs carriage — unchanged, and deliberate — but
  `carriageExposure()` now counts the absorbed orders. It reports **no rupee
  figure**, because MMAKF does not know what a parcel costs to send.
- **2. Category landing pages and marketplace search** — CLOSED.
  `src/db/marketplace-browse.ts`, `/shop/category/[...path]` and
  `/shop/brand/[slug]`, 47 tests. Every public query interpolates
  `publicListingPredicate()` itself rather than re-stating its conditions — the
  bug that made this necessary was `myListings()` hand-copying three of the five.
  The brief's "beginner / competition / training" filters are **absent, not
  disabled**: no column backs them, and a filter that silently matches nothing
  is worse than one that is not offered.
- **3. Bulk product import pipeline** — CLOSED. `src/db/product-import.ts`,
  `/portal/seller/import`, 39 tests, four API actions. Four acts and not one:
  rows land in a staging table, are validated and deduplicated *there*, and
  `import/submit` creates **drafts only**, into the same moderation queue a
  hand-typed item goes through. CSV is parsed in the browser; the server
  validates meaning, not format.
- **4. Payout provider adapter** — CLOSED. `src/lib/payouts/` behind the same
  abstraction as `src/lib/payments/`, plus `sendPayoutThroughProvider()` and
  `refreshPayoutFromProvider()`, 55 tests. **A send never writes `paid`** — an
  accepted instruction is a promise to try, and only the provider's own answer
  moves the row. The RazorpayX adapter answers `isConfigured() === false` **even
  with correct credentials** until `RAZORPAYX_VERIFIED=true`, and
  `mapPayoutStatus()` maps nothing until the vocabulary is confirmed against the
  live API.
- **5. Policy document authoring** — CLOSED. `src/db/marketplace-policy.ts`.
  Still ships **no policy text** — `registerPolicies()` creates the eight names
  the enum already carries, and a name is not content. An acceptance points at a
  version and stores that version's body hash on itself, so a published body
  edited in place stops verifying.
- **6. Notifications for marketplace events** — CLOSED.
  `src/db/marketplace-events.ts`, 21 catalogue entries, 14 notifiable, two new
  audiences, 25 tests. See the floor rule in
  [marketplace/MARKETPLACE-ARCHITECTURE.md](marketplace/MARKETPLACE-ARCHITECTURE.md):
  a notifiable event above `member` is silently never delivered, because the
  drain is capped there and `consume()` steps over the rest without erroring.
- **7. Verification document upload** — CLOSED as far as it honestly can be.
  `src/db/seller-documents.ts` and `/portal/seller/documents`, with
  `seller_verification` added to `src/lib/uploads.ts` at classification
  `restricted`. The storage key never appears in a list response or an audit
  row, and resolving one needs `marketplace:verify` — `marketplace:read` is not
  enough. **The upload control itself is still absent**, because
  `UPLOAD_STORAGE_URL` is not configured on this deployment and a control that
  cannot store a file is a fake feature.

## Deferred deliberately

**Seller API and webhooks.** The brief says "eventually support". Designing an
integration surface before any seller has used the portal would be designing
against no usage at all.

---

## Scheduling queue — CLOSED items, 17 August 2026 (evening)

Items 1, 2, 4 and 8 above are done. Recorded here rather than deleted, because
the reason each existed is the reason it must not come back.

- **1. No API route** — CLOSED. `src/pages/api/schedules/[...action].ts`, 15
  actions, 22 tests. GET public and draft-proof; POST authenticated with the
  module's own scope check and no second authorisation model.
- **2. `SCHEDULE_CHANGED` orphan** — CLOSED by retirement. It duplicated
  `CLASS_SESSION_CANCELLED` / `CLASS_SESSION_RESCHEDULED`, which have producers,
  a consumer and resolvable audiences. Tombstone comment left in the catalogue.
- **4. Batch resolution limited to one day** — CLOSED. `directoryRange()` and the
  `directory-range` read, capped at 14 days, with a stated per-club standing so
  "closed all weekend" and "has published nothing" cannot be conflated.
- **8. `deliverQueuedPush()` uncalled** — CLOSED. Step 6 of the reconcile cron.

## Still open

- **5. No published-week materialisation.** Twelve queries per register render,
  uncached. Correct and bounded. The lever if the register grows past a few
  hundred clubs; invalidated on `SCHEDULE_PUBLISHED`, which now has a live
  consumer path to hang it on.
- **6. Only the headquarters has schedule rows.** Federation data entry through
  `/admin/schedules`. The self-service onboarding wizard (location → operating
  days → hours → seasons → classes → coaches → exceptions → preview → publish)
  does not exist.
- **3. Club-level schedule change notifies no wider audience.** BLOCKED, not
  skipped: "everyone who trains at this club" is not a query this system can
  answer honestly. Needs queryable club membership first. Do not invent the
  audience.
- **Venue-scoped and class-scoped batch resolution.** `directoryDay()` and
  `directoryRange()` cover dojo scope. A room-level or class-level directory
  would need the same treatment; nothing asks for it yet.

---

## Scheduling queue — 17 August 2026 (late)

### CLOSED

- **Club-level notification.** Recorded here twice as "blocked on queryable club
  membership". **That was wrong and the correction matters:** `persons.dojoId`
  makes "everyone who trains at this club" a QUERY, `NOTIFIABLE.SCHEDULE_PUBLISHED`
  is addressed to `unit_members`, and `resolveRecipients()` implements it. Proven
  end to end by `tests/club-notification.test.ts` (8 tests): two members of a club
  get inbox rows, a member of another club gets none, a person who has left gets
  none, repeat drains do not duplicate, and a state or national publication
  reaches **nobody** — that last one being a deliberate refusal, now asserted
  rather than assumed.
- **Onboarding wizard.** `/admin/schedules/start` + `src/lib/week-form.ts`.
  See [docs/scheduling/README.md](scheduling/README.md#onboarding-the-first-week-a-club-publishes).

### Still open

- **No published-week materialisation.** Twelve queries per register render,
  uncached — correct and bounded. **Deliberately not built:** it needs a new
  table, which needs a migration plus the companion `*_data_api_lockdown.sql`
  every table-adding migration requires, in a directory a parallel workstream is
  actively numbering. The trigger to build it is a register in the hundreds of
  clubs, and `SCHEDULE_PUBLISHED` now has a live consumer path to hang the
  invalidation on.
- **Only the headquarters has schedule rows in production.** No longer an
  engineering gap — the wizard is the answer, and it is data entry now.
- **Venue-scoped and class-scoped batch resolution.** Nothing asks for it yet.


---

## Marketplace queue — CLOSED items, 23 August 2026

Items 1 through 7 of the marketplace addendum above are done. Recorded rather
than deleted, on the same rule the rest of this file follows: a queue that
quietly loses its history cannot be checked against what was promised.

| Was | Now |
|---|---|
| 1 — Shipping zone configuration | **Built.** `src/db/shipping.ts`, `/portal/seller/shipping`, 29 tests. `matchZone()` / `priceMethod()` / `quoteCarriage()` are one implementation used by both the seller's preview and `checkout()`, so the quote a seller is shown is the quote a buyer is charged. |
| 2 — Category landing pages and search | **Built.** `src/db/marketplace-browse.ts`, `/shop/category/[...path]` and `/shop/brand/[slug]`, 47 tests. |
| 3 — Bulk product import pipeline | **Built.** `src/db/product-import.ts`, `/portal/seller/import`, 39 tests, four API actions. Creates **drafts only**, into the same moderation queue a hand-typed item goes through. |
| 4 — Payout provider adapter | **Built, and refuses to send.** `src/lib/payouts/` behind the same abstraction as `src/lib/payments/`, 55 tests. See the caveat below — this one is not what "built" usually means. |
| 5 — Policy document authoring | **Built.** `src/db/marketplace-policy.ts`, 25 tests (shared suite with documents). Versions, publication, seller acceptance against a version, and the body hash stored twice so a tampered version is detectable. The eight documents still ship with **no text**, by design. |
| 6 — Notifications for marketplace events | **Built.** `src/db/marketplace-events.ts` with 21 producers, 21 catalogue entries, 14 `NOTIFIABLE` entries, two new audiences, 25 tests. |
| 7 — Verification document upload | **Built and gated.** `src/db/seller-documents.ts` and `/portal/seller/documents`. The storage key never appears in a list or an audit row; resolving one needs `marketplace:verify`. **There is still no upload control**, because `UPLOAD_STORAGE_URL` is unset — see below. |

### Three of these are not finished in the way the word usually means

Recorded plainly, because a reader skimming the table above would otherwise
believe three things that are not true.

**The payout rail refuses to send.** `src/lib/payouts/razorpayx.ts` answers
`isConfigured() === false` **even with correct credentials**, until somebody
sets `RAZORPAYX_VERIFIED=true` having tested a transfer end to end.
`mapPayoutStatus()` maps nothing at all, deliberately, until the provider's
status vocabulary is confirmed against its documentation rather than guessed —
a wrong mapping here writes "paid" against money that never moved. So
`payout/send` reports that no rail can send and refuses; payouts are still
recorded by hand through `payout/paid`. That is the intended state, not an
oversight, and it is why `sendPayoutThroughProvider()` never writes `'paid'`
itself: an accepted instruction is a promise to try.

**There is no upload control.** `UPLOAD_STORAGE_URL` is unset, so no file can be
attached to anything anywhere on the platform. The documents slice is built,
tested and permission-gated; the control is *absent* rather than present and
disabled, because a button that cannot work teaches a seller their evidence was
received.

**No commission is configured.** Every screen exists. A sale MMAKF has published
no commission for records a `commission_gaps` row, keeps `commissionMinor` NULL
rather than 0, and blocks the settlement. The decisions remain the federation's.

### Still deferred

**Seller API and webhooks.** Unchanged: the brief says "eventually support", and
designing an integration surface before any seller has used the portal would be
designing against no usage at all.

**Federation-facing notices.** The marketplace events above `member` — payout
instructions, settlement blocks, payment mismatches, fraud signals — sit on the
feed and no consumer delivers them, because the only one draining it is capped
at `member`. `ADMIN_NOTICES_NOT_WIRED` in `src/db/marketplace-events.ts` says so
rather than a second consumer being invented so the matrix could show a tick.

---

# Federation team and credential registers — 6 September 2026

## SHIPPED — the establishment, and the Black Belt register

| Was absent | Now |
|---|---|
| Nowhere to record who runs the federation | `departments` + `team_appointments` (migration 0056), `src/db/team.ts`, `/team`, `/admin/team`. Every row hangs off `persons.id`; there is no second name column. |
| A Black Belt register | `/black-belts`, derived from active Dan rank records via `blackBeltRegister()`. Filterable; facets derived from the rows that exist. |
| `publicRegister()` had no caller and a wrong docstring | Docstring corrected in place; behaviour left alone deliberately. Still has no caller — `blackBeltRegister()` is the new read. |

46 tests. `npx astro build` exits 0. Navigation, live-routes and accessibility
suites re-run at 495 passing **after** the pages were added — the discipline that
stopped `/learn/coaches` shipping as a 404 behind a menu entry a third time.

## 11 — A person cannot see their own appointment

**The most uncomfortable gap this wave opened.** `/team` publishes a real
person's name, photograph and biography on the public internet, and that person
has no page in this system on which to see it, check it, or ask for a correction.

`personRelationships()` in `src/db/team.ts` already gathers every relationship
one `persons` row holds — appointments, ranks, instructor qualifications,
memberships — under a single record. It is called by `/admin/team` and by nothing
a member can reach.

What is needed: `/my/appointments` (or a section on `/my`), resolving the person
from the caller's own binding and **never** from a query parameter — the rule
`/learn/portal` already follows. A correction request should reuse
`profile_change_requests`, which exists and is decided on `/admin/profile-changes`,
rather than minting a second review queue.

**Unblocks:** the honest version of §2's "public contact route where appropriate".
Right now the only person who can check what the federation says about somebody is
an administrator.

## 12 — Nobody is told they were published

The six `TEAM_APPOINTMENT_*` events are on the feed and nothing walks it. This is
**queue item 2 again**, now with six more producers, and it is the reason item 2
should be read as the highest-value item in this file rather than a tidy-up.

The specific act worth naming: `publishAppointment()` puts a named private
individual's face on www.mmakf.in and sends them nothing. Whatever the fan-out
ends up being, this is one of the events that most obviously needs it.

**Do not** solve this by lowering `TEAM_APPOINTMENT_SUSPENDED` from `restricted`
to reach a consumer capped lower. That floor is load-bearing — see the catalogue
note and Addendum VI of the wiring matrix.

## 13 — Structured data for the two new public pages

`/team` and `/black-belts` emit none, and `src/lib/seo.ts` was not touched.

§28 asks for structured data "only where truthful", and the truthful version needs
a decision nobody has taken: does MMAKF assert `schema.org/Person` entities for
its staff and its Dan grades publicly, with what identifiers? Emitting
`Organization` + `member` without that decision would publish a machine-readable
claim about named individuals that the federation has not agreed to make.

Recorded rather than guessed.

## 14 — `/people` and `/team` overlap, and neither should just be deleted

`/people` reads `get('leadership')` from the content store — an editorial page
about technical leadership. `/team` is a derived register of the operation. They
will show some of the same faces.

Collapsing them means deciding which people belong where, which is MMAKF's call
and not a developer's: doing it in code would move real names between public
pages on a judgement nobody at the federation made. What is needed first is the
federation stating whether technical leadership is an editorial page or a
register.

## 15 — No org chart

`departments.parent_id` is self-referencing and cycle-checked in
`setDepartmentParent()`. Nothing renders a hierarchy: `/team` groups by
`org_level`, which is flat. The data supports a tree the moment anybody wants one.

## Not queued, and why — additions

**A public list of withdrawn Dan grades.** A revoked grade vanishes from
`/black-belts` and is not republished as revoked. `/verify` answers the specific
question, with the reason. Publishing a browsable register of the disgraced is a
decision with real consequences for real people and MMAKF has published no policy
on it, so the register carries a standing note explaining that absence proves
nothing, and stops there.

**A discipline filter on the Black Belt register.** `rank_records` has no
discipline column and MMAKF grades one syllabus. A control that always returns
everything teaches a reader the register holds distinctions it does not.

**HR data on `team_appointments`.** Migration 0056 gives it nowhere to sit, and a
test fails on any column whose name contains one of thirteen forbidden strings.
The HR module (PART X) is still NOT STARTED and gets its own tables, its own
lockdown and `hr:*` when it arrives. It must not be built on top of `team:*`.
