# RESPONSIVE-DESIGN — the breakpoints in the code, and what has actually been measured

**This document records what exists.** Breakpoints were extracted from every `@media` rule in
`src/`; the evidence of what has and has not been width-tested comes from
`docs/AUDIT-REGISTER.md §3.2b`, `tests/layout-guards.test.ts`, and `git log --diff-filter=A` on each
route file. Branch `wave-2b-federation`.

> **Currency.** First written against committed state `9d67c09`; re-tallied against the **working
> tree** on 2026-08-12, which had moved (a concurrent accessibility pass added
> `src/styles/a11y.css`, a concurrent feature added `/people/[slug]`, and several page files were
> edited). The counts below are the re-tally. Re-run the tally in §1 before quoting a number.

Two people define the requirement, and they are not the same person:

- **A referee scores at the mat side, on a phone.** `/scoreboard`, `/live`, `/competitions`. One
  hand, bright light, no time. Anything that requires a sideways scroll to read a score is a defect.
- **A state secretary works on a laptop.** `/admin/*`, `/unit`. Nine-column tables, decision forms,
  audit trails. The full width is legitimately needed here — but the same secretary opens the queue
  on a phone on a Sunday.

The definition of done in `docs/MASTER-SPECIFICATION.md §9` says **"usable at 360px."** This
document records that **360px is the stated floor and 320px has never been tested on any surface.**

---

## 1. The breakpoints actually used

Every `@media` rule in `src/`, counted:

| Breakpoint | Occurrences | What it does |
|---|---:|---|
| `max-width: 1080px` | 1 | **The nav collapse.** `.nav-links` becomes a fixed drawer, the hamburger appears. |
| `max-width: 980px` | 1 | `/registration` intro column |
| `max-width: 900px` | 17 | `.grid-3` / `.grid-4` collapse to 2 columns; `/admin/competition` and `/admin/grading` sidebar collapse |
| `max-width: 860px` | 5 | `.q-form-grid` collapses to one column; `/dojos` `.dir-row` stacks |
| `max-width: 820px` | 1 | `/press` |
| `max-width: 800px` | 25 | **The most-used breakpoint.** The admin sidebar collapse (7 of 9 admin pages), the footer grid going to 2 columns, `/rankings` `.rk-header` |
| `max-width: 780px` | 7 | two-column explanatory key blocks on `/dojos`, `/athletes`, `/rankings` |
| `max-width: 760px` | 4 | `.tbl-hint` becomes visible — "Scroll the table sideways to see every column" |
| `max-width: 720px` | 1 | `.q-facts dl` stacks |
| `max-width: 700px` | 10 | `.cta-form` stacks; `/unit` `.up-form-grid` stacks; `/scoreboard` freshness block left-aligns |
| `max-width: 640px` | 19 | **The container / section breakpoint.** Container padding `28px` → `20px`; section padding `108px` → `72px`; `.page-hero` padding drops; `/athletes` and `/rankings` lookup rows stack |
| `max-width: 620px` | 4 | **`.btn` labels wrap** (the P1-16 fix, regression-tested); `.a-dl` / `.c-dl` label columns stack |
| `max-width: 600px` | 12 | `.grid-2/3/4` all collapse to one column; `.admin-main` padding drops to 16–18px |
| `max-width: 560px` | 16 | `.q-state` left-aligns; `/athletes` filters stack; `/rankings` `.rk-def` stacks |
| `max-width: 520px` | 12 | `/scoreboard` `.sb-grid` goes to one column; state blocks reduce padding to `22px 18px` |
| `max-width: 500px` | 3 | `/admin` list-panel form grid stacks |
| `max-width: 480px` | 6 | **The footer goes to one column**; `/rankings` `.rk-meta-row` stacks |
| `max-width: 460px` | 1 | `/admin/competition` `.c-facts` stacks |
| `max-width: 420px` | 4 | `.nav-name-2` narrows to `15ch`; `/dojos` `.dir-meta-row` stacks |
| `min-width: 1081px` | 1 | `main` top padding tightens from 88px to 76px once the nav is a single row |
| `min-width: 1500px` | 1 | `/scoreboard` widens its mat cards to `minmax(600px, 1fr)` for a venue display |
| `min-width: 981px` | 1 | `/registration` intro becomes sticky |
| `pointer: coarse` | 2 | **44px minimum touch targets** on `.btn`, `.gfilter`, `.sfilter`, `.btn-link`, `.nav-links a`, `.nav-hamburger` |
| `prefers-reduced-motion: reduce` | 4 | disables the `.fade` reveal, and (in `a11y.css`) the `.skip-link` transition. **It does not gate `html { scroll-behavior: smooth }`** — see `DESIGN-SYSTEM.md` DS-11 |

**Twenty-two distinct width values — 19 `max-width` and 3 `min-width`** (24 distinct query forms in
total, counting `pointer: coarse` and `prefers-reduced-motion`). There is no breakpoint scale —
800/780/760/720/700 all exist, and so do 640/620/600. Two of them are load-bearing and named:
`1080px` (nav) and `640px` (container and section rhythm). The rest are per-component decisions
taken where the content happened to break.

Reproduce the tally with:

```
grep -rhoE "@media[^{]*" src --include=*.astro --include=*.css   | sed 's/  */ /g;s/ *$//' | sort | uniq -c | sort -rn
```

**There is no lower bound.** The narrowest rule in the system is `420px`. Nothing anywhere responds
below that, so 360px and 320px are served the 420px layout.

---

## 2. The mobile-first rules the code actually follows

The CSS is **desktop-first**: 19 of the 24 media-query families are `max-width` overrides on top of
a desktop base. Only three `min-width` rules exist (1081px, 981px, 1500px), and all three widen
rather than establish a mobile base. That is a stated fact about the codebase, not a recommendation.

Within that, five rules are applied consistently and are worth keeping:

1. **Every multi-column grid declares its collapse.** `.grid-3` / `.grid-4` → 2 at ≤900px, all → 1
   at ≤600px; `.admin-wrap` → 1 column at ≤800px or ≤900px; `.ft-grid` → 2 at ≤800px, 1 at ≤480px.
   Every fixed-column grid found in the audit below has a collapse rule. **No unguarded fixed
   two-column grid was found.**
2. **Wide tables scroll inside their own container, never on the page body.** `.tbl-scroll` carries
   an edge-fade, a visible touch scrollbar, and a `.tbl-hint` that appears below 760px.
   `DataTable.astro`'s header comment states the rule outright: "The scroll lives on `.tbl-scroll`
   INSIDE this component … so the page body never scrolls sideways — which is the failure that makes
   an admin screen unusable at the mat side."
3. **Touch targets are 44px under `pointer: coarse`**, and individually where a control is small:
   `.q-submit`, `.q-refresh`, `.stat-link`, `.dt-src summary`, `.stat-src summary`, `.q-facts
   summary` all set `min-height: 44px` unconditionally.
4. **Long strings wrap rather than overflow.** `overflow-wrap: anywhere` on every value cell,
   reference, `<code>` and `<dd>` in `DataTable`, `StatCard` and `QueuePanel`; `.btn` drops
   `nowrap` below 620px.
5. **Label/value grids stack.** `.a-dl`, `.c-dl`, `.rk-meta-row`, `.rk-def`, `.dir-meta-row`,
   `.q-facts dl` each become a single column between 780px and 420px.

---

## 3. Widths that have actually been tested — and by what method

`docs/AUDIT-REGISTER.md §3.2b` records a **method correction** that matters more than any single
finding:

> Phase 1 and the first Phase 2 pass took "mobile" screenshots with `chrome --window-size=390`.
> Without mobile emulation Chrome lays out at **desktop width and crops**, which *fabricates*
> clipping. Several mobile findings were therefore artifacts, while the genuine 143px overflow above
> was mis-attributed. All mobile verification now uses CDP `Emulation.setDeviceMetricsOverride` plus
> direct `scrollWidth` measurement.

**A screenshot is not a width measurement on this site.** `body { overflow-x: hidden }` hides the
overflow; the only trustworthy check is `document.documentElement.scrollWidth <= innerWidth` under
real device-metrics emulation.

### Measured: 15 routes, at 390px, at commit `6a44fdf`

P1-16: "all 15 routes CDP-measured at zero overflow." The routes that existed at that commit:

```
/  /about  /academy  /affiliation  /belt-system  /contact  /events  /facilities
/faq  /gallery  /governance  /programs  /registration  /schedule  /shop  /unit  /admin  /404
```

Also verified at that commit: the nav wordmark no longer clips (P1-13, CDP-measured), the footer
contrast fix (P0-4, computed), and CSP on 17 pages with zero console violations (P2-b).

### Never measured at any width: 25 routes

Every one of these was added on 2026-08-12, after the audit baseline. `git log --diff-filter=A`
confirms the add commit for each; `/people/[slug]` is newer still (commit `5cfa2be`, uncommitted at
the time this document was first written):

```
/athletes            /athlete/[id]      /dojos             /officials
/rankings            /competitions      /scoreboard        /live
/verify              /regulations       /press             /checkout
/application         /my                /my/passport       /my/courses
/admin/command       /admin/dashboard   /admin/grading     /admin/competition
/admin/governance    /admin/approvals   /admin/cases       /admin/queue
/people/[slug]
```

**This is the whole federation product.** Every register, every dashboard, the scoreboard the
referee uses at the mat side, and the entire member area have never been width-tested — not at
390px, not at 360px, not at 320px.

### 320px: tested on nothing

No surface has been verified at 320px. The narrowest media query in the codebase is 420px, the
stated floor in `MASTER-SPECIFICATION.md §9` is 360px, and the audit measured at 390px. 320px
(iPhone SE 1st gen, and the width a phone reports at 125% text zoom on a 400px screen) is outside
everything that has been checked.

### What can be said without a browser

The following was verified by reading the CSS, and it is a static analysis, **not** a substitute for
measurement. At a 320px viewport the container gives **280px** of content (`padding: 0 20px`), and
`.admin-main` gives roughly **284px** (`padding: … 18px`).

- **Every fixed-column grid collapses above 320px.** `.admin-wrap` (260px/280px + 1fr) → ≤800/900px;
  `.a-dl` and `.c-dl` (190px + 1fr) → ≤620px; `.up-form-grid` (240px + 1fr) → ≤700px;
  `.governance` `280px 1fr` → ≤800px; `.athletes` `minmax(0,420px) auto` → ≤640px;
  `.rankings` `minmax(0,520px) auto` → ≤640px; `.dojos` `minmax(0,320px) minmax(0,1fr)` → ≤780px.
  None of these can overflow at 320px.
- **The one auto-fit track wider than 280px is guarded.** `/scoreboard` `.sb-grid` is
  `repeat(auto-fit, minmax(420px, 1fr))` — which would overflow — but it has an explicit
  `@media (max-width: 520px) { grid-template-columns: 1fr }`. `.sb-picker` is
  `minmax(280px, 1fr)` against ~292px of content at that page's padding: it fits, with 12px to
  spare. Every other `minmax()` floor in the codebase is 130–240px.
- **`.g-dl dt` sets `min-width: 130px`** inside a flex row that wraps — fine at 280px.
- **`.sb-freshness` sets `min-width: 260px`** — fits at 280px, and left-aligns at ≤700px.
- **All 20 wide tables declare a `min-width` between 520px and 900px and sit inside a horizontal
  scroller**, so they scroll rather than pushing the page — with the seven exceptions in §4.

Nothing in this static pass predicts a 320px overflow. That is a reason to run the measurement, not
a substitute for it: the P1-16 overflow was caused by a *button label*, which no amount of reading
grid declarations would have found.

---

## 4. Surfaces where the mobile affordance is missing

`.tbl-scroll` is what tells a phone user that a table scrolls. Seven tables do not have it — they
sit on a bare `<div style="overflow-x:auto">` with no edge-fade, no visible touch scrollbar, and no
`.tbl-hint`:

| Surface | Tables | Declared width |
|---|---|---|
| `/unit` | 4 (`.up-tbl`) | `min-width: 640px` |
| `/admin` | 3 (`.schedule-tbl`) | `min-width: 760px`, `780px`, `820px` |

P1-14 is recorded as "VERIFIED — edge-fade + visible scrollbar on all 7 tables". Seven *other* tables
were fixed; these seven were not.

Related, and separate: **`.dt-scroll` inside `DataTable` is not keyboard-scrollable** — no
`tabindex="0"`, no `role="region"`. `/rankings` adds both by hand in three places, so the pattern is
known in this codebase. See `DESIGN-SYSTEM.md §6`.

---

## 5. `overflow-x: hidden` makes width regressions silent

`global.css` sets `body { overflow-x: hidden }`. This does not prevent overflow; it clips it. The
consequence is on the record: P1-16's 57-character button label rendered 513px wide and overflowed
the document by 143px, **clipping page content**, while looking fine in a screenshot. The
mis-attribution of that finding to the nav cost a full verification cycle.

Any future width regression on this site will be invisible to visual inspection and visible only to
`scrollWidth`. That is an argument for a test, not for removing the rule.

---

## 6. What renders today, and its structure

Re-measured 2026-08-12 against `npx astro dev --port 4433 --host 127.0.0.1` on this branch (Astro
5.18.2, Node v25.9.0, no `DATABASE_URL`, no Redis). 43 route files exist under `src/pages`; 42 route
paths were requested (two are dynamic: `/athlete/[id]`, `/people/[slug]`). Every one returned the
expected status, and **every one of the 42 contained exactly one `<h1>`** — measured by counting
`<h1` in the response body, all 42 returned `1`.

| Result | Routes |
|---|---|
| `200` | 41 paths — every public, member and admin surface, plus `/people/sensei-vikas-pathak` |
| `404` | `/404` ("Lost on the mat?") and `/athlete/1` ("Not a federation ID.") — correct: `1` is not a federation ID format |

`/people/` with an unrecorded name (`/people/vikas-pathak`, missing the honorific) correctly returns
`404`: the slug is matched against a recorded name, never parsed.

That is a genuine structural strength and is worth protecting: no route ships zero `<h1>`, and no
route ships two. **It is also not tested** — the check above is a manual curl, not an assertion.

---

## 7. What is regression-tested

`tests/layout-guards.test.ts` — 6 tests, run 2026-08-12 (`npx vitest run tests/layout-guards.test.ts`
→ 1 file passed, 6 tests passed). Three of them are responsive assertions, all against the CSS
source:

```
.btn labels wrap below 620px                      (P1-16, the 143px overflow)
coarse-pointer targets are >= 44px; hamburger >= 44x44
.nav-inner uses min-height, not a fixed height    (P1-13, clipped wordmark)
```

The `.skip-link` added by the Q-28 pass sets `min-height: 44px` and is the first focusable element,
but **no test asserts its existence or its size**.

There is **no test that measures a rendered width**. `MASTER-SPEC.md §1226` specifies the check —
"Mobile viewport (390×844): hamburger opens/closes, page has no horizontal scroll (assert
`document.documentElement.scrollWidth <= innerWidth` on every page)" — and it is not implemented.
Adding it would require a headless browser; the repo has no browser automation dependency, and the
project rule is **no new dependencies**, so this is a decision for the federation, not a defect to
be fixed unilaterally.

---

## 8. Findings — responsive

| # | Severity | Finding | Where |
|---|---|---|---|
| RD-1 | **Serious** | **24 of 42 routes have never been width-measured at any viewport.** Every register, every dashboard, the member area, and the mat-side `/scoreboard` were added after the audit baseline `6a44fdf` and no CDP measurement has been run on them. | all wave-2b routes |
| RD-2 | **Serious** | **320px is tested on nothing.** The stated floor is 360px, the audit measured 390px, and the narrowest media query in the codebase is 420px. | site-wide |
| RD-3 | Moderate | `MASTER-SPEC.md §1226` specifies a `scrollWidth <= innerWidth` assertion on every page; it is not implemented, and `body { overflow-x: hidden }` means no visual check can substitute for it. | `tests/`, `global.css` |
| RD-4 | Moderate | Seven tables on `/unit` and `/admin` have no scroll affordance on touch (bare `overflow-x:auto`, no edge-fade, no `.tbl-hint`). | `unit.astro`, `admin/index.astro` |
| RD-5 | Moderate | `DataTable`'s scroll container cannot be scrolled by keyboard (no `tabindex` / `role="region"`), unlike the hand-rolled equivalents on `/rankings`. | `DataTable.astro` |
| RD-6 | Minor | Twenty-two distinct breakpoint values (19 `max-width`, 3 `min-width`) with no scale; 800/780/760/720/700 and 640/620/600 all coexist. Two are load-bearing (1080px nav, 640px container); the rest are ad hoc. | site-wide |
| RD-7 | Minor | Nothing in the system responds below 420px, so 360px and 320px are both served the 420px layout. | site-wide |
| RD-8 | Minor | The CSS is desktop-first (19 `max-width` families against 3 `min-width` rules, all three of which widen) while the primary field user is on a phone. | site-wide |

---

## 9. What this document does NOT cover

- **No width was measured in a browser during this pass.** §3 reports what `docs/AUDIT-REGISTER.md`
  recorded at commit `6a44fdf` and what `git log` shows has been added since. The only thing
  measured live here was HTTP status and `<h1>` count (§6). **No `scrollWidth` reading was taken at
  any viewport, by this document or by anyone, on any of the 25 routes in §3.**
- **The static pass in §3 is not a measurement and must not be cited as one.** It reads grid
  declarations and `minmax()` floors. It cannot see a long word, a long button label, an
  unwrappable `<code>` string, a rendered table cell, or a photograph's intrinsic width — and a
  button label is exactly what caused P1-16.
- **Nothing was tested on a real device.** No iOS Safari, no Android Chrome, no browser zoom, no
  text-only zoom, no landscape orientation, no dynamic-type setting, no on-screen keyboard shrinking
  the viewport.
- **Breakpoint counts are a grep of `@media` rules.** Responsive behaviour expressed without a
  media query — `clamp()`, `minmax()`, `auto-fit`, `flex-wrap`, `ch` and `vw` units — is not in
  the tally, and there is a lot of it.
- **Print styles, container queries and `prefers-contrast` are absent from the codebase** and were
  not evaluated.
- **The counts drift.** Four agents edit this repository concurrently; three of the counts in §1
  changed between the first writing of this document and its re-tally hours later. Re-run the grep.
