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
| `/clubs` | **Find a club** — the search. Filters by state, district, city, age, audience, level, discipline and online availability, all derived from what clubs have actually published. Nearby by PIN code, city, or a browser location the reader presses a button for. |
| `/clubs/[slug]` | A club's own page: standing and charter validity first, then **its own** published week, its classes, its rooms and its credentialed instructors. |
| `/clubs/[slug]/schedule.ics` | The club's subscribable timetable — anonymous, published occurrences and closures only. |
| `/my/schedule` | A member's own four weeks: what they hold, what moved, what was cancelled, and what their club has open to book. |
| `/admin/schedules` | The editor: owner picker, resolved week, seasons, versions, the seven-day grid, special days, occurrence generation, cancel/reschedule, and the migration panel. |

Both public timetable pages catch and log a database failure rather than 500 —
the editorial strings are a complete answer on their own, and losing the
register must not take the timetable off the internet.

### /clubs is not /dojos

Two questions, two surfaces, one register:

- **/dojos** is the affiliation **register**. *Is the club my child already
  trains at affiliated, today?* It lists lapsed units, with standing in words,
  because the reader most in need of it is a parent of a child already
  somewhere.
- **/clubs** is the **search**. *Where can my child train?* It offers currently
  affiliated clubs only. Recommending a club whose charter expired is the
  federation vouching for something it has withdrawn.

### Distance, honestly

`nearbyClubs()` orders by great-circle distance **only** where the venue carries
real coordinates; every other club follows in name order with `distanceKm: null`,
and the page labels distances straight-line. A PIN code is an **area match**, not
a distance: `postal_codes` maps a code to an `admin_areas` row and carries no
coordinates, so inventing one for the centre of a postal district would publish a
measurement nobody took. Location is asked for by a button press, never read on
load.

### What a club page will not publish

No telephone number, no email address, no instructor contact details — the
federation removed its own published personal numbers from fourteen places on
this site, and republishing a club's under a different heading would undo that.

The instructor list is an **INNER** join on `instructor_quals`. A left join — the
natural way to write it — would publish the name of every member at the club,
including every child, under the heading *"Who teaches here"*.

A lapsed, suspended or revoked club has **no page**: `clubProfile()` returns null
and the route answers a real 404, not a soft one. A soft 404 is indexed.

---

## Moving and cancelling

- `cancelSession()` releases every place, attaches the reason to each booking,
  and publishes `CLASS_SESSION_CANCELLED`.
- `rescheduleSession()` creates the successor, **carries every live booking onto
  it**, links the rows, and publishes `CLASS_SESSION_RESCHEDULED`. A member whose
  Tuesday moved still has a place; a member whose Tuesday was cancelled does not,
  and the difference is what they are told.
- The new time is checked exactly as a generated one is — room open, inside the
  room's hours, no coach or venue conflict. `force` is the only way past, it is
  never a default, and what was overridden is written to the audit row.

## Finding a time for a school or corporate

`deliveryOptions()` returns every start satisfying all of: **facility available +
instructor available + inside the client's own window + nothing else on the room
+ nothing else on the coach**. Starts are on a 15-minute grid inside each open
window.

`durationMinutes` is **required with no default** — how long MMAKF's school
sessions run is federation policy nobody has set, and a default would appear in a
quotation as though the federation had decided it. The same refusal
`src/db/booking.ts` makes about session length, notice period and cancellation
windows.

## Who is told

| Event | Audience | Resolved from |
|---|---|---|
| `CLASS_SESSION_CANCELLED` | everyone holding a place | `bookings.class_session_id` |
| `CLASS_SESSION_RESCHEDULED` | everyone holding a place | same |
| `SCHEDULE_PUBLISHED` | the **club's** own members | `persons.dojo_id`, active only |

`SCHEDULE_PUBLISHED` resolves to **nobody** for a national, state or district
publication. Not because those changes do not matter, but because "every member
in the country" is a fan-out this system must never perform on the strength of
one administrator saving a form. A national announcement is a circular, which is
a different act with a different approval path.

Notification bodies carry the class and the time and **never the reason**: a
notification travels through channels the federation does not control, and
"cancelled — instructor bereavement" is not a sentence to put in an SMS to two
hundred families. `SCHEDULE_PUBLISHED` carries no times at all — half a timetable
is worse than none, and the link goes to the page that has all of it.

## Calendar

`/clubs/[slug]/schedule.ics` is **always anonymous**, for the reason
`/calendar.ics` sets out at length: a calendar client fetches with no cookies and
no way to sign in, so a session-scoped feed works in a browser and then quietly
does nothing in the app that subscribes — except on the day somebody shares the
URL. The feed carries published occurrences and closures, not the instructor
against each occurrence (a year of one named person's whereabouts), not the
closure reasons, and not the remaining places (a number cached at poll time is a
number that is wrong when it is read).

A cancelled session is published with `STATUS:CANCELLED` rather than dropped, so
a subscriber's existing entry changes instead of lingering for ever.

A **personal** feed — "my classes" — needs a per-user secret in the URL and its
own revocation story. Until the federation asks for that, `/my/schedule` is where
a member reads their own.

## SEO

`/clubs/[slug]` is expanded into the sitemap from `publishableClubs()`, which
returns clubs that are **currently affiliated AND carry a slug an administrator
set**. Both halves matter: the first stops a lapsed club being advertised as the
federation's recommendation; the second stops a URL being minted from a name that
will change and break a link a parent bookmarked. The federation's instruction is
explicit — *"DO NOT generate fake location pages. Only index real verified
locations."*

`tests/clubs.test.ts` asserts that every URL the sitemap advertises resolves,
which is what stops the two implementations drifting.

---

## Attendance

`session_attendance` had existed since the education wave and was **read** by
`src/db/grading.ts` (to count a candidate's sessions since their last grade) and
by `src/db/athletes.ts`. **Nothing wrote it** — so grading was counting a number
that was always zero.

`src/db/attendance.ts` is the writer. It uses the tables that already exist:
`training_sessions` for the sheet, `session_attendance` for the marks, joined to
an occurrence by `training_sessions.class_session_id` (migration 0049, unique
when set). A separate `class_session_attendance` table would have left grading
blind to every class the engine ran — a defect that surfaces years later as a
candidate refused a grading they had trained for. `tests/attendance.test.ts`
asserts the existing join still sees it.

Four rules:

1. **One register per occurrence.** A second call amends; it does not duplicate.
2. **Present is never assumed.** Three states — present, absent, **not marked** —
   and the third is the default. Filling in gaps would invent training somebody
   did not do, or deny training they did.
3. **An amendment records what it replaced.** `session_attendance` has no
   `correctedFrom` column, so the value goes into the audit row.
4. **No register at a class that did not happen.** Cancelled is refused; so is a
   class that has not started, unless `allowFuture` is passed explicitly for a
   camp registered from a signed list.

**Authority:** `attendance:write` in the club's scope — *or* the coach teaching
that very occurrence, checked against `class_sessions.coach_person_id`. An
`INSTRUCTOR` holds `attendance:read` and not `attendance:write`, so the row is
what lets them mark their own class and nothing else.

`missingRegisters()` lists classes that ran with nobody marked. Without it, a
class whose instructor forgot the register is indistinguishable from a class
nobody attended.

## Personal calendar feeds

`src/pages/calendar.ics.ts` refused to build a per-user feed for a stated reason:
one "needs a per-user secret in the URL and its own revocation story".
`src/lib/calendar-feed.ts` is both halves.

- **The secret is never stored.** `calendar_feed_tokens.token_hash` is a SHA-256
  of it, as `users.mfa_recovery_hashes` treats recovery codes. Returned once, at
  creation; not recoverable, and not in the audit trail either.
- **32 bytes from `randomBytes`**, base64url. SHA-256 rather than a slow hash
  deliberately: the input is 256 bits of entropy, not a password, and a slow hash
  would add latency to every calendar poll and defend against nothing.
- **Revocation is immediate** — resolution reads `status` on every fetch — and is
  a status, not a delete.
- **Unknown, revoked and malformed all return the same `null`,** so a URL cannot
  enumerate live tokens.
- **Ten live tokens per person.** A member with forty cannot say which leaked.

Two scopes. `own_classes` carries the class, the time and the room. `coach_diary`
carries **busy blocks only** — "MMAKF (busy)", no class name, no venue, no
student — because a teaching calendar is routinely shared with a family or an
employer, and a year of named classes in it is a movement pattern for an adult
who works with children.

Served at `/my/calendar/[secret].ics` with `Cache-Control: private, no-store`,
`X-Robots-Tag: noindex`, and 404 for anything that does not resolve.

## Federation-wide announcements

`src/lib/notifications.ts` resolves `SCHEDULE_PUBLISHED` to a **club's** own
members and to **nobody** above that, because "every member of the federation is
a fan-out this system must never perform on the strength of one administrator
saving a form" — and it named a circular as "a different act with a different
approval path". `src/db/schedule-announce.ts` is that path.

Four safeties, in the order they bite:

1. **The audience is counted and frozen at draft time.** An administrator
   authorises a *number*, not a promise.
2. **Above `TWO_PERSON_THRESHOLD` (200) it takes two people** — through
   `src/lib/approvals.ts`, which already has the once-only execution guard, not a
   second implementation. `mass_notification` joins its registry.
3. **The confirmed count is typed, not clicked.** A figure that does not match
   the frozen one means a stale page, and the send is refused.
4. **It cannot write to anybody twice.** `queue()` deduplicates on
   `(domainEventId, personId, channel)` — its only deduplication — so the
   announcement publishes `SCHEDULE_ANNOUNCED` first and stamps every
   notification with that event's id.

`sent_count` is recorded separately from `audience_count`: somebody may have left
the unit in between, and the gap is reported rather than hidden. A national
announcement reaches every *placed, active* person; somebody an intake created
and never placed is not written to. An institution reaches nobody — a client is
not a member.

## Windows that cross midnight

Migration 0032 refused to make `22:00–02:00` expressible, because "one row
meaning two days would make every downstream date calculation ambiguous". **That
rule is unchanged.** What migration 0049 changed is who does the arithmetic:
`setRules()` accepts a crossing window and **splits it** into `22:00–24:00` on
the day and `00:00–02:00` on the next, wrapping Sunday onto Monday.

`24:00` is storable only as a *closing* time — the CHECK on `opens_at` is
untouched, because a window cannot begin at the end of a day. `zonedInstant()`
converts it to the following midnight, so the first half's end instant is exactly
the second half's start: the two abut, with no gap and no overlap.

Asking an administrator to enter two rows was the alternative, and it is how a
timetable ends up with one half of a window moved and the other left behind.

## The admin resource view

`/admin/timetable` is a grid of **rooms against days** for one week, plus the
register at each class. A date-ordered list answers "what is on" and makes
somebody read forty rows to answer "is this room free on Thursday evening"; a
grid answers it by looking.

An empty cell means *nothing is booked in that room that day* — **not** that the
room is open. Opening hours are a schedule, and the page says so rather than
letting a blank read as availability.

---

## Not built

- **Google / Outlook two-way sync.** `calendar_connections`, `calendar_events`
  and `calendar_sync_log` exist and are still not driven. The read side is now
  complete — a club feed, a member feed and a coach busy feed, all iCal — which
  is what a subscription-based integration actually needs. A *push* integration
  additionally needs OAuth credentials this deployment does not hold, and
  `src/lib/youtube.ts` sets the precedent for how those would be stored
  (AES-256-GCM, `encryptToken`). `SCHEDULE_PUBLISHED` and `SCHEDULE_ANNOUNCED`
  are the hooks a push consumer attaches to.
- **Attendance-derived grading eligibility rules.** The count is now real;
  what number of sessions MMAKF requires for each grade is federation policy
  nobody has set, and `src/db/grading.ts` continues to report the count rather
  than invent a threshold.

---

## Tests

`tests/scheduling.test.ts` (83), `tests/schedule-bootstrap.test.ts` (16),
`tests/clubs.test.ts` (18), `tests/attendance.test.ts` (21),
`tests/calendar-feed.test.ts` (18) and `tests/schedule-announce.test.ts` (21).

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
booked student without the reason · rescheduling carrying bookings onto the new
time · a move refused outside the room hours and on a closed day · an override
recorded in the audit trail · delivery options for a school inside the client’s
own window and against a coach’s diary · a personal week showing what moved
rather than a gap · a club’s own members told and the country not · a search that
refuses to offer a lapsed club · a club page that lists instructors and not
students · a distance that is measured or absent, never guessed · a PIN code as
an area rather than a coordinate · a sitemap that advertises only URLs that
resolve · an overnight window split across two days whose halves abut exactly ·
24:00 refused as an opening time · a register that amends rather than
duplicates and records what it replaced · an unmarked person who is not an
absent person · a coach who may mark their own class and not another · the
existing grading join still seeing every mark · a feed secret that is absent
from the database and from the audit trail · revocation that bites on the next
poll · an unknown, revoked and malformed token that are indistinguishable · an
announcement audience counted and frozen · a typed confirmation that refuses a
stale figure · a large fan-out that waits for a second person · what actually
went out recorded apart from what was promised · and the source greps for
hard-coded times, weekdays and season names.
