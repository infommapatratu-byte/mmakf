# Scheduling

*The federation scheduling engine — migration 0032, `src/db/scheduling.ts`.*

---

## The defect this replaced

MMAKF's opening hours lived in two English sentences on the editorial record:

```
federation.contact.hours        'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST'
federation.contact.hoursSunday  'Sun · Summer 06:00–10:00 & 15:00–18:00 ·
                                 Winter 08:00–11:30 & 16:00–18:30 IST'
```

`/schedule` published the first under the heading **“The weekly timetable”** and
called it MMAKF's. It is the **hombu dojo's** timetable. An affiliated club in
Bokaro that trains Monday to Friday, 18:00–21:00, was represented on the
federation's own site as training at six in the morning — and a parent who read
that page and travelled to a club sixty miles away found a locked door with the
federation's name over it.

Three separate failures, all in those two lines:

1. **One schedule, belonging to nobody.** No club could state its own.
2. **The season was in the prose.** `Summer … Winter …` with the changeover date
   written down nowhere at all. Nothing could answer “is the dojo open at 09:30
   on the 4th of October?”
3. **Changing it needed a developer.** String literals in a seed file behind a
   deploy.

---

## The model

Everything below is a row. Nothing in `src/db/scheduling.ts` knows what time
anything opens — `tests/scheduling.test.ts` asserts that by grepping the source
for a clock time and finding only `00:00`, which is the boundary of a calendar
day and not an hour anybody opens at.

### Reused, not rebuilt

| Concept | Where it already lived |
|---|---|
| Organisation / club / dojo | `state_units`, `district_units`, `dojos` |
| Facility / training location | `venues` (a **room**; a dojo is a **member**) |
| Instructor | `persons` + `coach_profiles` |
| Instructor availability | `coach_availability` |
| Booking | `bookings` + `booking_resources`, `src/db/booking.ts` |
| Facility unavailability | `venue_blackouts` |
| Who changed what, when, why | `audit_events` + `writeAudit()` |

The wave adds **one column** to `bookings` (`class_session_id`) rather than a
second booking table, and **seven columns** to `venues` and `dojos` (timezone,
slug, coordinates, civil area, parking, transport).

### New

| Table | What it holds |
|---|---|
| `seasons` | A named stretch of the calendar with dates somebody chose. Owned by a scope. |
| `schedules` | The **identity** of a schedule — owner, purpose, room, class, timezone. Holds no timings. |
| `schedule_versions` | One effective-dated edition. Published, superseded, never edited. |
| `schedule_rules` | The weekly windows inside a version. ISO day 1–7, optional season. |
| `schedule_exceptions` | A single date that does not follow the pattern. |
| `dojo_classes` | A class a club runs, week after week. |
| `class_sessions` | One occurrence — a real Tuesday at a real time somebody can book. |

---

## How a day resolves

`openingHoursOn(db, target, dayIso)` — five steps, in order:

1. **Find the schedule.** Walk **room → club → district → state → federation**
   and stop at the first level with a schedule for the purpose asked about *that
   has a version in force on the date asked about*. A schedule that exists but
   has published nothing does **not** stop the walk — that is what makes an
   unconfigured club inherit rather than render blank.
2. **Find the version.** The one whose effective window contains the date.
3. **Find the season.** If any season-scoped rule matches the day-of-week, the
   **season-scoped rules win** and the all-year rules for that day are ignored.
   Specificity, not union: “and in summer, this instead”, never “both at once”.
4. **Apply the exceptions.** `closed` shuts the day; `replace` supplants the
   windows; `add` unions; `remove` subtracts.
5. **Subtract the blackouts.** A maintenance order beats an administrator's
   optimism.

### Three states, never two

`ResolvedDay` distinguishes:

- **open** — hours, and the reader comes.
- **closed** (`open: false`, `unconfigured: false`) — a statement. Come back.
- **not said** (`unconfigured: true`) — this unit has published nothing. The
  reader **telephones**.

A surface that renders the third as an empty week tells a parent the club never
opens. `src/components/OpeningHours.astro` renders it as a sentence.

---

## Inheritance

Resolved, **never copied**. No job pushes the federation's hours down. A club
that has configured nothing inherits — and the result names the level it came
from, so the page can say *“these are the national federation's published
hours; this club has not recorded its own.”* A club that configures something
overrides, and the federation's rows are not touched.

`schedules.inherits_from_schedule_id` exists for the case the hierarchy cannot
express — a satellite following another club — and is deliberately the
exception. Cycles are refused by the service (the database can only see one row,
so it rejects self-parenting alone).

---

## Versioning

Timings live in `schedule_rules` → `schedule_versions`, which carry
`effective_from` / `effective_to`.

- `setRules()` **refuses** on anything not a draft.
- `publishVersion()` end-dates the incumbent to the day before the successor
  starts and marks it `superseded`. It is never deleted and its rules are never
  edited.
- Every read takes `asOf`, so an attendance record from March renders against
  March's timetable.

`schedule_versions_published_needs_publisher_ck` makes “who and when” unstorable
otherwise: a row cannot **reach** `published` without a publisher and a
timestamp. The reason is required by `publishVersion()` and lands in
`audit_events`.

---

## Classes are not the building

A dojo open 06:00–21:00 is not running a class for fifteen hours.

- Facility hours: a schedule at `purpose = 'operating'` or `'training'`.
- A class: a row in `dojo_classes` with its own schedule at `purpose = 'class'`.
- `generateSessions()` intersects the two and **refuses** — reporting each
  refusal, never swallowing it — when a class window falls outside the room's
  open hours, on a day the room is closed, or where it would double-book the
  coach or the room.

`dojo_classes_venue_required_ck` enforces the online rule in the schema: every
mode but `'online'` must name a venue, so **an online class cannot consume a
physical dojo** unless it is explicitly `hybrid`.

Generation is idempotent — `class_sessions_occurrence_uk` on
`(class_id, starts_at)` — and a second run recognises its own prior output
*before* the conflict check, so regeneration does not report every session as a
venue double-booking.

---

## Conflicts

`detectConflicts()` returns a list; empty means clean. Callers decide whether a
conflict is fatal, but no caller is unaware of one — *“do not allow silent
double booking”*, and the operative word is **silent**.

Detected: coach double-booking (against class sessions **and** ordinary
bookings), coach recorded as unavailable/leave/travel, venue double-booking,
venue blackout.

It is a **read**. The guarantee that two simultaneous writers cannot both pass
it comes from the transaction and `pg_advisory_xact_lock` in
`bookClassSession()` (namespace `42_711`, keyed on the session) and in
`src/db/booking.ts` (namespace `42_710`, keyed on the coach) — not from here.
`class_sessions_capacity_ck` backs the same rule independently in the database.

---

## Privacy

`schedule_exceptions.reason` is free text an administrator typed, and the honest
reasons are the sensitive ones — a bereavement, a police enquiry, a safeguarding
review.

- `publicTimetable()` / `publishedWeek()` take **no principal** and return the
  *kind* of a special day (`holiday`, `grading`) with `reason: null` and
  `reasonWithheld: true`.
- `openingHoursOn(..., { principal })` returns the reason only to a caller
  holding `schedule:read` in that owner's scope.
- `CLASS_SESSION_CANCELLED` carries the class and the time and **not** the
  reason: a notification travels through channels the federation does not
  control.

Migration `0033_data_api_lockdown.sql` puts all seven tables behind RLS. The
three that matter are `class_sessions` (a year of a named coach's whereabouts),
`schedule_exceptions` (the reasons), and `dojo_classes.online_url` (a joining
link for a children's class).

---

## Authority

| Action | Held by | For |
|---|---|---|
| `schedule:read` | national, state, district, **club**, instructor | The private half — why a day is closed. The hours themselves are public and need nothing. |
| `schedule:write` | national, state, district, **club**, training operations | Draft a version, define a season, record a special day. |
| `schedule:publish` | national, state, **club**, training director | Put a draft in front of members. |

Split from `venue:write` deliberately: a venue is a room in the estate and
`venue:write` is national and district administration, whereas the timetable is
the thing a `DOJO_ADMIN` must change on a Tuesday without asking anybody. Split
`write` from `publish` for the reason `policy:write` is split from
`policy:approve`.

Every check runs against the **owner** of the thing being changed, resolved
through `resourceForOwner()` — which fills in the state and district above a
club, so a state administrator reaches the clubs in their own state and no
others.

---

## Surfaces

| Surface | What it does |
|---|---|
| `/schedule` | The hombu dojo's week, labelled as the hombu dojo's, with a link to the club directory. Engine first, editorial strings as fallback. |
| `/facilities` | The headquarters building's hours, same precedence. |
| `/admin/schedules` | The editor: owner picker, resolved week, seasons, versions, the seven-day grid, special days, and the migration panel. |

Both public pages catch and log a database failure rather than 500 — the
editorial strings are a complete answer on their own, and losing the register
must not take the timetable off the internet.

---

## Migrating the published hours

`src/db/schedule-bootstrap.ts`, run from `/admin/schedules` by an administrator
holding `schedule:publish`. It is an admin action rather than a CLI script
because `schedule_versions` refuses a published row with no publisher — a script
would put a name on a record belonging to somebody who was not there.

`planMigration()` returns exactly what would be written and writes nothing;
`applyMigration()` re-plans before writing, so the “will not overwrite” refusal
is true at the moment of writing rather than at the moment of rendering.

**Four refusals**, each a test in `tests/schedule-bootstrap.test.ts`:

1. **Not at national scope.** A national schedule is inherited by every
   unconfigured unit — which would publish Patratu's clock as the default for
   every affiliated club in the country.
2. **Does not touch the editorial record.** The two strings stay. Pages fall back
   to them anywhere the engine has no answer, so nothing goes dark between the
   migration and somebody checking the rendering.
3. **Will not overwrite** a club that already has an operating schedule.
4. **Will not guess a class length.** The editorial `schedule` array records a
   start and no finish (`'6:00 AM'`). Those rows are **reported and not
   migrated** — how long a class runs is federation policy nobody has set, and
   an invented duration would afterwards read as the federation's decision.

Season dates come from `DIRECTIVE_SEASONS` — the windows stated as an **example**
in the federation's own instruction (01-Apr–30-Sep, 01-Oct–31-Mar). Every
surface that offers them says so, and moving a season afterwards moves every
rule bound to it.

---

## Not built

Named because a gap somebody knows about is a decision and a gap nobody knows
about is a defect.

- **Calendar adapters.** `calendar_connections`, `calendar_events` and
  `calendar_sync_log` exist and are not driven by this engine.
  `SCHEDULE_PUBLISHED` is on the domain feed with a declared payload, which is
  the hook a sync consumer attaches to.
- **Club-level change notification.** `CLASS_SESSION_CANCELLED` fans out to
  everyone holding a place, because that audience is a query. “Everyone who
  trains at this club” is not a query this system can answer honestly yet, so
  `SCHEDULE_PUBLISHED` carries **no consumer** rather than fanning out to a list
  somebody guessed at.
- **Club discovery by distance.** `venues.latitude` / `longitude` /
  `area_id` exist and are unpopulated; there is no nearby-club search.
- **Public per-club pages.** `dojos.slug` and `venues.slug` exist for
  `/clubs/[slug]`; the route is not built. `/dojos` remains the directory.
- **Rescheduling.** `class_sessions.rescheduled_to_session_id` exists;
  `cancelSession()` is implemented and a reschedule helper is not.
- **A window crossing midnight.** Not expressible, deliberately — 22:00–02:00 is
  two windows on two days, and one row meaning both makes every downstream date
  calculation ambiguous.

---

## Tests

`tests/scheduling.test.ts` (58) and `tests/schedule-bootstrap.test.ts` (16).

Covered: HQ / Club A / Club B as three different weeks · closed vs unconfigured ·
inheritance at every level and room-level override · the federation's rows
untouched by an override · seasonal Sunday both ways round · moving a season
moves the timetable · overlapping seasons refused · club-local seasons ·
holiday / seminar / maintenance exceptions · reason redaction on the public read ·
blackout subtraction · version supersession and the March-attendance case ·
published versions unedited · drafts invisible · publisher and reason enforced ·
cross-club and national authority refusals · class inside facility hours ·
refusals reported · idempotent generation · online vs hybrid venue rules · coach
and venue double-booking · coach availability · capacity under a five-way race ·
cancellation returning the seat · the cancellation notification reaching the
booked student without the reason · and the source greps for hard-coded times,
weekdays and season names.
