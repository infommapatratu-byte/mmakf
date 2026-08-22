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

## ~~0d — Registration must actually create a person~~ (shipped — kept for the record)

**The gap the wave above exposed rather than closed, and the reason 0a is only
half of what it looks like.**

`src/pages/api/register.ts` queues an application to a Redis list.
`createPersonForSource()` in `src/db/federation.ts` is written, tested, and has
**no caller anywhere in `src/`**. So no membership application has ever become a
`persons` row by any automatic path.

The consequence for the identity foundation specifically: the structured address
and the verified contacts are captured onto the application record and stop
there, because there is no person to hang a `person_addresses` or
`person_contacts` row from. The same is true of `detectPersonDuplicates()`,
which takes a `personId`.

- an approval path on the membership queue that calls `createPersonForSource()`
- then `setPersonAddress()` and `addContact()` from what the application carried
- then `detectPersonDuplicates()`, which RAISES and must never block
- the consent given at registration written through `recordConsent()` with the
  policy version it was given against

**Unblocks:** everything the identity foundation was built for. Until this
exists, `person_contacts`, `person_addresses` and `duplicate_candidates` can
only be populated by hand.

---

## 0e — Granting a guardian capability has no screen

`/my/family` reads `guardianCan()` correctly and will show a verified
guardianship holding **nothing**, because `grantGuardianCapability()` is gated on
`guardian:verify` and no admin surface calls it.

- an admin screen to verify a claimed relationship and grant capabilities one at
  a time
- it must respect the double gate: `view_medical` and `view_safeguarding` need
  `medical:read` / `safeguarding:write` ON TOP of `guardian:verify`

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

Updated 17 August 2026, after the surfaces were built. The previous version of
this addendum listed nine items; six have shipped and are recorded below rather
than deleted, because a queue that quietly loses its history cannot be checked
against what was promised.

| Was | Now |
|---|---|
| 1 — `/seller/apply` and the seller portal | **Built.** `/seller/apply`, and `/portal/seller` × 4 pages. |
| 2 — The admin marketplace console | **Built.** `/admin/marketplace` with six queues, `/[id]` Seller 360, commissions, settlements. |
| 4 — Public storefront | **Partly.** `/shop/seller/[slug]` and `/shop/product/[ref]` built. Category landing pages are not — see item 2 below. |
| 6 — Trust computation | **Built.** `src/db/marketplace-trust.ts` — reviews, moderation, rating roll-ups, performance snapshots, fraud review. |
| 9 — Returns test coverage | **Built.** `tests/marketplace-returns.test.ts`, 27 tests. |
| 3 — Commission configuration | **Reachable.** The screens exist; the DECISIONS remain MMAKF's. See [MARKETPLACE-POLICY.md](marketplace/MARKETPLACE-POLICY.md). |

---

## 1 — Shipping zone configuration

**The highest-priority gap, and it is costing money now.**

`shipping_zones` and `shipping_methods` exist and `checkout()` reads them. There
is no seller surface to create one, so `resolveShipping()` finds no zone and
returns **zero**. Every seller on the marketplace is currently absorbing
carriage silently.

Needs: a section on `/portal/seller` — zone by states and postcode prefixes,
methods with a kind and a price. `return-policy/set` is already wired; this is
the same shape.

## 2 — Category landing pages and marketplace search

`/shop/category/[...path]` does not exist, so an adopted taxonomy has nowhere to
be browsed. `marketplace_categories.path` is a materialised ancestry, so a
subtree is one prefix match.

Also: the filters the brief names — Shotokan, kata, kumite, beginner,
competition, children, adults — map onto `listings.discipline`,
`shotokanRelevant` and `ageMinYears`, all of which are populated and none of
which is searchable yet.

## 3 — Bulk product import pipeline

Staging tables exist. Needs validate → preview → dedupe → category-map →
moderate → publish. Deliberately after (1) and (2): importing five hundred
products into a marketplace whose categories cannot be browsed is five hundred
items nobody will find.

## 4 — Payout provider adapter

`createPayout()` writes the instruction with a database-enforced idempotency
key; `markPayoutPaid()` is operated by hand from `/admin/marketplace/settlements`.
An adapter goes behind the same abstraction as `src/lib/payments/`.

## 5 — Policy document authoring

`marketplace_policies` and `policy_versions` ship empty **by design** — see
MARKETPLACE-POLICY.md. What is missing is the surface to publish a version and
record seller acceptance against it.

## 6 — Notifications for marketplace events

The brief lists them per audience — seller, buyer, admin. `domain_events` and
`notification_deliveries` exist; nothing publishes a marketplace event yet.

## 7 — Verification document upload

`seller_documents` exists and `sellerDossier()` reads it. There is no upload
control on `/seller/apply` or the seller portal, so verification currently rests
on evidence supplied out of band. `src/lib/uploads.ts` and `src/lib/storage.ts`
are the existing path.

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
