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
