# Implementation queue

What to build next, in order, and why that order.

Read [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) first — it says what
exists. This file says what does not, and what each item unblocks.

---

## Ordering principle

**Surfaces before new domains.** Eleven capabilities are fully modelled, typed
and tested with no page in front of them. Building a twelfth domain adds nothing
the federation can use; building a page in front of an existing one adds a
capability the same day.

Every item below is a surface over something that already works.

---

## 1 — Coach application form

`applyAsCoach()` and `applyAsCoachWithAutomation()` exist, are tested, and
create the candidate record, the screening task and the acknowledgement. Nothing
calls them from a page.

- `/learn/coaches` — the audience page (currently in the nav, not built)
- `/learn/coaches/apply` — the form
- `POST /api/learn/coach-application` — following the two-callers-one-core
  pattern in `api/learn/application.ts` so it works without JavaScript

**Unblocks:** the entire recruitment pipeline, which currently has an admin
screen and no way for anybody to enter it.

---

## 2 — Institution client portal

`institution_users` links a federation login to a client; the `institution` RBAC
scope already gives `INSTITUTION_ADMIN` and `INSTITUTION_COORDINATOR` a tenant
that contains no federation resource.

- `/learn/portal` — dashboard
- programmes, sessions, attendance, documents, quotes, invoices, support
- invitation flow: staff invite a named contact, who registers through the
  existing `registerAccount()` and is bound at institution scope

**Unblocks:** PART Z entirely. **Watch:** the tenant isolation test must come
first — Institution A must not reach Institution B by guessing an id.

---

## 3 — Quotes and proposals

`issueQuote()`, `reproduce()` and `explainQuote()` all work and are tested. The
fee framework ships empty, so the first useful screen is the one that lets the
federation **author** a framework.

- `/admin/fees` — author a framework, add rules, publish (publishing is
  irreversible; the screen must say so)
- `/admin/quotes` — issue, approve, send
- itemised quote view for the client portal

**Unblocks:** every fee in the system. Currently every path ends at "request a
quotation" because there is nothing to calculate from.

**Blocked on the federation:** the actual rules.

---

## 4 — Bookings, calendar and attendance

`bookings`, `coachAvailability`, `programSessions`, `programAttendance` and the
collision detection are all built.

- `/admin/bookings` — day/week/month/agenda
- `/admin/venues`
- `/admin/attendance` — session register, with the correction trail
- coach's own calendar on the learn surface

**Unblocks:** PART J, PART N, PART Y and the delivery half of every programme.

---

## 5 — CRM and programme surfaces

- `/admin/leads` — the pipeline, `leadPipeline()` already returns it
- `/admin/programs` — the template builder with its
  draft → under_review → approved → published → archived lifecycle

---

## 6 — Workflow inspection

`/admin/workflows` — definitions, runs, steps, failures, retries.

Small, and disproportionately valuable: it is how the federation answers *"what
did the system do on our behalf?"* without reading TypeScript.

---

## 7 — The rest of the SEO landing pages

Three exist (`/karate-for-schools`, `/karate-for-corporates`,
`/karate-for-universities`). The directive lists twenty-two.

**Build only those where MMAKF genuinely provides the service**, each with
substantive content. `/karate-training`, `/karate-grading`,
`/karate-certification`, `/womens-self-defense`, `/childrens-karate`,
`/karate-seminars` are defensible. City pages are **not** until the federation
confirms where it operates — PART BA calls a page built to capture a keyword
rather than to inform a reader a doorway page.

---

## 8 — External calendar sync

`calendarConnections`, `calendarEvents` and `calendarSyncLog` exist. Needs
Google and Microsoft OAuth. MMAKF stays the system of record for MMAKF bookings;
external calendars mirror.

---

## Not queued, and why

| | |
|---|---|
| **HR module** | `hr:*` actions and `HR_OFFICER` exist; no tables. Needs the federation to say what it wants recorded before anything is designed. |
| **Participant and parent portals** | Depend on the institution portal existing first. |
| **Network map / data visualisation** | Cosmetic until the register holds more than seven entries. |
| **Design rebuild of pre-existing pages** | Real work, but every page listed above is a capability the federation does not currently have. Pages that merely look dated come after pages that do not exist. |

---

## Standing debt

- `drizzle.config.ts` points at `src/db/schema.ts` alone, so `drizzle-kit
  generate` sees one of ten schema files and would emit `DROP TABLE` for the
  other 117. Migrations are hand-written because of this. Either point it at all
  schema files or document the prohibition in the config itself.
- `drizzle/meta/*_snapshot.json` exists for 6 of 12 migrations. Harmless today
  (the runner sorts by filename and ignores the journal) but it means the
  drizzle tooling cannot be trusted here at all.
- No email transport. Messages render and queue correctly; nothing sends them.
