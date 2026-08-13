# Implementation status

**Honest accounting, updated 13 August 2026.**

This file exists because the question was asked directly — *"have you implemented
this prompt fully or again summarised?"* — and the answer then was "about half",
after a period of describing the work in a way that blurred that.

So: what is built, what is scaffolded, and what is not started. A row saying
BUILT means it has tests and has been exercised against a real Postgres or a real
HTTP request. Nothing is marked BUILT because a page or a table exists.

---

## Numbers

| | |
|---|---|
| Database tables | **144** (117 before this session) |
| Migrations | 12, all applied through the production runner in CI |
| Tests | **2,226** across 68 files, all passing |
| Routes | 105 |
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

---

## SCAFFOLDED — data model and domain logic exist, no surface yet

These have tables, typed functions and tests. What they do not have is a page.
They are **deliberately absent from the admin menu** rather than listed and
broken — see the note in `ADMIN_GROUPS`.

| Capability | Model | Missing |
|---|---|---|
| CRM pipeline | `leads`, `leadActivities`, `leadPipeline()` | `/admin/leads` |
| Quotes and proposals | `quotes`, `quoteVersions`, `quoteLines`, `proposals`, `issueQuote()`, `explainQuote()` | `/admin/quotes` |
| Programme management | `trainingPrograms`, `programTemplates` | `/admin/programs` |
| Bookings and calendar | `bookings`, `bookingResources`, `coachAvailability` | `/admin/bookings` |
| Venues | `venues`, `venueBlackouts` | `/admin/venues` |
| Attendance | `programSessions`, `programAttendance` | `/admin/attendance` |
| Contracts | `contracts` | Surface, and the quote → contract transition |
| Client documents | `clientDocuments` | Storage binding and the portal view |
| Institution client portal | `institutionUsers` + institution RBAC scope | `/learn/portal` |
| Workflow inspection | `workflowRuns`, `workflowSteps` | `/admin/workflows` |
| External calendar sync | `calendarConnections`, `calendarEvents`, `calendarSyncLog` | Google/Microsoft OAuth |

---

## NOT STARTED

- Coach application form on the learn surface (`applyAsCoach()` exists and is
  tested; nothing calls it from a page yet)
- Participant and parent portals (PART AA, AB)
- Institutional analytics surfaces (PART V)
- HR module (PART X) — `hr:*` actions and `HR_OFFICER` exist; no tables
- Network visualisation and India map
- Data export (CSV/XLSX/PDF)
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
