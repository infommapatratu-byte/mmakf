# Implementation status

**Honest accounting, updated 14 August 2026.**

This file exists because the question was asked directly — *"have you implemented
this prompt fully or again summarised?"* — and the answer then was "about half",
after a period of describing the work in a way that blurred that.

So: what is built, what is scaffolded, and what is not started. A row saying
BUILT means it has tests and has been exercised against a real Postgres or a real
HTTP request. Nothing is marked BUILT because a page or a table exists.

---

## Numbers

Re-counted on 16 August 2026 by running the commands, not by reading a previous
version of this file.

**This table has now been found stale twice.** The second time, an independent
audit re-counted and found it claiming 73 test files against 77 actual, along
with eight other stale or silent entries. That is worth recording rather than
quietly correcting, because it is the specific failure this document exists to
prevent: a status file that is wrong is worse than no status file, since it is
believed.

Every figure below came from one of these, run just now:

```
ls tests/*.test.ts | wc -l              96 files
npx vitest run                          3,319 passing, 2 expected fail
ls drizzle/*.sql | wc -l                35 migrations
grep -h 'CREATE TABLE' drizzle/* | wc -l  269 tables
find src/pages -type f | wc -l          142 route files
find src/pages/admin -name '*.astro'    33 admin surfaces
```

Re-run them before citing a number from here.

## PRODUCTION STATE, WHICH IS NOT THE SAME AS THIS REPOSITORY

| | |
|---|---|
| Production commit | `eee2319`, verified from `/api/health` on all three hosts |
| `www.mmakf.in` | serves the public federation ✅ |
| `learn.mmakf.in` | serves the training platform ✅ (served the public homepage until 16 Aug) |
| `admin.mmakf.in` | serves the operations console ✅ (same) |
| Database | **`not_configured`** — the runtime receives no `DATABASE_URL` |
| Migrations in production | **NONE APPLIED.** No table exists in the production database. |

The gap between the two tables above is the honest state of this project: the
repository is well ahead of what is running.

| | |
|---|---|
| Database tables | **144** (117 before this session) |
| Migrations | 12 files. **Applied to the test database in CI. NOT applied to production** — see below. |
| Tests | **2,670** across **79** files, all passing (`npx vitest run`) |
| Route files under `src/pages` | 130 |
| Admin surfaces | 27 |
| Statuses in the federation dictionary | **170**, across 8 tones |
| `npx astro build` | succeeds |
| Live 404s from links the site publishes | **0** (was 2) |

---

## BUILT — has tests, runs against real Postgres

| Capability | Where | Notes |
|---|---|---|
| Institutional application intake, 20 steps | `db/applications.ts` | Works with JavaScript off. Draft resumable by token. |
| Full derivation from one submission | `db/automations.ts` | Institution, lead, request, owner, task, timeline, acknowledgement. Proved idempotent. |
| Workflow engine | `lib/workflow.ts` | Idempotency by unique index; resume from first unfinished step; retry with backoff; conditions fail closed. |
| Task engine | `db/tasks.ts` | Role assignment, dependencies, cycle refusal, escalation to a role queue. |
| Coach lifecycle | `db/coaches.ts` | Stages cannot be skipped; rejection needs a reason; append-only stage history. |
| Coach assignment engine | `db/coaches.ts` | Recommends with reasons, never appoints. Re-checks availability at confirmation. |
| Safeguarding exclusion | `db/coaches.ts` | NULL clearance = not cleared. Excluded from work with minors, with the reason stated. |
| Double-booking prevention | `db/coaches.ts` | Half-open intervals, so back-to-back sessions do not clash. Coach, venue and blackout. |
| Support: thread, escalation, tenant | `db/support.ts` | Extends the existing desk in `cases.ts` rather than replacing it. |
| Unified fee engine | `db/fees.ts` | Integer paise, PPM multipliers, reproducible quotes, immutable published frameworks. **Ships empty.** |
| Message templates | `lib/email-templates.ts` | Renders and **queues**. Missing value = error, not "Dear ,". |
| RBAC with tenant scope | `lib/rbac.ts` | 32 roles, `institution` scope, HR/medical restricted at grant time. |
| Three surfaces over one app | `lib/surface.ts` | Host allowlist. CSRF runs before the rewrite. |
| Federation-first navigation | `lib/surface.ts` | Every link asserted to resolve. |
| Audience pages ×6 + 3 SEO landings | `data/audiences.ts` | One definition, two surfaces. |
| Individual fee estimator | `pages/training/estimate.astro` | Returns a real figure or says a quotation is needed. Never a placeholder. |
| Admin: applications, tasks, coaches, support | `pages/admin/*` | Scope-filtered in SQL; menu filtered by RBAC; recomposed for phones. |
| Supabase Data API lockdown | `0010`, `0012` | RLS on all 144 tables, grants revoked. |
| Permissioned data export | `lib/export.ts`, `api/export/[kind].ts` | CSV and JSON, seven kinds. Two gates (`export:run` **and** the kind's read action), scope as a SQL predicate, an `audit_events` row per file. Formula injection neutralised; UTF-8 BOM; money as integer paise. **CSV and JSON only.** |

---

## BUILT — the second wave of surfaces

Nine capabilities moved out of SCAFFOLDED. Every one was **fetched over HTTP
before its menu entry was added** — `/learn/coaches` and `/learn/request` both
shipped as 404s from a menu entry added ahead of the page, and that is the
discipline that stops a third.

| Surface | Gated on | Notes |
|---|---|---|
| `/admin/leads` | `engagement:read` | Pipeline by status, source attribution. Read-only: nothing here changes a lead, so it renders no controls rather than disabled ones. |
| `/admin/fees` | `feeframework:read` | **The one that unblocks everything.** Author a framework, add rules, publish. Publishing is irreversible and the page says so beside the control. |
| `/admin/quotes` | `quote:read` | Versions, validity, and how each total was reached. |
| `/admin/programs` | `program:read` | Templates with `draft → under_review → approved → published → archived`, and the programmes actually running. |
| `/admin/bookings` | `booking:read` | Agenda with collisions. |
| `/admin/venues` | `venue:read` | Register, capacity, blackouts. Absent accessibility data reads as UNRECORDED, never as absent facilities. |
| `/admin/attendance` | `attendance:read` | Sessions **and the correction trail** — both what was recorded and what it was changed to, with who changed it. |
| `/admin/workflows` | `workflow:read` | Definitions, runs, steps, failures. How the federation answers "what did the system do on our behalf?" without reading TypeScript. |
| `/learn/portal` | institution scope | The client portal. Institution resolved from the caller's binding, never from a query parameter. |

### What these surfaces deliberately do NOT do

Stated because a page that exists is not the same as a capability that is
finished:

- **`/admin/leads` is read-only.** No status transition, no owner assignment, no
  note. Those need `engagement:write` and a POST endpoint; neither exists.
- ~~**`/admin/quotes` cannot approve a version.**~~ **Resolved 14 August 2026** —
  `approveQuoteVersion()`, `rejectQuoteVersion()` and `awaitingApproval()` now
  exist in `src/db/fees.ts`. See the third wave below.
- **A draft fee rule cannot be edited or deleted.** Correcting one means
  authoring a new version. `fees.ts` exposes no `updateRule`.
- **Publishing V2 does not mark V1 superseded.** `activeFramework()` picks the
  highest version whose date window is open.
- **The fee framework is national-only by construction** — `fee_frameworks` has
  no scope column, so a scoped holder is refused rather than shown a filtered
  list. That is the fail-closed reading, not a filter anybody wrote.
- **Counts on `/admin/leads` are a floor past 500 rows**, and the page says so
  when the cap is hit. There is no `leadCounts()` aggregate and writing raw SQL
  in a page would move the scope predicate out of the domain module.

## BUILT — the third wave: foundations, and two records nobody could read

Four changes, 14 August 2026. Three of them close a gap where the system already
held the data and had no way to show it or act on it.

| Work | Where | What it changes |
|---|---|---|
| **Design tokens (§99)** | `src/styles/global.css` | A radius scale, a 4px spacing scale, a clamped type scale, four elevations, motion durations and easings, a named z-index ladder, and the shell dimensions. There was previously one radius, one container width, two shadows and no scale at all, so 58 files hard-coded everything else. **Every colour token is byte-identical** — several carry a measured contrast ratio and changing a hex would silently undo an accessibility fix. |
| **The status dictionary (§102)** | `src/lib/status.ts`, `src/components/Status.astro` | 166 statuses over 8 tones, replacing 28 enums' worth of private opinions about colour and wording. The drift guard reads the enum labels out of the migrations and **found 94 statuses that were rendering as untoned grey chips the first time it ran.** |
| **Quotation approval** | `src/db/fees.ts`, `/admin/quotes` | A quotation parked at `awaiting_approval` could never move — there was no approve function. `approveQuoteVersion()`, `rejectQuoteVersion()` and `awaitingApproval()` close it. **The approver must not be the issuer, compared on `userId`**: `TRAINING_DIRECTOR` holds both `quote:issue` and `quote:approve`, so checking the action alone would let one person satisfy a two-person control by doing it twice. A principal with no `userId` is refused, because it cannot be *shown* to be somebody else. |
| **The audit log has a page** | `/admin/audit` | `audit_events` has been written to since migration 0000 — ranks awarded and revoked, results finalised, certificates issued, coaches suspended — and **nothing read it**. A complete record of the federation's own decisions with no way to look at it is a liability, not an asset. The menu's "Audit trail" entry also pointed at `/admin/approvals`, which is the two-person approval queue and a different thing entirely. |

Alongside these, four accessibility regressions the guards caught were fixed,
and one page that should never have shipped was removed.

### What these deliberately do NOT do

- **The tokens are not applied retrospectively.** Pages predating them still
  hard-code values. `--radius` keeps its unsuffixed name so all 58 files soften
  together, but spacing, type and elevation are only used where new work touched.
- **The status dictionary validates no transitions.** It says what a status
  means, not whether `draft → approved` is legal. See
  [domains/status-model.md](domains/status-model.md).
- **`/admin/audit` is read-only and has no export.** It reads the register; it
  cannot produce a CSV or a signed extract for an external auditor.
- **Rejecting a quotation does not notify the institution.** There is no email
  transport. It records the rejection and its reason, and stops.

---

## BUILT — the fourth wave: the location engine and the identity foundation

**17 August 2026.** Migration `0025_identity_and_geography.sql` plus its lockdown
`0026_data_api_lockdown.sql`; `src/db/geography.ts`, `src/db/identity.ts`;
99 tests in `tests/geography.test.ts` and `tests/identity.test.ts`, all passing
against a real Postgres (PGlite) with every migration applied.

### The gap this closed

Before it, the federation recorded WHERE somebody is in exactly two ways, and
both were the same way: `persons.state_unit_id`, `persons.district_unit_id` and
a free-text `persons.city`. That trio is repeated on `coach_profiles`, `venues`,
`institutions` and `routing_rules`.

**That is not geography.** `state_units` is the register of CHARTERED MMAKF
BODIES — a row exists when the federation has chartered a unit, and not
otherwise. So the register **could not record the residence of anybody living
outside the chartered hierarchy**, which is precisely the population a national
federation is trying to recruit. For everybody else, "where do you live"
collapsed to a free-text city with no postal code, no locality, no country and
no canonical id: two members in the same town were `Guwahati` and `Gauhati`, and
nothing could tell they were neighbours.

There was also **no relationship model at all** — no parent, no guardian, no
dependant. A federation whose own published programmes start at age 5 could not
name a child's guardian.

| Work | Where | What it changes |
|---|---|---|
| **Civil geography** | `countries`, `admin_areas`, `geo_aliases`, `postal_codes` | One self-referencing ladder with a `level`, a `depth` and a materialised `path`, so depth is not fixed by DDL. **No foreign key joins it to `state_units` in either direction** — that absence is the feature, and `tests/geography.test.ts` asserts it structurally. |
| **Resolution that refuses to guess** | `resolveArea()` | Returns `resolved` / **`ambiguous`** / `unknown`. A best-match resolver picks whichever row the index returned first, files the member one level off, and emits no signal. Ambiguity is a return value, narrowed by `within` (the state a form already collected) or `level`. |
| **Addresses** | `addresses`, `person_addresses` | Immutable content plus a validity window. An unresolved address is **stored, not refused** — with `localityText` kept verbatim so it re-resolves the day the district is loaded. `unresolvedAddresses()` is that backlog. |
| **Verified contacts** | `person_contacts` | `persons.email` stays the primary string; **whether anybody proved it lives only here.** `addContact()` has no `verified` parameter — verification is a separate act taking a method and a reference. |
| **Guardianship** | `person_relationships`, `guardian_authorizations` | An assertion confers nothing; a **verified** relationship still confers nothing until a capability is granted one at a time. `view_medical` and `view_safeguarding` are **gated twice** — a FEDERATION_ADMIN can attach a parent to a child and still cannot hand over the safeguarding file. |
| **Consent as a record** | `consent_records` | Append-only, carries the policy VERSION, and a withdrawal is a new row. Consent to version 1 is not consent to version 4, and a test asserts no function in the module UPDATEs the table. |
| **Duplicates** | `duplicate_candidates` | Raised on index lookups only (never a scan or a fuzzy compare), stored once per pair via a `left_id < right_id` CHECK, and **never merged** — see below. |
| **Governed changes** | `profile_change_requests` | `dob`, `gender`, `nationality` and the name fields move through request → decision → apply. The apply step re-reads the record and **refuses if it moved underneath the decision**; the decider may not be the requester. |
| **Four new actions** | `src/lib/rbac.ts` | `geo:write`, `guardian:verify`, `duplicate:review`, `profilechange:decide`. There is deliberately **no `geo:read`** — resolving an address happens on the public intake path where the caller holds nothing. |

### What this deliberately does NOT do

- **It ships EMPTY.** Not one country, state, district or postal code is seeded,
  for the reason the fee, tax and currency tables ship empty: a plausible seeded
  row is indistinguishable six months later from one somebody verified. Rows
  arrive through `upsertCountry()` / `upsertArea()`, which **require a `source`**.
- **It does not merge two people.** `decideDuplicate()` accepts `merged` as a
  decision and performs no merge — there is no such code path, and a test asserts
  both records survive. What a merge means for rank history, membership numbers
  and certificates already issued is MMAKF's to decide, and writing it now would
  invent that policy at the least visible moment.
- **It does not back-derive name parts.** `given_name` / `family_name` are added
  and left NULL on existing rows. Splitting `Shihan Pramod Kumar Pathak` on
  spaces yields a family name of `Kumar`, and a wrong parse is worse than an
  absent one because nothing downstream can tell it was guessed. Only
  `match_key` — which is order-independent — is derived.
- **It does not define the age of majority, what proves a guardianship, which
  policies need consent, or what score means two records are one person.** Each
  is MMAKF's; each has a place to arrive and no invented default.
- **THERE IS NO SURFACE YET.** This is the honest limitation and the largest one:
  the engines have a service layer, RBAC gating, audit writes and 99 tests, and
  **no page in `src/pages` calls them.** No registration step collects a
  structured address, no admin screen works the duplicate or change-request
  queues, and no parent dashboard exists. By this file's own standard that makes
  the wave BUILT at the domain layer and UNWIRED at the surface — see
  IMPLEMENTATION-QUEUE.md items 0a–0c, which are now first.

---

## SCAFFOLDED — model and domain logic, still no surface

| Capability | Model | Missing |
|---|---|---|
| Contracts | `contracts` | The quote → contract transition, and a surface |
| Client documents | `clientDocuments` | Storage binding |
| External calendar sync | `calendarConnections`, `calendarEvents`, `calendarSyncLog` | Google/Microsoft OAuth |
| **In-app notifications** | `notifications`, `src/lib/notifications.ts` | **A surface.** `myNotifications()`, `markRead()` and `queueHealth()` have no caller in `src/pages`. There is no bell and no notification centre, so a member cannot read an in-app notification. |
| **Event → notification fan-out** | `NOTIFIABLE`, `notifyForEvent()` | **A consumer.** Nothing walks the domain-event feed calling it. The only path that currently writes a notification on a real request is `send_message` inside a workflow. |
| **Web push** | `src/lib/push.ts` — 1,386 lines, RFC 8291 and RFC 8292, fully tested | **Everything else.** The module is imported by nothing: no subscribe endpoint, no settings page, no `push` handler in `public/sw.js`, no VAPID keys. A complete engine that has never run outside its tests. |
| Notification delivery | `deliverQueued()` | An email or SMS provider, and a line in `/api/cron/reconcile` to sweep the queue. |

Notifications are the largest gap between "tested" and "usable" in the system,
and [domains/notifications.md](domains/notifications.md) §7 sets it out in full
rather than letting the test count imply otherwise.

---

## NOT STARTED

- Participant and parent portals (PART AA, AB)
- Institutional analytics surfaces (PART V)
- HR module (PART X) — `hr:*` actions and `HR_OFFICER` exist; no tables
- Network visualisation and India map
- **XLSX and PDF export.** CSV and JSON are built (see above). Both of the other
  two need a library — a zip writer and a spreadsheet XML schema for XLSX, a
  layout engine for PDF — and this codebase adds no dependencies. Neither is
  stubbed and neither appears as an accepted `format`, so a caller asking for one
  is told there is no such format rather than handed a CSV with the wrong
  extension.
- **A screen to run an export from.** The endpoint is reachable and audited;
  nothing in the admin navigation links to it yet.
- Remaining SEO landing pages beyond the three built
- Premium design rebuild across the pages predating this session

---

## Blocked on the federation

None of these can be built without MMAKF supplying the facts. The infrastructure
is in place and empty.

| Needed | What it unblocks |
|---|---|
| **Fee rules** | Every quotation. The framework runs and holds nothing, so every path ends at "request a quotation". |
| **A service standard**, or a decision that there is none | Every deadline in the system is NULL. Nothing escalates because nothing is late. |
| A photograph of Shihan Pramod Kumar Pathak | His profile shows a monogram |
| Anything on Grandmaster S N T Lee | The master's entry holds only the name |
| 2021–2026 news material | The news page carries what was supplied and no more |
| Official school and coach lists | The registers count only what is recorded |
| `DATABASE_URL` linked to the Vercel project | Every database-backed page currently reports the database as unreachable in production |

**One contradiction needs resolving.** The Johar Jharkhand clipping states the
title "Junior Tiger Lee" was given in 2021 *"वर्ल्ड मार्शल आर्ट की ओर से"* — by or on
behalf of World Martial Art — naming no person. The federation states his master
Grandmaster S N T Lee awarded it. These are not reconciled anywhere; the page
carries the federation's statement and the archive is left as printed.

---

## Standing rules this codebase is written under

1. **Never invent a federation fact.** No fee, date, statistic, recognition,
   affiliation or office holder that MMAKF has not supplied.
2. **Do not announce an absence on a public page.** An unknown detail is left
   out silently. The news page once read "the federation has not supplied the
   day, the venue…" — that belongs in an internal register.
3. **A missing safeguard is not a safeguard.** NULL clearance means not cleared.
4. **No fake success.** No toast without a write, no `sendEmail()` that logs to
   the console, no placeholder price.
5. **Verify against production, not the repository.** Content lives in Redis;
   editing `seed.ts` does not reach a running page. A deployment can be refused
   before it exists.

---

## Domain documentation

Each of these was written by reading the source, and each ends with what its
subject does **not** do.

| Document | Covers |
|---|---|
| [domains/design-system.md](domains/design-system.md) | §71/§99 — the tokens, and the real API of `PageHeader`, `DataTable`, `Status`, `SidePanel` and the five state components |
| [domains/status-model.md](domains/status-model.md) | §102 — the eight tones, the distinctions that earn their place, and how the drift guard works |
| [domains/notifications.md](domains/notifications.md) | §T/§47/§48 — the allow-list, transports, push, and the large gap between built and usable |
| [domains/seo.md](domains/seo.md) | §P — route classification, the dynamic-route expansion policy, and what is deliberately not expanded |
| [domains/automation.md](domains/automation.md) | §AF/§R — the workflow engine, idempotency, resumption and retries |
| [domains/admin-platform.md](domains/admin-platform.md) | The three surfaces over one application |
| [domains/coaches.md](domains/coaches.md) | The coach lifecycle and the assignment engine |
| [domains/institutional-training.md](domains/institutional-training.md) | The institutional pipeline |

**The single register of what MMAKF has not supplied is
[PENDING-FEDERATION-VERIFICATION.md](PENDING-FEDERATION-VERIFICATION.md).** No
other document keeps its own list; they link to it.

> **One caveat on an older document.** The token tables in
> [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) are out of date — it records
> `--radius: 2px`, and the token is now `10px` within a seven-step scale.
> `domains/design-system.md` supersedes it on values. Its argument about
> institutional intent still stands, but its findings were not re-verified.

---

## Technical knowledge library (migration 0031)

The Shotokan technical library — provenance, movement-level kata, bunkai,
sport-kumite regulation, terminology search and the media↔technique review
pipeline. Full account in
[technical/TECHNICAL-LIBRARY.md](technical/TECHNICAL-LIBRARY.md); conflicts with
work running in parallel in
[parallel/PATCH-CONFLICTS.md](parallel/PATCH-CONFLICTS.md).

| Area | State | Note |
|---|---|---|
| Schema, migration, constraints | **Built and verified** | 14 tables, 6 enums. All 31 migrations apply to a fresh Postgres; every CHECK refuses what it should, proven by raw SQL in tests |
| Rights engine | **Built and verified** | `mediaUse()` is the single decision point; enforced on the write path *and* again on the read path |
| Review workflow + audit | **Built and verified** | `technical:review` gated, append-only trail in `technical_reviews`, decider resolved from session not form |
| Admin review queue | **Built** | `/admin/technical-library`. Rights blocker shown before the technical question; approve control absent where rights forbid |
| Terminology search | **Built and verified** | Alias-aware: `oi-zuki` / `oi zuki` / `oizuki` / `oi tsuki` reach one canonical term |
| Reference sources + JKA curriculum + WKF rules | **Seeded from primary sources** | Verbatim, cited, idempotent. JKA guideline is unreachable from the grading engine by construction |
| Heian movement data (P05) | **Not populated** | Deliberate. Per-kata movement counts could not be verified from a primary source — the JKA instructor manual requires an accurate count but does not publish one |
| Bunkai applications (P16) | **Not populated** | Deliberate. Table and approval constraint exist; no attributable interpretation was verified |
| Learner-facing pages | **Built** — see the addendum below | The architecture decision was resolved: `/learn` is the institutional-engagement surface, so the technical library went to the **public** surface at `/shotokan/*` alongside the existing `/shotokan` and `/kata` |
| YouTube ingestion (P41) | **Interface exists, not run** | `src/lib/youtube.ts` predates this patch; no credentials on this deployment, and nothing was faked |

### Addendum — the curriculum browser and the video source register

Added 17 August 2026, in parallel with the rows above. Full account in
[technical/SHOTOKAN-KNOWLEDGE-MODEL.md](technical/SHOTOKAN-KNOWLEDGE-MODEL.md).

| Area | State | Note |
|---|---|---|
| Kihon library — 40 techniques | **Built and verified** | 10 stances, 8 punches, 8 blocks, 6 strikes, 8 kicks, 2 movement categories. Every technique §7–§11 names, asserted by slug |
| Kumite library | **Built and verified** | 6 systems, 16 principles, 8 combination families. Traditional and sport separated at the record level |
| Terminology | **Built and verified** | 83 terms, translated *and* explained. 8 carry Hindi; the rest are null by policy, not by omission |
| Video source register | **Built and verified** | 121 recordings, all checked against the platform with a negative control. All 26 kata covered |
| Public routes | **Built and verified** | `/shotokan/kihon`, `/shotokan/techniques/[slug]`, `/shotokan/kumite`, `/shotokan/kumite/[slug]`, `/shotokan/terminology`, `/shotokan/videos`. In the nav, in the sitemap, fetched over HTTP by `tests/routes-live.test.ts` |
| Alias-aware search | **Built and verified** | `searchTechnical()` — `gyaku zuki` / `gyaku-zuki` / `gyakuzuki` / `reverse punch` all resolve; `sen no sen`, `bassai dai`, `enpi`/`empi` too |
| Discovery pipeline | **Built and runs** | `scripts/discover-videos.mjs` reproduces the register end to end. Never writes; every classification labelled a machine guess |
| Link health | **Built and runs** | `scripts/check-video-links.mjs` — per id, never per page. Last run 121/121 OK |
| Rights decisions on the 51 held recordings | **Not made** | Deliberate. They are third-party uploads; a committee decides, not a script |
| Technical player, chapters, timeline (§29, §30) | **Not built** | `media_chapters` exists; nothing consumes it, and there is no reviewed media to generate timestamps from |
| Multi-angle synchronised playback (§28) | **Not built** | MMAKF has recorded no multi-angle material |

**The 121 recordings are not in the database.** They are a verified static
register that the review queue can be seeded from; seeding them into
`media_assets` + `media_technical_links` is the next step and is not done.

Two RBAC actions added, additively: `technical:read`, `technical:review`. Gate on
these rather than `content:*` — reviewing what MMAKF teaches is a different
authority from publishing what MMAKF says.

---

# Addendum — the marketplace platform (migration 0029)

Added 17 August 2026. Counted by running the code, not by reading a plan.

The shop became a multi-seller marketplace. What follows is the honest split
between what has tests and has been exercised against a real Postgres, what
exists as schema with no surface, and what is not started.

## BUILT — schema, logic and tests

| Area | Module | Evidence |
|---|---|---|
| Seller registration, verification, brands, badges, 360 | `src/db/seller-registry.ts` | badge derivation and expiry asserted; `grantBadge()` refuses derived badges |
| Governed taxonomy, product policy, variants, quarantine, counterfeit cases | `src/db/catalogue.ts` | strictest-ancestor policy, union of requirement flags, brand-authorisation gating, expiry — all asserted |
| Inventory: five buckets, movement ledger, race-safe reservation | `src/db/inventory.ts` | oversell refused by conditional UPDATE **and** by CHECK constraint, both asserted |
| Multi-seller checkout and split | `src/db/seller-orders.ts` | the brief's critical test, in full, including refund isolation |
| Fulfilment lifecycle, shipments | `src/db/seller-orders.ts` | accept → pack → ship → deliver with stock movement asserted; `paid → delivered` refused |
| Commission: rules, versions, resolution, freezing, gaps | `src/db/marketplace-finance.ts` | draft-not-applied, specificity ordering, basis-on-shipping, unresolved blocks close |
| Settlement, payouts, adjustments, statements | `src/db/marketplace-finance.ts` | accrual, refund commission reversal, idempotency key |
| Returns, refunds, disputes, buyer reports | `src/db/returns.ts` | policy reconciliation and the inspection arithmetic are enforced in code; **not yet under test** |

`tests/marketplace-platform.test.ts` — 44 tests, all passing, against PGlite with
all 31 migrations applied. `tests/marketplace.test.ts` — 89 pre-existing tests,
still passing after the schema change.

Migration `0029_marketplace_platform.sql` adds 54 tables and 64 columns;
`0030_data_api_lockdown.sql` puts every one behind row-level security. Verified:
261 tables, 0 without RLS.

## BUILT AS SCHEMA — no surface, no computation yet

| Area | State |
|---|---|
| `marketplace-trust.schema.ts` — reviews, performance snapshots, fraud signals, promotions, featured placements, event merchandise | Tables, constraints and indexes exist. `fraud_signals` is written by seller registration. **Review moderation, performance computation and the promotion consent flow are not implemented.** |
| Bulk product import | `product_imports` / `product_import_rows` staging tables exist. **The pipeline is not implemented.** |
| Shipping zones and methods | Tables exist and `checkout()` resolves carriage from them. **No seller surface to configure them**, so every seller currently resolves to zero carriage. |
| Policy documents and acceptance | Tables exist and ship empty, by design. **No authoring surface.** |
| Payout provider adapter | `seller_payouts` records the instruction with an idempotency key. **No provider call** — `markPayoutPaid()` is operated by hand. |

## NOT STARTED

- **Surfaces.** No `.astro` pages were added. `/seller/apply`, the seller portal
  (dashboard, products, inventory, orders, returns, settlements, shipping), the
  admin marketplace console (sellers, Seller 360, commissions, settlements,
  disputes, brands, moderation) and the public storefront routes
  (`/shop/seller/…`, `/shop/category/…`, `/shop/brand/…`) are **not built**. The
  functions every one of them needs are built, tested and named in
  `docs/marketplace/`.
- **Seller API and webhooks.** The brief says "eventually support"; deferred
  deliberately. No tables, no routes.
- **Marketplace search and SEO surfaces** for the new taxonomy.
- **Notifications** for the new marketplace events.

Recorded here rather than implied, because the gap between "the engine is built
and tested" and "a seller can use it" is the whole of the remaining work, and a
status file that blurred it would be the thing this document exists to prevent.

### Shotokan corpus in the database (migration 0034)

The repository held two Shotokan libraries that could not see each other: a
static corpus rendered at `/shotokan/*` and `/kata/*`, and database tables that
make a corpus reviewable but were **empty** — nothing anywhere inserted into
`kata`, `techniques` or `kumite_forms`. `importShotokanCorpus()` bridges them.

| Area | State | Note |
|---|---|---|
| Kata, techniques, kumite systems in the database | **Built and verified** | 26 kata, 42 techniques, 6 kumite systems. Files stay canonical; the database is a projection, not a second copy |
| Knowledge graph | **Built and verified** | `technique_kata_appearances` answers "which kata contain gyaku-zuki". `technicalLookup()` tags every answer with its `precision` — `movement` where researched, `kata` where only the appearance is documented |
| Video register unblocked | **Verified** | Before the corpus, all 59 kata-tagged videos were skipped for want of a kata row. After it, they enter the review queue at `new` with rights `unknown` |
| Movement counts | **Imported with provenance, not as fact** | Every count carries a citation stating its strength. See conflict 8 in [parallel/PATCH-CONFLICTS.md](parallel/PATCH-CONFLICTS.md) |
| Sport vs traditional kumite | **Separated** | Sport systems import but do not publish as Shotokan teaching progression; competition rules live in `sport_kumite_rulesets` with a version and an effective date |

Tests: 50 passing in `tests/technical-library.test.ts`. A test asserts that every
`technique_kata_appearances.movement_ordinal` written by the importer is null —
an invented ordinal would be indistinguishable from a researched one.
