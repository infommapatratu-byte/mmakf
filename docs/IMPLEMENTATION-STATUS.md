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

**Found stale a third time, 5 September 2026.** Every count in the block below
was low, two of them by more than a third, and the PRODUCTION STATE table under
it had gone from stale to actively wrong: it described a database that has since
been configured and migrated. Re-counted by running the commands.

Every figure below came from one of these, run just now:

```
ls tests/*.test.ts | wc -l                140 files
ls drizzle/*.sql | wc -l                   55 migrations
grep -h 'CREATE TABLE' drizzle/*.sql | wc -l  286 tables
find src/pages -type f | wc -l            193 route files
find src/pages/admin -name '*.astro'       46 admin surfaces
```

**`npx vitest run` and `npx astro build` were deliberately NOT run in this pass,
and their previous figures are marked below rather than repeated as current.**
Another workstream held six files open mid-edit while this was counted —
`src/db/engagement.ts`, `src/db/fees.ts`, `src/lib/workflow.ts` and three admin
pages, the last write landing sixty-eight seconds before the count. A suite run
across a half-written tree measures the moment, not the tree, and a green number
obtained that way is exactly the kind of figure this document exists to keep out.
Whoever finishes that work owns those two lines.

Re-run them before citing a number from here.

## PRODUCTION STATE, WHICH IS NOT THE SAME AS THIS REPOSITORY

| | |
|---|---|
| Production commit | `205be61`, verified from `/api/health` on all three hosts, 5 September 2026 |
| `www.mmakf.in` | serves the public federation ✅ |
| `learn.mmakf.in` | serves the training platform ✅ (served the public homepage until 16 Aug) |
| `admin.mmakf.in` | serves the operations console ✅ (same) |
| Database | **`ok`** — `DATABASE_URL` is set and the register answers on all three hosts |
| Migrations in production | **APPLIED.** |

**This table has been reversed, not adjusted, and the reversal is the single most
consequential correction this file has carried.** It said production had no
`DATABASE_URL` and that no table existed there. Both are false as of 5 September
2026, and the second one is provable rather than merely reported: `database: ok`
in the health payload is the return value of

```
select 1 from _mmakf_migrations limit 1
```

in `databaseHealthy()` — see [src/db/index.ts](../src/db/index.ts). That statement
cannot succeed unless the migration ledger exists, so `ok` is positive evidence
that migrations have been applied, not an assumption about it. What it does not
establish is WHICH migrations, and nobody should read it as saying all 55 are in.
Confirming that needs `npm run db:status` against the production connection
string, which is a Vercel sensitive variable and pulls back empty, so it has to
come from the operator.

The old gap — the repository far ahead of what was running — has closed, and the
direction of the remaining difference has flipped. Production serves the same
commit as local `main`. What is ahead of production now is not the repository's
history but its **working tree**: seventeen files of uncommitted work, six of
them still being written while this was counted.

| | |
|---|---|
| Database tables | **286** |
| Migrations | 55 files. Applied to the test database in CI, **and applied in production** — see above. |
| Test files | **140** |
| Tests passing | 3,502 when last measured (23 August, at 97 files). **Not re-measured on 5 September** — see the note above. Any figure quoted from here is a floor at best. |
| Route files under `src/pages` | 193 |
| Admin surfaces | 46 |
| Statuses in the federation dictionary | **261**, across 8 tones (counted from `DICTIONARY` in `src/lib/status.ts`) |
| `npx astro build` | succeeded when last run (23 August). Not re-run 5 September. |
| Live 404s from links the site publishes | **0** when last checked (23 August). Not re-checked 5 September. |

> **This table used to contradict the one above it**, carrying 144 tables /
> 2,670 tests / 79 files / 12 migrations while the Numbers block said 269 / 3,319
> / 96 / 35. Both were in the same document, four screens apart. That is the
> third staleness this file has recorded, and the most embarrassing kind: not a
> figure that drifted from reality, but a document disagreeing with itself.
> Corrected 17 August 2026 by running the commands.

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
- ~~**THERE IS NO SURFACE YET.**~~ **Resolved 17 August 2026** — see the wave
  below. The domain layer shipped first and was unwired for part of a day; the
  strikethrough is kept rather than deleted because this file's whole purpose is
  to be checkable against what it previously claimed.

---

## BUILT — the fifth wave: the surfaces over the identity foundation

**17 August 2026.** The four links `docs/SYSTEM-WIRING-MATRIX.md` §2.22 recorded
as ABSENT — public UI, API, admin UI, user UI — plus the domain events.

| Surface | Gated on | What it does |
|---|---|---|
| `/admin/duplicates` | `duplicate:review` | Both people side by side, and **which signals fired** rendered as sentences rather than a bare score. Three decisions, each demanding a reason. |
| `/admin/profile-changes` | `profilechange:decide` | The request, the evidence, and the old value beside the new. **Warns that the record moved BEFORE the reviewer presses approve**, rather than handing them a refusal after. |
| `/my/family` | none — `guardianCan()` | The caller's dependants, every field behind its own capability check. Takes no identifier at all. |
| `/api/geography/resolve` | **unauthenticated by design** | Cascading country → state → district for the registration form, and `resolveArea()`. Rate limited, reads only the map. |
| Registration location step | — | `LOCATION_FIELDS` in `lib/registration.ts`, rendered through `isOffered()` and validated against the same predicate. |
| Domain events | — | Twelve types on the catalogue, published from `db/identity.ts`. |

### The three decisions in this wave worth knowing about

- **`/admin/duplicates` states in words that recording a merge merges nothing.**
  `decideDuplicate()` accepts `merged` and performs no merge, deliberately. An
  administrator who presses a button labelled "merge" and believes two records
  were combined has been misled *by the page*, so the control reads "record a
  merge decision" and a standing notice explains why. A test asserts the
  sentence is present.
- **The geography endpoint has no `geo:read` gate, and says why.** Resolving an
  address happens on the public intake path where the caller holds nothing.
  Gating it would mean either a permission check that always passes for
  anonymous callers, or a registration form that cannot resolve an address. It
  is rate limited instead, and it cannot reach `addresses` or `persons` — a test
  asserts both absences.
- **The location step degrades rather than blocking.** The geography tables ship
  empty, so `isOffered()` is what stops a required select with no options in it:
  a register-backed field that cannot be answered is neither rendered nor
  validated, and the free-text district and city carry the applicant until the
  map is loaded. The postal code and address lines are asked unconditionally,
  because they need no register and a postal code is the strongest signal
  `resolveArea()` has for placing an address later.

---

## BUILT — the sixth wave: the approval reaches the register, and an
## adversarial review of the fifth

**17 August 2026, later the same day.**

### The join that did not exist

`provisionFromRegistration()` in `src/db/provisioning.ts`, called from the
approval path in `api/queue/decide.ts`: an approved registration now creates the
person, the address, the contacts, the consent rows and — for a minor — the
guardian's asserted claim, then raises any duplicate. Idempotent throughout, so a
retried approval finds what the first run made. 26 tests.

`/admin/guardianships` (`guardian:verify`) decides those claims and grants
capabilities one at a time, with the medical/safeguarding double gate both
enforced and explained on the page. 21 tests.

### An adversarial review of the fifth wave found nineteen confirmed defects

Three independent reviewers were pointed at the surfaces with instructions to
break them; every finding they claimed was then independently refuted by a fourth
before being accepted. Recorded here in full because the point of this file is to
be checkable, and because several were in code carrying a comment that claimed
the opposite:

| Severity | Defect | Fixed |
|---|---|---|
| **High** | `decideDuplicate()`'s per-record scope check called `assertCanAnywhere()` — the gate it had *already* asserted — so the branch was dead and **any holder of `duplicate:review` in any scope could decide any candidate by id.** A Kerala administrator decided an Assam candidate in the reviewer's reproduction. The comment above it described the IDOR it was failing to prevent. | Throws `ForbiddenError`; non-person subjects fail closed |
| **High** | Both new admin pages called `EmptyState` with a `description` prop it does not declare and **without the required `action` it dereferences** — a `TypeError` and a 500 in the ordinary empty state, and immediately after a reviewer decided the last item in a queue | Correct props; `ErrorState` given its required `safe` |
| **Medium** | The four-eyes rule on governed changes was skipped whenever the actor could not be named. **One shared office login filed a date-of-birth change and approved its own request.** | An unattributable actor now fails the test rather than passing it, on both sides |
| **Medium** | `Number('')` is `0` and passes `Number.isInteger`, so an empty district set `within = 0`, `resolveArea()` threw, a bare `catch` swallowed it, and **the applicant's chosen civil state was silently dropped behind a 200** | Parsed and membership-checked; the catch is scoped and logs |
| **Medium** | The locality-ambiguity question was a dead end: the client rendered it as a generic failure with "call the office", no control could answer it, and the `unresolvedValue` the API advertised as the way out **was rejected by the validator** | The select is built from the returned candidates; `UNRESOLVED_CHOICE` is accepted and records no area |
| **Medium** | A `'distinct'` decision could be filed *with* a surviving record — a row and a restricted-feed event reading "two different people, and the surviving record is #2" | Refused in the module, cleared on the page |
| **Low** | `dependantsOf()` ignored the validity window `guardianCan()` enforces, so a granted capability rendered as "Not granted" on a relationship not yet in force | Same window in both |
| **Low** | `/my/family` was offered only for *verified* relationships, so the "claims awaiting a decision" section was unreachable by the parent waiting on one | Asserted claims offer the link |
| **Low** | `op=children` reported a loaded **leaf** area as `loaded: false`, which this endpoint's own contract tells callers to treat as "fall back to free text" | `loaded` describes the register; emptiness is `areas: []` |
| **Low** | Three false claims in copy: "raised automatically" (nothing called the detector), "the pair will not be raised again" (no suppression exists), "may be outside your scope" (the lookup is unscoped, so that cannot be the cause) | All three corrected to what is true |

`tests/identity-review-fixes.test.ts` (16 tests) pins the four behavioural ones.
**Every one of them passed on the broken code**, which is the honest lesson: the
existing suite asserted what the module meant to do, not the ways it failed to.

### What this wave still does NOT do

- **A registration does not create a person, and this wave did not change that.**
  `src/pages/api/register.ts` queues the application to Redis;
  `createPersonForSource()` in `db/federation.ts` has **no caller anywhere in
  `src/`**. So the structured address and the contacts are captured onto the
  application record and are not yet turned into `person_addresses` and
  `person_contacts` rows — there is no person to attach them to. Building the
  approval → register-entry path is its own item and is not smuggled in here.
- **`detectPersonDuplicates()` still has no caller on the intake path**, for the
  same reason: it takes a `personId`.
- **Nothing consumes the new domain events.** They are published; the
  notification fan-out named in IMPLEMENTATION-QUEUE.md item 2 is what would
  react to them.
- **No guardian capability can be granted from any screen.** Granting is gated on
  `guardian:verify` and has no admin surface yet, so `/my/family` will show a
  verified guardianship holding nothing until one is built.

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
| Public routes — **all nine §33 names** | **Built and verified** | `/shotokan`, `/shotokan/kihon`, `/shotokan/kata`, `/shotokan/kumite`, `/shotokan/techniques`, `/shotokan/stances`, `/shotokan/terminology`, `/shotokan/live`, `/shotokan/videos`, plus `/shotokan/techniques/[slug]` and `/shotokan/kumite/[slug]`. In the nav, in the sitemap, and each asserted to answer 200 over HTTP by `tests/routes-live.test.ts` |
| §31 search, **without a database** | **Built and verified** | `searchTechnical()` was written and had no caller. `/search` reads Postgres, the library does not live there, and production has no `DATABASE_URL` — so "gyaku zuki" returned the not-configured notice while the answer was compiled into the same page. Technical results now render outside the database guard. Asserted for `gyaku zuki`, `bassai dai` and `sen no sen` |
| §25 live detection, **actually running** | **Built** | `syncBroadcasts()` and `closeStaleBroadcasts()` were complete and had **no caller** — no route, no cron. `/api/cron/media-sync` invokes them gated on `CRON_SECRET`, skipping cleanly when the database or YouTube credentials are absent, publishing nothing. **Deliberately NOT in `vercel.json`** — a sub-daily cron makes Vercel reject the whole deployment on a Hobby plan, and a daily one cannot detect an hour-long class. Scheduling is the operator|’s choice |
| Alias-aware search | **Built and verified** | `searchTechnical()` — `gyaku zuki` / `gyaku-zuki` / `gyakuzuki` / `reverse punch` all resolve; `sen no sen`, `bassai dai`, `enpi`/`empi` too |
| Discovery pipeline | **Built and runs** | `scripts/discover-videos.mjs` reproduces the register end to end. Never writes; every classification labelled a machine guess |
| Link health | **Built and runs** | `scripts/check-video-links.mjs` — per id, never per page. Last run 121/121 OK |
| Database seed, end to end | **Built and verified against a real Postgres** | `npm run library:seed`. `seedTechnicalLibrary()` was complete and tested but **reachable only from vitest** — no script, no route — so the only process that had ever run it wrote to a throwaway PGlite database. An operator could migrate, deploy, open the review queue and find it empty with nothing to tell them what they had missed. Verified: 26 kata, 42 techniques, 6 kumite forms, 145 appearances, 125 terms, 625 aliases, 95 citations, **121 media assets, 59 review-queue links** — and a second run produces zero deltas |
| Rights decisions on the 51 held recordings | **Not made** | Deliberate. They are third-party uploads; a committee decides, not a script. Post-seed state is `rights = unknown` on all 121 assets, `published = 0` |
| Technical player, chapters, timeline (§29, §30) | **Built and verified** | `src/components/TechnicalPlayer.astro` — chapter markers, seven speeds, loop-a-section, approximate step, running time. It reads chapters from `media_chapters` and, where there are none, SAYS SO rather than deriving plausible ones from the duration (§30). The step control is labelled approximate because the IFrame API exposes no frame boundary, and a control called frame that does not move one frame teaches a student to mistrust the tool |
| Student progress marking (§43, §44) | **Built and verified** | `practice_marks` and `practice_assignments` (migration 0051), `src/db/practice.ts`, `POST /api/practice`, the control on every technique page, and `/my/practice`. 24 tests |

### §44, made structurally true rather than promised

The practice feature is one schema change away from being read as attainment —
by a report, by an export, or by a future migration adding a
`grading_candidate_id` "just to link them". §44 is one sentence:

> Watching Bassai Dai does NOT make Bassai Dai "completed".

So the separation is built in rather than commented:

| Guard | How |
|---|---|
| No path to the grading engine | `practice_marks` and `practice_assignments` have foreign keys to `persons` and to nothing else, in either direction. Asserted against `information_schema`, and verified on a real Postgres rather than PGlite alone |
| No terminal state | The vocabulary is `watched` / `practising` / `needs_work` / `bookmarked`. There is no "completed", no "mastered", no "passed", no score and no percentage — a student cannot mark themselves finished with a kata, because finishing a kata is not a student's call |
| Every mark labelled a self-report | `self_reported` is NOT NULL DEFAULT true and no code path writes false, so an export of the table cannot be read as an attainment record by whoever opens the spreadsheet |
| An assignment is not attainment either | `practice_assignments` has no `completed_at` and no sign-off column. `acknowledged` — "I have seen it" — is the furthest a student can move one |
| No progress bar | `/my/practice` shows counts of the member's own marks, never a proportion of the library. A percentage toward a destination that does not exist is a lie told with a rectangle |

`needs_work` is the entry that earns its place: a library whose only self-report
is positive collects nothing anybody would act on, and an honest "I cannot do
this yet" is the one mark that changes what a member does at their next session.

---

### The pattern worth naming: three capabilities that existed and never ran

Found in one session, all the same shape, and none of them visible from the
test suite because every one was tested:

| Capability | State | Symptom |
|---|---|---|
| `seedTechnicalLibrary()` | Complete, idempotent, tested | Called only by vitest. An operator got an empty review queue with nothing telling them why |
| `searchTechnical()` | Complete, tested | No caller. §31's own acceptance query returned nothing on the live site |
| `syncBroadcasts()` | Complete, tested, error-isolated | No route, no cron. §25's premise — a class appears by itself — was never true |

This is the same defect as a page linked from nowhere, which this repository
already checks for. **A capability is not shipped until something invokes it on
its own**, and a green test suite is not evidence that anything does.
| Multi-angle recordings (§28) | **Schema built; empty, which is the honest state** | `media_angle_groups` / `media_angle_members`. Modelled as a RELATIONSHIP rather than columns on `media_assets`, because synchronising two views needs the OFFSET between them and an offset has no home on a single row. MMAKF has filmed no multi-angle material, so no group exists and the surfaces say so |

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
| Returns, refunds, disputes, buyer reports | `src/db/returns.ts` | policy reconciliation and the inspection arithmetic asserted; the refundable figure multiplies before it divides |
| Verification documents, versioned policy and acceptance | `src/db/seller-documents.ts`, `src/db/marketplace-policy.ts` | the storage key never appears in a list or an audit row; an acceptance names a version and carries its hash twice |
| Shipping zones, methods and carriage quoting | `src/db/shipping.ts` | one implementation shared by the seller's preview and `checkout()`; an unzoned seller absorbs carriage and the exposure is counted |
| Browse, storefronts, category and brand pages | `src/db/marketplace-browse.ts` | every public query goes through `publicListingPredicate()`; no filter exists without a column behind it |
| Bulk product import | `src/db/product-import.ts` | four acts, staged; `import/submit` creates **drafts only**, into the same moderation queue a hand-typed item goes through |
| Payout rails | `src/lib/payouts/`, `src/db/marketplace-finance.ts` | a send never writes `paid`; only the provider's own answer does. The RazorpayX adapter answers `isConfigured() === false` even with correct credentials until `RAZORPAYX_VERIFIED=true` |
| Domain events and notifications | `src/db/marketplace-events.ts` | 21 event types, 14 notices, two new audiences; the catalogue and the producer module are asserted to agree |

### Tests, counted by running them

| Suite | Tests |
|---|---|
| `marketplace-payouts` | 55 |
| `marketplace.test.ts` | 51 |
| `marketplace-browse` | 47 |
| `marketplace-platform` (the brief's own critical and security tests) | 44 |
| `marketplace-import` | 39 |
| `marketplace-portal` | 38 |
| `marketplace-shipping` | 29 |
| `marketplace-returns` | 27 |
| `marketplace-documents-policy` | 25 |
| `marketplace-events` | 25 |
| `marketplace-sitemap` | 22 |
| `marketplace-checkout` | 17 |
| **Total** | **419** |

All passing against PGlite with every migration applied. Run together with
`notifications`, `domain-events`, `money-safety`, `data-api-lockdown` and
`api-contract`, the combined result is 532 passing and 2 expected failures.
`npx tsc --noEmit` reports no errors and `npm run build` completes.

Migration `0029_marketplace_platform.sql` adds 54 tables and 64 columns;
`0030_data_api_lockdown.sql` puts every one behind row-level security. Verified:
261 tables, 0 without RLS.


## BUILT — surfaces

Added in the same wave, after the engine. Every one takes no identifier it
should not: the seller pages resolve the shop from the session, and the admin
pages ask `assertCan()` per query against the caller's scope.

| Surface | Route | What it does |
|---|---|---|
| Apply to sell | `/seller/apply` | The full application — nine seller types, twelve legal forms, structured addresses, requested categories. Collects **no bank account number**. |
| Seller overview | `/portal/seller` | Standing, the nine verification checks with their outcomes, derived badges with their basis, storefront editing, open/close the shop, and what MMAKF has not decided. |
| Seller products | `/portal/seller/products` | Catalogue, variants, stock receipt, low-stock. Names **which of the five visibility conditions is failing** for an item that is not on sale, and warns before a variant edit sends the item back to review. |
| Seller orders | `/portal/seller/orders` | Accept → pack → dispatch → deliver, with optional tracking; returns to authorise or refuse; disputes to answer. |
| Seller money | `/portal/seller/money` | The period's arithmetic **and every line behind it**, payouts, statements, and any sales held for want of a commission. |
| Marketplace console | `/admin/marketplace` | Six queues with counts; adopt the taxonomy; decide disputes and flags; re-check held sales. |
| Seller 360 | `/admin/marketplace/[id]` | Risk flags, the nine verifications with a recording form each, badges, brand authorisations, trade figures, payout accounts, items, disputes, fraud signals, audit link. |
| Commission | `/admin/marketplace/commissions` | Create rules, draft rates, publish them with an authority. The basis radios have **no default**. |
| Settlements | `/admin/marketplace/settlements` | Close → approve → pay out, with the unresolved-commission block shown as a block. |
| Storefront | `/shop/seller/[slug]` | Public shop. Allow-listed fields; badges with their basis; city-level location only. |
| Product | `/shop/product/[ref]` | Resolved **through the public predicate**, so an unapproved or quarantined item 404s exactly as it is absent from the shop. Variants, safety block, verified-purchase reviews. |

**API.** `/api/marketplace/[...action]` gained 47 actions across registration,
storefront, variants, inventory, checkout, fulfilment, returns, disputes,
verification, badges, brands, taxonomy, commission, settlement, payout and
reviews. One dispatch table, no local policy — every branch is a thin call onto
a module that holds its own authorisation.

**RBAC.** Five new actions with their grants and their reasons: see
`docs/marketplace/SELLER-RBAC.md`.

## BUILT — trust

`src/db/marketplace-trust.ts`: verified-purchase reviews with
moderation-before-publication, seller rating roll-ups from published reviews
only, performance snapshots, and fraud-signal review. Nothing in it enforces
anything.

`tests/marketplace-returns.test.ts` — 27 tests covering the return policy
reconciliation, frozen eligibility, the inspection arithmetic, the refund
ceiling, commission reversal, platform-funded refunds, disputes, reviews and
performance.

## Test position

| Suite | Tests |
|---|---|
| `marketplace-platform.test.ts` | 44 |
| `marketplace-returns.test.ts` | 27 |
| `marketplace.test.ts` (pre-existing) | 89 |
| `marketplace-portal.test.ts` (pre-existing) | still passing |

Plus `money-safety`, `data-api-lockdown`, `rbac-adversarial` and
`api-contract` — all passing against the new code.

Two defects were found by tests during the build and fixed rather than
allow-listed:

1. **`checkListingAgainstPolicy()` returned early on a null category**, skipping
   the brand and counterfeit checks — so a seller could evade brand
   authorisation by naming no category. The two gates are now independent.
2. **`refundableMinor` divided money then multiplied**, losing a paisa on
   partial returns. Now derived from the unit price with no division, through
   the repository's single sanctioned `applyFactor()`.

And one drift was found by reading: **`myListings()` computed public visibility
from three hand-copied conditions** while `publicListingPredicate()` had grown
to five. It now interpolates the predicate itself, so a sixth condition cannot
reintroduce the gap.

## NOT STARTED — what remains

- **Bulk product import pipeline.** `product_imports` / `product_import_rows`
  staging tables exist; the validate → preview → dedupe → category-map →
  moderate → publish pipeline does not.
- **Shipping zone configuration surface.** Zones and methods exist and
  `checkout()` reads them; there is no seller page to create one, so every
  seller currently resolves to zero carriage. **This is the highest-priority
  gap: sellers are silently absorbing carriage.**
- **Payout provider adapter.** `createPayout()` writes the instruction with a
  database-enforced idempotency key; `markPayoutPaid()` is operated by hand from
  the settlements page.
- **Policy document authoring.** `marketplace_policies` / `policy_versions` ship
  empty by design; there is no surface to publish one.
- **Seller API and webhooks.** The brief says "eventually support"; deferred.
- **Marketplace search and category landing pages** for the new taxonomy.
  `/shop/category/[...path]` is not built.
- **Notifications** for the new marketplace events.

## Notifications — status as at 17 August 2026

**EVENT → NOTIFICATION: REAL + WIRED** (was severed).

The domain-event feed is drained by the `notifications` consumer from
`src/pages/api/cron/reconcile.ts`, and the queued rows are swept in the same
run. Before this, `consume()` and `notifyForEvent()` had zero production callers
and the member inbox at `/my/notifications` could never receive a row.

Still open: `deliverQueuedPush()` in `src/lib/push.ts` has no production caller
either — web push rows stay queued. In-app delivery is unaffected.

## Scheduling — status revised, 17 August 2026 (evening)

**REAL + WIRED.** All fifteen links joined. The two that were absent this
morning are closed.

| Component | Status |
|---|---|
| Engine (`src/db/scheduling.ts`) | REAL |
| Prose→rows migration (`schedule-bootstrap.ts`) | REAL |
| Directory resolver, one day (`directoryDay`) | REAL — fixed query count, differentially tested |
| Directory resolver, a run of days (`directoryRange`) | REAL — capped at 14 days, states `open`/`closed`/`not_published` per club |
| **API route** (`/api/schedules/*`) | **REAL** — was MISSING. GET public, POST authenticated, 22 tests |
| Public surfaces | REAL |
| Admin surface | REAL |
| Domain events | REAL — `SCHEDULE_CHANGED` retired as an orphan; the three that fire have producers and a consumer |
| Notifications | REAL — feed drained from the reconcile cron; push backlog swept |
| Audit | REAL |
| Tests | REAL — 6 suites |

**Data, as opposed to code:** unchanged. Only the Hombu has rows in production.
`scripts/seed-demo-schedules.mjs` produces a local demonstration register for
anyone who wants to see the surfaces working.

---

# Addendum 2 — the remaining slices (17 August 2026, later)

Three of the seven queued items shipped. Verified: **522 tests passing across 11
suites**, `npx astro build` completes, all migrations apply with 0 tables
outside the RLS lockdown.

## BUILT — shipping zones and methods

**The gap that was costing sellers money is closed.** `src/db/shipping.ts`,
`/portal/seller/shipping`, 5 API actions, `tests/marketplace-shipping.test.ts`
(29 tests).

The important structural change: `resolveShipping()` in seller-orders.ts no
longer holds its own copy of the zone matcher and the method pricer. It
delegates to `quoteCarriage()`, which is **the same function the seller's
preview calls**. A seller shown one figure and their buyer charged another is a
complaint nobody can resolve, because both screens would be telling the truth
about different code.

Weight now reaches the quote too — variants carry `weightGrams` onto the priced
line, which nothing was doing, so every parcel had been quoted as weightless and
every weight-banded rate came out at the lightest band.

The zero-carriage behaviour for an unconfigured seller is **unchanged and still
deliberate**; what is new is that it is no longer silent. `carriageExposure()`
counts the orders it has applied to, and the page says so. It reports **no rupee
figure** for what it cost — what a parcel costs to send is a fact about the
seller's carrier that MMAKF does not hold.

## BUILT — seller verification documents

`src/db/seller-documents.ts`, `/portal/seller/documents`, 2 API actions,
covered by `tests/marketplace-documents-policy.test.ts`.

`storage_key` never leaves the module except through `documentDownloadRef()`,
which checks authority (owner, or `marketplace:verify` in scope), audits the
read, and is the only function that resolves one. Asserted: a list response
contains no key, an audit row contains no key, and a finance officer holding
`marketplace:read` cannot read a trader's PAN card.

A new `seller_verification` upload purpose was added to `src/lib/uploads.ts`,
classified **restricted** — filing it under `affiliation_document` would have
made a PAN card as widely readable as a dojo's insurance certificate.

**The upload control is ABSENT on this deployment**, and that is the finding
worth recording: `uploadCapability()` reports no object storage
(`UPLOAD_STORAGE_URL` unset). The page says so plainly rather than showing a
button that would accept the bytes and drop them. A seller who uploaded a PAN
card, saw "uploaded", and was then refused for a missing PAN card is the worst
outcome the page could produce.

## BUILT — policy documents, versions and acceptance

`src/db/marketplace-policy.ts`, 5 API actions, covered by the same test file.

**Not one word of policy text.** `registerPolicies()` creates the eight *names*
the schema's enum already carries; every body is written by MMAKF and arrives
through `policy/draft`. Acceptance names a **version**, not a policy, and stores
the body hash a second time on the acceptance — so a published body edited in
place is detectable, and `acceptanceStillValid` goes false rather than the
discrepancy passing unnoticed. A seller who accepted v1 of a document now on v2
is outstanding again.

## NOT STARTED — the four that remain

- **Category landing pages and marketplace browse.** `/shop/category/[...path]`
  and `/shop/brand/[slug]`. The taxonomy is adopted and has nowhere to be
  browsed; the Shotokan/kata/kumite/age filters map onto real populated columns
  and are not searchable yet.
- **Bulk product import pipeline.** Staging tables exist; the
  validate → preview → dedupe → moderate → publish pipeline does not.
- **Payout provider adapter.** `createPayout()` writes the instruction with a
  database-enforced idempotency key; `markPayoutPaid()` is operated by hand.
- **Marketplace domain events and notifications.** No producer publishes a
  marketplace event yet.

And one new item, discovered while building documents:

- **Object storage.** `UPLOAD_STORAGE_URL` is unset, so no file can be attached
  to anything anywhere on the platform — not only to a seller record. Until it
  is configured, verification rests on evidence supplied out of band.


---

# Addendum II — the four remaining slices, and what the wiring cost

Added 23 August 2026. Counted the same way: by running it.

The list at the end of the first addendum named four things as not started.
All four are now built, and the entries above them are stale in the ways this
section corrects. **Where the two addenda disagree, this one is right.**

## The four

| Slice | Module | Surface | Tests |
|---|---|---|---|
| Carriage and zones | `src/db/shipping.ts` | `/portal/seller/shipping` | 29 |
| Verification documents, versioned policy | `src/db/seller-documents.ts`, `src/db/marketplace-policy.ts` | `/portal/seller/documents` | 25 |
| Payout rails | `src/lib/payouts/` (4 files), `sendPayoutThroughProvider()` / `refreshPayoutFromProvider()` | `/portal/seller/money` | 55 |
| Marketplace browse and SEO | `src/db/marketplace-browse.ts` | `/shop/category/[...path]`, `/shop/brand/[slug]` | 47 |
| Bulk product import | `src/db/product-import.ts` | `/portal/seller/import` | 39 |
| Domain events and notifications | `src/db/marketplace-events.ts` | — (feed and inbox) | 25 |

**Marketplace suite total: 291 tests, all passing** — the six above plus
`marketplace-platform` (44) and `marketplace-returns` (27), against PGlite with
every migration applied.

## Corrections to Addendum I

- **API actions: 90, not 47.** The dispatch table gained bulk import
  (`import/start|validate|submit|cancel`) and the payout rails
  (`payout/send|refresh`) on top of the earlier waves.
- **Returns are under test.** Addendum I originally said "not yet under test";
  that stopped being true when `tests/marketplace-returns.test.ts` landed, and
  the row has since been corrected in place rather than left to mislead.

## The bug the event wiring existed to fix, and the worse one it nearly introduced

`src/db/marketplace-events.ts` was written with twenty-one event types that were
not in `src/lib/domain-events.ts`. `publish()` validates against `EVENT_TYPES` at
runtime and refuses an unknown type outright, so **every producer would have
thrown the first time a real order was placed.** Nothing in the type system said
so: the module casts past the union deliberately, so that it can be written and
tested before the catalogue change lands.

The first attempt at that wiring was worse, and is why
`tests/marketplace-events.test.ts` asserts what it does. The floors were chosen
on sensitivity — a seller's order flow is commercial information, so `official`;
a verification outcome, `confidential`. Both readings are defensible. Both are
fatal, because the notifications drain in `src/pages/api/cron/reconcile.ts` runs

```
consume(db, 'notifications', ..., { maxClassification: 'member' })
```

and `consume()` **steps over anything above its cap without erroring**. Eight
seller notices would never have been delivered, and the feed would have shown
the events sitting there looking exactly like ones that had been.

So the rule, asserted directly rather than inferred:

> A marketplace event with a notifications consumer sits at `member`.
> Sensitivity is held by keeping the material **off the payload**, not by
> raising the floor.

Which is what the producers do. No marketplace event carries a public field. The
payloads omit the buyer's address, phone and email, the seller's bank details,
the evidence behind a fraud signal, and the storage key of any document. A
dispatch carries `trackingRecorded: true` — a boolean, because the number itself
would let anybody reading the feed follow a stranger's parcel across a carrier's
website. Where a figure genuinely must travel it goes on a separate, higher
event that no consumer delivers: `MARKETPLACE_PAYOUT_INITIATED` carries the
amount at `confidential` **precisely so** `MARKETPLACE_PAYOUT_PAID` can be the
seller's notice.

Two audiences were added to `resolveRecipients()` rather than reusing the
near-miss `subject`, which ends in `Number(payload?.personId ?? entityId)`. For a
grading the entity *is* the person and that fallback is right. Every marketplace
entity is an order, a shop or a parcel, so it would address a federation notice
to whoever happens to hold that number in `persons`. Both new audiences resolve
through a real query and **both return `[]` when they cannot** — a guest
checkout notifies nobody rather than somebody arbitrary.

## Still not done

- **Object storage.** `UPLOAD_STORAGE_URL` is unset, so no file can be attached
  to anything on the platform. The documents slice is built and gated; until
  storage is configured there is no upload control, because a control that
  cannot work is worse than a stated absence.
- **RazorpayX is not verified.** The adapter answers `isConfigured() === false`
  **even with correct credentials**, until `RAZORPAYX_VERIFIED=true` is set by
  somebody who has tested a transfer end to end. `mapPayoutStatus()` maps
  nothing, deliberately, until the provider's status vocabulary is confirmed
  against its documentation rather than guessed. So `payout/send` reports that
  no rail can send money and refuses, and payouts are recorded by hand through
  `payout/paid`.
- **Federation-facing notices.** The events above `member` — payout
  instructions, settlement blocks, payment mismatches, fraud signals — are on
  the feed and read by nobody automatically, because the only consumer draining
  it is capped at `member`. `ADMIN_NOTICES_NOT_WIRED` in
  `src/db/marketplace-events.ts` states this rather than a second consumer being
  invented to look complete.
- **Commission remains unconfigured.** No rule is seeded. A sale MMAKF has
  published no commission for records a `commission_gaps` row, keeps
  `commissionMinor` NULL rather than 0, and blocks the settlement. That is the
  designed behaviour, not a gap in the build.


---

# Addendum III — the producers were never called

Added 23 August 2026, an hour after Addendum II, which did not catch this.

`src/db/marketplace-events.ts` had 21 producers, a catalogue entry for each, a
`NOTIFIABLE` entry for fourteen, two purpose-built audiences and 25 passing
tests. **Nothing in production called any of them.**

Every column of the wiring matrix read ✓. The tests passed, because they called
the producers directly. And not one buyer would ever have been told their order
had shipped, because `checkout()`, `onOrderPaid()`, `shipSellerOrder()`,
`markDelivered()`, `decideReturn()`, `refundReturn()`, `markPayoutPaid()` and
the rest returned without publishing anything at all.

This is the third failure mode in the same subsystem, and they form a sequence
worth keeping:

1. **Producers with no catalogue entry** — `publish()` refuses an unknown type,
   so every producer would have thrown on the first real order. Loud, at least.
2. **Catalogue entries above the consumer's cap** — `consume()` steps over
   anything above `member` without erroring, so eight notices would simply never
   have arrived. Silent.
3. **Producers nothing calls** — no error, no missing notice, no failing test.
   Just a feed that stays empty for ever. Silent, and invisible to every check
   the first two taught us to run.

A test suite that exercises a module directly cannot see (3). What sees it is
asking, of each producer, *who calls this?*

## Where each one is now called

| Producer | Called from |
|---|---|
| `publishOrderPlaced`, `publishSellerOrderPlaced` | `checkout()`, after the seller orders are written |
| `publishOrderPaid`, `publishSellerOrderPaid` | `onOrderPaid()` |
| `publishOrderShipped` | `shipSellerOrder()` |
| `publishOrderDelivered` | `markDelivered()` |
| `publishSellerReturnRequested` | `requestReturn()` |
| `publishReturnDecided` | `decideReturn()` — **both** branches, a refusal included |
| `publishRefundIssued`, `publishSellerRefundPosted` | `refundReturn()` |
| `publishPayoutInitiated` | `createPayout()`, in the success branch only |
| `publishPayoutPaid` | `markPayoutPaid()`, below the already-paid early return |
| `publishSettlementBlocked` | `closeSettlement()`, **before** the throw |
| `publishVerificationDecided` | `decideVerification()` |
| `publishSellerApplied` | `applyToSell()` |
| `publishPolicyPublished` | `publishPolicyVersion()` |
| `publishSellerReviewPublished` | `moderateReview()`, on `published` only |
| `publishFraudSignal` | `raiseFraudSignal()`, only when the insert wrote a row |
| `publishProductReported` | `reportProblem()` in `returns.ts` |
| `publishPaymentMismatch` | `confirmPayment()` in `orders.ts`, before the throw |

Four of those placements are decisions rather than mechanics:

- **A refusal is published.** `decideReturn()` publishes on both branches. A
  buyer is entitled to hear that their return was refused; the producer reads
  the outcome from the row, so the event cannot claim 'authorised' about a
  rejected one.
- **A block is published before the throw.** A settlement nobody can close is
  money a seller is not being paid. If the only trace is an exception shown to
  whichever operator pressed the button, it is gone when they close the tab.
- **A deduplicated fraud signal publishes nothing.** `onConflictDoNothing()`
  returns no row for a signal already raised, and re-announcing it would put a
  second undecided accusation about the same trader on the feed.
- **A mismatch publishes from the authoritative comparison**, in
  `confirmPayment()`, not from the pre-fulfilment `assertGatewayAmount()`. The
  producer self-guards with `NOT_A_MARKETPLACE_ORDER`, so a membership fee
  paid through the same path raises no marketplace event.

## The one that is still not called, on purpose

`publishLowStock()` takes a `noticeKey` and **refuses to run without one**,
because how often a seller should be told their stock is low is a decision
nobody at MMAKF has made. Wiring a sweep here would mean this system choosing a
cadence on the federation's behalf and then notifying real traders on it.
`LOW_STOCK_CADENCE_NOT_SET` states that instead. The producer, its sweep
(`publishLowStockForSeller()`) and its tests are ready for whichever cadence is
chosen.

## Import cycles

`marketplace-events.ts` statically imports `@/db/marketplace` and
`@/db/inventory`, so those two — and only those two — need `await import()` when
calling back into it. `applyToSell()` in `marketplace.ts` and the mismatch call
in `orders.ts` use a dynamic import; the other five modules take a plain
top-level one, because reaching for `await import()` everywhere would hide the
one real constraint behind a habit.

## Verified

Whole suite: **142 files, 4,750 tests, 0 failures.** `npm run build` completes.
`tsc --noEmit` is clean.


---

# Addendum IV — four more things nothing called, and a register nobody could see

Added 23 August 2026, after auditing every marketplace export for a caller.

Addendum III recorded that the 21 event producers were dead code. The same
question — *who calls this?* — asked of every export in the fourteen marketplace
modules found four more, three of them serious.

## 1. A paid marketplace basket did not move

**`onOrderPaid()` was reachable from the test suite and from nowhere else.**

`confirmPayment()` in `src/db/orders.ts` marks the order paid and commits
`product_variants` stock — the legacy shop's columns. A marketplace basket holds
none of those: its stock is in `listing_variants` and its work is in
`seller_orders`. Neither was touched by a real payment.

So a cleared marketplace payment left every seller order at `payment_pending`
for ever, the buyer's reservation committed to nothing and released never, no
dispatch clock started, no seller told they had anything to pack, and no accrual
— therefore no commission, no settlement, no payout. **The money was taken and
the marketplace did not move.**

Nothing failed. The order said `paid`, the receipt was issued, the ledger
balanced, and `tests/marketplace-platform.test.ts` — including the brief's own
critical multi-seller test — passed, because it calls `onOrderPaid()` itself.

Now called from `confirmPayment()` through `fulfilMarketplace()`, after the
commit for the reason `activate()` gives: seller-orders.ts opens its own
transactions, and nesting them would make a failure while committing stock roll
back the record that money was taken. Idempotent and self-guarding — an order
with no seller orders returns `{ updated: 0 }`.

## 2. Abandoned baskets held stock for ever

**`releaseExpiredReservations()` had no caller.**

`expireStaleOrders()` in the reconcile cron releases the legacy shop's holds. A
marketplace basket reserves in `stock_reservations` against `listing_variants`,
with an expiry `checkout()` sets, and nothing released them.

Silent and cumulative: a seller's available quantity fell with every abandoned
checkout and never recovered, until the item read out of stock while the goods
sat on the shelf. No error, no queue, nothing to notice. Now step 1b of
`/api/cron/reconcile`, in its own try/catch so one sweep's fault does not stop
the other.

## 3. The policy register had no screen

`src/db/marketplace-policy.ts` could create the eight documents, draft a version,
publish it, mark it mandatory and record acceptance — five API actions, 25 tests
— and **`policyRegister()`, `policiesForSeller()` and `acceptanceRegister()` had
no caller anywhere.** An officer could publish a seller agreement and had no way
to see that they had; a seller could be required to accept a document they could
not find. An obligation nobody can see is not an obligation.

Built:

- **`/admin/marketplace/policies`** — the eight documents, every version with its
  hash, draft and publish as separate acts, mandatory toggled only with a stated
  reason, and the acceptance register per document. Linked from the console, so
  the page is not itself unreachable. Publishing warns that the text is sealed
  and that sellers who accepted an earlier version become outstanding again.
- **A section on `/portal/seller`** — what the seller has been asked to accept,
  in three distinct states (no text published, published and outstanding,
  accepted), the text itself to read, and an accept button that sends a
  **version id, never a policy code**.

Both surface the hash comparison: the digest is stored on the version and again
on the acceptance, so a published body altered in place stops matching what was
signed, and both screens say so rather than letting it pass.

## 4. And the buyer had nowhere to stand

Found by the same question, and the largest of the four.

The marketplace could take a buyer's money, split their basket across sellers,
accept a return, record a report and raise a dispute — `return/request`,
`report/create` and `dispute/raise` are all buyer actions on the API, all
tested. **`orderForBuyer()` had no caller anywhere in `src/`, and there was no
page under `/my` for an order at all.**

So a buyer could be sold goods and then could not see the order, could not tell
whether it had been dispatched, and could not ask to return it. The remedy
existed in the engine and was unreachable by the only person entitled to use it.

Built: **`/my/orders`** — the buyer's own orders, resolved from the session with
no identifier in the URL. Each basket shows the shops it was split across, each
shop's progress in a buyer's words, the lines, and the consignments. From it a
buyer can ask to return items and report a problem to MMAKF.

Three things it is careful about:

- **Tracking is not faked.** A number appears only where a seller recorded one;
  otherwise it says the parcel was dispatched without tracking, because
  "dispatched" and "dispatched, here is where it is" are different promises.
- **The return window is not invented.** Whether a return may be asked for is
  the engine's decision against the policy frozen onto the order. The page
  offers the request and lets `requestReturn()` refuse it in its own words,
  rather than computing an eligibility rule that would immediately disagree with
  the one that matters.
- **A dispatch deadline is never shown as a delivery date.** An SLA is the
  seller's commitment to MMAKF, not a promise to the buyer.

## The guard

`tests/marketplace-wiring.test.ts` — six tests:

- a real payment, confirmed through `beginPayment()` → `confirmPayment()` and
  **not** `onOrderPaid()` by hand, pays both sellers' orders, commits the stock,
  publishes the seller's event, and does none of it twice on a replay;
- **every marketplace event producer has a caller in `src/`**;
- the stock-expiry sweep has one, and it is the cron;
- the marketplace fulfilment step has one, and it is `orders.ts`.

The reachability tests read the corpus once rather than re-reading 397 files per
producer — the first version took four minutes and failed in a full-suite run
while passing alone, which is the signature of a test that races rather than one
that has found something.

`publishLowStockForSeller()` is exempted **with its reason in the assertion**: it
takes a notice key because how often a seller is told their stock is low is a
decision MMAKF has not made, and choosing a cadence here would be this system
notifying real traders on its own authority.

## Verified

Whole suite green, `tsc --noEmit` clean, `npm run build` completes.


## 5. The fraud queue could only ever be empty

Two more with no caller, found in the same pass and wired as step 8 of
`/api/cron/reconcile`:

- **`detectReviewPatterns()`** — the admin console has a fraud-signal queue that
  nothing could ever put anything into. It raises a SIGNAL and decides nothing:
  four or more reviews averaging 4.75+ from one buyer against one seller in
  fourteen days is worth a person's look, and is also what a delighted dojo
  owner buying six things looks like. Its window and thresholds were already
  chosen inside the module, so calling it adds no decision — and its signals now
  reach the feed too, through the `publishFraudSignal()` wiring above.
- **`computeAllPerformance()`** — every seller row carries a performance band
  that had never been written since the column was added.

The performance sweep is the one place in this round where a figure had to be
chosen: a snapshot must be *of* some period, and the function requires one. The
trailing 30 days is stated in the code with its reasoning rather than left
implicit, and it is defensible only because **nothing enforces on the result** —
the module says so outright ("NOT read by any enforcement path — there is none"),
and a seller with too few completed orders gets a null score and
`PERFORMANCE_NOT_COMPUTED` rather than a number computed from a sample too small
to defend. If performance ever gains consequences, that window stops being a
reporting detail and belongs in configuration.

## What is still unreferenced, and why that is now correct

31 exports across the fourteen marketplace modules have no caller outside their
own file. They were checked one at a time and fall into three groups:

- **Internal helpers exported for testability** — `matchZone`, `priceMethod`,
  `basisForLine`, `normaliseFilters`, `assertBrowsablePath`, `resolveCommission`,
  `refreshSellerRating` and the like. Called within their module; exported so a
  test can reach them directly.
- **Deliberate** — `publishLowStock` and `publishLowStockForSeller`, which take
  a notice key because the cadence is a federation decision nobody has made.
- **Read surfaces nobody has asked for yet** — `mySellerOrder`,
  `sellerOrdersForAdmin`, `movementsForVariant`, `importsForSeller`,
  `updateZone`. Each is a screen that does not exist: a seller can create a
  shipping zone but not edit one, and there is no stock-movement ledger view.
  Recorded here rather than built, because none of them leaves a user unable to
  complete a journey — unlike the four in Addendum IV, every one of which did.

---

## BUILT — the seventh wave: the federation's own people

**6 September 2026.** Migrations `0056_federation_team.sql` and
`0057_data_api_lockdown.sql`; `src/db/team.schema.ts` and `src/db/team.ts`;
`blackBeltRegister()` / `blackBeltFacets()` in `src/db/grading.ts`; the surfaces
`/team`, `/black-belts` and `/admin/team`.

**46 tests**, in `tests/team.test.ts` (32) and `tests/black-belt-register.test.ts`
(14), all passing against a real Postgres (PGlite) with all 57 migrations
applied. `npx astro build` exits 0. `tests/navigation.test.ts`,
`tests/routes-live.test.ts` and `tests/accessibility.test.ts` pass at 495 —
run **after** the three new pages were added and **before** any claim here.

### The gap this closed

The federation had three registers of people and none of them held the people who
run it. `committees` holds offices under the constitution; `role_bindings` holds
what a login may do; `persons` holds members and their grades. The media desk,
the competition office and every state coordinator had nowhere to sit.

The two available workarounds were both bad in ways that do not undo. Inventing a
fourth people table is how one human being ends up with two records and a
certificate issued against the wrong one. Filing a content editor under
`committees` states, publicly, something false about their standing.

| Work | Where | What it changes |
|---|---|---|
| **The establishment** | `departments`, `team_appointments` | Every row hangs off `persons.id`. There is no second name column anywhere in the migration, because the same human being is routinely an employee, a Sensei, a Black Belt and an official at once. |
| **Publication as an act** | `team:publish`, `team_appointments_publish_ck` | Recording a post and putting somebody's face on www.mmakf.in are separate authorities. A STATE_ADMIN holds the first and not the second. The CHECK refuses to publish anything not `active`, so a draft, a suspended officer or somebody who left cannot reach `/team` **even by a direct UPDATE** — a test asserts it by bypassing the module. |
| **A register with nowhere to leak from** | migration 0056 | No salary, no private phone, no government id, no bank detail, no HR note — not as a nullable column and not as a jsonb blob. A test reads `information_schema` and fails on any column whose name contains one of thirteen forbidden strings. `public_contact` is an OFFICE ROUTE and the admin screen says so in words, because no code can tell a desk number from a mobile. |
| **The version trail** | `team_appointment_history` | `audit_events` answers "who unpublished the Finance Officer on 3 March". This answers "what did the page say about her that morning", which is what gets asked when somebody produces a screenshot. Append-only, asserted by reading the module's source. |
| **The Black Belt register** | `blackBeltRegister()`, `/black-belts` | Derived from active Dan rank records. Filterable by name, Dan, state, year and provenance, with facets **derived from the rows that exist** so no filter offers a choice returning nothing. |
| **Three RBAC actions** | `src/lib/rbac.ts` | `team:read`, `team:write`, `team:publish`. MEDIA_OFFICER gets `team:read` only — the press office writes *about* the federation and does not decide who speaks for it. |
| **Six domain event types** | `src/lib/domain-events.ts` | Five at `official`; `TEAM_APPOINTMENT_SUSPENDED` at `restricted`, because `official` is every dojo administrator in India and "a named officer is under review" must not reach them. |

### `publicRegister()` was written, unwired, and its docstring was wrong

`publicRegister()` in `src/db/grading.ts` has had **no caller anywhere in `src/`**
since wave 2c. Its docstring said a person appears only if they hold "an active
membership and an active rank". The query joins `rank_records` and filters
`persons.status`; it has never touched `memberships`.

Corrected in place rather than deleted, and the behaviour deliberately **not**
tightened to match the comment: whether a lapsed membership should strip somebody's
rank from a public register is MMAKF's decision, not a comment's. It is the more
dangerous direction for a comment on a public register to be wrong in — a reader
checking whether a lapsed member could appear would have been told no on the
strength of a join that does not exist.

`blackBeltRegister()` is a new, Dan-only, filterable read. `publicRegister()` is
left as it is and still has no caller.

### What this wave deliberately does NOT do

- **NOBODY IS TOLD THEY WERE PUBLISHED.** The six events are on the feed and
  nothing walks it — the same gap as queue item 2, now with six more producers.
  Putting a real person's name and photograph on the public internet without
  telling them is a genuine shortcoming and is recorded as one rather than
  softened.
- **A PERSON CANNOT SEE THEIR OWN APPOINTMENT.** There is no `/my/appointments`.
  The domain read exists — `personRelationships()` gathers appointments, ranks,
  instructor qualifications and memberships under one `persons` row — and no
  self-service surface calls it. So the person on the page has no in-system way
  to ask for a correction.
- **THE PUBLIC PAGE HAS NO STRUCTURED DATA.** No `Organization` /
  `OrganizationRole` JSON-LD is emitted for `/team`, and none is emitted for
  `/black-belts`. `src/lib/seo.ts` was not touched. §28 asked for structured data
  "only where truthful", and the truthful version needs a decision about whether
  MMAKF asserts `Person` entities publicly, which nobody has taken.
- **`/people` STILL READS THE CONTENT STORE.** It was not migrated onto the new
  register and it was not deleted. It is an editorial page about technical
  leadership, `/team` is a derived register of the operation, and collapsing the
  two without the federation deciding which people belong where would move real
  names between pages on a developer's judgement.
- **NO ORG CHART.** `departments.parent_id` is self-referencing and cycle-checked,
  and nothing renders a hierarchy. `/team` groups by `org_level`, which is flat.
- **IT SEEDS NOTHING.** Not one department, not one appointment. Both surfaces
  report that MMAKF has not published its team, which is true.

### Same wave: the public teaching faculty

`publicFaculty()` and `facultyFacets()` in `src/db/coaches.ts`; `/teachers`,
linked from `PUBLIC_NAV` under Training. **13 tests** in
`tests/teaching-faculty.test.ts`.

The coach domain was already built and complete — application, stages,
qualifications, safeguarding exclusion, assignment, double-booking prevention —
and had **no public surface at all**. A visitor could not find out who teaches
for MMAKF.

**The rule the whole surface is built around:** `coach_profiles.dan_grade` is
free text an applicant typed about themselves; `rank_records` is the federation's
examination register. Printing the first under the MMAKF masthead as though it
were the second is how a federation publishes credentials it never awarded — the
exact failure `/verify` exists to end. So they travel as two named fields,
`verifiedGrade` and `statedGrade`, and the page:

- renders the verified grade as a credential, saying whether it traces to a
  recorded examination or is a legacy record;
- renders the stated one **only** when there is no verified grade, in a visibly
  different (dashed, differently coloured) block, labelled "Not verified by
  MMAKF";
- never fills an absent verified grade in from the stated one.

A test asserts the data separation with a profile whose stated grade
(`Godan`) deliberately disagrees with the register (`Yondan`), and a second
asserts the page renders the two through different CSS classes.

**Safeguarding clearance is deliberately absent, in both directions.** It is the
most important thing a parent wants to know, and publishing "cleared" would make
its ABSENCE a public statement that a named instructor is not cleared to work
with children — published by omission, with no process behind it and no way for
the person to answer it. The real control is unaffected: an uncleared coach is
still not assignable to work with minors. The page carries a standing note
telling a parent to ask the federation, so the silence is explained rather than
left as a gap for them to fill with the worst reading.

**One defect found and closed while writing it:** `publicFaculty()` filters on
`suspended_at IS NULL` **as well as** `status = 'active'`. A suspension that set
the timestamp and left the status behind would otherwise have kept a suspended
instructor in front of parents looking for a teacher. A test covers exactly that
row.

### Reviewing the wave against itself found two defects, both mine

Recorded in full, because the point of this file is to be checkable and because
both were in code that read as correct on the page.

They are the **same class** of mistake the sixth-wave adversarial review found in
`decideDuplicate()`: a gate that asks *"does this caller hold the action
SOMEWHERE"* standing in for one that should ask *"may they do it HERE"*.

| Severity | Defect | Fixed |
|---|---|---|
| **High** | `publishAppointment()` and `unpublishAppointment()` gated on `assertCanAnywhere('team:publish')`. GENERAL_SECRETARY carries that action, and a role can be bound at a STATE — so **a state-bound secretary would have passed the gate and could then publish or withdraw any appointment in the country by id**, the national secretariat's own included. The module's header already said `/team` is a national page; the code did not check it. | `assertNationalPublish()` requires `visibleScopes(...).kind === 'all'`. Two tests, one for publish and one for withdraw. |
| **Medium** | `personRelationships()` gated the whole function on `team:read` and returned ranks, instructor qualifications and memberships. MEDIA_OFFICER holds `team:read` and neither `rank:read` nor `membership:read` — so **the press office could read the rank and membership history of anybody in the federation by walking person ids.** | Each section behind the action that governs it, following the `/my/family` pattern. A withheld section returns `null`, never `[]`, so a surface can say "not yours to see" instead of implying a 5th Dan holds no grades. |

**Neither was reachable through the GRANTS table as it stands today**, and that is
precisely why they are worth pinning rather than quietly correcting: the code was
safe because of who happens to hold what, not because of what it checked. One
binding at a different scope, or one action added to a role, and both open. The
second one needed no new binding at all — only for somebody to call the function
from a screen a MEDIA_OFFICER can reach, which is a change a future author would
make without thinking about it.

`tests/team.test.ts` carries four tests for these, bringing that file to 36.

---

## PRODUCTION FAULT — every form on the site was refused

**Reported 6 September 2026** ("this showing from months"), reproduced against
`www.mmakf.in` the same day. Two separate defects, one of which is not ours.

### 1. The cause: Vercel's edge blocks form-encoded POSTs

Every POST carrying an encoding an HTML form can produce is answered

```
403  Cross-site POST form submissions are forbidden
```

**That string is not in this repository and never has been** — `git log -S`
finds no commit containing it, and the middleware's own refusal reads
`{"error":"Request refused"}`. It is Vercel's, emitted at the edge.

The evidence, run against production:

| request | result |
|---|---|
| `POST /start/individual` urlencoded | 403 `Cross-site POST form submissions are forbidden` |
| …plus `Origin` + `Sec-Fetch-Site: same-origin` | 403 — a *perfectly formed same-origin* submission |
| `POST /robots.txt` | 403 — **a static file. No function runs.** |
| `POST /no-such-path-xyz` | 403 — before routing |
| `POST` multipart / `text/plain` / no content-type | 403 |
| `PUT /start/individual` | 403 `{"error":"Request refused"}` — **our** message |
| `POST` `application/json` | reaches the function |
| `GET /start/individual` | **200** |

So the rule is keyed on CONTENT TYPE, applies before the application, and
`application/json` is the only body that gets through. Which means **a plain
`<form method="post">` could not work anywhere on this deployment** — not the
institutional intake, not registration, not a single admin write.

**THE ACTUAL FIX IS A VERCEL PROJECT SETTING and only the account holder can
make it.** Nothing in this repository can turn that rule off.

### 2. What was fixed in code, so the site works meanwhile

`src/lib/form-intake.ts` — `readSubmission(request)` reads a submission
whichever way it arrives and always returns a `FormData`, so all **31** page
handlers changed by one function name and nothing else. Their
`String(form.get(k) ?? '')` helpers and checkbox tests are untouched.

`src/scripts/form-upgrade.ts`, loaded once from `Base.astro` — intercepts
same-origin form posts and re-sends them as `application/json`.

**This is not a CSRF hole.** The middleware still runs its origin check on
every mutating request, unchanged, and `/api/` paths still require JSON as they
always have — a cross-site form cannot send `application/json` without a CORS
preflight this application never answers, which is the property that rule was
always built on. A live test asserts an `/api/` route still refuses a
form-encoded body.

**It does break the no-JavaScript guarantee, and that is stated rather than
hidden.** While the edge rule stands, a no-JS submission cannot reach the
application at all — with or without this code. The choice was between forms
working for everybody running JavaScript and forms working for nobody.
**When the Vercel setting is changed, `src/scripts/form-upgrade.ts` should be
deleted** and nothing else undone.

### 3. A second, genuine defect found underneath it

`src/middleware.ts` passed `url.host` into `isSameOrigin()`. That same file
records, twenty lines above the call, that **behind Vercel's proxy `url.host` is
the internal invocation host** — it is why `publicHost` exists there.

So `isTrustedHost(host)` was asking whether an internal Vercel hostname is one
of the federation's public hosts. It never is. The `same-site` branch could
never be satisfied, and every POST crossing the apex-to-www redirect was refused
**by our own middleware** — the exact fault `eb1004e` had already fixed once and
believed closed.

It went unnoticed because the unit tests pass `'www.mmakf.in'` as `host` by
hand, and **no test ever called the function with the value the caller actually
supplies.**

Fixed by making the decision rest on the INITIATOR allowlist, which is where the
protection always came from: `Origin` and `Sec-Fetch-Site` are browser-set and
unforgeable by script, and the host a request arrived on adds nothing. Also
fixed: `initiator()` returned null on the first unparseable header, so an opaque
`Origin: null` discarded a good `Referer` behind it.

`employee.mmakf.in` was added to `TRUSTED_HOSTS` in the same change — a surface
missing from that list has every form on it refused, which is this same bug.

**11 unit tests** in `tests/hardening.test.ts` now call the function with the
internal-host shape the caller really passes, and **5 live tests** in
`tests/routes-live.test.ts` prove it over HTTP, including that a hijacked
sibling subdomain and a genuine cross-site POST are still refused.

### What the operator has to do

1. In the Vercel project, find the setting producing
   `Cross-site POST form submissions are forbidden` — check **Deployment
   Protection** and **Firewall** — and turn it off for this project.
2. Confirm with:
   `curl -sS -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "p=1" https://www.mmakf.in/robots.txt -o - -w "\n%{http_code}\n"`
   A 403 with that message means it is still on; anything else means it is off.
3. Then delete `src/scripts/form-upgrade.ts` and its `import` in `Base.astro`.
