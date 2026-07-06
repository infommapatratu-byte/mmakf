# Changelog

Content-key and schema migrations are recorded here (MASTER-SPEC §5.5).

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
