# Changelog

Content-key and schema migrations are recorded here (MASTER-SPEC §5.5).

## 2.1.1 — 2026-08-22 — The belt ladder the federation actually awards

Two corrections to `beltGrading` and `syllabus`, both reported by the federation
against the live site.

**THERE IS NO PURPLE BELT.** The kyu table published a Purple belt at 5th Kyu and
the kata syllabus carried it twice more, as `Blue → Purple` and
`Purple → Brown 3`. MMAKF awards no purple belt: 6th and 5th Kyu are both Blue,
the second being a grade passed with the colour retained, and Brown 3 begins at
4th Kyu as it always did. Ten kyu grades and the 5th Kyu examination fee are
unchanged — only the colour was wrong. The swatch array in
`src/pages/belt-system.astro` is a SECOND, INDEPENDENT encoding of the same
ladder, keyed by position rather than by rank, so it had to be corrected in step;
that duplication is now noted in the file against the day somebody edits one and
not the other.

**THE DAN LADDER RAN TO SIX AND STOPS AT TEN.** `beltGrading.dan` listed Shodan
to Rokudan and glossed VI Dan as "Grandmaster level (Shihan)". Shotokan runs to
Judan, and a federation publishing six is telling every senior karateka it holds
no grade left to give them. All ten are now published, with the same
n-years-after-the-previous rule the first six already used; the top two say they
are conferred rather than examined. No migration is needed —
`rank_records.grade_ordinal` and `grade_definitions.ordinal` were already
documented as `dan: 1..10`.

STILL OPEN, deliberately not changed here: `/about`, `/`, `/governance`, `README.md`
and the MASTER-SPEC glossary each style the founder's VI Dan as
"Grandmaster · Soke". That is a claim about a person's own grade, not about the
ladder, and AUDIT-REGISTER P1-8 already holds it. Extending the ladder makes the
wording harder to defend, so P1-8 wants a decision from the federation rather
than an edit from here.

## 2.1.0 — 2026-08-17 — Closing the five gaps the engine named (migration 0049)

`docs/domains/scheduling.md` listed, by name, five things the scheduling engine
deliberately did not do. All five are now built.

**Attendance was being read and never written.** `session_attendance` had existed
since the education wave and was READ by `src/db/grading.ts` — which counts a
candidate's sessions since their last grade when deciding whether they may be
examined — and by `src/db/athletes.ts`. NOTHING IN THE REPOSITORY EVER WROTE A
ROW, so the count was always zero. `src/db/attendance.ts` is the writer, using
the tables that already exist: `training_sessions` for the sheet, joined to an
occurrence by the new `training_sessions.class_session_id`. A separate
attendance table would have left grading blind to every class the engine ran.
Three states — present, absent and NOT MARKED — with the third as the default,
because filling in gaps invents training somebody did not do. An amendment
records the value it replaced in the audit row. An `INSTRUCTOR` may mark THE
SESSION THEY TEACH through a check against `class_sessions.coach_person_id`, and
holds no `attendance:write` at all.

**A revocable personal calendar feed.** `src/pages/calendar.ics.ts` refused to
build one for a stated reason — it "needs a per-user secret in the URL and its
own revocation story". `src/lib/calendar-feed.ts` is both halves:
`calendar_feed_tokens` stores a SHA-256 of a 32-byte secret and never the secret,
which is returned once and is absent from the audit trail too; revocation bites
on the next poll; and unknown, revoked and malformed tokens all return the same
404 so a URL cannot enumerate live ones. `/my/calendar/[secret].ics` serves it
with `private, no-store`. A COACH feed carries BUSY BLOCKS ONLY — no class name,
no venue, no student — because a teaching calendar is routinely shared and a year
of named classes in it is a movement pattern for an adult who works with children.

**A federation-wide announcement that cannot be sent by accident.**
`src/lib/notifications.ts` still refuses to fan out above club scope
automatically. `src/db/schedule-announce.ts` is the deliberate act it named: the
audience is COUNTED AND FROZEN at draft time, the administrator TYPES the figure
they were shown, and above 200 recipients a second person must agree — through
`src/lib/approvals.ts`, which already has the once-only guard, not a second
implementation. `sent_count` is recorded apart from `audience_count`, so somebody
leaving the unit between draft and send is reported rather than hidden.

**Windows that cross midnight.** Migration 0032's rule is UNCHANGED — one row
still never means two days — but `setRules()` now performs the split itself:
22:00–02:00 becomes 22:00–24:00 on the day and 00:00–02:00 on the next, wrapping
Sunday onto Monday. `24:00` is storable only as a CLOSING time, and
`zonedInstant()` maps it to the following midnight so the two halves abut
exactly. Asking an administrator to enter two rows is how a timetable ends up
with one half moved and the other left behind.

**The admin resource view.** `/admin/timetable` is a grid of rooms against days
for one week, plus the register at each class and a report of classes that ran
with nobody marked. An empty cell means nothing is booked in that room — not that
the room is open, which is a schedule and is said so.

**Authority** — `DOJO_ADMIN` gains `attendance:read/write` (a club must be able
to record who was at its own class) and `notification:read/send` (a club must be
able to tell its own families the Sunday moved; the scope binding limits it to
that club, and the threshold still applies). `INSTRUCTOR` gains
`attendance:read`. `mass_notification` joins `APPROVAL_ACTIONS`.

**Tests** — `tests/attendance.test.ts` (21), `tests/calendar-feed.test.ts` (18),
`tests/schedule-announce.test.ts` (21), and seven more in
`tests/scheduling.test.ts` for the overnight split. Migration
`0050_data_api_lockdown.sql` puts the two new tables behind RLS.

## 2.0.0 — 2026-08-17 — The federation scheduling engine (migration 0032)

**The defect.** MMAKF's opening hours lived in two English sentences on the
editorial record, and `/schedule` published them under the heading "The weekly
timetable" as though they were the federation's. They are the **hombu dojo's**.
Every affiliated club in the country was represented on the federation's own
site as training at six in the morning because Patratu does — and a parent who
read that page and travelled to a club sixty miles away found a locked door with
the federation's name over it. The season was in the prose (`Summer … Winter …`)
with the changeover date recorded nowhere at all, and changing any of it needed a
developer editing TypeScript behind a deploy.

**Schema** — `drizzle/0032_scheduling_engine.sql`, seven new tables:
`seasons`, `schedules`, `schedule_versions`, `schedule_rules`,
`schedule_exceptions`, `dojo_classes`, `class_sessions`. Plus a timezone, slug,
coordinates and civil area on `venues`; a slug and timezone on `dojos`; and ONE
column on `bookings` (`class_session_id`) rather than a second booking table.
`drizzle/0033_data_api_lockdown.sql` puts all seven behind row-level security.

Reused rather than rebuilt: `state_units` / `district_units` / `dojos` for the
hierarchy, `venues` for facilities, `coach_availability` for instructor
availability, `bookings` + `booking_resources` for booking, `venue_blackouts` for
room closures, and `audit_events` for who-changed-what-when-why.

**Engine** — `src/db/scheduling.ts`. A schedule belongs to a SCOPE (the same
`scope_type` RBAC already uses). Inheritance is RESOLVED, never copied: the
resolver walks room → club → district → state → federation and stops at the
first level with a version in force, so an unconfigured club inherits visibly
and a configured one overrides without the federation's rows being touched.
Seasons are rows with dates an administrator chose — nothing in the engine knows
the words 'summer' or 'winter', and a test greps the source to keep it that way.
Versions are effective-dated and superseded, never edited, so a March attendance
record still renders against March's timetable. Facility hours and class times
are different objects, and a class outside its room's open hours is refused and
REPORTED rather than silently dropped.

**Authority** — three new actions: `schedule:read` (the private half — why a day
is closed), `schedule:write`, `schedule:publish`. A `DOJO_ADMIN` holds all three
for its own club, which is the whole point: a club sets its own hours, seasons,
class times and holidays without the federation and without a developer.

**Surfaces**
- `/schedule` and `/facilities` now read the engine and fall back to the
  editorial strings, and both state in words that the timings are the
  headquarters' and not any club's.
- `/admin/schedules` — the editor: owner picker, resolved week, seasons,
  versions, a seven-day × four-session grid, special days, and a dry-run
  migration panel for the published headquarters hours.

**Migration of the existing values** — `src/db/schedule-bootstrap.ts`, run as an
audited admin action. It carries the exact published values across and refuses
four things: to store them at national scope (which would publish one dojo's
clock as every club's default), to touch the editorial record, to overwrite a
club that has already configured hours, and to guess a class length — the
editorial timetable records a start and no finish, so those thirteen rows are
reported and left where they are.

**Notification** — `SCHEDULE_PUBLISHED` and `CLASS_SESSION_CANCELLED` join the
domain-event catalogue. The second fans out to everyone holding a place on the
session, carrying the class and the time and NOT the reason.

**Club discovery and club pages** — `/clubs` is the SEARCH (currently-affiliated
clubs, filtered by city, PIN code, age, audience, level, discipline and online
availability, ordered by straight-line distance only where a venue carries real
coordinates); `/dojos` remains the REGISTER, which also lists lapsed units.
`/clubs/[slug]` is a club's own page — affiliation standing first, then ITS OWN
published week, its classes, its rooms and its credentialed instructors. The
instructor list is an INNER join on `instructor_quals`; a left join would have
published every child at the club under "Who teaches here". A lapsed club has no
page and returns a real 404. The sitemap expands only clubs that are affiliated
AND carry a slug an administrator set.

**Moving a class** — `rescheduleSession()` creates the successor and CARRIES
EVERY LIVE BOOKING ONTO IT: a member whose Tuesday moved still has a place, and
that is a different thing to tell them than a cancellation. The new time is
checked exactly as a generated one is; `force` overrides and writes what it
overrode to the audit row.

**Finding a time for a school or corporate** — `deliveryOptions()` returns starts
that satisfy facility available + instructor available + the client's own window
+ nothing else on the room + nothing else on the coach. `durationMinutes` is
required with no default, for the reason src/db/booking.ts gives about session
length.

**Personal schedules and calendars** — `/my/schedule` shows a member their four
weeks (cancelled and moved sessions included, struck through, with what
happened) and what their club has open to book; it takes no identifier of any
kind. `/clubs/[slug]/schedule.ics` is an always-anonymous subscribable feed of
published occurrences and closures — no instructor per occurrence, no closure
reasons, no seat counts.

**Notification** — `CLASS_SESSION_RESCHEDULED` joins the catalogue, and
`SCHEDULE_PUBLISHED` now fans out to the CLUB's own members via `persons.dojo_id`.
It resolves to nobody for a national, state or district publication: "every
member in the country" is not a fan-out this system performs because one
administrator saved a form.

**Tests** — `tests/scheduling.test.ts` (76), `tests/schedule-bootstrap.test.ts`
(16) and `tests/clubs.test.ts` (18). Documented in `docs/domains/scheduling.md`,
including what remains deliberately unbuilt: Google/Outlook two-way sync,
federation-wide change notification, class-session attendance, and a window
crossing midnight.

## 1.9.0 — 2026-08-11 — Real transactions + multi-agent audit remediation

**Real functionality replacing placeholder affordances**
- **Event registration is real**: new `POST /api/event-register` issues an entry reference (`MMAKF-E-YYYY-NNNNNN`), stores entries privately (`eventRegs`, never in `/api/data`), and surfaces them in a new admin **Event Entries** queue. Row "Register" buttons now deep-link to the entry form and pre-select the event — the toast-only buttons are gone.
- **Shop orders are real**: every product carries a `upi://pay` intent link (amount + payee pre-filled) and a WhatsApp order deep link, replacing the informational toast.
- Visual depth: crossfading hero slideshow (3 slides, reduced-motion aware), horizontal gallery carousel on the homepage, photo cards for news (new admin `img` field on news).

**Audit remediation** (30-agent visual/content/code audit with adversarial verification)
- **Critical**: past events were advertised as "next" with live Register buttons. New `src/lib/events.ts` filters and sorts by real dates; concluded events move to an archive table on /events; empty states added.
- Footer crest watermark painted a grey square (the asset is an opaque JPEG named .png) — replaced with a soft crimson glow; same fix on 404.
- Shop product photos showed unrelated stock (sweatshirt for a gi, pull-ups for a belt set) — removed in favour of the branded icon fallback.
- Unverifiable claims corrected: "WKF Affiliated" → "WKF International Pathway" (ticker + site-wide meta), invented "1,200+ women trained" stat, "longest-running in eastern India" superlative, invented state-unit charter years (now blank + "pending confirmation" note), a named individual's "world-record-level" claim, and hedge-worded Guinness copy.
- Academy: "180+ recorded lessons" claim (14 exist) removed sitewide; pills now state real counts; "1 Lessons" pluralisation fixed; "Online University" unified to **Online Academy**.
- Gallery captions no longer present stock photography as specific federation moments (now generic training/competition categories).
- Governance: "National Champion" replaced as an office designation (athletic honour ≠ office); note added that statutory titles are constituted under the bye-laws.
- Header wordmark shows the full federation name (no "Modern Martial Arts" truncation); footer meme tagline replaced; ad-agency homepage copy rewritten factually.
- Mobile: Dan credential pills wrap instead of overflowing on /belt-system.

## 1.8.0 — 2026-08-11 — Light institutional redesign (Master Charter §5–§7)

- **Full light theme**: warm-white paper body with ink text, controlled crimson/gold accents, dark photo heroes and a dark crest-watermarked footer — the national-federation convention (white-major per federation direction; black reserved for hero/footer bands). All 300+ component styles re-tokenized; semantic token names preserved (`--white` = primary text/ink, `--bg` = paper).
- **Glyph cleanup**: all kanji watermarks (空手道 / 師範 / 修行 / 師 / 道) and ◆ diamond separators removed — they read as vague symbols and could render as broken boxes on devices without Japanese fonts. Replaced by the official federation crest (`/logo.png`) as the watermark (footer, 404, governance portrait placeholder) and clean middot/hairline separators.
- **Invented fees removed** (Charter §68): registration category fee amounts and the academy's ₹999/month deleted — fees now read "as notified by the office". No official amount is stated anywhere unless supplied via admin-editable content.
- White glass navigation with active-page underline; hero and page heroes keep dark photo treatment with light text overrides; PWA `theme-color` → white.

## 1.7.0 — 2026-07-07 — Online Academy (LMS) + circulars channel

- **Schema**: three new public keys — `courses` (id, title, belt, level, desc), `lessons` (course [exact-title join], title, dur, video URL, access Free/Members), `circulars` (no, date, title, body) — 23 public keys total.
- **New page /academy** — the LMS surface behind the Online University claim: how-online-training-works, course catalogue grouped by belt level with numbered lesson tables (duration, access pill, Watch link when a video URL is present; "Coming online"/"Members library" states otherwise). Linked from the homepage explore strip and footer Training column; in the sitemap (15 routes).
- **Unit Portal deepened**: units now see official **Circulars from the national office** (top of portal) and the **Documents & forms register** (charter renewals, grading applications) without leaving the portal.
- Admin: three new panels — Academy Courses, Academy Lessons (paste a video URL to activate Watch), Circulars.

## 1.6.0 — 2026-07-06 — Multi-level federation management (Unit Portal)

- **New surface `/unit`** — the management portal for State Associations, District Associations and Clubs. Each unit signs in with an access code and gets tools scoped server-side to its state: members register (read-only), registration applications to verify (with contact details — that's their workflow role), and a submissions channel to the national office (Result report / News report / Event proposal / Grading report, ≤2000 chars).
- **Fully controlled by the national admin panel**: new `unitAccess` key (ADMIN-ONLY — writable via the authenticated data API through a new allow-list, never present in public KEYS or `/api/data`) with a Unit Access ListPanel to issue, edit, and instantly revoke codes (Status → Disabled). New read-only **Unit Submissions** queue in admin; publishing remains a national-admin action via the News/Events/Results panels.
- **Auth**: second signed-cookie session type `mmakf_unit` carrying `{name, level, state}` (HMAC-SHA256, 7-day, HttpOnly, SameSite=Lax, timing-safe verify). New endpoints `POST /api/unit/login` (400 ms damping on failure), `POST /api/unit/logout`, `POST /api/unit/submit` (401 without session; unit identity stamped server-side from the session, never from the request body).
- New private key `submissions` (cap 500, excluded from public KEYS like `leads`/`registrations`).
- Footer gains a "Unit Portal →" link beside Admin. Sample access codes in seed are placeholders — rotate before production.

## 1.5.0 — 2026-07-06 — National member registration & ID verification

- **Schema**: new public key `members` (national register: id, name, type, grade, state, unit, status, validTill — no contact data; 20 public keys total) and new **private** key `registrations` (applications with phone — excluded from KEYS, never served by /api/data, mirroring `leads`).
- New page **/registration** (in main nav, replacing Facilities which remains in the explore strip/footer): membership categories with fees (Athlete ₹300/yr · Instructor ₹1,000/yr · Dojo per charter · Official ₹500/yr), four-step process, online application form, and the public **Verify a Member ID** tool.
- New endpoints: `POST /api/register` (validates type against the four categories, issues application number `MMAKF-R-{year}-{serial}`, stores privately, cap 2000) and `GET /api/verify?id=` (case-insensitive lookup against the members register; returns register data only; no-store).
- Member ID scheme: `MMAKF-{A|I|D|O}-{year}-{serial}`.
- Homepage gains a Member Services band (Register / Verify) after the events calendar; footer links both.
- Admin: **Members Register** panel (full CRUD — approval workflow: verify application → collect fee → add member) and read-only **Registration Applications** table (first 200 shown).

## 1.4.0 — 2026-07-06 — Federation audit: homepage, documents & results registers

- **Homepage audit fix**: fee/curriculum surfaces removed from the homepage — programs grid (₹ fees), training-system pillars, belt fee tables, Online University pricing, weekly schedule table, shop teaser and testimonials now live only on their dedicated pages. Homepage = hero + calendar panel, news, events, about, explore strip, lineage, women's division, achievements, enroll, contact.
- **Schema**: new content keys `documents` (official register: title, cat, ref, url — empty url renders a "request from office" mailto) and `results` (championship results: title, date, venue, note) — 19 public keys total.
- /governance gains **Documents & Policies** (constitution, code of conduct, NADA/WADA anti-doping, safeguarding, charter/grading/tournament forms); /events gains **Championship Results** register.
- Admin: Documents and Results panels; footer links to both registers.

## 1.3.0 — 2026-07-06 — National federation structure & governance

- **Schema**: new content key `stateUnits` (state associations register: state, unit, hq, districts, status, since) — 17 public keys total. `leadership[]` gains `since`, `specialty`, `img`, `bio` (full profiles).
- New page **/governance** (in main nav): office-bearers register table, six standing committees/commissions, seven-tier organisational hierarchy (National → State → District → Club → School), featured Grandmaster profile + full faculty biographies with monogram/portrait support.
- **/affiliation** reframed as the national structure: four-step affiliation ladder (National Federation → State Associations → District Associations → Clubs/Dojos/Schools) + chartered State Associations register + unit-charter enquiry contact.
- **Homepage rebuilt on the national-federation pattern** (researched WKF + AIFF): no officials' names on the homepage; hero side panel is now "Next on the Calendar" (upcoming events); News and Events sections moved to the top (news-first); leadership card grid removed in favour of the /governance page.
- Nav: **Governance** added; **Shop** moved to footer/explore strip (federation convention).
- Admin: State Associations panel; Leadership panel now edits designation, grade, since, specialty, portrait URL, note and full biography.

## 1.2.0 — 2026-07-06 — Photography pass (AS-6 revised)

- **Schema**: `products[]` and `gallery[]` gain optional `img` (image URL). When present it renders as a dark-treated cover photo; `icon` remains the fallback. Admin panels expose the field.
- Homepage hero and eight sub-page heroes (`about`, `programs`, `facilities`, `schedule`, `belt-system`, `events`, `shop`, `affiliation`) now carry full-bleed background photographs behind gradient shades; `PageHero` gains an `image` prop.
- Seed gallery items re-captioned to match their photographs (all 21 image URLs verified live before adoption).
- CSP `img-src` extended with `https://images.unsplash.com`.
- Photo treatment: `grayscale(0.25–0.45) brightness(0.6–0.88)` normalizes mixed stock into the black/crimson/gold identity; hover restores full color.

## 1.1.0 — 2026-07-06 — Spec-normative build (§15.8)

- **Schema**: admin add-forms now write `icon` for programs/products/achievements (previously `ico`/`e`, which public pages never read). Items added through the old forms carry dead `ico`/`e` fields — harmless; re-add or ignore.
- `storage.getAll()` batches reads into one Redis `MGET`; malformed stored values (wrong broad shape) fall back to seed with a logged warning.
- New endpoints: `GET /api/health`, `GET /sitemap.xml`. New branded `404` page.
- Login hardening: constant-time cookie-signature compare; production refuses logins when `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET` are unset.
- Admin: delete confirmation, double-submit guards, failure toasts on network errors.
- Public forms: `res.ok` handling, double-submit guard, privacy microcopy, `noscript` fallback, aria-labels; toasts announce via `aria-live`; hamburger exposes `aria-expanded`; visible `:focus-visible` outline; ticker honors reduced motion.
- Shop/homepage order buttons use data attributes + delegated listener (no inline handler interpolation).
- Homepage enroll section replaced by the shared `EnrollCTA` component (one form implementation site-wide).
- Infra: `vercel.json` (region `bom1`, CSP-Report-Only, nosniff, referrer policy), GitHub Actions CI (test + build), Vitest suite (21 tests).

## 1.0.0 — 2026-07-06 — Full federation build

- 12 public pages; 16 admin-editable content keys (added `facilities`, `faqs`, `gallery`, `syllabus`, `branches`); institutional design system; master spec in `docs/MASTER-SPEC.md`.

## 0.x — May 2026 — v5 base

- Single-page site + admin CMS (11 keys), Vercel + Upstash architecture.
