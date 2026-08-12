# MMAKF Engineering Audit Register

**Phase 2 — second-pass audit from production baseline `914cabd`**

| Field | Value |
|---|---|
| Baseline commit | `914cabd` (v1.9.0) — verified live at www.mmakf.in |
| Audit started | 2026-08-11 |
| Method | 5 parallel investigation tracks (UX desktop, UX mobile, content, engineering, adversarial security), every P0–P2 finding independently re-verified by a second agent before entry |
| Register status | **OPEN** — see §3 for live counts |

## 1. Severity definitions

| Level | Meaning |
|---|---|
| **P0** | Security, data loss, incorrect official information, payment/data integrity, broken core workflow |
| **P1** | Important operational or institutional defect |
| **P2** | Meaningful UX / content / engineering issue |
| **P3** | Polish |

Status values: `OPEN` · `FIXED` · `VERIFIED` · `REQUIRES MMAKF DECISION`

## 2. Carry-over: the five unverified findings from the Phase 1 audit

The Phase 1 audit ran 30 agents; five verification runs terminated on session limits, so their
findings entered `914cabd` **unverified**. They are re-tested in this phase.

| ID | Original finding (Phase 1) | Was it fixed in 914cabd? | Phase 2 action |
|---|---|---|---|
| C-1 | `/about` — anonymous "Parent of Student" testimonial reads fabricated; initials-avatar shows "PO" | No | Re-tested this phase |
| C-2 | `/about` — duplicate agent on the same testimonial finding | No | Merged into C-1 |
| C-3 | All pages — footer nav links dark-on-dark contrast (`.ft-col a` token) | Theme changed since (light redesign) | Re-tested this phase |
| C-4 | `/shop` — price/action row collision, inconsistent wrapping of struck-through MRP | Row markup changed (UPI + WhatsApp links added) | Re-tested this phase |
| C-5 | `/belt-system` — Dan credential pills overflow on mobile | Yes — wrap rule added at ≤560px | Verification pending |

## 3. Findings register

**Audit yield: 71 raw findings** across five tracks. P0s were fixed and shipped immediately
(commit `683e65f`, live on production) rather than held for the full remediation queue.

### 3.1 P0 — Critical (all FIXED + VERIFIED in production)

| ID | Area | Finding | Evidence | Status | Fix | Verification |
|---|---|---|---|---|---|---|
| **P0-1** | `src/lib/auth.ts`, `/admin`, `/api/data/[key]` | **Privilege escalation via session token type-confusion.** `mmakf_admin` and `mmakf_unit` are HMAC-signed with the same secret and neither payload declares its type, so `isAuthenticated()` accepted *any* validly-signed token. A club-level unit could rename its cookie to `mmakf_admin` and become national admin. | Reproduced pre-fix: unit login → replay token as `mmakf_admin` → `/admin` returned **200 with the full dashboard**, private leads visible, and `POST /api/data/faqs` returned **200** (content write succeeded). | **VERIFIED** | Audience claim `k: admin\|unit` checked by the verifier **plus** per-audience derived signing keys (HMAC domain separation). Legacy tokens rejected. | Post-fix dev: forged admin → login form, write → 401; genuine admin/unit both work. Production (`683e65f`): forged → `dashboard:0, login form present`, write → **401**. 8 regression tests in `tests/auth-audience.test.ts`. |
| **P0-2** | `src/lib/auth.ts:23` | Admin session HMAC key falls back to the repo-visible literal `dev-secret-change-me` when neither env var is set. | `getSecret()` fallback chain, file:line. | **FIXED** (mitigated) | Production already refuses logins without `ADMIN_PASSWORD`+`ADMIN_SESSION_SECRET` (`login.ts:10` boot guard); the derived-key change also means the literal no longer signs anything directly. | Guard confirmed present at `src/pages/api/auth/login.ts:10`; production has both env vars set (verified in Vercel). |
| **P0-3** | `src/pages/admin/index.astro` — Unit Access panel | **Data loss:** adding one unit access code deleted every existing code, locking all chartered units out of `/unit`. The client model (`define:vars`) omitted admin-only keys, so add/delete operated on `undefined` and wrote a 1-element array. | Panel rendered rows server-side but `data.unitAccess` was absent from the injected client model. | **VERIFIED** | Inject `unitAccessList` into the client model. | Admin page now serves 4 existing codes and `"unitAccess"` appears in the client model; add/delete splice the real array. |
| **P0-4** | `src/layouts/Base.astro` — site-wide footer | Every footer nav link on every page rendered at **2.00:1** contrast (WCAG AA needs 4.5:1) — effectively unreadable. The light redesign repointed `--off-white` to an ink value while the footer stayed a dark band. | Computed contrast of `#4C463C` on `#14120F`. | **VERIFIED** | Explicit light values: links `#D8D2C6` (10.4:1), headings `#D9BC66` (7.6:1), bottom bar `#A9A296` (5.4:1). | Production CSS confirmed: `.ft-col a{...color:#d8d2c6...}`, `.ft-h{...#d9bc66...}`, `.ft-bottom{...#a9a296}`. |

### 3.2 P1 — Major

**All code-fixable P1s are FIXED + VERIFIED in production.** Four remain open as
`REQUIRES MMAKF DECISION` (institutional facts only the federation can settle) and one
requires a Vercel dashboard change.

| ID | Area | Finding | Status |
|---|---|---|---|
| P1-1 | `GET /api/data` | Members register downloadable in bulk. **Accepted by design** — a public register must be publicly checkable — but `/api/verify` is now rate-limited (30/min/IP) against enumeration, and the register carries no PII. | ACCEPTED + MITIGATED |
| P1-2 | All public write endpoints | No rate limiting anywhere. | **VERIFIED** — Redis INCR/EXPIRE limiter; production: 12 rapid enrolments → 10×200 then 429; 7 logins → 5×401 then 429 |
| P1-3 | 4 private-list writers | Non-atomic read-modify-write lost records under concurrency. | **VERIFIED** — LPUSH+LTRIM; 8 concurrent submissions → 8 persisted |
| P1-4 | `/events`, `/` | News announced open registration for an event the same page reported as concluded. | **VERIFIED** — production: 0 occurrences |
| P1-5 | `/`, `/about` | Limca/Guinness recognition asserted flatly in the ticker but hedged in the Recognition panel — internally inconsistent. | REQUIRES MMAKF DECISION |
| P1-6 | `/shop` | 12oz boxing gloves sold as federation competition gear — not WKF-legal karate equipment. | **VERIFIED** — renamed to kumite mitts; production: 0 occurrences |
| P1-7 | `/`, `/events` news cards | Stock photography captioned as documentary evidence of named events. | PARTIAL — captions genericised in v1.9.0; `alt` text still mirrors headlines. Resolves fully when the federation supplies real photography (D-11) |
| P1-8 | `/about`, `/governance`, `/belt-system` | Shotokan titling wrong/self-contradictory: VI Dan styled "Grandmaster · Soke"; belt table says VI Dan = "Grandmaster level (Shihan)". | REQUIRES MMAKF DECISION |
| P1-9 | `/affiliation` | "MMAKF is the apex national body" — no recognition cited to support apex status. | REQUIRES MMAKF DECISION |
| P1-10 | `/contact` | Map iframe kept a dark-theme `invert(0.92)` filter. | **VERIFIED** — removed |
| P1-11 | `/shop` | Price/action row collided ("₹1,800UPI Pay"). | **VERIFIED** — prices and actions stack; footers pin to card bottom |
| P1-12 | `/belt-system` | Kata syllabus omits the 2nd→1st Kyu examination and merges 4th→2nd. | REQUIRES MMAKF DECISION |
| P1-13 | `src/layouts/Base.astro` | Wordmark clipped by fixed 72px nav height on mobile. | **VERIFIED** — min-height + padding; CDP-measured |
| P1-14 | All data tables | No scroll affordance on touch. | **VERIFIED** — edge-fade + visible scrollbar on all 7 tables |
| P1-15 | `global.css` + `Base.astro` | `.fade{opacity:0}` could leave content permanently invisible if the script failed. | **VERIFIED** — hiding is JS-gated + 4s failsafe animation |

**New P1 found in Phase 2 verification** (not in the original 71 — surfaced only by correct measurement):

| ID | Area | Finding | Status |
|---|---|---|---|
| P1-16 | `/about`, `global.css` | The 57-character governance CTA rendered **513px wide** (`.btn` is `white-space:nowrap`), overflowing the document by **143px** and clipping page content. Screenshot-based checks had mis-attributed this to the nav. | **VERIFIED** — labels wrap below 620px; all 15 routes CDP-measured at zero overflow |

### 3.2b Method correction (important)

Phase 1 and the first Phase 2 pass took "mobile" screenshots with `chrome --window-size=390`.
Without mobile emulation Chrome lays out at **desktop width and crops**, which *fabricates*
clipping. Several mobile findings were therefore artifacts, while the genuine 143px overflow
above was mis-attributed. All mobile verification now uses CDP
`Emulation.setDeviceMetricsOverride` + direct `scrollWidth` measurement.

### 3.3 P2 — completed batch

| ID | Area | Finding | Status |
|---|---|---|---|
| P2-a | All pages | No canonical link; `og:url` hardcoded to root, so every page advertised itself as the homepage. No structured data. | **VERIFIED** — per-page canonical + og:url; SportsOrganization JSON-LD |
| P2-b | `vercel.json` | CSP was Report-Only with no report destination — enforced nothing, reported nothing. | **VERIFIED** — enforced; all 17 pages load with **zero CSP violations** (CDP console capture) |
| P2-c | Domain | `https://mmakf.in` 301s to **`http://`** www — a protocol downgrade. | MITIGATED (HSTS preload added, so browsers upgrade the hop) — **REQUIRES DASHBOARD FIX** for the redirect target itself |
| P2-d | `public/logo.png` | JPEG served as `image/png` under `nosniff`. | **VERIFIED** — renamed `logo.jpg`, served `image/jpeg` |
| P2-e | `/admin` | `stats` and `beltGrading` had no admin panel — the office could not edit headline figures or grading fees without a deploy. | **VERIFIED** — three new panels; list panels now support nested keys (`beltGrading.kyu`); round-trip tested |
| P2-f | Site-wide | Missing security headers. | **VERIFIED** — HSTS, X-Frame-Options, Permissions-Policy, noindex on `/api/*` |

### 3.4 Remaining P2 / P3

47 further findings (predictable reference numbers, inert Report-Only CSP, missing canonical/JSON-LD,
apex→www HTTP downgrade, logo MIME mismatch, webfont `@import` blocking, per-page sequential Redis
round-trips, stats/statistics without source, `stats` and `beltGrading` having no admin panel,
recycled photography, unheaded events section, touch-target sizes, and the Shotokan-terminology
cluster). Full list retained in the workflow journal; scheduled into the P1→P2 remediation queue.

## 4. Method notes

- **No finding is entered on assertion alone.** Each is reproduced by an independent agent
  (command + observed output, or file:line, or a screenshot that was actually read) before entry.
- **Refuted findings are recorded too** (§5), so the same false positive is not re-investigated.
- Findings that require federation policy input (real fees, official titles, approved recognitions)
  are marked `REQUIRES MMAKF DECISION` and never silently invented.

## 5. Refuted / not-reproduced

*Populated after verification.*
