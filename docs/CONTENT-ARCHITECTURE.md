# CONTENT-ARCHITECTURE — every route, its audience, its source, and what it says today

**This document records what exists.** Every route below was requested against a live
`npx astro dev` on branch `wave-2b-federation` (Astro 5.18.2, Node v25.9.0, **no `DATABASE_URL`, no
Redis credentials**). Data sources were read from the `---` frontmatter of each page. The
empty-state text is quoted from the rendered HTML, not from memory.

> **Currency.** First written against committed state `9d67c09`; re-checked against the **working
> tree** on 2026-08-12 (dev server on port 4433, all 42 route paths re-requested). One route has
> been added since — `/people/[slug]` — and is folded in below. Route counts move almost daily on
> this branch; re-run `find src/pages -name "*.astro"` before quoting one.

**Caveat on the "same as production" claim.** The local configuration here is *no Redis and no
Postgres*. Production has Redis (`/api/health` reports `{"redis":true,"database":"not_configured"}`),
so **the Class A behaviour observed locally is the in-memory fallback path, not the production
path**. The conclusion in §1 is unaffected — `get()` returns `SEED[key]` in both cases when the
office has never written the key — but the two paths are different code and only one of them was
exercised here.

---

## 1. The single most important fact about this information architecture

**There are two content architectures on one site, and they behave in opposite ways when they have
no data.**

| | **Class A — editorial** | **Class B — system of record** |
|---|---|---|
| Store | Redis (Upstash), one key per topic | Postgres via `postgres.js` |
| Reader | `get()` / `getAll()` from `@/lib/storage` | `db` from `@/db`, guarded by `isConfigured()` |
| Routes | 19 | 24 |
| **Behaviour with no data** | **falls back to `src/data/seed.ts` and renders it as ordinary page content** | **renders a named, explained, unmistakable "not configured" state** |
| What a visitor sees today | a complete, confident federation website | an honest account of what cannot yet be shown |

Class B is exemplary. `/scoreboard` says: *"Rather than show an empty board that looks like a
competition with no points, this page states plainly that there is nothing to read."* `/live` says:
*"Rather than show an empty schedule that might read as 'no classes are running'…"*. That is the
project's rule working exactly as specified.

Class A does the opposite, by design of the storage layer rather than by anyone's decision:
`storage.get(key)` returns `SEED[key]` whenever Redis is absent **or** whenever the office has never
saved that key. There is no marker on the page distinguishing a value the federation published from
a default that shipped in the repository. `/belt-system` prints ten kyu grading fees in rupees;
`/schedule` prints twelve named batches with named instructors; `/governance` prints a register of
office bearers with grades and serving-since dates; `/programs` prints nine programs with monthly
prices. All of it renders identically whether it came from the federation or from `seed.ts`.

`docs/MMAKF-SYSTEM-AUDIT.md` already classifies one instance of this — the member register, "seven
hand-typed rows in `seed.ts`" behind `/api/verify`, marked **H / MOCK**. The finding here is that
the same condition applies to **every Class A route**, and that nothing in the UI carries the
distinction. This is recorded as finding **CA-1** and is not fixed here: `src/data/seed.ts` and
`src/lib/storage.ts` are outside this stream's file ownership.

---

## 2. Class A — editorial routes (Redis, `seed.ts` fallback)

All 19 render `200` (`/people/[slug]` for a recorded name; an unrecorded name correctly `404`s).
None has a "no data" state, because none can reach one.

| Route | Audience | Purpose | Source (`storage` keys) | Data today | If the key were empty |
|---|---|---|---|---|---|
| `/` | prospective student, parent, press | The federation's front door: hero, stats, programs, news, events, gallery strip | `getAll()` — all 25 keys | seed | sections render with seed rows |
| `/about` | prospective member, press | Lineage, story, leadership, achievements | `federation`, `leadership`, `achievements`, `testimonials`, `programs` | seed | no empty state exists |
| `/governance` | member, unit, journalist, regulator | Office bearers, committees, documents register | `federation`, `leadership`, `documents` | seed | **the office-bearer table would render empty with no explanation** |
| `/affiliation` | a club or state wanting to affiliate | The national ladder, branches, state units, how to charter | `federation`, `branches`, `stateUnits` | seed | tables render empty |
| `/programs` | prospective student | Nine training pathways with monthly prices | `federation`, `programs` | seed | grid renders empty |
| `/schedule` | current student | Weekly timetable, twelve batches | `federation`, `schedule`, `programs` | seed | table renders empty |
| `/belt-system` | student, parent | Kyu/Dan structure, syllabus table, grading fees | `federation`, `beltGrading`, `syllabus`, `programs` | seed | fee tables render empty |
| `/academy` | remote student | Online curriculum: courses, lessons, live sessions | `federation`, `courses`, `lessons`, `programs` | seed | lesson table renders empty |
| `/events` | member, competitor | Calendar, news, results archive | `federation`, `events`, `news`, `results`, `programs` | seed | `upcomingEvents()` / `pastEvents()` return nothing |
| `/facilities` | prospective member, parent | What the hombu dojo has | `federation`, `facilities`, `programs` | seed | grid renders empty |
| `/faq` | prospective student, parent | Plain answers to entry questions | `federation`, `faqs`, `programs` | seed | accordion renders empty |
| `/gallery` | prospective member, press | Categorised images of the federation at work | `federation`, `gallery`, `programs` | seed | grid renders empty |
| `/contact` | anyone | Address, phone, both email addresses, hours, enrolment form | `federation`, `programs` | seed (real contact details) | contact block renders empty |
| `/press` | journalist, sceptic, member | Scanned clippings and official channels | `press`, `social`, `federation` | seed | **filtered — entries without a valid image are dropped** |
| `/shop` | member | Published equipment catalogue with prices | `products` + Postgres products when configured | seed catalogue | catalogue renders empty |
| `/registration` | applicant | The four membership categories, the application form, the ID verifier | `federation`, `stateUnits`, plus `redisHealthy()` | seed | state dropdown empties |
| `/regulations` | official, instructor, member | Class A external rulebooks vs Class B MMAKF's own documents | `federation` + a page-literal register of 22 external links | link register is page-literal | n/a |
| `/people/[slug]` | journalist, regulator, prospective member | One person's profile: title and grade stated **apart**, honours rendered with the source each was recorded from | `leadership`, `schedule`, `programs`, `press`, `social`, `federation` | seed | `404` — a slug that matches no recorded name returns "No such profile" rather than an empty page. **This is the only Class A route with a real not-found state**, because it matches a slug rather than rendering a list |
| `/404` | anyone | Not-found, with three ways back | none | n/a | n/a |

`/press`, `/regulations` and `/people/[slug]` are the Class A routes that **carry their provenance
on the page**, and they are the model the others are not following. `/people/[slug]`'s header
comment states the rule outright: *"nothing here is written by the page. Every line is a field the
federation recorded, and an honour renders WITH the source it was recorded from. A field the
federation has not recorded renders as absent — never as a placeholder, an approximation, or a stock
photograph."* Note the tension with **CA-1**: the fields it renders so carefully still come from
`seed.ts` today.

- `/press`: *"A clipping is evidence that a newspaper printed something. It is not, on its own,
  independent confirmation of what was reported. Every entry below carries a `verification` line
  recording exactly what the federation has established — nothing here should be read as more than
  that line states."* One entry reads *"Clipping held · outlet and date unconfirmed"* because the
  masthead is cropped from the scan.
- `/regulations`: *"nothing on this page is a summary of a rule — the rule is whatever the linked
  document says"*, and it separates **Class A — other organisations** ("MMAKF did not write these
  documents and cannot amend them") from **Class B — MMAKF's own** ("The federation's constitution,
  conduct, safeguarding, grading, selection and disciplinary instruments. These are MMAKF's to
  author and adopt"), with MMAKF's own instruments listed as **not yet published**.

---

## 3. Class B — system-of-record routes (Postgres)

All render `200` (except `/athlete/[id]` with a non-ID, which correctly returns `404`). None carries
any data today, because `DATABASE_URL` is unset. Every one names that fact.

### Public registers

| Route | Audience | Purpose | Source | State today | Exact words |
|---|---|---|---|---|---|
| `/athletes` | parent, employer, opponent's coach, journalist | Look up one member by federation ID; browse only with authority | `searchAthletes()`, `athletes` schema | `not_configured` | *"The federation records database is not configured for this deployment, so the register…"* — plus the standing rule: *"The register cannot be browsed in bulk, and that is deliberate."* |
| `/athlete/[id]` | anyone with an ID | One public register entry with provenance per fact | `publicAthleteProfile()` | `not_configured` / `bad_id` / `not_found` | with `/athlete/1`: *"Not a federation ID. … A federation ID looks like `MMAKF-MEM-2026-000001` and is printed on a membership card and on a certificate."* |
| `/dojos` | prospective student, parent | Every chartered dojo, district and state unit with its standing | `publicDirectory()` | `not_configured` | *"The affiliation register is not available in this environment — the federation records database is not configured for this deployment, so this page cannot read the affiliation register."* Page also states the invariant: *"A unit whose charter has lapsed is not removed from this page; it is shown as lapsed."* |
| `/officials` | tournament organiser, unit secretary | Who is licensed to officiate, examine and instruct, as at today | `publicOfficialsDirectory()` | `not_configured` | *"Register not available."* Page also warns: *"If you are appointing an official for an event in the future, this page cannot answer for that day — a licence current today may lapse before the event."* |
| `/rankings` | athlete, selector, journalist | Published rankings with the whole working kept | `rankings` schema | `not_configured` | *"Rankings are not available in this environment — the federation records database is not configured for this deployment, so no ranking table can be read."* Thesis on the page: *"A ranking nobody can audit is a ranking nobody should trust."* |
| `/competitions` | competitor, coach, spectator | Events, entry lists, draws, final results | `publicEvents()` / `publicEventDetail()` | `not_configured` | *"The competition register is not yet available. Competition records — events, entries, draws and results — are held in the federation database, which is not configured on this deployment. Nothing is shown here rather than a placeholder standing in for a…"* |
| `/scoreboard` | **referee and table official at the mat side**, spectator | Per-mat live scores, polled every 12s | `publicScoreboard()` | `not_configured` | *"The scoreboard has no record to read. … Rather than show an empty board that looks like a competition with no points, this page states plainly that there is nothing to read."* Header states: *"This board is polled every 12 seconds. It is not a live feed — what you see is the official record as at the time above."* |
| `/verify` | parent, employer, another federation | Check a member ID or certificate number, with a stated provenance grade | `/api/verify` (client fetch) | form renders; the answer comes from Redis `members` (7 seed rows) | *"This check runs in your browser, so JavaScript must be enabled. If you cannot enable it, write to admin@mmakf.in…"* Grades results as **Examined** / **Legacy record** / read from the old hand-maintained register |
| `/live` | enrolled student | Live class, attendance, questions | `liveNow()`, `upcomingClasses()`, `liveClassQuestions()` | `not_configured` | *"The classroom is not available on this deployment. Classes, attendance and questions are federation records, and no federation database is configured here."* Also: *"Automatic broadcast detection is not configured"* when YouTube OAuth is absent |
| `/checkout` | buyer | Basket, delivery details, order placement | `orders`, `paymentStatusReport()` | order system not connected | *"Online ordering is not live yet. The federation's order system is not connected on this deployment, so an order cannot be created or paid for here. **Nothing you entered has been charged or recorded.**"* |
| `/application` | applicant | Check a submitted application by reference + access code | `/api/application` | Redis-backed queue | *"A lost access code cannot be recovered. The office cannot resend or reset an access code, and that limitation is exactly what keeps this check private…"* |

### Member area

| Route | Audience | Purpose | Source | State today | Exact words |
|---|---|---|---|---|---|
| `/my` | signed-in member | Landing: passport summary, courses, live classes | `identify()`, `athletePassport()`, `courseProgress()` | `not_configured` | *"Not available on this deployment. The member area reads the federation's system of record, and no federation database is configured for this deployment. **Nothing can be shown — not an empty record, and not a placeholder one.**"* |
| `/my/passport` | signed-in athlete | Grades, certificates, results, derived at request time | `athletePassport()` | `not_configured` | *"The passport is derived from the federation's system of record at the moment it is asked for. No federation database is configured for this deployment, so there is nothing to derive it from."* Carries the provisional-result rule: *"Provisional results — not yet published by the federation"* |
| `/my/courses` | enrolled student | Enrolments, lesson progress, quiz attempts | `@/db/academy` | `not_configured` | *"Enrolments, lesson progress and quiz attempts are federation records, and no federation database is configured for this deployment. Nothing can be enrolled on and nothing recorded."* |

### Administration

All nine admin routes render a **sign-in form** to an unauthenticated request. Eight authenticate a
person (`identify()` from `src/lib/session.ts`, then `can()` / `canAnywhere()` / `visibleScopes()`
from `src/lib/rbac.ts`, roles resolved from the database on every request). One — `/admin` — is
still gated by a **single shared password** (`isAuthenticated()` from `src/lib/auth.ts`).

| Route | Audience | Purpose | Source | Signed-out state | Signed-in state today |
|---|---|---|---|---|---|
| `/admin` | federation office | The editorial CMS: `ListPanel` editors for every Redis key | `getAll()` | *"Sign in"* | edits seed/Redis content — **shared credential, so no decision is attributable to a person** |
| `/admin/command` | national officers | The national command centre: `StatCard` + `DataTable` over analytics | `@/db/analytics` | *"Sign in"* | *"The federation database is not configured"* — and *"No federation register is configured for this deployment. **This is a real state, not a failure.**"* |
| `/admin/dashboard` | scoped administrators | Scope-filtered figures and registers | `@/db/analytics`, `visibleScopes()` | *"Sign in. You will land on the scope your account is bound to. The figures you see are the ones your bindings allow, and no others."* | *"The federation database is not configured on this deployment."* |
| `/admin/grading` | examination board | Grading sessions, panels, scorecards, decisions | `summariseScores()` | *"Sign in"* | not configured — and where a pass mark is unset: *"…not configured it — it is not a threshold this system chose."* |
| `/admin/competition` | tournament commission | Events, categories, entries, draws, match states | `listEvents()`, `explainMatch()` | *"Sign in"* | not configured; separately reports *"The shared store is not configured on this deployment."* |
| `/admin/governance` | federation secretariat | Office bearers, committees, terms | `governance.schema` | *"Sign in"* | not configured. Page comment records the design rule: `not_configured`, `vacant` and `filled` are **three different facts** and are rendered as three |
| `/admin/approvals` | two-person-control approvers | Dual-authorisation decisions | `@/lib/approvals` | *"Sign in"* | *"The federation database is not configured on this deployment."* |
| `/admin/cases` | safeguarding officer | Safeguarding and disciplinary casework | `@/db/cases` | *"Sign in"* | not configured. Where no review interval exists: *"No review date is set. The federation has not configured a review interval, so none has been applied."* |
| `/admin/queue` | office | The four Redis submission queues, worked through `QueuePanel` | `QUEUES`, `queueSummary()`, `openItems()` | *"Sign in"* | *"Shared storage is not configured on this deployment. The queue is being…"* / *"The federation database is not configured. Decisions are still recorded…"* |

### Unit portal

| Route | Audience | Purpose | Source | State today |
|---|---|---|---|---|
| `/unit` | chartered state / district / club secretary | Scoped view of that unit's submissions | `getUnitSession()`, `scopeList()`, Redis | *"Unit sign in. For chartered state associations, district associations and clubs. Access codes are issued by the federation office."* → *"Invalid or disabled access code"* / *"Lost your code? Contact the federation office — admin@mmakf.in"* |

---

## 4. Audience map

Who each surface is actually for. Several routes appear twice; that is correct — a register serves
both the person in it and the person checking it.

| Audience | Their routes |
|---|---|
| **Prospective student / parent** | `/`, `/programs`, `/schedule`, `/belt-system`, `/facilities`, `/faq`, `/gallery`, `/contact`, `/academy`, `/dojos` |
| **Current member** | `/my`, `/my/passport`, `/my/courses`, `/live`, `/events`, `/shop`, `/checkout`, `/registration` |
| **Applicant** | `/registration`, `/application` |
| **Competitor / coach** | `/competitions`, `/scoreboard`, `/rankings`, `/events` |
| **Referee / table official at the mat side** | `/scoreboard`, `/competitions`, `/officials` |
| **Third-party verifier** (employer, school, another federation, parent) | `/verify`, `/athletes`, `/athlete/[id]`, `/officials`, `/dojos` |
| **Affiliating club / state unit** | `/affiliation`, `/unit`, `/dojos` |
| **Journalist / sceptic / regulator** | `/press`, `/regulations`, `/governance`, `/rankings`, `/verify` |
| **Federation office** | `/admin`, `/admin/queue` |
| **Scoped administrator** (state / district) | `/admin/dashboard`, `/admin/governance`, `/admin/grading`, `/admin/competition` |
| **National officer** | `/admin/command`, `/admin/approvals` |
| **Safeguarding officer** | `/admin/cases` |

**Gap:** the navigation offers eight items — About, Governance, Programs, Schedule, Events,
Affiliation, Registration, Contact — plus Enroll. **Not one of the eleven public federation
surfaces is in the primary navigation.** `/athletes`, `/dojos`, `/officials`, `/rankings`,
`/competitions`, `/scoreboard`, `/verify`, `/press`, `/regulations`, `/live`, `/academy` are
reachable only from the footer, from `/registration#verify`, or by typing the URL. The nav still
describes a dojo's website; the site behind it is a federation's. Recorded as **CA-2**.

---

## 5. The voice rules the project follows

Derived from the copy that is actually on the pages and from the comments in the components. These
are descriptive: this is how the project already writes.

1. **State the fact, then state its limit.** `/officials`: *"Only current licences appear"* is
   immediately followed by *"If you are appointing an official for an event in the future, this page
   cannot answer for that day."* `/scoreboard`: *"It is not a live feed — what you see is the
   official record as at the time above."*
2. **Never overclaim; name what a piece of evidence does and does not establish.** `/press`:
   *"A clipping is evidence that a newspaper printed something. It is not, on its own, independent
   confirmation of what was reported."* `/verify` grades every answer — **Examined**, **Legacy
   record**, or read from the old hand-maintained register — rather than returning a bare "valid".
3. **Say "not yet published by the federation" rather than inventing.** `/regulations` lists MMAKF's
   own constitution, safeguarding, grading and selection instruments as **not yet published**.
   `/my/passport` labels an unpublished result *"Provisional results — not yet published by the
   federation."*
4. **An absence is named by its kind.** "No records" (a true empty register), "not yours to see" (a
   permission boundary), "could not be read" (a failure), and "not configured" (no system of record
   here) are four different sentences and are never substituted for each other. `DataTable` enforces
   this in code; `/admin/governance` extends it to `not_configured` / `vacant` / `filled`.
5. **A zero that was measured is printed at full contrast.** `StatCard`: *"An empty federation shows
   zeros and that is the honest answer on day one."* An unexplained blank is treated as a bug and
   says so on the page.
6. **Mark provenance on the page, not in a comment.** Every `StatCard` and `DataTable` carries a
   `<details>` naming the table, column and filter. `/athlete/[id]` states how each fact is known.
   `/rankings` keeps *"which events counted, what each was worth, and what was left out and why."*
7. **Explain a refusal by naming the authority required.** `QueuePanel`: *"Deciding … requires the
   `<action>` authority at a scope that covers the whole queue. Your account does not hold it, so no
   decision controls are shown and no items are listed — a button here would only be refused by the
   server."*
8. **Say when a limitation is deliberate.** `/athletes`: *"The register cannot be browsed in bulk,
   and that is deliberate."* `/application`: *"A lost access code cannot be recovered … that
   limitation is exactly what keeps this check private."*
9. **Reassure about consequences, specifically.** `/checkout`: *"Nothing you entered has been charged
   or recorded."* `EnrollCTA`: *"We use these details only to contact you about your trial class."*
10. **Always give the offline route.** Every blocked path names `admin@mmakf.in` and/or
    `+91 99391 44318`. `EnrollCTA` and `/verify` both carry a `<noscript>` fallback that does.
11. **Attribute a decision to a person, or say you cannot.** `QueuePanel` prints *"— shared
    credential, not attributable to a person"* when `userId` is null rather than implying an actor.
12. **Distinguish translation from the original.** `/press`: *"'Karate training and belt grading
    concluded at Patratu' — English translation of the printed headline; not an official federation
    translation."*

**Where the voice is not applied:** the Class A editorial routes carry none of it. `/belt-system`
prints ten grading fees, `/governance` prints a register of office bearers, and `/schedule` prints
twelve batches — with no provenance line, no "as recorded on", and no way to tell a
federation-published value from a `seed.ts` default. The vocabulary for saying so already exists on
`/press`, `/regulations` and `/athlete/[id]`.

---

## 6. Content that is blocked on the federation, not on engineering

Reproduced from `PROJECT-CONTEXT.md §7` because it determines what these pages can ever say. Do not
work around any of it by inventing content.

`DATABASE_URL` · merchant account · **the grading syllabus (requirements, intervals, pass marks)** ·
governance documents (constitution, bye-laws, safeguarding, selection) · a photograph of Sensei
Vikas Pathak · Sensei Sumitra's name and grade (three sources disagree) · the WKF-standing and
Limca/Guinness claims (see `CLAIMS-AUDIT.md`) · YouTube OAuth credentials · retention periods and
the grievance officer (see `PRIVACY.md`) · four competition policy questions.

---

## 7. Findings — content architecture

| # | Severity | Finding | Where |
|---|---|---|---|
| CA-1 | **Serious** | Class A routes cannot reach an empty state: `storage.get()` silently substitutes `src/data/seed.ts`, so 18 public pages render repository defaults — grading fees, office bearers, timetables, prices, member records — with no marker distinguishing them from federation-published content. Class B routes, with the same absence of data, say so explicitly. `MMAKF-SYSTEM-AUDIT.md` records this for the member register only; it applies to every Class A key. | `src/lib/storage.ts`, `src/data/seed.ts`, all Class A routes |
| CA-2 | **Serious** | None of the eleven public federation surfaces (registers, scoreboard, verifier, rulebook register, press archive, academy) is in the primary navigation. `/athletes`, `/dojos`, `/officials`, `/rankings`, `/competitions`, `/scoreboard`, `/verify`, `/press`, `/regulations`, `/live` and `/academy` are footer-only or URL-only. The nav describes a dojo; the site is a federation. | `src/layouts/Base.astro` `navItems` |
| CA-3 | Moderate | `/admin` is gated by a **shared password**, not by `identify()` + `can()`, so every CMS edit made there is unattributable — `QueuePanel` already prints "shared credential, not attributable to a person" for exactly this condition elsewhere. | `admin/index.astro`, `src/lib/auth.ts` |
| CA-4 | Moderate | `/governance` — the page a regulator or journalist reads first — is illustrated with a stock photograph recycled from `/about`, and its office-bearer register carries no "as recorded on" date or provenance line. | `governance.astro` |
| CA-5 | Moderate | Class A pages have no failure state either. If Redis is reachable but returns a malformed value, `guardShape()` falls back to seed and logs to the server console; the page shows seed content and the reader is told nothing. | `src/lib/storage.ts` |
| CA-6 | Minor | `/press` silently drops any clipping whose `img` fails `safeHref()`, and `Base.astro` silently drops any social channel without a `url`. Both are correct filters, but neither says how many entries were withheld. | `press.astro`, `Base.astro` |
| CA-7 | Minor | `/verify` requires JavaScript for the lookup itself; the `<noscript>` route is an email to the office. On the register pages the equivalent lookups are server-rendered. | `verify.astro` |
| CA-8 | Minor | `EnrollCTA` reports every submission failure through the 3.5-second global toast, then re-enables the button — a visitor who looks away sees a form that appears to have done nothing. | `EnrollCTA.astro` |

---

## 8. What this document does NOT cover

- **Signed-in admin content was never seen.** All nine admin routes were requested
  **unauthenticated** and returned their sign-in form. The "signed-in state today" column is read
  from the page source, not from a rendered authenticated response. No credential was used and no
  RBAC path was exercised.
- **Class B empty-state copy is the `not_configured` branch only.** With no `DATABASE_URL`, the
  `empty`, `error` and `denied` branches of those pages were never rendered. Their wording is read
  from source and is **not** quoted from output.
- **No content correctness review.** This maps where content comes from. It does not check whether
  any fee, name, date, grade or claim on a Class A page is true — that is
  `docs/CLAIMS-AUDIT.md`'s job, and CA-1 is precisely the finding that the site gives a reader no
  way to tell.
- **The `/api/*` surface is out of scope.** Only routes under `src/pages` that render HTML are
  mapped. API endpoints, their auth, and their error shapes belong to `docs/API-ARCHITECTURE.md`.
- **The audience map in §4 is an inference**, not research. No user was asked, and no analytics
  exist. It is a reasoned reading of each page's own stated purpose.
- **The voice rules in §5 are descriptive, and incomplete.** They were derived from the copy the
  reviewer read. No page's copy was reviewed line by line for compliance with them, so "the project
  follows this rule" means "every instance found follows it", not "no counter-example exists".
- **Nothing here is fixed.** `src/lib/storage.ts`, `src/data/seed.ts` and the page files belong to
  other streams. CA-1 through CA-8 are all open.
