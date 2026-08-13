# Pending federation verification

**Everything the system is waiting on MMAKF for.**

PART BG: *"If a specific institutional fact is unavailable: DO NOT INVENT IT.
Build the infrastructure. Create PENDING_FEDERATION_VERIFICATION. Continue
everything else."*

This is that register. Every row is a fact the federation has not supplied, the
place in the system that is holding a space for it, and what supplying it turns
on. **Nothing here is guessed, defaulted or filled with a placeholder.** Each is
NULL or empty in the database and renders as absent.

Updated 13 August 2026.

---

## 1 — Blocking a whole capability

These are the ones worth reading first. Each is a system that is built, tested
and doing nothing.

### 1.1 Fee rules

| | |
|---|---|
| **What is needed** | The rules that turn a configuration into a figure. A base, per-participant, per-session, per-batch, per-campus, per-instructor, travel, multiplier, discount and tax structure — in whatever shape the federation actually prices in. |
| **Where it waits** | `fee_frameworks` / `fee_rules` (migration 0007). `src/db/fees.ts` computes, reproduces and explains. `/admin/fees` is the screen to author them. |
| **What it turns on** | **Every quotation in the system.** Today `activeFramework()` returns null, so `/training/estimate`, every audience page and every institutional application all end at "request a quotation". |
| **What happens without it** | Nothing breaks. The engine reports honestly that no framework covers the request. It will never show an invented number. |

**One decision needed alongside the numbers:** money is stored as **integer
paise** and multipliers as **parts-per-million**. `450.50` is `45050`. A 7.5%
uplift is `1075000` PPM. This is not negotiable — floating-point rupees drift —
but it does mean the rules have to be supplied in those units or converted once,
carefully, on the way in.

### 1.2 A service standard — or a decision that there is none

| | |
|---|---|
| **What is needed** | Either "MMAKF responds to an institutional application within N working days", or an explicit "we do not publish one". |
| **Where it waits** | `institution_applications.sla_due_at`, `tasks.due_at`, `tasks.escalate_at`, `task_templates.due_in_hours`, `support_tickets.sla_due_at` — all NULL. |
| **What it turns on** | Task escalation, ticket escalation, the "past deadline" counters on `/admin/tasks` and `/admin/support`, and the "MMAKF has undertaken to respond by" row on the applicant's status page. |
| **What happens without it** | Nothing is ever late, so nothing ever escalates. The counters read zero truthfully. A test asserts no message template contains "within N hours", so no page or email invents one. |

Either answer is fine and both are better than the current silence. "We do not
publish one" is a legitimate position and the system already behaves correctly
under it.

### 1.3 `DATABASE_URL` in the Vercel project

| | |
|---|---|
| **What is needed** | The Supabase connection string, set as an environment variable on the Vercel project and linked to Production. |
| **Where it waits** | `src/db/index.ts`. `/api/health` currently answers `"database": "not_configured"`. |
| **What it turns on** | Every database-backed page in production: the whole application intake, the coach pipeline, all four admin surfaces, the client portal. |
| **What happens without it** | Each of those pages renders and says plainly that the database is unreachable. Nothing pretends to have stored anything. |

Two operational notes when this is done:

- **Turn the Supabase Data API switch OFF.** This app never uses PostgREST — the
  only data path is `postgres.js` over TCP. Migrations `0010` and `0012` already
  put RLS on all 144 tables and revoke the `anon`, `authenticated` and
  `service_role` grants, but the dashboard switch removes the endpoint entirely.
- **Run `node scripts/migrate.mjs`** against it before the first request.

---

## 2 — Facts about people and the federation's history

### 2.1 Grandmaster S N T Lee

**Confirmed by the federation (13 August 2026):** he is Shihan Pramod Kumar
Pathak's master, and he awarded the name *Junior Tiger Lee*.

That is recorded, and it is all that is recorded. Still absent:

- his grade
- his school, style or organisation
- his nationality
- the dates of the relationship
- when and where the name was conferred
- any photograph

**Where it waits:** `leadership[].master` in `src/data/seed.ts` has `name`,
`relation`, `conferred` and `source` and no other field, because there is
nothing else to put in one. `/people/[slug]` renders what exists.

**The YouTube channels were checked, on the federation's suggestion, and
yielded nothing.** `@PramodPathakMartialArt` and `@mmak_india` return a
JavaScript shell to a server-side fetch — the page title
("Pramod Pathak Martial Arts Academy") is retrievable and no video title,
description or upload date is. Site-scoped searches for *"Junior Tiger Lee"*
and *"S N T Lee"* returned nothing that plainly concerns this person. A wider
public-web search found no documented martial arts teacher of that name; note
that a previous audit reached the same conclusion for "Tiger Lee" (§2 of
[CLAIMS-AUDIT.md](CLAIMS-AUDIT.md)) — every hit is an unrelated American
taekwondo school.

**This is not evidence of absence.** It is evidence that the information is not
retrievable this way. The likely route is a person, not a search engine: if
MMAKF can supply a photograph, a certificate, a grade, a school name, or the
name of the event where the name was conferred, it goes straight into the
record. Until then the profile carries the master's name and the fact that he
conferred it, on the federation's own word, and nothing further.

**One question outstanding.** The held clipping (*Johar Jharkhand*, August 2022)
says the name was given in 2021 *"वर्ल्ड मार्शल आर्ट की ओर से"* — by or on behalf of
World Martial Art — and names no person. The federation says his master awarded
it. These are very possibly the same event described from two sides. **They are
not reconciled anywhere in the system**, because a likely explanation is not a
source. Either account can be recorded as soon as MMAKF says which is the
correct formulation.

### 2.2 A photograph of Shihan Pramod Kumar Pathak

**Where it waits:** `leadership[0].img` is `''`. `/people/[slug]` renders a
monogram and says nothing about the absence — announcing "no photograph is held"
on a public page is the pattern the federation objected to on the news page.

A test asserts the field stays empty until MMAKF supplies one.

### 2.3 News and events, 2021–2026

Four items are on record with their sources. Anything else the federation wants
published — championships, gradings, seminars, camps, results — has to come from
MMAKF. Nothing is reconstructed from memory or inferred from a photograph.

**Where it waits:** the `news`, `events` and `results` keys in the editorial
store. Note that editing `src/data/seed.ts` does **not** reach a running site —
use `npm run content:push`. See `scripts/reseed.mjs`.

---

## 3 — Registers that count only what is recorded

None of these are wrong. They are all *small*, and they are small because the
federation has not supplied the rest.

| Register | Holds | Where |
|---|---|---|
| Office bearers | The recorded leadership | `leadership` |
| Affiliated centres | 7 entries | `branches` → `/network` |
| Documents | 8, of which some have no published copy | `documents` → `/documents` |
| Members / athletes | Empty | `persons`, `memberships` |
| Coaches | Empty until candidates apply | `coach_profiles` |
| Officials, referees, judges | Empty | `official_quals` |
| Competitions and results | Empty | `competition_events` |

Every one of these renders its true count. `/network` says "this counts entries
on the federation's own register and nothing else" rather than implying the
register is the whole picture.

**Explicitly NOT claimed anywhere on the site**, because none has been
evidenced: student numbers per quarter, the number of schools reached, WKF
affiliation or pathway status, government recognition or empanelment, and any
record or ranking claim.

---

## 4 — Configuration, not facts

Smaller, and all unblocking real behaviour.

| Needed | Turns on |
|---|---|
| An email provider (SMTP or an API key) | Delivery. Messages render and queue correctly today; `src/lib/email-templates.ts` renders and `notifications` stores them with status `queued`. Nothing sends them, and nothing pretends to. |
| VAPID keys | Web push. `push_devices` and the preference model exist. |
| Google / Microsoft OAuth credentials | External calendar sync. `calendar_connections`, `calendar_events` and `calendar_sync_log` exist. |
| Routing rules — who handles which enquiries | `routing_rules` is empty, so every application arrives **unassigned** and sits in the national queue. That is deliberate: assigning to an arbitrary administrator would look like routing while producing work nobody agreed to do. |
| Programme templates | `/admin/programs` and the wizard's "a published programme, if one fits" step. Nothing is advertised as available that is not published. |
| Venues | Scheduling and double-booking prevention have nothing to protect yet. |

---

## 5 — How this register is meant to work

1. **Nothing here blocks building.** Every item has its infrastructure in place
   and empty. PART BE: *"DO NOT BLOCK BUILDING ON PRODUCTION DATABASE
   DEPLOYMENT."*
2. **Nothing here is defaulted.** No fee is 0, no deadline is 48 hours, no count
   is estimated. NULL means unknown and every surface treats it that way.
3. **A missing safeguard is not a safeguard.** The one place absence is not
   neutral: `coach_profiles.safeguarding_cleared_on` being NULL means **not
   cleared**, and such a coach is excluded from work with children. That is the
   fail-safe direction and it is deliberate.
4. **Supplying an item should require no code change.** Each waits in a table or
   an editorial key. If supplying something turns out to need code, that is a
   defect in this register — say so.

---

## Related

- [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) — what is built
- [IMPLEMENTATION-QUEUE.md](IMPLEMENTATION-QUEUE.md) — what is next
- [CLAIMS-AUDIT.md](CLAIMS-AUDIT.md) — claims examined, and what was found
