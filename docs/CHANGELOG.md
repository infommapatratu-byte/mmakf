# Changelog

Content-key and schema migrations are recorded here (MASTER-SPEC §5.5).

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
