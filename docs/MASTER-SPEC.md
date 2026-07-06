# MMAKF Federation Platform — Master Engineering Specification

**PRD · SRS · Technical Design Document · System Architecture Blueprint**

| Field | Value |
|---|---|
| Product | Official website + headless admin CMS of the Modern Martial Arts Karate-Do Federation of India (MMAKF) |
| Document version | 1.0.0 |
| Date | 2026-07-06 |
| Status | Approved — single source of truth |
| Repository | `https://github.com/infommapatratu-byte/mmakf` |
| Production domain (target) | `https://www.mmakf.in` (+ apex `mmakf.in`) |
| Runtime stack | Astro 4 (SSR, `output: 'server'`) · Vercel serverless · Upstash Redis · vanilla TypeScript/JS · zero client framework |
| Audience | AI coding agents (Claude Code) and senior software engineers. This document is written so implementation never requires product clarification. |

---

## 0. Document Conventions, Glossary & Assumptions Register

### 0.1 Requirement identifiers

- `FR-*` — functional requirement (must implement).
- `NFR-*` — non-functional requirement (must satisfy).
- `BR-*` — business rule (governs behavior).
- `AS-*` — explicit assumption. Where the original intent allowed multiple readings, the chosen interpretation is recorded here **and the alternatives are listed**; do not silently change them.
- `FUT-*` — designed but deferred capability (build the seams, not the feature, unless stated).

MoSCoW notation: **[M]** must, **[S]** should, **[C]** could.

### 0.2 Glossary

| Term | Meaning |
|---|---|
| Federation / MMAKF | Modern Martial Arts Karate-Do Federation of India, est. 1983, HQ Patratu, Ramgarh district, Jharkhand |
| Hombu dojo | Federation headquarters training hall at Patratu |
| Shihan | Grandmaster-level instructor title (here: Shihan Pramod Kumar Pathak, VI Dan, Soke) |
| Sensei / Senpai | Instructor / senior student |
| Kyu | Coloured-belt grade, counts down 10th → 1st |
| Dan | Black-belt grade, counts up I → X (site lists I–VI) |
| Kihon / Kata / Kumite / Bunkai / Reigi | The five training pillars: basics / forms / sparring / application / etiquette |
| Gi | Karate uniform |
| WKF | World Karate Federation (international pathway: SportsID, Sportdata) |
| Content key | One of 16 named JSON documents that constitute all editable site content (see §5) |
| Lead | An enrolment enquiry captured from the public free-trial form |
| Admin | The single federation operator persona with password access to `/admin` |
| Seed | Compile-time default content in `src/data/seed.ts`; the fallback when a key is absent from Redis |

### 0.3 Assumptions register (binding)

| ID | Assumption | Alternatives considered | Rationale |
|---|---|---|---|
| AS-1 | Single-admin model: exactly one shared admin password; no user accounts, roles, or per-editor identity in v1. | Multi-user RBAC with named accounts. | Original product operates with one federation office. RBAC is specified as FUT-1 with seams (see §9.3). |
| AS-2 | Commerce is **manual UPI**: the shop and grading fees direct users to pay UPI `9939144318@ybl` and confirm via phone/WhatsApp. No payment gateway, cart, or order database in v1. | Razorpay/Stripe checkout with order records. | Matches the federation's actual operating flow. Gateway integration is FUT-2 (§13.6). |
| AS-3 | Event "registration" is informational: the Register button surfaces instructions (call the office; desk opens 30 days before event). No event-registration records in v1. | Online event registration with forms and payments. | Consistent with AS-2; specified as FUT-3. |
| AS-4 | Content datastore is **Upstash Redis** key-value JSON (16 keys + `leads`), not a relational DB. §5 documents this store with RDBMS-grade rigor plus a relational migration mapping. | Postgres from day one. | Zero-ops, free tier, already integrated via Vercel Marketplace. |
| AS-5 | The public site renders **server-side on every request** and relies on HTTP/edge caching (60 s browser / 300 s edge on the data API; page HTML uncached by default) rather than static builds, so admin edits appear within minutes without redeploys. | SSG + rebuild webhooks. | Matches `output: 'server'` and the existing cache headers. |
| AS-6 *(revised 1.2.0)* | Imagery = hotlinked stock photography (images.unsplash.com, dark-treated via CSS `grayscale/brightness` filters + gradient shades) on heroes, products and gallery, with the inline SVG icon system as the universal fallback (`img` absent/failing → icon tile). Self-hosted uploads remain FUT-4 (§6.10). CSP `img-src` allows `https://images.unsplash.com`; admin products/gallery panels expose an `img` URL field. | v1 icon-only (original AS-6); media library with uploads. | User verdict: icon-only tiles read as wireframe. Hotlinks add photography with zero storage ops; the federation swaps in real dojo photos over time via the admin URL fields. |
| AS-7 | Notifications in v1 are in-app toasts only; transactional email for new leads is FUT-5 with a fully specified design (§11). | Email/SMS from day one. | No email provider is provisioned; the office works from the admin Leads table + phone. |
| AS-8 | Locale: English (Indian conventions — ₹, IST, en-IN dates). Hindi i18n is FUT-6. | Bilingual launch. | All current copy is English. |
| AS-9 | Legal/compliance baseline is India's DPDP Act 2023 for lead PII (name + phone). No cookies requiring consent banners are set for visitors (analytics is cookieless Vercel Web Analytics; the only cookie is the admin session). | GDPR-style consent tooling. | Target audience is Indian; §9.10 documents obligations. |
| AS-10 | "Facilities" (user request) means both the *physical dojo facilities content* (a dedicated page + editable dataset) **and** full product surface area (all pages/features listed herein). Both are in scope and specified. | Facilities = only amenities page. | User asked for "full fledged dojo website with all facilities" then "full federation level". |

### 0.4 Reading map

Sections 1–4 define *what* the product does; 5–13 define *how*; 14–17 define *operations and growth*; 18 is the end-to-end behavioral contract and acceptance checklist.

---

# 1. Product Vision

## 1.1 Purpose

Give MMAKF — a 42-year-old Shotokan karate federation with record-book recognition, a WKF pathway, and a historical footprint of 130+ school programs — a single authoritative digital home that:

1. **Represents** the institution with governing-body gravitas (not a gym landing page).
2. **Recruits** students through a zero-friction free-trial funnel.
3. **Operates** as the federation's publishing tool: every piece of public content is editable by a non-technical office administrator in a password-gated CMS, with changes visible on the public site within minutes and no developer involvement.
4. **Grows the federation** by explaining and soliciting dojo affiliation, school programs, athlete registration, and officials certification.

## 1.2 Mission

*"Forging warriors through discipline, lineage, and purpose since 1983"* — expressed digitally: austere, credible, fast, editable, and reachable from any device including low-end Android phones on 3G, installable as a PWA, and functional offline for previously visited pages.

## 1.3 Objectives (v1)

| # | Objective | Measure |
|---|---|---|
| O1 | Publish the full institutional site (12 public pages, §3) | All routes live at `www.mmakf.in`, Lighthouse ≥ 90 performance/SEO/a11y/best-practices on the homepage |
| O2 | Capture enrolment leads 24×7 | Lead form → Redis → visible in admin within 5 s of submission |
| O3 | Self-service content operations | Admin can change any of the 16 content keys without code changes; change visible publicly ≤ 5 min (cache TTL) |
| O4 | Federation-level presence | Affiliation page with charter process, officials certification, and branch register live |
| O5 | Zero-cost baseline infrastructure | Runs within Vercel Hobby + Upstash free tiers at expected traffic (≤ 50k req/mo) |

## 1.4 Problems being solved

| Problem | Today (pre-product) | Solved by |
|---|---|---|
| No credible web presence; students discover MMAKF only by word of mouth | Static one-off HTML files, unmaintained | Full SSR site with SEO metadata, sitemap-ready routing |
| Office cannot update announcements/schedules | Requires a developer for any change | `/admin` CMS over 16 content keys |
| Enquiries lost to missed phone calls | Phone-only intake | Persistent lead capture with timestamped queue (max 500, FIFO eviction) |
| Affiliating dojos have no documented pathway | Verbal, inconsistent | Affiliation page: requirements, 4-step charter workflow, officials certification, branch register |
| Equipment sales are ad-hoc | In-person only | Shop catalogue with UPI payment instructions (AS-2) |
| No record of federation structure/syllabus | Paper | Belt-system page: kyu/dan tables, per-grade kata syllabus, grading principles |

## 1.5 Target users & personas

| Persona | Description | Primary goals | Devices |
|---|---|---|---|
| **P1 Prospective student / parent** ("Anita", 38, Ramgarh) | Parent evaluating karate for her 9-year-old | Trust signals, fees, schedule, safety, book a free trial | Android phone, patchy 4G |
| **P2 Current student** ("Rohan", 16, green belt) | Trains 3×/week | Check timetable, next grading kata, events, buy gear | Phone |
| **P3 Federation admin** ("Office", Patratu HQ) | Non-technical operator | Post news/events, edit schedule/fees, read leads, update branches | Shared Windows laptop, Chrome |
| **P4 Affiliating dojo owner** ("Sensei Manoj", II Dan, Bokaro) | Runs an independent club | Understand charter requirements/process, contact federation | Phone + desktop |
| **P5 Competitive athlete/coach** | WKF-track member | Event calendar, registration windows, certification pathways | Phone |
| **P6 Remote/online student** (anywhere) | Trains via Online University | Program details, schedule of live sessions, video grading info | Desktop/tablet |

## 1.6 Expected outcomes

- ≥ 30 qualified leads/month within 3 months of launch.
- 100% of content changes performed by P3 without developer help.
- ≥ 2 affiliation enquiries/quarter attributable to the affiliation page (mailto link with pre-filled subject).
- The site becomes the canonical reference cited on certificates, banners, and school communications.

## 1.7 Success metrics (KPIs)

| KPI | Definition | Target | Source |
|---|---|---|---|
| Lead conversion rate | `enroll` POSTs ÷ unique visitors | ≥ 2% | Vercel Analytics + lead count |
| Lead response latency | Time from lead `ts` to office phone call | < 24 h (manual SLA) | Office process |
| Content freshness | Days since last admin write | ≤ 14 | Redis `mmakf:*` write timestamps (FUT: audit log §12.5) |
| Availability | Uptime of `/` | ≥ 99.5% monthly | Vercel status + external ping |
| Performance | p75 LCP on 4G moto-class device | ≤ 2.5 s | Vercel Speed Insights |
| PWA installs | `appinstalled` events | tracked, no target v1 | Analytics event (§12.2) |

---

# 2. Functional Requirements

Feature inventory. Every feature is specified with purpose, user flow, business logic, I/O, validation, errors, success, edge cases, permissions, dependencies, data flow, UI behavior, API/backend/database operations, notifications, logs, and analytics events. Analytics event names are defined in §12.2; where v1 ships without an analytics emitter for a given event, the event is still named here and marked *(planned)* so instrumentation is a mechanical task.

## 2.0 Feature index

| ID | Feature | Priority |
|---|---|---|
| F1 | Public content rendering engine (SSR + content keys) | [M] |
| F2 | Global navigation, footer, and site shell | [M] |
| F3 | Homepage | [M] |
| F4 | About page (story, dojo kun, lineage, leadership, achievements, testimonials) | [M] |
| F5 | Programs page | [M] |
| F6 | Facilities page | [M] |
| F7 | Schedule page (timetable + etiquette) | [M] |
| F8 | Belt System & Syllabus page | [M] |
| F9 | Events & News page | [M] |
| F10 | Gallery page (filterable) | [M] |
| F11 | Shop page (filterable catalogue, manual UPI ordering) | [M] |
| F12 | FAQ page (accordion) | [M] |
| F13 | Contact page (cards + embedded map) | [M] |
| F14 | Affiliation & Certification page (charter workflow, officials, branch register) | [M] |
| F15 | Enrolment lead capture (free-trial form, reusable CTA) | [M] |
| F16 | Admin authentication (login/logout, signed-cookie session) | [M] |
| F17 | Admin dashboard & content editors (object editor + 13 list editors) | [M] |
| F18 | Admin leads viewer | [M] |
| F19 | Public data API (`GET /api/data`) | [M] |
| F20 | PWA & offline behavior (manifest + service worker) | [M] |
| F21 | Toast notification system (public + admin) | [M] |
| F22 | Scroll-reveal animation system | [S] |
| F23 | SEO & social metadata | [M] |
| F24 | Analytics (Vercel Web Analytics + named event taxonomy) | [S] |

---

## F1 — Public content rendering engine

**Purpose.** Every public page renders from the *live content store*, so the admin's edits govern the site without deploys.

**Business logic.**
- BR-1.1: For any content key `k`, effective content = `Redis GET mmakf:{k}` if non-null, else `SEED[k]`. No partial merging — a stored key fully replaces its seed.
- BR-1.2: All 16 keys: `federation`, `stats`, `leadership`, `programs`, `schedule`, `events`, `news`, `products`, `achievements`, `testimonials`, `beltGrading`, `facilities`, `faqs`, `gallery`, `syllabus`, `branches`. Plus operational key `leads` (never rendered publicly).
- BR-1.3: If Redis is unreachable or misconfigured, pages must still render using seed data (graceful degradation, log a warning). A Redis outage must never 500 a public page.
- BR-1.4: Pages fetch only the keys they need via `get(key)`; the homepage uses `getAll()`.

**Data flow.** Request → Astro SSR (Vercel function) → `storage.get()` → Upstash REST (HTTPS) or in-memory Map (dev) → HTML.

**Edge cases.**
- Stored key with unexpected shape (e.g., admin saved a string where an array is expected): rendering code must tolerate `null`/non-array via defensive defaults (`Array.isArray(x) ? x : []` pattern) — a malformed key degrades that section to its empty state, never crashes the page. *(Implementation note: current templates assume shape; harden during build per this requirement.)*
- Empty array: each section renders its documented empty state (§3.14).

**Logs.** `console.warn` on Redis read/write failure with key name (visible in Vercel function logs). No PII in logs.

**Permissions.** Read: public. Write: admin only (F17).

---

## F2 — Global navigation, footer, site shell (`src/layouts/Base.astro`)

**Purpose.** Consistent chrome, SEO head, PWA registration, toast host, scroll-reveal bootstrap.

**UI behavior.**
- Fixed top nav, height 72 px, background `rgba(6,6,7,.88)` + 24 px backdrop blur, bottom hairline `--border`.
- Brand block: crest (44 px) + "MMAKF" (Oswald 600, tracking .14em) + subtitle "Karate-Do Federation of India" (gold, .52rem, uppercase).
- Links (Oswald, .68rem, uppercase, tracking .16em): About, Programs, Facilities, Schedule, Events, Affiliation, Shop, Contact, then a red **Enroll** button → `/contact#enroll`.
- Active page: gold text + 1 px gold underline; computed by exact match of `Astro.url.pathname` (trailing slash stripped) against the item href; `aria-current="page"` set.
- ≤ 1080 px: links collapse into a full-width drop-down panel under the bar, toggled by a 3-bar hamburger (`aria-label="Toggle navigation"`); bars animate to an X; panel slides via `transform: translateY(-120%) → none` at .3 s; any link click closes it.
- Footer: 4 columns (brand+blurb / **Training**: Programs, Class Schedule, Belt System & Syllabus, Dojo Facilities, FAQ / **Federation**: About & Leadership, Affiliation & Certification, Events & News, Gallery, Shop / **Connect**: `admin@mmakf.in`, `karate.pramod@gmail.com`, `tel:+919939144318`, Visit the dojo → `/contact`, Admin → `/admin`). Collapses 4→2→1 columns at 800/480 px. Decorative `空手道` watermark bottom-right at 1.8% white opacity. Bottom bar: © year (computed) + "Made in Bharat with discipline."
- Props: `title`, `description`, `showNav`, `showFooter` (admin passes `showNav={false} showFooter={false}`).

**Head/SEO (F23 lives here).** UTF-8, viewport, meta description, `theme-color #060606`, manifest link, PNG favicon `/favicon-32.png`, apple-touch-icon 192, OG title/description/type/url, twitter `summary_large_image`, per-page `<title>`.

**Scripts.** (inline, vanilla) hamburger toggle; `window.showNotif(msg)` toast (3.5 s auto-hide); IntersectionObserver (`threshold .08`) adding `.vis` to `.fade` elements; service-worker registration on `load` (silently ignores failure).

**Error conditions.** None user-visible; JS failures leave a functional non-animated site (progressive enhancement — nav links are plain anchors; the hamburger requires JS, which is acceptable because ≤1080 px without JS still shows the brand and users can use footer links; **acceptance:** all pages reachable from footer without JS).

---

## F3 — Homepage (`/`, `src/pages/index.astro`)

**Purpose.** The federation's front door: identity, credibility, conversion.

**Content dependencies.** `getAll()` — federation, stats, leadership, programs, schedule, events, news, products, achievements, testimonials, beltGrading.

**Sections, in order** (full UX detail in §3.3):
1. **Hero** — pill "Established 1983 · Shotokan Karate · Tiger Lee Lineage"; display-1 headline with italic gold emphasis; lead paragraph naming Shihan and HQ; CTAs: `Explore Programs` (red, → `/programs`), `Book a Free Trial` (gold outline, → `#enroll`), `Affiliate a Dojo` (ghost, → `/affiliation`); right rail sticky "Senior Technical Authority" card listing `leadership[0..3]` with 01–04 indices; decorative vertical `空手道` watermark; stats band of 5 items (`stats` key) with hairline separators.
2. **Ticker** — infinite marquee (60 s loop, muted .64rem) of credibility strings; `aria-hidden="true"`; duplicated content for seamless loop.
3. **About teaser** — "The eye of the warrior." two-column prose.
4. **Explore strip** — 6 numbered tiles (About & Lineage, Training Programs, Dojo Facilities, Belt System & Syllabus, Affiliation, Gallery) as 1 px-gapped grid; hover: surface lift + gold arrow slide.
5. **Lineage** — 3 numbered cards (Jr. Tiger Lee → Shihan Pathak → Active Senseis).
6. **Leadership** — grid of all `leadership` entries.
7. **Programs** — all `programs` cards with icon, pills (level, mode), ₹fee/month, Enroll link → `#enroll`.
8. **Training system** — 5 pillar cards (Ki/Ka/Ku/Bu/Re) — static content.
9. **Belt progression** — two tables from `beltGrading` (kyu with fees; dan with notes + WKF pills).
10. **Virtual university** — feature list + mock live-session card; CTAs Join Online / View all programs.
11. **Schedule** — full timetable table from `schedule`; `mode` renders as pill, `online` gets `live` styling.
12. **Women's division** — copy + 4 stat tiles (static).
13. **Achievements** — cards from `achievements` with badge pills.
14. **Events** — rows from `events` (date block day/mo/year, type, title, location with pin icon, fee, Register button → toast BR-9.2).
15. **News** — cards from `news`; empty state: "Announcements will appear here."
16. **Shop teaser** — all `products` in a 4-grid with order-toast buttons (BR-11.3) + UPI note.
17. **Testimonials** — quote cards with initials avatar (first letters of first two name words).
18. **Enroll CTA** — free-trial form (F15) with program `<select>` fed from `programs`.
19. **Contact** — 5 cards: address, federation email, grandmaster email, phone (+hours), UPI.

**Analytics events** *(planned)*: `home_view`, `cta_programs_click`, `cta_trial_click`, `cta_affiliate_click`, `explore_tile_click{tile}`.

---

## F4 — About page (`/about`)

**Purpose.** Institutional depth: history, values, people, recognition, social proof.

**Content dependencies.** `federation`, `leadership`, `achievements`, `testimonials`, `programs` (for CTA select).

**Sections.** PageHero (pills: `Est. 1983`, lineage, affiliation) → Story (two-column, 3 paragraphs referencing founding year from `federation.founded`) → **Dōjō Kun** (5 precepts, static, numbered 01–05, English + romanized Japanese: Seek perfection of character / Be faithful / Endeavour / Respect others / Refrain from violent behaviour) → Lineage (3 cards) → Leadership grid → Achievements grid → Testimonials grid → EnrollCTA (F15).

**Business logic.** BR-4.1: Dojo kun and lineage numbers are hardcoded editorial content (not CMS keys) by design — they are doctrinal, not operational. *(Alternative — making them CMS keys — rejected to keep the admin uncluttered; revisit under FUT if requested.)*

---

## F5 — Programs page (`/programs`)

**Content dependencies.** `federation`, `programs`.

**Sections.** PageHero (pills: `Dojo & Online`, `First class free`) → full programs grid (same card anatomy as homepage; Enroll links target on-page `#enroll` of the EnrollCTA at the bottom) → Training-system pillars → **"Not sure where to start?"** — 6 static guidance cards (children / beginners / women / remote / competitive / black-belt track) → cross-links to `/belt-system` and `/schedule` → EnrollCTA.

**Business logic.** BR-5.1: Fee renders as `₹{Number(fee).toLocaleString()}/month`; a non-numeric fee renders as ₹0 (validation should prevent this — §4.1). BR-5.2: Program `icon` must be a valid Icon name (§7.5); unknown icon renders nothing inside the tile frame (acceptable degradation) — admin guidance lists valid names.

---

## F6 — Facilities page (`/facilities`)

**Purpose.** Answer P1's implicit safety/quality questions; showcase the hombu.

**Content dependencies.** `federation`, `facilities`, `programs`.

**Sections.** PageHero (pills: HQ location, `Open Mon–Sat`) → facilities grid (card: icon tile, name, description, tag pill; seed ships 10 facilities: Main Training Hall / Impact Training Bay / Strength & Conditioning Zone / Online Class Studio / Changing Rooms & Lockers / Drinking Water Station / First-Aid & Recovery Corner / CCTV-Monitored Premises / Dojo Library & Study Corner / Parking & Waiting Lounge; tags from {Training, Digital, Amenity, Safety, Learning}) → **Safety standards** — 4 static cards (Supervised Training, First Response, Age-Matched Batches, Monitored Premises) → **Visit** split: prose + CTAs (`Plan your visit` → `/contact`, `See class timings` → `/schedule`) + HQ card (address + hours from `federation.contact`) → EnrollCTA.

**Business logic.** BR-6.1: `tag` is free text rendered in a neutral pill; no enum enforcement (admin may invent tags). BR-6.2: Facilities are display-ordered by array order; admin "Add" prepends (BR-17.4) — office should re-order via delete/re-add *(v1 limitation; drag-reorder is FUT-7)*.

---

## F7 — Schedule page (`/schedule`)

**Content dependencies.** `federation`, `schedule`, `programs`.

**Sections.** PageHero (pills: `Dojo · Patratu`, `Online · Worldwide`; lead cites `federation.contact.hours`) → timetable table (columns Day/Time/Discipline/Level/Instructor/Mode; min-width 720 px inside `overflow-x:auto` wrapper — **the page body must never scroll horizontally**) → note that timings shift on tournament weekends, linking `/events` → **Reigi / Dojo etiquette** — split layout, 6 numbered rules (static: bow on entry/exit; arrive 10 min early; barefoot, no jewellery; clean gi; address Sensei/Shihan, respond "Oss"; no unsupervised sparring) → 3 planning cards (morning batches / online evenings / Saturday open mat, static) → EnrollCTA.

**Business logic.** BR-7.1: `mode` value `online` renders pill variant `live` (gold); any other value renders neutral pill with its literal text. BR-7.2: Rows render in stored order — the office maintains day-order manually; no automatic sorting (deterministic, avoids misparsing "6:00 AM").

---

## F8 — Belt System & Syllabus page (`/belt-system`)

**Content dependencies.** `federation`, `beltGrading`, `syllabus`, `programs`.

**Sections.** PageHero → dual panel: **Kyu table** (each row: colour swatch + rank + ₹fee; swatch palette fixed 10-entry array white→yellow→orange→green→blue→purple→browns, mapped by index — BR-8.1: if admin adds an 11th kyu row, swatch falls back to `#888`) and **Dan table** (rank, note, WKF pill) → **Kata syllabus table** (columns Grading/Belt/Kihon/Kata/Kumite from `syllabus`; min-width 860 px, own scroll container) → note: gradings quarterly at hombu + video submission online; Dan exams under Shihan authority → **Grading principles** — 3 static cards (Time in grade / Full syllabus / Character counts) → EnrollCTA.

---

## F9 — Events & News page (`/events`)

**Content dependencies.** `federation`, `events`, `news`, `programs`.

**Sections.** PageHero (pills: `Registration by phone`, phone number) → event rows (identical anatomy to homepage §F3.14) → News grid (cards: type pill + date pill, title, body) with empty state → EnrollCTA.

**Business logic.**
- BR-9.1: Events are ordered as stored (admin curates order); no automatic date sorting or past-event hiding in v1 — the office deletes stale events. *(Alternative — auto-hide past events — rejected: `day/mo/year` are display strings, not validated dates; parsing risk. FUT-8 adds ISO dates + auto-archival.)*
- BR-9.2: Register button calls `showNotif('Registration desk opens 30 days before each event. Call +91 99391 44318.')`. No network call.
- BR-9.3: News item `type` defaults to label "News" when empty.

---

## F10 — Gallery page (`/gallery`)

**Content dependencies.** `federation`, `gallery`, `programs`.

**Behavior.** Filter pill row: `All` + distinct `cat` values in first-appearance order (computed server-side via `Set`). Clicking a filter: swaps `.active` (red fill), toggles `.hidden` on non-matching `figure.gitem` via `data-cat` exact match — client-side, no navigation, no URL change *(deep-linkable filters are FUT-9)*. Tiles: 16:10 icon visual with radial gold glow, category, title, caption; hover lift + gold border. Grid 3→2→1 at 900/560 px. Footer note links `/events`.

**Edge cases.** Empty gallery: section renders with only the `All` pill and no tiles *(acceptable; admin seeds 9 items)*. Filter with zero remaining tiles cannot occur (filters derive from data).

---

## F11 — Shop page (`/shop`)

**Content dependencies.** `federation`, `products`.

**Behavior.** Same filter mechanics as F10 over product `cat` (seed: uniform, accessories, equipment, merch). Product card: optional badge (gold, top-right), 1:1 icon thumb, category, name, price `₹p` + struck-through MRP `₹m` when present, **+ Order** button.

**Ordering flow (AS-2).** BR-11.3: + Order → `showNotif("Order {name}: pay via UPI {federation.upi}, then message us with the screenshot.")`. Name is escaped for the inline handler (apostrophes). No cart, no order record. Page footer: UPI id + WhatsApp phone + "Collection at the dojo desk; outstation delivery on request."

**Analytics** *(planned)*: `shop_filter{cat}`, `shop_order_intent{product_id}` — the KPI proxy for shop demand.

---

## F12 — FAQ page (`/faq`)

**Content dependencies.** `federation`, `faqs`, `programs`.

**Behavior.** Native `<details>/<summary>` accordion (max-width 860 px). First item `open` by default. Custom +/× indicator via CSS pseudo-elements rotating on `[open]`. Multiple items may be open simultaneously (native behavior; **no** exclusive-accordion JS). Trailing card: "Still have a question?" with `tel:` and `mailto:` links. Seed ships 10 Q&As. EnrollCTA.

**Accessibility.** `<summary>` is natively keyboard-operable (Enter/Space) and screen-reader friendly; `::-webkit-details-marker` hidden.

---

## F13 — Contact page (`/contact`)

**Content dependencies.** `federation`, `programs`.

**Sections.** PageHero (pills: `Walk-ins welcome`, `First class free`; lead = address + hours) → split layout: left = 5 contact cards (HQ address / phone+WhatsApp with hours / federation email / grandmaster email / UPI); right = **embedded Google Map** `https://www.google.com/maps?q={urlencode(federation.contact.address)}&output=embed`, `loading="lazy"`, `referrerpolicy="no-referrer-when-downgrade"`, sticky at ≥900 px, min-height 420 px (320 mobile), CSS filter `grayscale(1) invert(0.92) contrast(0.9)` to match the dark theme → EnrollCTA (the `#enroll` anchor target of the global nav button).

**Edge cases.** Map iframe blocked/offline: browser shows empty frame within the bordered panel — contact cards carry all information; no functional loss. BR-13.1: map query derives from the *live* `federation.contact.address` so an address change re-points the map automatically.

---

## F14 — Affiliation & Certification page (`/affiliation`)

**Purpose.** The federation-level growth engine (user requirement: "make it full federation level").

**Content dependencies.** `federation`, `branches`.

**Sections.**
1. PageHero — pills: `federation.affiliation`, `Charters granted annually`.
2. **Four ways in** — static cards: Student Membership / Dojo Affiliation / School Programs / Athlete Registration (WKF SportsID + Sportdata).
3. **How a dojo affiliates** — split: prose + **Requirements** list (lead instructor II Dan+ or MMAKF-appointed; safe premises meeting federation facility standards; full adoption of syllabus and code of conduct; annual charter renewal with grading records to hombu) | 4-step numbered workflow: **01 Apply** (email `federation.contact.email` with club profile, credentials, premises) → **02 Technical review** (senior sensei visit or video review; syllabus demonstration; premises inspection) → **03 Provisional charter** (one probationary year under mentor sensei; first joint grading with hombu examiners) → **04 Full affiliation** (register listing; grading + tournament rights).
4. **Officials certification** — 3 static cards: Judge (from 1st Kyu; 1 seminar + 2 supervised tournaments) / Kumite Referee (from I Dan; WKF rules; annual re-certification) / Certified Coach (from II Dan; WKF accreditation pathway).
5. **Branch register** — table from `branches` (Centre/City/District/In-charge/Status); `status === 'Headquarters'` renders `featured` pill, others neutral. Seed: 7 rows (Hombu, Ramgarh, Hazaribagh, Ranchi, Bokaro, Women's Wing partner schools, Online University).
6. **CTA** — `mailto:{email}?subject=Dojo Affiliation Enquiry` (red button) + `tel:` ghost button.

**Business logic.** BR-14.1: Affiliation intake is email/phone (no web form) in v1 — deliberate: charters need attachments and human vetting. *(Alternative — web form with file upload — deferred to FUT-10, depends on FUT-4 storage.)*

---

## F15 — Enrolment lead capture (EnrollCTA component + homepage form)

**Purpose.** The single conversion action of the site.

**User flow.** Any page → "Step onto the mat." section → fill Name, Phone, select Program → **Book Free Trial** → toast confirmation → office calls back.

**Input & validation.**

| Field | Client rule | Server rule (`POST /api/enroll`) |
|---|---|---|
| name | `required` | required non-empty after `String().slice(0,120)` |
| phone | `required` | required non-empty after `String().slice(0,32)` |
| program | `required` (select from live `programs` names, placeholder "Choose a program") | optional; sliced to 120 |

BR-15.1: Phone format is **not** pattern-validated (office serves mixed formats: +91, bare 10-digit, WhatsApp). *(Alternative — regex validation — rejected to avoid false rejections; FUT-11 adds soft normalization.)*

**Backend processing.** Construct lead `{id: Date.now(), name, phone, program, ts: ISO-8601}` → read `leads` list → `unshift` → truncate to **500** → write. BR-15.2: newest-first, capacity 500 with silent tail eviction. BR-15.3: no dedupe — repeat submissions are legitimate (sibling enrolments); office dedupes by phone.

**Success.** HTTP 200 `{ok:true}` → form resets → toast "Oss. Free trial booked. We will call you shortly."

**Errors.**
- Non-JSON body → 400 `{error:'Invalid JSON'}`.
- Missing name/phone → 400 `{error:'Name & phone required'}`.
- Network failure client-side → toast "Could not submit. Please call +91 99391 44318." (form **not** reset — user can retry).
- BR-15.4 (spec correction to implement): client must treat non-2xx as failure (check `res.ok`), not only thrown fetch errors.

**Concurrency edge case.** Two simultaneous submissions race on read-modify-write; a lead may be lost. Accepted at expected volume (< 1 lead/hour). FUT-12: switch `leads` to a Redis list (`LPUSH` + `LTRIM`) for atomicity — documented migration in §5.8.

**Permissions.** Public, unauthenticated. **Rate limiting:** none in v1 at app layer (NFR-SEC-6 recommends Vercel WAF rule: 10 req/min/IP on `/api/enroll`).

**Notifications.** v1: none (AS-7). FUT-5: email to office per lead (§11.2).

**Analytics** *(planned)*: `enroll_submitted{program}`, `enroll_failed{reason}`.

---

## F16 — Admin authentication

**Login flow.** `/admin` unauthenticated → centered card: brand, password field (`autofocus`), Unlock button, "Authorised personnel only. All actions are logged." → `POST /api/auth/login {password}` → on 200 the browser stores the `Set-Cookie` and the page `location.reload()`s into the dashboard; on 401 an inline red "Invalid password" appears and the field re-selects.

**Session mechanics** (`src/lib/auth.ts`).
- Cookie `mmakf_admin` = `base64url(JSON{t: issuedAtMs}) + '.' + base64url(HMAC-SHA256(payload, secret))`.
- Secret = `ADMIN_SESSION_SECRET` else `ADMIN_PASSWORD` else `'dev-secret-change-me'`; **must** be ≥ 8 chars or server throws.
- Attributes: `Path=/; Max-Age=604800; HttpOnly; SameSite=Lax` + `Secure` in production. Expiry: 7 days from issue, enforced server-side by comparing `t`.
- Password check: `crypto.timingSafeEqual` (constant time); default password in dev `mmakf2025`; production **must** set `ADMIN_PASSWORD` (§14.4).
- Failed login: artificial 400 ms delay (cheap brute-force damping) then 401.
- Logout: `POST /api/auth/logout` → cookie cleared (`Max-Age=0`) → reload → login screen.

**Business rules.** BR-16.1: There is no session store — sessions are stateless; rotating `ADMIN_SESSION_SECRET` invalidates all sessions instantly (documented operator recovery for a leaked cookie). BR-16.2: signature verification uses string comparison of HMACs; upgrade to `timingSafeEqual` on both compares during build (NFR-SEC-3).

**Edge cases.** Malformed cookie → treated as unauthenticated. Expired → login screen on next SSR request (in-flight API writes return 401; admin UI surfaces "Save failed" toast — acceptable; FUT-13 adds 401-triggered auto-redirect).

---

## F17 — Admin dashboard & content editors (`/admin` authenticated)

**Layout.** Two-pane: sticky 260 px sidebar (brand; anchor nav: Dashboard, Federation Profile, Leadership, Programs, Schedule, Events, News, Facilities, FAQs, Gallery, Syllabus, Branches, Shop Products, Achievements, Testimonials, Enrolment Leads; Logout; "View Site →" opens `/` in new tab) + scrollable main column (max 1100 px). Single-page; sidebar links are same-page anchors. ≤ 800 px: sidebar stacks above content (non-sticky).

**Dashboard panel.** 4 stat cards (counts of programs/events/news/products) + Quick links (smooth-scroll buttons to News, Events, Schedule, Leads).

**Federation Profile editor** (object mode). Grid form binding: name, shortName, tagline, founded, style, lineage, headquarters, affiliation, upi, contact.email, contact.phone, contact.address, contact.hours (dot-path names write nested fields via `setNested`). Submit → deep-clone current object, apply all form fields, `POST /api/data/federation` → on 200, local model updated + toast "Profile saved"; on failure toast "Save failed". BR-17.1: fields not present in the form (e.g., `contact.emailSecondary`) are preserved by the clone-then-merge strategy.

**List editors** (`ListPanel` × 13). Each renders: "Add new" form (fields per schema below; `textarea` for long text; `type:number` coerced with `Number(v) || 0`) + item list (primary line = first field; meta line = up to 3 further non-empty values truncated to 70 chars, HTML-escaped) + per-item **Delete**.

| Panel | apiKey | Add-form fields (order) |
|---|---|---|
| Leadership | leadership | name, role, rank, note* |
| Programs | programs | icon, name, lvl, mode, fee#, desc* |
| Schedule | schedule | day, t, d, lvl, ins, mode |
| Events | events | day, mo, year, type, fee, t*, loc* |
| News | news | title*, date, type, body*† |
| Facilities | facilities | icon, name, tag, desc*† |
| FAQs | faqs | q*, a*† |
| Gallery | gallery | icon, title, cat, desc* |
| Syllabus | syllabus | grade, belt, kumite, kihon*, kata* |
| Branches | branches | name*, city, district, incharge, status |
| Shop Products | products | e, cat, badge, p#, m#, n* |
| Achievements | achievements | icon, title, badge, body*† |
| Testimonials | testimonials | name, role, txt*† |

`*` full-width · `†` textarea · `#` number

**Mutation semantics.**
- BR-17.2: Add = build item from form → `unshift` onto a copy → `POST /api/data/{key}` with the **entire array** → on 200 update local model, reset form, re-render, toast "Added".
- BR-17.3: Delete = splice copy at index → POST whole array → toast "Deleted". No confirmation dialog in v1 *(spec addition: add `confirm()` guard — §3.11 requires a confirmation for destructive actions; implement `window.confirm('Delete this item?')`)*.
- BR-17.4: New items appear first (both in admin list and on public pages that render array order).
- BR-17.5: Whole-array last-write-wins; concurrent editors can clobber each other (single-admin AS-1 makes this acceptable; FUT-14 adds optimistic versioning via a `rev` field).
- BR-17.6: `news` and `products` additions get `id: Date.now()`.

**Rendering safety.** All admin-rendered user content passes `esc()` (HTML-entity escaping of `& < > "`).

**Known v1 field-name gaps to fix during build** (spec-normative): Programs add-form must use `icon` (not `ico`); Products must use `icon` (not `e`); Achievements must use `icon` (not `ico`) — matching public renderers which read `p.icon`/`a.icon`. The table above already reflects the corrected names.

---

## F18 — Admin leads viewer

Read-only table (When = `new Date(l.ts).toLocaleString('en-IN')`, Name, Phone gold, Program), newest first, first 100 of max 500 rendered. Empty state: "No leads yet." Fetched server-side at page render from key `leads`. No export in v1 *(FUT-15: CSV download endpoint `GET /api/leads.csv`, admin-only)*. No delete in v1 — retention is bounded by the 500 cap; DPDP erasure requests handled via FUT-15 or direct Redis operation (§9.10 runbook).

---

## F19 — Public data API

`GET /api/data` → JSON object of all 16 keys (never `leads`). Headers: `Content-Type: application/json`, `Cache-Control: public, max-age=60, s-maxage=300`. Purpose: external consumers (future mobile app, widgets) and cache-warmed client reads. **Spec-normative check:** `getAll()` iterates only the 16 public `KEYS` — `leads` must never be exposed here (security acceptance test §15.5-T3).

---

## F20 — PWA & offline

- `manifest.webmanifest`: name/short_name MMAKF, `display: standalone`, theme/background `#060606`, icons 192+512.
- Service worker `/sw.js`, cache name **`mmakf-v3`** (bump on any precache change), precache `['/','/manifest.webmanifest','/favicon-32.png']`.
- Fetch strategy: same-origin GETs only; **skip** `/api/*` and `/admin*` entirely; navigations = network-first with cache fallback, final fallback cached `/`; assets = cache-first with background fill.
- `skipWaiting()` + `clients.claim()` for immediate activation; old caches deleted on activate.
- **Offline behavior contract:** previously visited pages render from cache; unvisited routes fall back to the cached homepage; forms fail with the retry toast (F15 error path); admin is network-only by design.

## F21 — Toast system

Single fixed toast (bottom-right, 380 px max) per surface. Public: `#notif` + `window.showNotif(msg)`, 3.5 s. Admin: `#toast` + `toast(msg)`, 1.8 s, replaces pending timer. Toasts are polite status messages — not focus-stealing (`aria-live="polite"` to be added during build; §3.13).

## F22 — Scroll-reveal

`.fade` elements start `opacity:0; translateY(14px)`; IntersectionObserver adds `.vis` at 8% visibility; `prefers-reduced-motion: reduce` disables entirely (CSS override ships in global.css).

## F23 — SEO & social metadata

Per-page unique `<title>` and `description` (already authored, see each page's `<Base>` props). `site` config `https://www.mmakf.in`. `robots.txt` allows all *(verify `/admin` disallow during build: add `Disallow: /admin` and `Disallow: /api/` — spec-normative)*. FUT-16: `sitemap.xml` via `@astrojs/sitemap` (blocked by SSR — emit a static hand-rolled sitemap route listing the 12 public routes).

## F24 — Analytics

Vercel Web Analytics enabled via adapter (`webAnalytics: { enabled: true }`) — pageviews, referrers, device mix, cookieless. Named custom events per §12.2 are *(planned)*: implement with `@vercel/analytics` `track()` behind a tiny `analytics.ts` helper so call sites are one-liners.

---
# 3. Complete User Experience

## 3.1 Design language (binding)

The visual voice is **institutional / governing-body**: near-black surfaces, hairline borders, deep crimson + antique gold accents, disciplined uppercase micro-typography, italic serif emphasis, decorative kanji watermarks at ≤ 3% opacity. Explicitly rejected: bright saturated fills, bouncy motion, emoji, rounded-bubble aesthetics (user feedback: earlier look read "childish").

**Design tokens** (CSS custom properties in `src/styles/global.css` — the single theming surface; changing these re-themes the entire product):

| Token | Value | Use |
|---|---|---|
| `--bg` / `--bg-2` | `#060607` / `#0a0a0b` | page / alternating section |
| `--card` / `--card-2` | `#0e0e10` / `#131315` | surfaces |
| `--border` / `--border-2` | `#1a1a1c` / `#26262a` | hairlines / emphasized hairlines |
| `--red` / `--red-2` / `--red-3` | `#8E1212` / `#B01818` / `#5e0d0d` | primary action / hover / numerals |
| `--red-glow` | `rgba(142,18,18,.25)` | button hover shadow |
| `--gold` / `--gold-2` / `--gold-3` / `--gold-dim` | `#C2A24B` / `#D4B96A` / `#E8D28F` / `rgba(194,162,75,.55)` | accents, icons, active states |
| `--white` / `--off-white` / `--muted` / `--muted-2` | `#EDEAE3` / `#B9B3A8` / `#79746B` / `#45423C` | text hierarchy |
| `--font-display` | Oswald | headings, labels, buttons |
| `--font-accent` | Cormorant Garamond italic | emphasis words inside display headings |
| `--font-body` | Inter | body copy |
| `--font-kanji` | Yu Mincho → Hiragino Mincho ProN → Noto Serif JP → MS PMincho → serif | watermarks only |
| `--radius` | `2px` | sharp geometry everywhere |
| `--max-w` | `1180px` | container |

Typography scale: `.display-1` clamp(2.6rem→4.6rem, w500), `.display-2` clamp(1.9rem→2.9rem), `.lead` 1.05rem/300, `.body-txt` .93rem/300, `.eyebrow` .66rem uppercase tracking .38em gold with 32 px leading rule. `::selection` gold-on-black. Body 15.5 px, line-height 1.65.

Component vocabulary (reused everywhere): `.card` (gradient surface `#0e0e10→#0a0a0b`, hairline, 30 px padding; `.hoverable` gains gold hairline on hover), `.card-icon` (50 px hairline tile, 26 px gold stroke icon), `.pill` (hairline capsule .58rem uppercase; variants `live`/`featured` gold), `.btn` (14×30 px, .72rem uppercase tracking .22em; `-primary` red, `-gold` gold outline, `-ghost` neutral outline, `-link` bare), `.input` (2% white fill, hairline, gold focus ring-less border), `.rule` (48×1 px crimson divider), `.grid-2/3/4` (collapse 4/3→2 at 900 px, →1 at 600 px).

## 3.2 Global chrome

Documented at F2. Additional interaction detail:
- **Skip/no-JS:** every page's primary content is server-rendered; no client data fetching on public pages.
- **Scroll behavior:** `scroll-behavior: smooth` for same-page anchors (`#enroll`).
- **Scrollbar:** 5 px, thumb `--border-2`, gold-dim on hover (WebKit).

## 3.3 Homepage — section-by-section states

| Section | Loading | Empty | Error |
|---|---|---|---|
| All sections | none (SSR — content arrives with HTML) | per-section below | Redis failure → seed content (BR-1.3); page never blanks |
| Hero stats | — | `stats: []` → band renders zero cells (border frame only) | — |
| News | — | muted line "Announcements will appear here." spanning grid | — |
| Events / Programs / Leadership / Shop / Testimonials / Achievements | — | section renders headline with empty grid (v1); admin keeps ≥ 1 item as editorial rule | — |

Hero right-rail card is `position: sticky; top: 96px` at > 900 px; below, it stacks under CTAs. Stats band: 5 columns → 2 at ≤ 700 px (last cell spans full row).

## 3.4 Sub-page template (PageHero)

Every non-home public page opens with `PageHero`: optional pill row → eyebrow → `display-1` H1 (HTML emphasis allowed via `set:html`) → crimson rule → lead. Background: crimson/gold radial washes + vertical-writing kanji watermark (`空手道` default, `kanji` prop overridable), clamp(6rem→10rem), 2.5% white. Padding 96/72 px (→ 64/48 px ≤ 640 px), bottom hairline.

## 3.5 Tables (schedule, syllabus, branches, kyu/dan, leads)

Shared anatomy: `--card` surface, hairline outer border, header row `--bg-2` with gold .66rem uppercase tracking .2em labels, 14×18 px cells, .88rem, row hairlines, last row borderless. Every wide table sits in its own `overflow-x: auto` wrapper with a min-width (schedule 720, syllabus 860, branches 760) — **page-level horizontal scroll is a defect**.

## 3.6 Forms

- Enroll (CTA): 4-control grid `1fr 1fr 1.2fr auto` collapsing to single column ≤ 700 px. Placeholder-labeled (compact marketing form) — `aria-label`s to be added matching placeholders (§3.13).
- Admin: label-above (`.input-label`), 2-col grids collapsing at 800/500 px; textareas 3 rows.
- Focus: `.input:focus` gold border; buttons/links rely on browser default focus ring — **do not remove outlines**.
- Validation UX: HTML5 `required` blocks submit with native tooltips; server errors surface as toasts (public) or inline red text (admin login).

## 3.7 Buttons & links inventory

| Context | Control | Action |
|---|---|---|
| Nav | Enroll (red) | `/contact#enroll` |
| Hero | Explore Programs / Book a Free Trial / Affiliate a Dojo | `/programs` / `#enroll` / `/affiliation` |
| Program card | Enroll → | on-page `#enroll` |
| Event row | Register (ghost) | toast BR-9.2 |
| Product card | + Order | toast BR-11.3 |
| Facilities | Plan your visit / See class timings | `/contact` / `/schedule` |
| Affiliation CTA | Email the federation (red) | `mailto:` with subject `Dojo Affiliation Enquiry` |
| Footer | Admin → | `/admin` |
| Admin sidebar | Logout / View Site → | POST logout + reload / `/` new tab |

## 3.8 Modals, dialogs, drawers

v1 deliberately has **no modal dialogs** on the public site (calm, page-based UX). The mobile nav panel is the only drawer. Admin uses `window.confirm` for deletes (BR-17.3 addition). Confirmation semantics: destructive = browser confirm; success = toast; failure = toast "Save failed"/"Add failed".

## 3.9 Empty / loading / skeleton states

SSR means no client loading spinners on public pages; perceived loading is bounded by NFR-PERF targets. Skeletons are unnecessary and intentionally absent. The only async client actions are form POSTs and admin mutations — both give immediate toast feedback; buttons are not disabled during flight in v1 *(spec addition: disable submit button + text "…" while awaiting fetch to prevent double-submit; applies to enroll + admin forms)*.

## 3.10 Error states

| Failure | User experience |
|---|---|
| Redis down | Site renders seed content; admin saves fail with toast; leads POST returns 200 but write is lost only if both Redis and memory fail (impossible — memory always works; in prod without Redis, writes go to per-instance memory and may not persist — deploy checklist §14.6 requires Redis in prod) |
| 404 route | Astro default 404 (FUT-17: branded 404 page with nav back home — implement during build: `src/pages/404.astro`, dark theme, "Lost on the mat?" + links) |
| 500 render error | Astro/Vercel error page; Vercel alerting (§14.7) |
| JS disabled | Full content readable; filters/accordions degrade (accordion stays native-functional; filters show all items; forms still submit — enroll uses fetch, so provide `<noscript>` line near forms: "JavaScript required to submit online — call +91 99391 44318."; spec-normative) |
| Offline | F20 contract |

## 3.11 Confirmation & messaging catalogue (exact strings)

| Event | Surface | Text |
|---|---|---|
| Lead success | toast | `Oss. Free trial booked. We will call you shortly.` |
| Lead failure | toast | `Could not submit. Please call +91 99391 44318.` |
| Event register | toast | `Registration desk opens 30 days before each event. Call +91 99391 44318.` |
| Shop order | toast | `Order {name}: pay via UPI {upi}, then message us with the screenshot.` |
| Admin login fail | inline | `Invalid password` |
| Admin saves | toast | `Profile saved` / `Added` / `Deleted` / `Save failed` / `Add failed` |
| Admin delete guard | confirm | `Delete this item?` |

## 3.12 Responsive matrix

| Breakpoint | Behavior |
|---|---|
| ≥ 1080 | Full nav row |
| ≤ 1080 | Hamburger + slide-down panel |
| ≤ 900 | 4/3-grids → 2; hero → single column; gallery 2-col; contact map unsticks; admin remains 2-pane until 800 |
| ≤ 800 | Footer 2-col; belts/etiquette/affiliation splits stack; admin sidebar stacks |
| ≤ 700 | Enroll form single column; hero stats 2-col |
| ≤ 640 | Section padding 72→64; container padding 20 px; event rows re-flow (date+body, actions drop to full-width bottom row) |
| ≤ 600 | All grids single column |
| ≤ 560/500/480 | gallery 1-col / pillars & contact 1-col / footer 1-col |

Touch targets ≥ 40 px effective (nav links 8×11 padding + 72 px bar; mobile nav items 14 px padding with hairline separators).

## 3.13 Accessibility (WCAG 2.1 AA intent)

- Semantic landmarks: `nav`, `main`, `footer`, `section`, real `table`/`thead`/`th`, `figure/figcaption`, `details/summary`, `form/label` (admin) — already structural; keep.
- Decorative elements `aria-hidden`: kanji watermarks, ticker, hero bg, pin SVGs (`aria-hidden="true"` on inline icons; Icon component sets it).
- Color contrast: `--white` on `--bg` ≈ 14:1; `--off-white` ≈ 8:1; `--gold-2` on card ≈ 6.5:1; muted `.6rem` labels are non-essential duplicated info. Red buttons `#8E1212` with `#f5f0ea` text ≈ 7:1. Verify all pairs ≥ 4.5:1 during build (§15.6).
- Keyboard: everything reachable by Tab in DOM order; accordion native; filters are real `<button>`s; mobile hamburger is a `<button>`; smooth-scroll anchors keep focus behavior default.
- To add during build (spec-normative): `aria-live="polite"` on both toasts; `aria-label` on enroll inputs; `aria-expanded` on hamburger; visible custom `:focus-visible` style (2 px gold outline) replacing any suppressed default; `prefers-reduced-motion` also pauses the ticker animation.
- Screen readers: page `<h1>` exactly once per page (PageHero / hero headline).

## 3.14 Admin UX specifics

Login screen is minimal-chrome (`showNav=false/showFooter=false`). Dashboard type scale: `.admin-h` 1.5rem, `.admin-sub` muted; stat numerals 2.4rem gold. List items: name line + 70-char meta line; Delete is a quiet outline button turning crimson on hover. Panels separated by hairlines with `scroll-margin-top: 20px` for anchor jumps. The sidebar "active" state is static on Dashboard in v1 (anchor-scroll spy is FUT-18).

## 3.15 Content authoring guidance (shipped in admin help text / docs)

Icon names valid for `icon` fields: `karate-gi, kata, kumite, shield, women, star, medal, globe, black-belt, book, school, users, pin, monitor, mat, target, dumbbell, water, first-aid, locker, cctv, parking, clock`. Dates in events are display strings (`day` "15", `mo` "JUN", `year` "2026"). Fees are integers in ₹.

---

# 4. Business Logic (consolidated rulebook)

## 4.1 Validation rules

| Rule | Where enforced |
|---|---|
| V-1 Lead name/phone required; name ≤ 120, phone ≤ 32, program ≤ 120 chars (post-truncation emptiness = reject) | server `/api/enroll` + client `required` |
| V-2 Admin write key ∈ KEYS (16) else 400 `Invalid key` | server `/api/data/[key]` |
| V-3 Admin write body must parse as JSON else 400 | server |
| V-4 Login body JSON with `password` string; constant-time compare | server |
| V-5 Session secret ≥ 8 chars (boot-time throw) | server |
| V-6 Numeric admin fields coerce `Number(v) || 0` | admin client |
| V-7 Content shape is **not** schema-validated server-side in v1 (admin is trusted); defensive rendering per F1 covers malformed shapes. FUT-19: zod schemas per key at the API boundary | — |

## 4.2 Permissions model

| Actor | Can |
|---|---|
| Anonymous visitor | Read all public pages; `GET /api/data`; `POST /api/enroll` |
| Admin (valid cookie) | Everything anonymous can + read `/admin` dashboard (incl. leads) + `POST /api/data/{key}` + logout |
| Nobody | Read `leads` via any public endpoint; write content without cookie (401) |

## 4.3 State machines

**Lead lifecycle** (v1 states are operational, tracked outside the system after capture):
```
[Submitted] --office calls--> [Contacted] --walk-in--> [Trial attended] --> [Enrolled | Declined]
     |                                                        
     +--(500-cap eviction)--> [Evicted]
```
System-tracked state: existence in `leads` only. FUT-20 adds a `status` field + admin dropdown.

**Admin session:** `Anonymous → (valid password) Authenticated → (7 d elapse | logout | secret rotation) Anonymous`.

**Content key:** `Seed-backed → (first admin save) Store-backed → (subsequent saves) Store-backed (replaced)`. There is no revert-to-seed in the UI; operator runbook: `DEL mmakf:{key}` in Upstash console restores seed (§16.3).

## 4.4 Calculations

- Product/pricing: display-only; savings not computed (MRP struck through visually).
- Initials avatar: first character of first two whitespace-separated name tokens, uppercased.
- Footer year: `new Date().getFullYear()` server-side.
- Lead cap: `list.slice(0, 500)` post-unshift.
- Dashboard stats: array lengths at render time.

## 4.5 Automation & scheduling

None in v1 (no cron). Edge cache expiry (60 s/300 s) is the only time-based behavior. FUT-8 (event auto-archival) and FUT-5 (lead email) introduce the first background behaviors; both are specified to run inside request handlers or Vercel Cron, not a queue.

## 4.6 Exception handling & retries

- All storage reads wrap Redis errors → seed fallback + `console.warn`.
- All storage writes wrap Redis errors → fall through to in-memory write (dev semantics) + warn; **in production this masks persistence loss** — NFR-REL-2: production deploy MUST configure Redis; health check §14.7 verifies a canary write at deploy time (implement `GET /api/health` returning `{redis: true|false}`; admin-only detail level).
- Client fetch failures: enroll form retains input for retry; admin toasts failure and leaves local model unchanged (no optimistic mutation — model updates only after 200).
- No automatic retries anywhere in v1 (idempotency of whole-array writes makes manual retry safe; enroll retry may duplicate a lead — acceptable, BR-15.3).

## 4.7 Conflict resolution

Last-write-wins on whole keys (BR-17.5). The admin UI holds a page-load snapshot in `data`; a second tab's edits are invisible to the first until reload. Single-admin assumption AS-1 governs; FUT-14 for versioning.

## 4.8 Caching rules

| Layer | Policy |
|---|---|
| `GET /api/data` | `public, max-age=60, s-maxage=300` (browser 1 min, Vercel edge 5 min) |
| Public HTML | No explicit cache header in v1 → Vercel default (no store for SSR). Admin edits therefore appear on next request for HTML, ≤ 5 min for API consumers. *(Alternative — `s-maxage=60` on HTML for cost — acceptable optimization, keep TTL ≤ 60 s if applied.)* |
| Static assets (`/public`) | Vercel immutable CDN defaults |
| Fonts | Google Fonts CSS with `display=swap` |
| SW runtime cache | F20 strategy, cache `mmakf-v3` |

Invalidation: content changes require no purge (TTL-bounded). Deploys purge edge automatically. SW cache purges via cache-name bump.

---
# 5. Database Design

## 5.1 Store topology

Primary store: **Upstash Redis** (serverless, REST API over HTTPS, region nearest Vercel deployment — recommend `aws-ap-south-1` Mumbai). Access exclusively through `src/lib/storage.ts` (`get`, `set`, `getAll`) — **no other module may talk to Redis directly** (architectural invariant).

Key namespace: `mmakf:{key}`. Every value is a JSON document (Upstash SDK serializes/deserializes automatically).

```
mmakf:federation      object
mmakf:stats           array<Stat>
mmakf:leadership      array<Leader>
mmakf:programs        array<Program>
mmakf:schedule        array<ClassSlot>
mmakf:events          array<Event>
mmakf:news            array<NewsItem>
mmakf:products        array<Product>
mmakf:achievements    array<Achievement>
mmakf:testimonials    array<Testimonial>
mmakf:beltGrading     object{kyu:array<KyuRank>, dan:array<DanRank>}
mmakf:facilities      array<Facility>
mmakf:faqs            array<Faq>
mmakf:gallery         array<GalleryItem>
mmakf:syllabus        array<SyllabusRow>
mmakf:branches        array<Branch>
mmakf:leads           array<Lead>            # operational, admin-only
```

## 5.2 Entity schemas

Types are TypeScript-notation; "req" = required for correct rendering (enforced editorially + defensive rendering per F1; server schema validation is FUT-19).

**Federation** (singleton object)

| Field | Type | Req | Notes |
|---|---|---|---|
| name | string | ✓ | full legal name |
| shortName | string | ✓ | "MMAKF" |
| tagline | string | ✓ | used in `<title>` of `/` |
| founded | string | ✓ | "1983" (display string) |
| style | string | ✓ | "Shotokan Karate" |
| lineage | string | ✓ | "Tiger Lee Lineage" |
| headquarters | string | ✓ | city/district/state |
| affiliation | string | ✓ | "WKF International Pathway" |
| upi | string | ✓ | UPI VPA; rendered in shop/contact toasts |
| contact.email | string | ✓ | primary office email |
| contact.emailSecondary | string |  | grandmaster email; not in admin form (BR-17.1 preserves) |
| contact.phone | string | ✓ | display format "+91 99391 44318"; `tel:` links strip spaces |
| contact.address | string | ✓ | drives contact map query (BR-13.1) |
| contact.hours | string | ✓ | office hours string |

**Stat** `{value: string, label: string}` — hero band, exactly 5 recommended.

**Leader** `{name✓, role✓, rank✓, note}` — order = display order; first 4 appear in hero rail.

**Program** `{icon✓(IconName), name✓(unique-by-convention; used as lead `program` value), desc✓, lvl✓, fee✓(int ₹/month), mode✓("Dojo"|"Online"|"Dojo / Online"|free text)}`

**ClassSlot** `{day✓("Mon".."Sun" display), t✓("6:00 AM"), d✓(discipline), lvl✓, ins✓(instructor), mode✓("dojo"|"online" — lowercase; drives pill variant BR-7.1)}`

**Event** `{day✓("15"), mo✓("JUN"), year("2026"), type✓("Grading"|"Tournament"|"Seminar"|"Workshop"|"Exhibition"|free), t✓(title), loc✓, fee✓("₹500"|"Free"), status("upcoming")}` — `status` currently informational.

**NewsItem** `{id✓(epoch-ms int), title✓, date✓(display "12 May 2026"), type("Announcement"|"Promotion"|"Community"|free), body✓}`

**Product** `{id✓(epoch-ms), n✓(name), cat✓(filter facet), icon(IconName), p✓(int price ₹), m(int MRP ₹, optional strike-through), badge(string|null)}`

**Achievement** `{icon(IconName), title✓, body✓, badge✓}`

**Testimonial** `{txt✓, name✓, role✓}`

**KyuRank** `{rank✓("10th Kyu — White"), fee✓(int)}` · **DanRank** `{rank✓, note✓, wkf✓}`

**Facility** `{icon✓(IconName), name✓, tag✓, desc✓}`

**Faq** `{q✓, a✓}`

**GalleryItem** `{icon✓(IconName), title✓, cat✓(filter facet), desc✓}`

**SyllabusRow** `{grade✓, belt✓, kihon✓, kata✓, kumite✓}`

**Branch** `{name✓, city✓, district✓, incharge✓, status✓("Headquarters"|"Affiliated"|"Community"|"Digital"|free — "Headquarters" triggers featured pill)}`

**Lead** `{id✓(epoch-ms), name✓(≤120), phone✓(≤32), program(≤120), ts✓(ISO-8601 UTC)}` — PII; see §9.10.

## 5.3 Keys, constraints, indexes

Redis KV has no secondary indexes; all reads are whole-document by key — appropriate because every dataset is small (≤ 500 rows) and always consumed whole. "Primary key" per row = `id` where present (news, products, leads) else array position. Uniqueness is conventional, not enforced. Referential links (program name ← lead.program; icon names ← Icon component) are **soft references**: dangling values degrade gracefully (lead keeps the historical program string even if the program is renamed — desirable audit property).

## 5.4 Cascading, soft delete, versioning, audit

- Delete = row removed from array = hard delete. No cascades exist (no cross-key references to maintain).
- Soft delete: not implemented; not required at v1 volumes. FUT-20 lead statuses supersede deletion for leads.
- Versioning/audit history: none in v1. FUT-21 (designed, deferred): on every `set`, also `LPUSH mmakf:audit:{key}` a record `{ts, bytes, actor:'admin'}` trimmed to 50 — enables §12.5 audit trail and content freshness KPI, ~zero cost.
- Backups: §14.8 (Upstash daily backup + weekly JSON export via `GET /api/data` snapshot into repo/artifact).

## 5.5 Migration & seed strategy

- Seed lives in code (`src/data/seed.ts`) and is the migration baseline: **new keys are added to SEED + KEYS in one commit**; deployed code immediately serves seed content for the new key; admin gains its panel in the same release.
- Renaming a field = code reads new field; stored documents still carry old field → write a one-off migration note in the PR and have the admin re-save the affected panel (clone-merge writes the full current shape), or run a console script. Document every such change in `docs/CHANGELOG.md` (§16).
- **Removing** a key: delete from KEYS (API rejects writes), leave stored data orphaned (harmless), optionally `DEL`.

## 5.6 Relational migration mapping (FUT — for a future Postgres move)

Each array key becomes a table with `id serial PK`, `position int` (display order), audit columns (`created_at`, `updated_at`); `federation` becomes a single-row `settings` table or stays JSONB; `leads` gains `status` enum + index on `(created_at desc)`, `(phone)`. This mapping is documentation-only in v1.

## 5.7 Capacity planning

Total content payload ≈ 40–80 KB JSON; leads ≤ 500 × ~200 B ≈ 100 KB. Upstash free tier (256 MB, 500K commands/mo) exceeds requirements by orders of magnitude; `getAll()` = 16 GET commands per homepage render → with edge caching of HTML off, ~16 commands/view → budget 30k views/mo ≈ 480k commands: **implement NFR-PERF-4 (below) to cut this 16× via MGET.**

## 5.8 Normative storage optimizations (implement during build)

- NFR-PERF-4: `getAll()` must use a single `MGET mmakf:federation … mmakf:branches` (Upstash `redis.mget`) instead of 16 sequential GETs; fallback per-key on error.
- FUT-12 (when volume warrants): `leads` → Redis list ops (`LPUSH`, `LTRIM 0 499`, `LRANGE 0 99`) for atomic appends.

---

# 6. Backend Architecture

## 6.1 Topology

```
Browser ──HTTPS──> Vercel Edge (CDN, TLS, edge cache)
                      │
                      ├── static assets  (/public/*, hashed /_astro/*)
                      └── Vercel Serverless Function (Node 18+, single Astro SSR handler)
                             ├── Astro router → page components (SSR HTML)
                             ├── /api/* endpoints (Astro APIRoute)
                             ├── src/lib/storage.ts ──HTTPS REST──> Upstash Redis
                             └── src/lib/auth.ts (HMAC session, no external calls)
```

One deployable unit (the Astro app). No microservices, no queues, no background workers in v1 — deliberately (§17 documents the seams for later extraction).

## 6.2 Module inventory

| Module | Responsibility | May import |
|---|---|---|
| `src/data/seed.ts` | Canonical content shapes + defaults + `KEYS` allow-list | nothing |
| `src/lib/storage.ts` | Store abstraction: Redis ↔ memory fallback; `get/set/getAll` | seed |
| `src/lib/auth.ts` | Password check, cookie mint/verify/clear | node:crypto |
| `src/pages/api/*` | HTTP endpoints (thin controllers: parse → validate → storage/auth → respond) | storage, auth, seed |
| `src/pages/*.astro` | SSR views (read-only storage access) | storage, components, layout |
| `src/pages/admin/index.astro` | CMS view + inline client controller | storage, auth, ListPanel |
| `src/layouts/Base.astro`, `src/components/*` | Presentation | — |

Dependency rule: pages/components never import Redis SDK or crypto directly.

## 6.3 Request lifecycles

**Public page:** GET `/programs` → Vercel fn → Astro renders `programs.astro` → `get('federation')`, `get('programs')` → HTML (compressed, `compressHTML: true`) → browser paints; no client data fetch.

**Admin save:** submit → fetch POST `/api/data/programs` (cookie auto-attached, SameSite=Lax same-origin) → `isAuthenticated` → key allow-list → JSON parse → `set()` → `{ok:true}` → client updates snapshot + toast.

**Lead:** POST `/api/enroll` → validate → read-modify-write `leads` → `{ok:true}`.

## 6.4 Authentication & authorization

Fully specified at F16/§4.2/§9. Middleware: none — each protected surface calls `isAuthenticated(request.headers.get('cookie'))` explicitly (2 call sites: admin page, data write endpoint). Keep it explicit; do not introduce global middleware for two routes.

## 6.5 Background jobs, queues, events

None in v1. FUT hooks: Vercel Cron for event archival (FUT-8) and weekly backup export (§14.8); provider webhooks under `/api/hooks/*` namespace reserved.

## 6.6 Caching

§4.8 is normative. Server-side in-process caching is prohibited (serverless instances are ephemeral; the in-memory Map is a **dev fallback**, not a cache — never rely on it in prod paths).

## 6.7 Rate limiting

v1: 400 ms failed-login delay only. NFR-SEC-6 (should): Vercel WAF rules — `/api/auth/login` 5 req/min/IP; `/api/enroll` 10 req/min/IP; `/api/data/*` POST 60 req/min/IP. App-layer limiter (Upstash Ratelimit SDK) is the FUT path if WAF unavailable on plan.

## 6.8 File storage

None in v1 (AS-6). All media = inline SVG + two PNG icons + logo.png in `/public`. FUT-4: Vercel Blob for gallery photos (`GalleryItem.img?: string` URL field; admin upload endpoint with type/size validation per §9.8).

## 6.9 Search

No server search in v1 (12 pages, small catalogues; browser find suffices). Client-side filters (gallery/shop) are the discovery UX. FUT-22: static JSON search index + client fuzzy search if content volume grows.

## 6.10 Logging & monitoring

- Function logs: `console.warn/error` only for actionable conditions (Redis failures with key names; login endpoint does **not** log passwords or attempts' contents). Vercel retains logs per plan; no PII beyond what's operationally necessary (lead contents are never logged).
- Monitoring: Vercel deployment checks + Speed Insights + Web Analytics. External uptime ping (UptimeRobot free, 5 min interval on `/` and `/api/data`) — §14.7.
- `GET /api/health` (implement): `{ok:true, redis:boolean, version:string(commit sha env)}`, no auth, no cache; used by uptime monitor and deploy verification.

## 6.11 Backup & recovery

§14.8. RPO: 24 h (daily backup) for content; leads accepted at same RPO (office processes leads daily by SLA). RTO: < 1 h — restore = re-import JSON via console script or re-save panels from backup file.

---
# 7. Frontend Architecture

## 7.1 Stack decision

Astro components + design-token CSS + small inline vanilla scripts. **No React/Vue/Svelte, no Tailwind, no client router, no client state library.** Rationale: content site with two forms; every KB matters on target devices; the admin's interactivity is modest. This is a binding constraint — do not introduce a framework for v1 features.

## 7.2 Folder structure (authoritative)

```
mmakf-astro/
├── astro.config.mjs        # output:'server', vercel adapter (+webAnalytics), site URL, compressHTML, prefetch(viewport)
├── postcss.config.cjs      # empty plugins — MUST exist (stops upward config search; see ops note §14.10)
├── package.json            # deps: astro ^4.16, @astrojs/vercel ^7.8, @upstash/redis ^1.34
├── tsconfig.json           # strict Astro defaults + "@/*" → "src/*"
├── public/                 # favicon-32.png, logo.png, icons/{192,512}.png, manifest.webmanifest, robots.txt, sw.js
├── docs/                   # MASTER-SPEC.md (this file), CHANGELOG.md
└── src/
    ├── data/seed.ts
    ├── lib/{storage.ts, auth.ts}
    ├── styles/global.css
    ├── layouts/Base.astro
    ├── components/{Crest, Icon, PageHero, EnrollCTA, ListPanel}.astro
    └── pages/
        ├── index.astro … affiliation.astro   (12 public pages)
        ├── 404.astro                          (FUT-17 → implement)
        ├── admin/index.astro
        └── api/{data.ts, enroll.ts, data/[key].ts, auth/{login,logout}.ts, health.ts(new)}
```

## 7.3 Component hierarchy

```
Base (head, nav, footer, toast, observers, SW)
├── PageHero (eyebrow/title/lead/pills/kanji)     [all sub-pages]
├── EnrollCTA (form → /api/enroll)                 [about, programs, facilities, schedule,
│                                                   belt-system, events, gallery, faq, contact]
├── Icon (23-name inline SVG set, stroke 1.4, currentColor default)
├── Crest (brand mark, size prop)
└── ListPanel (admin generic list editor: schema via data-fields JSON)
```

Contract notes: `PageHero.title` is injected with `set:html` — **only literal strings from page code may be passed; never store-derived content** (XSS boundary, §9.6). `EnrollCTA` binds all `form[data-enroll-form]` instances idempotently.

## 7.4 State management

- Public: zero client state beyond DOM classes (filters toggle `.hidden`; nav toggles `.open`).
- Admin: one page-scoped snapshot object `data` (injected via `define:vars`), mutated only after successful POSTs; re-render is per-panel innerHTML rebuild. No reactivity library — keep this pattern.

## 7.5 Design system & reuse

§3.1 tokens + component classes are the design system; new UI must be composed from them. Icon set: 23 names (§3.15); adding an icon = new conditional block in `Icon.astro`, stroke-based, viewBox 32, stroke-width 1.4, `aria-hidden`.

## 7.6 Performance practices in the client

- `prefetch: { prefetchAll: true, defaultStrategy: 'viewport' }` — internal links prefetch when visible; keep.
- Inline scripts are tiny (< 2 KB each); no bundler-split needed.
- Fonts: single Google Fonts request, `display=swap`; system-font kanji stack avoids a JP webfont download entirely.
- Images: none raster besides logo/icons; keep SVG-first policy (AS-6).
- Error boundaries: not applicable (no client framework); inline scripts wrap risky ops in try/catch where failure is expected (SW registration, fetch).

## 7.7 Routing

File-based; all public routes prerender=false (SSR). Trailing-slash: Astro default ('ignore') — nav active-match strips trailing slash (F2). Anchors used: `#enroll` (contact + per-page CTAs), admin panel ids.

---

# 8. API Specification

Base URL: site origin. All bodies JSON; all responses `Content-Type: application/json` (except SSR pages). No API versioning in v1 — breaking changes require a `/api/v2/*` namespace (versioning strategy: additive-only on v1 endpoints; new shapes → new paths). Errors follow `{error: string}` envelope.

### 8.1 `GET /api/data`
Public content bundle. Auth: none. Cache: `public, max-age=60, s-maxage=300`.
**200** → `{federation:{…}, stats:[…], …, branches:[…]}` (16 keys, never `leads`).
Errors: none expected (storage falls back to seed); 500 only on code defect.

### 8.2 `POST /api/enroll`
Create lead. Auth: none. Rate limit: WAF 10/min/IP (NFR-SEC-6).
Request: `{"name":"Anita Sharma","phone":"+91 98xxxxxx01","program":"Kids Program"}`
**200** `{"ok":true}` · **400** `{"error":"Invalid JSON"}` | `{"error":"Name & phone required"}`
Server behavior: truncate fields (120/32/120), stamp `id`+`ts`, unshift into `leads`, cap 500.

### 8.3 `POST /api/auth/login`
Mint admin session. Request: `{"password":"…"}`.
**200** `{"ok":true}` + `Set-Cookie: mmakf_admin=<payload>.<sig>; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax[; Secure]`
**400** invalid body · **401** `{"error":"Invalid password"}` after 400 ms delay. Rate limit: WAF 5/min/IP.

### 8.4 `POST /api/auth/logout`
Clears cookie. Auth: none required (idempotent). **200** `{"ok":true}` + expiring Set-Cookie.

### 8.5 `POST /api/data/{key}`
Replace one content key. Auth: **admin cookie required**.
Path param: `key` ∈ the 16 KEYS. Request body: the complete new value (object for `federation`/`beltGrading`, array otherwise).
**200** `{"ok":true,"key":"programs"}` · **401** `{"error":"Unauthorized"}` · **400** `{"error":"Invalid key"}` | `{"error":"Invalid JSON"}`
Example:
```
POST /api/data/faqs
Cookie: mmakf_admin=…
[{"q":"New question?","a":"Answer."}, …existing…]
→ 200 {"ok":true,"key":"faqs"}
```

### 8.6 `GET /api/health` *(implement)*
`{"ok":true,"redis":true,"version":"<VERCEL_GIT_COMMIT_SHA|dev>"}`; no cache; no auth; `redis:false` must still return 200 (monitor alerts on payload, not status).

---

# 9. Security

## 9.1 Threat model summary

Assets: admin capability (deface site), lead PII, availability. Adversaries: drive-by scanners, password guessing, content-injection via admin fields, cache abuse. No payment data, no user accounts, no file uploads (v1) — the classic highest-risk surfaces are absent by design.

## 9.2 Authentication & session (normative)

As F16. Additional requirements: NFR-SEC-1 production MUST set strong `ADMIN_PASSWORD` (≥ 12 chars) and independent random `ADMIN_SESSION_SECRET` (32 B base64; `openssl rand -base64 32`); NFR-SEC-2 the dev defaults (`mmakf2025`, `dev-secret-change-me`) MUST NOT function in production — implement boot guard: if `import.meta.env.PROD` and either env missing → login endpoint returns 500 with logged error; NFR-SEC-3 HMAC comparison via `crypto.timingSafeEqual`.

## 9.3 Authorization / RBAC

Single role (AS-1): `admin` = holder of valid cookie. Enforcement points: `/admin` SSR gate; `POST /api/data/[key]`. FUT-1 RBAC seam: replace boolean `isAuthenticated` with `getSession(): {role} | null` and switch call sites — no other architecture change needed.

## 9.4 CSRF

State-changing admin endpoint is protected by: cookie `SameSite=Lax` (blocks cross-site POST carrying the cookie) + JSON `Content-Type` (cross-origin form posts can't set it without CORS preflight; no CORS headers are emitted → preflight fails). Residual risk accepted for v1; FUT: double-submit token. `POST /api/enroll` is intentionally CSRF-irrelevant (anonymous, no session effect).

## 9.5 Injection

- SQLi: N/A (no SQL). Redis access is SDK GET/SET on fixed key names from the allow-list; user input is never a key (path `key` validated against KEYS before use).
- Command injection: no shell-outs at runtime.

## 9.6 XSS

- Astro escapes all `{expression}` template output by default — store content rendered on public pages is auto-escaped.
- The **only** `set:html` sink is `PageHero.title`, restricted to page-literal strings (never CMS data) — invariant; code review gate.
- Admin client rendering uses `esc()` before innerHTML.
- Inline event handlers embedding product names escape quotes (BR-11.3); rework to `data-` attributes + delegated listener during build (spec-normative hardening; removes the string-interpolation class of bugs).
- CSP (implement, report-only first): `default-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src www.google.com; connect-src 'self'` — inline scripts/styles are integral to the architecture, hence `unsafe-inline` (documented tradeoff).

## 9.7 SSRF

No server-side fetches of user-supplied URLs anywhere. Keep it that way (review gate for future integrations).

## 9.8 File upload security (FUT-4 gate)

When photo uploads arrive: allow-list MIME (`image/jpeg,png,webp`), max 5 MB, re-encode via sharp, store in Vercel Blob with random names, serve from Blob domain — never from `/public`.

## 9.9 Secrets management

Secrets only in Vercel env vars (`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). Never committed; `.env` git-ignored; `.env.example` documents names only. Rotation runbook: rotate secret → all admin sessions die (BR-16.1) → re-login.

## 9.10 Privacy & compliance (DPDP Act 2023, AS-9)

- PII inventory: leads (name, phone, program, timestamp). Purpose: contact for trial class (stated on form context). Retention: bounded FIFO 500; practical horizon months.
- Erasure request runbook: locate by phone in admin, remove via console (`GET mmakf:leads` → filter → `SET`) until FUT-15 tooling exists; respond within 30 days.
- No visitor cookies, no third-party trackers; analytics is cookieless aggregate. Admin cookie is strictly functional.
- Add a one-line privacy note near the enroll form: "We use these details only to contact you about your trial class." (spec-normative copy addition) and a `/privacy` static page (FUT-23, short-form).

## 9.11 Audit logging

v1: Vercel request logs only. FUT-21 audit trail per §5.4 feeds §12.5.

## 9.12 Security acceptance tests

§15.5 enumerates: leads never in `/api/data`; content write without cookie → 401; wrong key → 400; forged cookie signature → unauthenticated; XSS payload `<img src=x onerror=…>` stored via admin renders inert on public page and in admin list; robots blocks `/admin`.

---

# 10. Performance

## 10.1 Budgets (NFR-PERF)

| Metric | Budget |
|---|---|
| NFR-PERF-1 p75 LCP (4G, mid Android) | ≤ 2.5 s home; ≤ 2.0 s sub-pages |
| NFR-PERF-2 CLS | ≤ 0.05 (no late-loading media; fonts swap) |
| NFR-PERF-3 HTML size | ≤ 60 KB gz per page (compressHTML on) |
| NFR-PERF-4 Redis round-trips | 1 MGET per page render (§5.8) |
| NFR-PERF-5 TTFB p75 | ≤ 600 ms (Mumbai Redis + nearest fn region `bom1`) |
| NFR-PERF-6 JS shipped | ≤ 8 KB total inline per public page |

## 10.2 Levers in place

Edge CDN for assets; API edge caching; viewport prefetching; zero framework JS; system-font kanji; SVG-only imagery; single CSS file; PWA repeat-visit cache; scroll animations on compositor-friendly properties (opacity/transform).

## 10.3 Scalability & availability

Vercel functions auto-scale horizontally; statelessness (BR-16.1, §6.6) makes concurrency safe except documented `leads` race (BR-15 → FUT-12 threshold: > 200 leads/mo). Upstash autoscales; both providers multi-AZ. Single-region function is acceptable (audience: India; set function region `bom1`). Load-balancing/HA are platform-provided; no action beyond region pinning.

---
# 11. Notifications

## 11.1 v1 surface

In-app toasts only (F21) — full catalogue §3.11. No email/SMS/push/webhooks ship in v1 (AS-7).

## 11.2 FUT-5 — Lead email alerts (fully specified, deferred)

Provider: Resend (free tier). Trigger: inside `/api/enroll` after successful write, fire-and-forget (never block or fail the lead response on email failure; log warn). Envelope: from `alerts@mmakf.in` (domain-verified), to `federation.contact.email`, subject `New trial lead — {name} ({program})`, plain-text body with name/phone/program/ts + link to `/admin#leads`. Env var `RESEND_API_KEY`. Retry: none (the admin table is the source of truth; email is convenience). Idempotency: one email per lead id.

## 11.3 FUT roadmap

WhatsApp deep-link reply buttons in admin leads (`https://wa.me/{phone}` — no API needed, near-free win; may ship in v1 if trivial); event-reminder emails (needs subscriber capture — out of scope); Web Push (no use case yet); outbound webhooks `POST {url}` on lead-created for future CRM (reserved config key `integrations`).

# 12. Analytics

## 12.1 Platform

Vercel Web Analytics (cookieless): pageviews, uniques, referrers, geo, device. Speed Insights for CWV field data.

## 12.2 Custom event taxonomy (implement with `track()` helper; all *(planned)* unless noted)

| Event | Props | Fires on |
|---|---|---|
| `enroll_submitted` | program, page | 200 from /api/enroll |
| `enroll_failed` | reason | non-200 or network error |
| `shop_order_intent` | product_id, cat | + Order click |
| `shop_filter` / `gallery_filter` | cat | filter click |
| `event_register_intent` | title | Register click |
| `cta_affiliate_click` | source_page | affiliate CTAs |
| `outbound_contact` | kind: tel/mailto/wa | contact link clicks |
| `pwa_installed` | — | `appinstalled` |
| `admin_saved` | key | admin 200 saves (no content logged) |

## 12.3 KPIs & dashboard

§1.7 table. Weekly review ritual (office): visitors, leads count (admin table), top pages, `enroll_submitted` by program → informs schedule/program emphasis.

## 12.4 Funnels

Primary: `home_view → cta_trial_click|/contact view → enroll_submitted` (target ≥ 2% end-to-end). Secondary: `/affiliation view → cta_affiliate_click`.

## 12.5 Audit trail

FUT-21 (§5.4): per-key write history (ts, size). Surfaced later as "Last updated" chips in admin panels.

# 13. Integrations

| Integration | Mode | Auth | Failure handling |
|---|---|---|---|
| **Upstash Redis** | REST via SDK | URL+token env vars | try/catch → seed fallback (read) / memory fallthrough (write) + warn; health endpoint exposes state |
| **Vercel platform** | Adapter `@astrojs/vercel/serverless` | — | platform SLAs; rollback §14.9 |
| **Google Fonts** | CSS `@import`, `display=swap` | none | swap → system fallbacks; site fully usable |
| **Google Maps embed** | iframe `output=embed`, lazy | none | empty frame; contact cards unaffected (F13) |
| **UPI (manual)** | Instructional string only | — | n/a (no API) |
| **WhatsApp** | `wa.me` deep links (planned) | none | falls back to normal tel/copy |
| **Resend (FUT-5)** | REST | API key | fire-and-forget, warn on failure |
| **Vercel Analytics** | build-time inject | — | no-op if blocked; never blocks render |

Data synchronization: none bidirectional; Redis is single source of truth for content. Retries: reads rely on fallback rather than retry (fast-fail philosophy for a content site).

# 14. Deployment & Operations

## 14.1 Environments

| Env | Trigger | Data | Auth |
|---|---|---|---|
| Local dev | `npm run dev` @ :4321 | in-memory (resets on restart) | password `mmakf2025` |
| Preview | any non-main push / PR | **shares prod Redis** unless `UPSTASH_*` overridden per-env — set preview-scoped vars to a separate Upstash DB (normative: previews must NOT write prod content) | preview-scoped password |
| Production | push to `main` | Upstash prod DB | strong secrets (NFR-SEC-1/2) |

## 14.2 Infrastructure

GitHub repo `infommapatratu-byte/mmakf` (branch `main`) → Vercel Git integration → build `astro build` → serverless function (region **bom1**) + static assets. Domains: `www.mmakf.in` primary + apex redirect; SSL automatic.

## 14.3 CI/CD

Vercel builds on every push; production promotes on `main`. Pre-merge gate (GitHub Action, add during build): `npm ci && npm run build` + `astro check` + the §15 unit/integration suite. No manual deploy steps.

## 14.4 Environment variables (complete)

| Var | Envs | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | preview, prod | admin login (required in prod — boot guard) |
| `ADMIN_SESSION_SECRET` | preview, prod | cookie HMAC key (required in prod) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | preview(sep DB), prod | content store (legacy `KV_REST_API_URL/TOKEN` also honored) |
| `RESEND_API_KEY` | prod (FUT-5) | lead emails |
| `VERCEL_GIT_COMMIT_SHA` | auto | /api/health version |

## 14.5 First-deploy runbook

1. Vercel → New Project → import repo (framework auto: Astro; defaults).
2. Storage tab → Marketplace → Upstash Redis (region Mumbai) → connect (injects URL/token).
3. Set `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` (prod+preview).
4. Deploy → first request serves seed → open `/admin`, verify login, save Federation Profile once (writes baseline to Redis).
5. Domains: add `www.mmakf.in` + `mmakf.in`, configure DNS per Vercel.
6. Verify checklist §14.6.

## 14.6 Deploy verification checklist

`/api/health` → `redis:true` · all 12 routes 200 · admin login/save/lead round-trip · Lighthouse ≥ 90×4 · robots.txt disallows /admin · manifest+SW install prompt on Android Chrome.

## 14.7 Monitoring & alerting

UptimeRobot: `/` and `/api/health` every 5 min → office email on 2 consecutive failures. Vercel: deployment failure notifications on. Weekly: skim function logs for storage warns.

## 14.8 Backup & DR

Upstash daily backups (enable in console). Plus weekly logical export: save `GET /api/data` JSON + admin-only leads dump (FUT-15; until then, Upstash console export) to a private location. Restore: console import or re-POST each key via authenticated script. DR worst case: redeploy from GitHub + restore JSON — RTO < 1 h, RPO ≤ 24 h.

## 14.9 Rollback

Vercel → Deployments → Promote previous (instant). Content bugs are fixed forward in admin (content isn't in deployments). SW pins old assets ≤ its cache bump discipline (F20).

## 14.10 Local-dev operational note (Windows)

A stray `postcss.config.js` in a parent directory (e.g. `Downloads`) breaks Vite's upward config search; the repo's root `postcss.config.cjs` (empty plugins) is **load-bearing — never delete it**.

# 15. Testing Strategy

Framework: Vitest (unit/integration) + Playwright (E2E) — add as devDependencies with `npm test` / `npm run e2e` scripts; CI per §14.3.

## 15.1 Unit

- `auth.ts`: cookie mint→verify round-trip; tampered sig fails; expired `t` fails; malformed cookie fails; `checkPassword` constant-time path incl. length mismatch; short-secret throw.
- `storage.ts`: seed fallback when Redis absent; key namespacing; `getAll` returns exactly the 16 KEYS (regression: never `leads`); MGET batching (NFR-PERF-4).
- `seed.ts`: every KEYS entry exists in SEED; every `icon` value ∈ Icon names; fees are integers.

## 15.2 Integration (API, via Astro dev server or handler harness)

Each §8 endpoint: happy path + every documented error; login sets correct cookie attributes; data write persists then round-trips through `GET /api/data`; enroll truncation (121-char name → 120) and cap-500 behavior; unauthorized write 401; bad key 400.

## 15.3 E2E (Playwright, against `npm run dev`)

1. Visitor journey: home → nav to each of the 12 pages (assert h1 + status 200) → filters work on gallery/shop → FAQ accordion toggles → submit enroll form → success toast.
2. Admin journey: login (wrong password → inline error; right → dashboard) → edit tagline → save toast → public home shows new tagline (new context) → add + delete FAQ (confirm dialog) → leads table shows E2E-submitted lead → logout returns to login.
3. Mobile viewport (390×844): hamburger opens/closes, page has no horizontal scroll (assert `document.documentElement.scrollWidth <= innerWidth` on every page).

## 15.4 Performance testing

Lighthouse CI on home+programs (budgets §10.1) per PR; `getAll` command-count assertion (unit-level).

## 15.5 Security testing

T1 forged cookie → /admin shows login. T2 POST /api/data/leads → 400 (not a public key) and POST /api/data/programs w/o cookie → 401. T3 `/api/data` body contains no `leads` property. T4 stored XSS payload in a program name renders escaped on `/programs` and in admin list. T5 robots.txt disallows /admin, /api.

## 15.6 Accessibility testing

axe-core scan (Playwright) on all 12 pages: zero critical violations; manual keyboard pass per §3.13; contrast audit of token pairs.

## 15.7 Manual QA checklist (release)

Cross-browser (Chrome/Android Chrome/Safari iOS/Firefox); PWA install + offline revisit; map iframe; all §3.11 strings verbatim; admin on shared laptop at 1366×768.

## 15.8 Acceptance criteria (definition of done, v1)

All FR-marked [M] features implemented per spec · §14.6 checklist green in production · §15.1–15.6 suites green in CI · zero known deviations from §3.11 copy and §3.1 tokens · spec-normative build additions completed (list: MGET, health endpoint, 404 page, delete confirm, submit-disable, aria-live/labels/expanded, focus-visible, noscript notes, robots disallow, sitemap route, prod env boot guard, timingSafeEqual signature compare, data-attribute order buttons, privacy microcopy).

# 16. Documentation Deliverables

| Doc | Audience | Content | Location |
|---|---|---|---|
| `README.md` | developers | stack, local dev, deploy runbook (exists; keep in sync) | repo root |
| `docs/MASTER-SPEC.md` | AI agents / engineers | this document | repo |
| `docs/CHANGELOG.md` | developers | schema/content-key migrations (§5.5) | repo |
| Admin guide | P3 office | login, each panel, icon-name list, messaging catalogue, "what appears where", lead handling SLA, erasure runbook | `docs/ADMIN-GUIDE.md` (write during build; ≤ 2 pages, screenshots) |
| API reference | integrators | §8 extracted | `docs/API.md` (generate from §8) |
| Ops runbook | maintainer | §14.5–14.10 + secret rotation + restore-from-backup + revert-key-to-seed | `docs/RUNBOOK.md` |

# 17. Future Scalability & Extensibility

Numbered FUT items defined throughout are the roadmap backlog; consolidated: FUT-1 RBAC · FUT-2 payment gateway (Razorpay; orders table; shop checkout) · FUT-3 event registration · FUT-4 media uploads (Vercel Blob) · FUT-5 lead emails · FUT-6 Hindi i18n (Astro i18n routing `/hi/*`; content keys gain `_hi` variants) · FUT-7 drag-reorder in admin lists · FUT-8 ISO event dates + auto-archival · FUT-9 URL-synced filters · FUT-10 affiliation web form · FUT-11 phone normalization · FUT-12 atomic leads list · FUT-13 admin 401 auto-redirect · FUT-14 optimistic content versioning · FUT-15 leads CSV export + delete · FUT-16 sitemap · FUT-17 branded 404 (promoted to v1 build list) · FUT-18 admin scroll-spy · FUT-19 zod content schemas · FUT-20 lead statuses · FUT-21 audit trail · FUT-22 client search · FUT-23 privacy page.

Architecture headroom: **multi-tenancy** (second federation) = namespace prefix per tenant (`{tenant}:mmakf:{key}`) + host-based tenant resolution in storage — the single-abstraction storage layer makes this a contained change. **Microservices**: unwarranted at any foreseeable scale; the seam, if ever, is extracting `/api/*` to standalone functions (already isolated modules). **Feature flags**: a `flags` content key read by pages — trivially addable via existing machinery. **Enterprise readiness** items (SSO, audit, SLAs) map onto FUT-1/21 + paid Vercel/Upstash tiers without redesign.

# 18. Final Product Definition — end-to-end behavioral contract

**Scenario A — Parent on a phone (P1).** Opens `www.mmakf.in` from a school WhatsApp group. In < 2.5 s sees the black/gold hero, "Established 1983" pill, and stats band. Scrolls: fade-ins reveal sections; ticker glides. Taps hamburger → Facilities → reads training-hall and CCTV cards → Schedule → sees Wed 6 AM Kids batch → taps Enroll in nav → lands on `/contact#enroll` → fills name+phone, selects Kids Program, taps Book Free Trial → button disables, toast "Oss. Free trial booked…" appears, form clears. Her data now sits first in the admin leads table. Next day the office calls (SLA < 24 h).

**Scenario B — Office admin (P3).** Opens `/admin` on the office laptop → password → dashboard. Posts news ("Registrations open…") via News panel → toast Added → item appears atop the list. Opens site in the View Site tab → news card is live on `/` and `/events` immediately (HTML uncached) — API consumers converge ≤ 5 min. Checks Leads → sees Anita → calls → done. Deletes a stale June event (confirm dialog → Deleted). Logs out; cookie cleared.

**Scenario C — Dojo owner (P4).** Googles the federation → `/affiliation`. Reads the four membership routes, requirement list (II Dan+ instructor…), and the 4-step charter workflow → taps **Email the federation** → mail client opens pre-subjected "Dojo Affiliation Enquiry" → sends club profile. The branch register shows where he'd appear post-charter.

**Scenario D — Degraded conditions.** Upstash has an outage: every public page still renders (seed or last-HTML), warns in logs, `/api/health` reports `redis:false`, UptimeRobot stays green (200), admin saves toast "Save failed" until recovery. A visitor in a tunnel re-opens the previously visited home page: SW serves it offline; tapping an unvisited route shows the cached home; the enroll form fails with the retry toast and preserved input.

**Scenario E — Hostile input.** A bot hammers `/api/enroll`: WAF throttles at 10/min/IP; entries are capped at 500 with truncated fields; nothing renders publicly. Someone pastes `<script>` into a testimonial via a stolen admin session: Astro escaping renders it as text on the public site; rotating `ADMIN_SESSION_SECRET` kills the stolen session platform-wide in one env-var change.

**Global acceptance statement.** The product is complete when: every scenario above behaves exactly as written; §15.8's definition of done is satisfied; the office operates the site for two consecutive weeks — posting news, editing schedule, processing leads — without developer assistance; and the public site holds its performance and accessibility budgets on re-audit.

---

*End of Master Specification v1.0.0 — maintained in-repo; every product change lands here first, then in code.*
