# Scheduling

**Whose hours are whose, and how a page finds out.**

Traced by reading the code on 17 August 2026. Every claim below names the file
that does the work. Where a link is missing it is written down as missing, not
as planned.

---

## The defect this domain exists to prevent

MMAKF's opening hours were once two English sentences in `src/data/seed.ts` —
`federation.contact.hours` and `federation.contact.hoursSunday` — rendered by
`/schedule` and `/facilities` and called *the MMAKF timetable*.

They are the **Hombu dojo's** timetable. An affiliated club in Bokaro that
trains Monday to Friday 18:00–21:00 was published, on the federation's own site,
as training at six in the morning. Three things were wrong and none was a
shortcut:

1. **There was one schedule and it belonged to nobody.**
2. **The season was in the prose.** `Summer 06:00–10:00 · Winter 08:00–11:30` is
   two schedules in one cell, with the changeover date written down nowhere.
3. **Changing it needed a developer.** Every timing was a string literal behind
   a deploy.

The engine exists so none of those three sentences can be written again. Hours
are rows. Seasons have dates. Every level owns its own.

### The invariant

> A club that has published nothing returns `configured: false` — never the
> headquarters' hours.

`configured: false` is a first-class result and every surface must render it as
a sentence ("ask the club"), never as an empty timetable. An empty week tells a
parent the club never opens; that is a different and much worse statement.

Where an answer *does* come from a level above the club, `isOwnSchedule` is
false and `inheritedFromLabel` names the level, so the surface can say whose
hours these are. **Inherited-and-labelled is not the same as silently borrowed.**

Asserted by `tests/register-timings.test.ts` and `tests/schedule-directory.test.ts`.

---

## Data model

`src/db/scheduling.schema.ts`, migration `drizzle/0032_scheduling_engine.sql`.

| Table | Holds |
|---|---|
| `seasons` | A named date range owned by a scope. Two active seasons may not overlap for one owner. |
| `schedules` | The schedule OBJECT — owner scope, purpose, timezone. Says nothing on its own. |
| `schedule_versions` | One effective-dated edition. Publishing a successor closes the incumbent; nothing is deleted. |
| `schedule_rules` | Day-of-week windows, optionally season-scoped. |
| `schedule_exceptions` | One dated departure: closed / replace / add / remove. |
| `dojo_classes` | A class as an object, distinct from the room it happens in. |
| `class_sessions` | Generated occurrences, bookable. |

Reused rather than duplicated: `state_units` / `district_units` / `dojos` for
organisation, `venues` for rooms, `persons` + `coach_profiles` for instructors,
`coach_availability`, `bookings` (+ one added `class_session_id` column),
`venue_blackouts`, and `audit_events` for the changelog.

**`owner_scope` is the existing `scope_type` enum** — `national | state |
district | dojo | institution` — the same vocabulary RBAC uses for role
bindings. So "may this administrator edit this schedule?" is answered by the
authority model that already exists.

---

## Resolution

Two resolvers, one answer.

**`openingHoursOn()` / `publishedWeek()` — `src/db/scheduling.ts`.** Canonical,
one target. Resolves schedule → version in force → seasons → rules →
exceptions → venue blackouts. Roughly six round trips per day per target.
`publishedWeek()` prefers `training` over `operating`, because "when can I train
here" is the question actually being asked.

**`directoryDay()` — `src/db/schedule-directory.ts`.** The same answer for a SET
of clubs in a **fixed twelve queries**, whether the set holds two clubs or two
thousand. Written for `/dojos`, which previously resolved each club separately
and therefore shipped with a cap of sixty clubs.

The arithmetic is written twice. That is safe only because it is not trusted:
`tests/schedule-directory.test.ts` is **differential** — for a fixture covering
own / district / state / national / nothing, seasonal rules, and all four
exception effects, it asserts both resolvers return the same windows, the same
`scheduleId`, the same `isOwnSchedule` and the same label. It also asserts the
query count for forty clubs equals the query count for two.

### Precedence

1. The club's own published schedule.
2. An explicit parent (`inherits_from_schedule_id`) — for a satellite that
   follows another club's timetable.
3. The federation tree — district, then state, then national — **labelled**.
4. Exceptions on the day, which beat the rules.
5. Venue blackouts, which beat everybody.
6. Otherwise `configured: false`.

Season rules **replace** all-year rules for the day; they are never unioned.
"And in summer, this instead", not "both at once".

---

## Wiring

| Link | State | File |
|---|---|---|
| PUBLIC UI | REAL | `/facilities`, `/schedule`, `/dojos`, `/clubs/[slug]`, `/my/schedule` |
| AUTH | REAL | `assertMayWriteSchedule()` on every write; `schedule:publish` checked separately from `schedule:write` |
| API | REAL | `src/pages/api/schedules/[...action].ts` — 15 actions. GET public and draft-proof, POST authenticated. 22 tests. |
| VALIDATION | REAL | `assertIsoDate` / `assertWall` / `assertTimezone`; overlap and reversed-range refusals in `setRules()` |
| SERVICE | REAL | `src/db/scheduling.ts`, `schedule-bootstrap.ts`, `schedule-directory.ts` |
| DATABASE | REAL | Postgres, seven tables above |
| EVENT | REAL | `SCHEDULE_PUBLISHED`, `CLASS_SESSION_CANCELLED`, `CLASS_SESSION_RESCHEDULED` published, each with a live consumer path. `SCHEDULE_CHANGED` was defined and never emitted; it is retired, with a tombstone comment so it is not re-added. |
| WORKFLOW | N/A | Publication is a direct authorised act, not a routed approval |
| NOTIFICATION | REAL | The `notifications` consumer drains the feed from `src/pages/api/cron/reconcile.ts` and `deliverQueued()` sweeps what it wrote. Before that runner existed, `consume()` had **zero production callers** and no published event ever reached the member inbox |
| CALENDAR | REAL | `/clubs/[slug]/schedule.ics` |
| AUDIT | REAL | 17 `writeAudit()` calls; a version cannot be published without a publisher and a reason |
| ADMIN UI | REAL | `/admin/schedules`, including the prose→rows migration |
| USER UI | REAL | `/my/schedule` |
| TEST | REAL | `scheduling.test.ts`, `schedule-bootstrap.test.ts`, `register-timings.test.ts`, `schedule-directory.test.ts` |

---

## Permissions

| Principal | May |
|---|---|
| National admin | Every schedule |
| State admin | Schedules in their state, and the clubs beneath it |
| District admin | Schedules in their district |
| Club admin | Their own club's |
| Coach | Their own availability |
| Public | Published versions only — drafts are invisible to every read in the module |

A draft is invisible on purpose: an administrator half way through rebuilding a
club's week must not have the public timetable change under them line by line.

---

## Known limitations

- **No published-week cache.** Twelve queries per register render, every render.
  Correct and bounded; the lever if the register grows past a few hundred clubs.
- **A club-level schedule change still reaches no wider audience.** The feed
  drain is now wired, so `SCHEDULE_PUBLISHED` produces notifications for the
  audience `NOTIFIABLE` can name — but not for "everyone who trains at this
  club", which is *deliberately* not attempted: that is not a query this system
  can answer honestly yet, and a guessed list is worse than no list. It becomes
  answerable once club membership is queryable. The people holding a place on a
  specific session ARE answerable, and they are told by name.
- **Batch resolution covers DOJO scope.** `directoryDay()` (one day) and
  `directoryRange()` (up to 14 days, with a stated `open` / `closed` /
  `not_published` standing per club) are written and exposed over HTTP.
  Venue-scoped and class-scoped batch resolution are not; nothing asks for them.
- **No cache.** Twelve queries per register render, every render. Correct and
  bounded, but a published-week materialisation is the next lever if the
  register gets large.
- **Only the Hombu has rows.** Every other club resolves to `configured: false`
  or to an inherited level. Filling them in is federation data entry through
  `/admin/schedules`, not engineering.

---

## Verified end to end, 17 August 2026

A test proves the resolver; it does not prove the page. `scripts/seed-demo-schedules.mjs`
writes a local demonstration register (loopback-only, `MMAKF-DEMO-` prefixed,
idempotent, refuses any non-loopback host) so the register can be rendered with
real rows against `npm run dev:db`.

Three clubs, three genuinely different answers, read off the rendered HTML of
`/dojos`:

| Club | Rendered |
|---|---|
| MMAKF Hombu Dojo (demo) | `06:00–09:00 & 17:00–20:00` — its own |
| MMAKF Bokaro Dojo (demo) | `18:00–21:00` — its own, nothing like the Hombu's |
| MMAKF Ranchi Centre (demo) | `Not published — ask the centre` |

The third row is the whole point. Ranchi has published nothing, the Hombu two
rows above it opens at six in the morning, and Ranchi does **not** show six in
the morning. The invariant holds on a rendered page and not only in a test.

---

## Onboarding: the first week a club publishes

`/admin/schedules/start`, added 17 August 2026.

`/admin/schedules` is complete and it is an EXPERT's screen — eleven forms, each
writing one row into one table, arranged the way the data model is arranged.
Months after the engine shipped, exactly one unit had schedule rows: the
headquarters, entered by a migration. **The engine was not the bottleneck. The
first five minutes were.**

This screen asks the questions in the order a person knows the answers — which
club, which days, what times — and does the create/draft/publish dance for them.

- **It adds no policy.** `createSchedule()` → `draftVersion()` → `publishVersion()`,
  the same three calls in the same order. Overlaps, reversed ranges, season
  collisions and publication authority are all decided by the module, and its
  refusals are shown **word for word**: "Sunday has two overlapping sessions:
  06:00–10:00 and 08:00–11:30" names the two rows to fix.
- **It drafts before it publishes.** A draft is invisible to every public read,
  so a half-typed week cannot appear on `/dojos`. Verified against a live
  register: a drafted week left the club showing *"Not published — ask the
  centre"*.
- **The club list comes from `visibleScopes()`**, and the posted id is re-checked
  against it — a rendered page is never evidence of authority.
- **Reading the posted week is [src/lib/week-form.ts](../../src/lib/week-form.ts)**,
  not a loop in the page. Every way that parsing goes wrong — a half-filled row
  dropped, a closed day that still carries sessions, slots renumbered — publishes
  a plausible WRONG timetable and raises nothing. 11 tests hold it.

### What it says about notification, and why the wording matters

Publishing writes `SCHEDULE_PUBLISHED` **inside the publish transaction**; the
inbox rows are written afterwards by the scheduled sweep. So the screen says the
notice is **queued**, not sent. A confirmation claiming members have been told,
minutes before they have, is a small lie that the first person to ask "why didn't
I get it?" discovers.

### Verified end to end

Against the local register (`npm run dev:db` + `scripts/seed-demo-schedules.mjs`):
a club with no timetable was taken through the wizard — three sessions across
Tuesday, Thursday and Saturday, Sunday marked closed — the review step rendered
the week back correctly with the Saturday session's name, the draft did **not**
appear on `/dojos`, and publishing on the shared admin password was refused with
`publisher_required`: a published version records who put it in force, and a
password shared by an office names nobody.
