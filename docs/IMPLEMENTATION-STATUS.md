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
ls tests/*.test.ts | wc -l          79 files
npx vitest run                      2,670 passing
ls drizzle/*.sql | wc -l            12 migrations
grep -c 'CREATE TABLE' drizzle/*    144 tables
find src/pages -type f | wc -l      130 route files
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
