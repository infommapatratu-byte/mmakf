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

### 3.2 P1 — Major (remediation in progress)

| ID | Area | Finding | Status |
|---|---|---|---|
| P1-1 | `GET /api/data` | Entire national members register downloadable unauthenticated in bulk (name, ID, grade, state, unit) — `members` sits in public `KEYS`. Register data is public by design, but bulk export enables scraping. | OPEN |
| P1-2 | All public write endpoints | No rate limiting anywhere; only a 400 ms sleep on failed login, which does not serialise concurrent attempts. Private lists can be flooded past their caps, evicting genuine records. | OPEN |
| P1-3 | `enroll.ts`, `register.ts`, `event-register.ts`, `unit/submit.ts` | Non-atomic read-modify-write on Redis JSON lists; concurrent lambdas lose records. | OPEN |
| P1-4 | `/events`, `/` | News feed contradicts the Results register on the same page (an event announced as open registration is also reported as concluded with medal counts). | OPEN |
| P1-5 | `/`, `/about` | Limca/Guinness recognition asserted flatly in the ticker but hedged in the Recognition panel — internally inconsistent. | REQUIRES MMAKF DECISION |
| P1-6 | `/shop` | "Boxing Gloves 12oz" sold as "the same gear the federation trains and competes in" — not WKF-legal karate equipment. | OPEN |
| P1-7 | `/`, `/events` news cards | Stock photography published as documentary evidence of named federation events (`alt` = the headline). | OPEN |
| P1-8 | `/about`, `/governance`, `/belt-system` | Shotokan titling wrong/self-contradictory: VI Dan styled "Grandmaster · Soke"; belt table says VI Dan = "Grandmaster level (Shihan)". | REQUIRES MMAKF DECISION |
| P1-9 | `/affiliation` | "MMAKF is the apex national body" — no recognition cited to support apex status. | REQUIRES MMAKF DECISION |
| P1-10 | `/contact` | Map iframe keeps a dark-theme `invert(0.92)` filter, wrong on the white page. | OPEN |
| P1-11 | `/shop` | Price/action row overflow: struck-through MRP collides with "UPI Pay" (renders "₹1,800UPI Pay"). | OPEN |
| P1-12 | `/belt-system` | Kata syllabus omits the 2nd→1st Kyu examination and merges 4th→2nd. | REQUIRES MMAKF DECISION |
| P1-13 | `src/layouts/Base.astro` | Federation wordmark clipped by the 72px fixed nav height at mobile widths. | OPEN |
| P1-14 | All data tables | Fixed min-width tables in bare `overflow-x:auto` with no scroll affordance on touch. | OPEN |
| P1-15 | `global.css` + `Base.astro` | `.fade{opacity:0}` reveal depends on a module script; if it fails to load, content is permanently invisible. | OPEN |

### 3.3 P2 / P3

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
