# DESIGN-SYSTEM — the system that is actually in the code

**This document records what exists.** It is not a proposal. Every token value, every font size and
every state below was read out of `src/styles/global.css`, `src/styles/a11y.css`,
`src/layouts/Base.astro` and `src/components/*.astro`. Contrast ratios were computed from the real
hex values, not estimated. Where a component is missing a state, that is recorded as a gap, not
quietly filled in.

> **Currency of this document.** It was first written against committed state `9d67c09`. It was then
> re-verified against the **working tree** on 2026-08-12, and the working tree had moved: a
> concurrent accessibility pass (Q-28) rewrote three tokens and added a second stylesheet, and a
> concurrent feature added a route. Everything below reflects the working tree, with the superseded
> values kept where they explain why a token has the value it does. **Nothing here has been
> re-verified against any later commit** — re-read `global.css` and `a11y.css` before trusting a
> hex value in a token table.

The system is **two stylesheets** — `src/styles/global.css` (454 lines) and `src/styles/a11y.css`
(73 lines, additive utilities only, imported by `Base.astro` immediately after `global.css`) — plus
per-page `<style>` blocks and three `<style is:global>` blocks (`DataTable`, `StatCard`, and the
nav/footer in `Base.astro`). There is no CSS framework, no design-token build step, no component
library. Astro 5 SSR, no client framework, zero UI dependencies.

---

## 1. Institutional intent

The stated objective is that this reads as **a national federation, not a local dojo**. These are
the specific choices in the code that carry it.

| Choice | Where | Why it reads institutional |
|---|---|---|
| **Warm paper ground, not a dark "martial arts" theme** | `--bg: #F6F4EF` | Registers, gazettes and government portals are printed on paper. The original theme was dark; the header comment in `global.css` records the deliberate switch to a "light institutional theme". |
| **Dark bands top and bottom, light body** | `.page-hero.has-img` uses `#14120F`; `footer` uses `#14120F` with `border-top: 3px solid var(--red)` | The federation convention: a dark masthead and a dark colophon around a white document. |
| **Deep crimson, not bright red** | `--red: #8E1212` | 9.35:1 on white. A heraldic crimson rather than a sports-brand red. |
| **Antique gold as the accent, never as a fill** | `--gold-2: #86671A`; `.btn-gold` is transparent with a gold border | Gold is used for rules, borders and eyebrows — a seal, not a highlight. |
| **Condensed display face for authority, serif italic for the human note** | `Oswald` for every heading, button, label and table header; `Cormorant Garamond` italic only inside `.display-1 em` / `.display-2 em` | The condensed face is the register; the italic serif is the single moment of voice. |
| **2px radius** | `--radius: 2px` | Effectively square. Rounded cards read consumer-app; near-square reads document. |
| **Letterspaced small caps everywhere** | `letter-spacing: 0.16em–0.38em` on `.eyebrow`, `.btn`, `.pill`, `.input-label`, `th` | The visual grammar of an official form. |
| **Provenance is a component, not a footnote** | `StatCard` renders a `<details>` "How this was counted"; `DataTable` renders "How these rows were selected" — both print the real table, column and filter | **The strongest institutional move in the system.** A figure that can name the query behind it is a federation record; a figure that cannot is marketing. |
| **A measured zero is rendered at full contrast** | `StatCard`: "`value = 0` … Rendered as a full-contrast `0`, never dimmed away and never hidden" | An empty federation shows zeros. Hiding them would be the lie. |
| **"No records" is not "not yours to see" is not "could not be read"** | `DataTable` has separate `empty` / `denied` / `error` states with distinct wording and distinct chrome | Three different institutional facts, never collapsed into one blank table. |
| **Exactly one `<h1>` on each of the 42 rendered routes** | measured 2026-08-12 — see `RESPONSIVE-DESIGN.md §6` | Document structure, not decoration. |

### Where the site still fails the institutional intent

These are findings. Another agent owns the page files this run; nothing here was fixed.

1. **Twelve page files are illustrated with anonymous stock photography.** **14**
   `images.unsplash.com` URLs (counted `grep -rho`; `/` alone carries three) across `/`, `/about`,
   `/academy`, `/affiliation`, `/belt-system`, `/events`, `/facilities`, `/governance`,
   `/programs`, `/registration`, `/schedule` and `/shop`. **Four** photograph IDs are reused:
   `photo-1591117207239` appears three times (`/`, `/academy`, `/programs`);
   `photo-1564415315949` on `/about` and **`/governance`**; `photo-1555597673` on `/` and
   `/registration`; `photo-1552072092` on `/` and `/events`. A national federation whose
   governance page is illustrated by a stock photograph of an unidentified karateka — recycled from
   its own About page — is asserting nothing about itself. `/press` is the counter-example and the
   proof it can be done: real scanned clippings, self-hosted, each with a `verified` line.
2. **The federation's own name renders at 8.00px.** `.nav-name-2` is `font-size: 0.5rem` with
   `letter-spacing: 0.16em`, uppercase — "Modern Martial Arts Karate-Do Federation of India" set at
   8px on every page. It is the identity line of the institution and it is below any legibility
   floor.
3. **~~`--muted` fails WCAG AA~~ — RESOLVED in the working tree, untested.** This was true at
   `9d67c09`: `--muted` was `#857E71` (4.02:1 on `--card`, 3.66:1 on `--bg`, 3.47:1 on `--card-2`)
   on 9.28px–12.80px text in ~200 places. The Q-28 pass changed it to `#706A5F`
   (**5.36 / 4.88 / 4.63:1** — recomputed here, clears AA on all three surfaces) and `--gold` from
   `#A07C1E` (3.89:1) to `#86671A` (**5.29 / 4.81 / 4.57:1**). **What remains is that nothing
   guards it**: there is no contrast test in `tests/`, so the next token edit can reintroduce the
   failure silently. See DS-16.
4. **~~No skip link~~ — RESOLVED in the working tree, untested.** `a11y.css` defines `.skip-link`
   and `Base.astro:112` renders `<a class="skip-link" href="#main-content">Skip to content</a>` as
   the first focusable element, with `<main id="main-content" tabindex="-1">`. Confirmed present in
   the served HTML. **No test asserts it**, and `a11y.css` cites `docs/ACCESSIBILITY.md`, which does
   not exist in the repository. See DS-16.
5. **`html { scroll-behavior: smooth }` is not gated by `prefers-reduced-motion`.** The
   reduced-motion block in `global.css` covers `.fade` only. In-page anchors — which is how
   `/governance#documents`, `/registration#verify` and `/contact#enroll` are reached from the
   footer — animate regardless.
6. **`Crest`'s `showLabel` branch is dead and would fail contrast if used.** No page passes
   `showLabel`; the label colour is hard-coded `#BF900A`, which is **2.91:1** on the white nav.
7. **The crest is a JPEG.** `/logo.jpg`, `object-fit: contain`, with a `drop-shadow` filter tuned for
   a dark background (`rgba(0,0,0,0.4)`) but rendered on white. `Base.astro` already carries a
   comment recording that the opaque JPEG "painted a visible grey square over the footer links" when
   used as a watermark. A federation crest should be an SVG.
8. **Webfonts load by `@import` from `fonts.googleapis.com`.** Line 10 of `global.css`: a
   render-blocking third-party request at the top of the only stylesheet, making the federation's
   typography dependent on Google's availability. It is permitted by the CSP
   (`style-src … https://fonts.googleapis.com; font-src … https://fonts.gstatic.com`), so it works —
   but there is no local fallback beyond the generic `sans-serif`.

---

## 2. Tokens — the real values

All from `:root` in `src/styles/global.css`. Contrast figures are computed (WCAG 2.x relative
luminance) against the surface the token is actually used on.

### Ground and surfaces

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#F6F4EF` | page ground ("warm paper"), mobile nav drawer, scrollbar track |
| `--bg-2` | `#FFFFFF` | `.page-hero` without a photo, `.cta-section`, `.admin-side` |
| `--card` | `#FFFFFF` | `.card`, `.stat`, `.q-item`, `.dt-scroll`, table body |
| `--card-2` | `#F1EEE7` | `.card-icon`, **table header row**, `.stat-void`, `.dt-denied`, `.dt-loading`, `.q-note` |
| `--border` | `#E6E2D8` | every default 1px border and every table row rule |
| `--border-2` | `#D5D0C3` | hover borders, scrollbar thumb, `.notif` border. 1.54:1 on white — decorative edges only |
| `--control-border` | `#8C867A` | **`.input` border only.** Added by Q-28: a text input has no other visible boundary, so its border carries information and must reach 3:1. Measured **3.62:1 on `--card`, 3.29:1 on `--bg`, 3.12:1 on `--card-2`** |

### Colour

| Token | Value | Contrast on `--card` | Used for |
|---|---|---|---|
| `--red` | `#8E1212` | 9.35:1 | `.btn-primary` background, `.rule`, `.stat-attention` left border, footer top border, `::selection` |
| `--red-2` | `#A61616` | 7.64:1 | `.btn-primary:hover`, `.text-red`, `.q-flag`, `.q-err` text |
| `--red-3` | `#E5CFCB` | border only | `.dt-error` border, `.q-flag` border, `.q-count.is-odd` border |
| `--red-glow` | `rgba(142,18,18,0.16)` | — | `.btn-primary:hover` shadow |
| `--gold` | `#86671A` | 5.29:1 (bg 4.81 · card-2 4.57) | `.q-count-n`, `.input:focus` border, `.notif` left border. **Was `#A07C1E` (3.89:1) until Q-28** |
| `--gold-2` | `#86671A` | 5.29:1 (bg 4.81 · card-2 4.57) | `.eyebrow`, `.text-gold`, active nav link, `:focus-visible` outline, all link hovers. **Now identical to `--gold`** — Q-28 records that on this paper ground exactly one gold clears 4.5:1, so both tokens hold it |
| `--gold-3` | `#6B5213` | 7.39:1 | `.btn-gold:hover` text, inline `<code>` in admin panels, `.q-ok` text |
| `--gold-dim` | `rgba(160,124,30,0.45)` | — | `.eyebrow::before` rule, `.btn-gold` border, `.rule.gold`, `.dt-denied` left border |

### Text

| Token | Value | Contrast | Used for |
|---|---|---|---|
| `--white` | `#1A1713` (ink) | 17.86:1 on card | body text, all headings, `.card-title`, `.stat-value`, `<dd>` values |
| `--off-white` | `#4C463C` | 9.34:1 on card | `.lead`, `.body-txt`, `.card-body`, table cells, nav links, all state paragraphs |
| `--muted` | `#706A5F` | **5.36:1 card · 4.88:1 bg · 4.63:1 card-2** | labels, eyebrows, table headers, help text, placeholders — 202 `var(--muted)` usages. **Was `#857E71` (4.02 / 3.66 / 3.47:1) until Q-28**; see finding 3 |
| `--muted-2` | `#C4BDAE` | **1.87:1 card · 1.70:1 bg · 1.61:1 card-2** | marked "decorative only — never text" in `:root`. One use as a glyph: `.stat-void .stat-value`, the em dash of an unproduced figure. It is `aria-hidden` with a full-contrast reason below it, so no information is lost, but a visible glyph at 1.61:1 is still there |

The semantic names are inherited from the superseded dark theme and are now **misleading**:
`--white` is the darkest ink in the system and `--off-white` is the second-darkest. The header
comment in `global.css` says so explicitly. Renaming is a mechanical change across 454 lines of
global CSS plus every page block; it has not been done.

### Type, shape, depth

| Token | Value |
|---|---|
| `--font-display` | `'Oswald', sans-serif` — every heading, button, label, table header, eyebrow, pill, stat |
| `--font-accent` | `'Cormorant Garamond', serif` — italic emphasis inside `.display-1 em` / `.display-2 em`, and `.italic` |
| `--font-body` | `'Inter', system-ui, -apple-system, sans-serif` — prose and inputs |
| `--radius` | `2px` |
| `--max-w` | `1180px` |
| `--shadow-1` | `0 1px 3px rgba(26,23,19,0.05)` — resting `.card` / `.stat` |
| `--shadow-2` | `0 8px 28px rgba(26,23,19,0.09)` — `.card.hoverable:hover` only |

Monospace is **not** tokenised. Every `<code>` block re-declares
`ui-monospace, SFMono-Regular, Menlo, monospace` inline — five separate declarations across
`DataTable`, `StatCard`, `QueuePanel` and two admin pages.

There is **no dark theme**. `meta name="theme-color"` is `#FFFFFF` and there is no
`prefers-color-scheme` block anywhere. That is a deliberate single-look commitment, not an
omission — but it means the dark bands (`.page-hero.has-img`, `footer`) must hard-code their own
light text values, which is exactly the defect P0-4 recorded: the footer inherited the ink tokens
onto a `#14120F` band and rendered every footer link at 2.00:1. The current explicit values
(`#D8D2C6` 12.42:1, `#D9BC66` 10.09:1, `#A9A296` 7.39:1) are guarded by a test in
`tests/layout-guards.test.ts`.

---

## 3. Type scale — measured, in px

`html` has no `font-size`, so `1rem = 16px`. `body` is `15.5px / 1.65`, which governs unclassed
prose only. Everything below is a real rendered size.

| px | rem | Where |
|---:|---|---|
| **8.00** | 0.5 | `.nav-name-2` — the federation's full name (finding 2) |
| 9.28 | 0.58 | `.pill`, `.stat-src dt`, `.dt-src dt` |
| 9.60 | 0.6 | `.card-eyebrow`, **`.dt-table th`**, `.dt-src summary`, `.stat-src summary`, `.tbl-hint` |
| 9.92 | 0.62 | `.input-label`, `.stat-label` |
| 10.24 | 0.64 | `.q-state-l`, `.q-h-why span` |
| 10.56 | 0.66 | `.eyebrow` |
| 10.88 | 0.68 | `.nav-links a`, `.stat-link` |
| 11.20 | 0.7 | `.ft-h` |
| 11.52 | 0.72 | `.btn`, `.btn-link` |
| 11.84 | 0.74 | `.stat-of`, `.stat-src dd`, `.q-help`, `.q-facts summary` |
| 12.16 | 0.76 | `.stat-note`, `.q-h-who` |
| 12.48 | 0.78 | `.stat-reason`, `.ft-bottom` |
| 12.80 | 0.8 | `.dt-note`, `.q-meta` |
| 13.12 | 0.82 | `.dt-state` |
| 13.60 | 0.85 | `.dt-table td` |
| 13.76 | 0.86 | `.dt-cap`, `.ft-col a` |
| 13.92 | 0.87 | `.notif` |
| 14.40 | 0.9 | `.card-body` |
| 14.72 | 0.92 | `.input` |
| 14.88 | 0.93 | `.body-txt` |
| 15.50 | — | `body` default |
| 16.80 | 1.05 | `.lead` (capped at `62ch`) |
| 17.28 | 1.08 | `.card-title`, `.nav-name-1` |
| 25.60 | 1.6 | `.q-count-n` |
| 33.60 | 2.1 | `.stat-value` |
| 30.4 → 46.4 | `clamp(1.9rem, 4vw, 2.9rem)` | `.display-2` |
| 41.6 → 73.6 | `clamp(2.6rem, 6vw, 4.6rem)` | `.display-1` |

**Observation, not a fix:** eleven distinct sizes live between 9.28px and 12.80px. That band is where
every label, header and help string in the system sits — it is where `--muted` is applied, and it is
why the Q-28 contrast correction mattered. The scale below 13px is not a scale — it is drift.

---

## 4. Spacing, layout, motion

| Rule | Value |
|---|---|
| Container | `max-width: 1180px`, padding `0 28px`, becoming `0 20px` at ≤640px |
| Section rhythm | `108px 0`, becoming `72px 0` at ≤640px; `section + section` gets `border-top: 1px solid var(--border)` |
| Section head | `margin-bottom: 64px` |
| Card padding | `30px` (`.card`), `18px 18px 14px` (`.stat`), `20px` (`.q-item`) |
| Grid gap | `16px` (`.grid`) |
| Margin utilities | only `mt-4/6/8/12` (16/24/32/48px) and `mb-4` — there is no spacing scale, these five are it |
| Nav | `position: fixed`, `min-height: 72px`; `main` gets `padding-top: 88px`, reduced to `76px` at ≥1081px |
| Focus | `:focus-visible { outline: 2px solid var(--gold-2); outline-offset: 2px }` — global, one rule, applies everywhere |
| Reveal | `.fade` becomes `.vis` via `IntersectionObserver` at `threshold: 0.08`; hiding is gated on `html.js-reveal` (set by an inline script) and carries a 4s `fade-failsafe` animation; fully disabled under `prefers-reduced-motion` |

`body { overflow-x: hidden }` is set globally. It **hides** horizontal overflow rather than
preventing it — the 143px overflow recorded as P1-16 was invisible in a screenshot while still
clipping page content. Any width regression on this site is silent by construction. See
`RESPONSIVE-DESIGN.md §5`.

---

## 5. Component inventory

### Shared components — `src/components/`

| Component | What it is for |
|---|---|
| **`DataTable.astro`** | The register table: any list of federation records that must be able to say how its rows were selected. Owns its own horizontal scroll (`.tbl-scroll` inside the component) so the page body never scrolls sideways. Used on `/admin/command` and `/admin/dashboard`. |
| **`StatCard.astro`** | One figure from the register, with the query that produced it attached. Distinguishes a **measured zero** from **no figure produced**. Used on `/admin/command` and `/admin/dashboard`. |
| **`QueuePanel.astro`** | One approval queue as the office works it: status counts, submitted fields, full decision history, and the form that moves the item. Renders no control it cannot honour. Used on `/admin/queue`. |
| **`PageHero.astro`** | The masthead for a dedicated page: eyebrow, `.display-1` title, `.rule`, lead, optional pills, optional photograph. `title` accepts `set:html` for `<em>` emphasis — **page-literal strings only; it is an XSS boundary** (MASTER-SPEC §9.6). The photo variant becomes a dark band with hard-coded light text. |
| **`ListPanel.astro`** | A CMS list editor on `/admin`: an "add new" form plus a client-rendered list with delete. Markup only — all behaviour lives in the page script in `admin/index.astro`. |
| **`EnrollCTA.astro`** | The single conversion action of the marketing site. Posts to `/api/enroll`. Reused on 9 pages. |
| **`Icon.astro`** | 23 stroke SVG icons (`karate-gi`, `kata`, `kumite`, `shield`, `women`, `star`, `medal`, `globe`, `black-belt`, `book`, `school`, `users`, `pin`, `mat`, `target`, `dumbbell`, `water`, `first-aid`, `locker`, `cctv`, `parking`, `clock`, `monitor`). All `aria-hidden`, `currentColor`, `stroke-width: 1.4`. |
| **`Crest.astro`** | The federation crest from `/logo.jpg`. Sized by prop, with real alt text. |

### Global classes — `src/styles/global.css`

| Class | Variants | Notes |
|---|---|---|
| `.btn` | `.btn-primary`, `.btn-gold`, `.btn-ghost`, `.btn-link` | `white-space: nowrap` on desktop; wraps below 620px (regression-tested) |
| `.pill` | `.live`, `.upcoming`, `.featured`, `.pill-dot` | status marker only, no interaction |
| `.card` | `.hoverable`, `.card-eyebrow`, `.card-icon`, `.card-title`, `.card-body` | |
| `.input` | `.input-label`, `select.input option` | border is `--control-border` (3.62:1). Mouse focus: gold border plus a 3px gold ring. Keyboard focus additionally gets `.input:focus-visible { outline: 2px solid var(--gold-2) }` — added by Q-28 because `.input:focus` had removed the site outline for every focus kind |
| `.grid` | `.grid-2`, `.grid-3`, `.grid-4` | collapses 3/4 to 2 at ≤900px, all to 1 at ≤600px |
| `.eyebrow` | `.center` | the `::before` rule is suppressed when centred |
| `.rule` | `.gold`, `.center` | 48×2px crimson |
| `.display-1`, `.display-2` | `em` renders gold italic serif; `.display-2 em.r` renders crimson | |
| `.lead`, `.body-txt` | | `.lead` is capped at `62ch` |
| `.tbl-scroll` | `.tbl-hint` | edge-fade plus a visible touch scrollbar; the hint appears ≤760px |
| `.notif` | `.show` | one global toast, `role="status" aria-live="polite"`, auto-hides after 3500ms |
| `.fade` | `.vis` | JS-gated scroll reveal with failsafe |
| utilities | `.text-gold`, `.text-red`, `.text-muted`, `.italic`, `.uppercase`, `.flex`, `.flex-wrap`, `.gap-3/4/6`, `.items-center`, `.justify-between`, `.justify-center`, `.mt-4/6/8/12`, `.mb-4` | 18 utilities in total |

### `src/styles/a11y.css` — additive utilities (Q-28)

| Class | What it does |
|---|---|
| `.sr-only` | Visually hidden, still in the accessibility tree. Uses `clip-path` with legacy `clip` alongside; deliberately **not** `display: none`. |
| `.skip-link` | The first focusable element on every page (`Base.astro:112`). Positioned off the top of the viewport and slides in on focus — not `display: none`, because a hidden element is not focusable. `z-index: 1000` clears the nav's 100; `min-height: 44px`; its transition is disabled under `prefers-reduced-motion`. |
| `main:focus { outline: none }` | `main` carries `tabindex="-1"` so the skip link can move focus into it; the ring belongs on the control that was operated, not on the whole document. |

### Page-local patterns that recur but are not components

Each of these appears on five or more pages, copied rather than shared:

- **`.admin-wrap` / `.admin-side` / `.admin-main` / `.admin-panel` / `.admin-h` / `.admin-sub`** —
  the admin chrome, redeclared in a `<style>` block in all **nine** admin pages
  (`260px 1fr`, or `280px 1fr` on `/admin/grading`). Nine copies of one shell.
- **The "not configured" state block** — a bordered card with a heading and an explanatory
  paragraph, hand-written on `/athletes`, `/dojos`, `/officials`, `/rankings`, `/competitions`,
  `/scoreboard`, `/live`, `/checkout`, `/my`, `/my/passport`, `/my/courses`, `/athlete/[id]` and all
  nine admin pages. Twenty-one implementations of one state. The wording is consistently good (see
  `CONTENT-ARCHITECTURE.md §5`); the markup is not shared.
- **Definition lists** — `.a-dl`, `.c-dl`, `.g-dl`, `.q-facts dl`, `.dt-src dl`, `.stat-src dl`,
  `.rk-meta-row`, `.dir-meta-row`, `.rk-def`: nine label/value grid implementations.
- **Wide tables** — `.up-tbl`, `.c-tbl`, `.g-table`, `.cp-tbl`, `.pp-tbl`, `.rk-tbl`,
  `.schedule-tbl`, `.lesson-tbl`, `.branch-wrap`, `.syllabus-wrap`, `.arch-wrap`, `.doc-wrap`,
  `.ob-wrap`. Only `DataTable` is a component; the other thirteen are per-page.

---

## 6. The state matrix

Every component that shows federation data must be able to say which of six things is true.
`Y` = implemented; `n/a` = not applicable; **`NO`** = the state can occur and is not handled.

| Component | default | loading | empty | error | permission-denied | disabled |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **DataTable** | Y rows | Y `aria-busy`, skeleton rows, `role="status"` | Y `emptyMessage`, default "No records." | Y `role="alert"`, module's own message | Y named as a boundary, not disguised as absence | n/a |
| **StatCard** | Y incl. full-contrast measured `0` | **NO** | Y — `0` is the empty state and is correct | **NO** folded into `unavailable` | **NO** folded into `unavailable` | n/a |
| **QueuePanel** | Y | **NO** (SSR only) | Y "Nothing is awaiting a decision in this queue." | Y per-form `.q-err` with `role="alert"` | Y full `.q-forbidden` block naming the required rbac action | Y `fieldset:disabled .q-submit` |
| **ListPanel** | Y | **NO** | **NO** renders an empty `<div>` | **NO** transient toast only | **NO** | Y button disabled during POST |
| **EnrollCTA** | Y | Y button becomes "Booking…" and is disabled | n/a | **NO** transient toast only | n/a | Y during submit |
| **PageHero** | Y | n/a | n/a | n/a | n/a | n/a |
| **Icon** | Y | n/a | n/a | **NO** unknown name renders nothing, silently | n/a | n/a |
| **Crest** | Y | n/a | n/a | **NO** no broken-image fallback | n/a | n/a |

### The gaps, stated precisely

- **`StatCard` collapses three different facts into one.** `unavailable` is the only non-numeric
  path, so "you may not see this figure", "the query failed" and "this figure cannot be narrowed to
  your scope" all render identically as an em dash plus prose. `DataTable` — same author, same
  dashboard — keeps `denied` and `error` apart deliberately. The card does not. On
  `/admin/dashboard` and `/admin/command` a stat and a table sitting side by side therefore report
  the same underlying condition with different fidelity. The card **does** guard the worst case: a
  `null` with no reason prints "This figure was not produced, and no reason was recorded. Report
  this — the dashboard should never show an unexplained blank."
- **`StatCard` has no loading state at all.** It is server-rendered, so today that is consistent.
  But `DataTable` ships a `loading` state for "a live probe that has not answered yet", and the
  `/scoreboard` polling pattern is exactly that. A stat that goes live will have nowhere to say it
  is waiting.
- **`ListPanel` is the weakest component in the system, and it is the one the federation office
  actually uses.** In `admin/index.astro`'s script, `render()` sets
  `listEl.innerHTML = rows.map(...).join('')`, so an empty list produces an **empty div** —
  indistinguishable from a list that failed to load. There is no loading state (rows come from an
  inlined `data` object). Every failure path is `toast('Add failed')` / `toast('Delete failed')` /
  `toast('Save failed')` — no reason, no status code — and the toast **auto-dismisses after
  3500ms**, so an admin who looked away learns nothing. It has no permission-denied state because
  `/admin` is gated by a single shared password rather than by `can()`.
- **`Icon` fails silently.** The component is a flat chain of `{name === 'x' && (...)}` with no
  fallback branch. A typo in an icon name renders nothing at all — no box, no warning, no build
  error. `seed.ts` stores icon names as editable CMS data (`{ icon: 'kata', … }`), which means a
  federation administrator can type an icon name into the admin panel and get a silently empty tile.
- **There is no global disabled treatment.** `global.css` contains no `:disabled` or `[disabled]`
  rule at all. A `.btn-primary` disabled by JS keeps its full crimson and its `cursor: pointer`.
  Only `QueuePanel` styles a disabled control (`fieldset:disabled .q-submit { opacity: .55 }`), and
  it does so locally.
- **There is no global error / success / warning message class.** Each surface re-invents one:
  `.dt-error`, `.dt-denied`, `.q-err`, `.q-ok`, `.q-forbidden`, `.q-note`, `.stat-reason`, plus the
  21 hand-written "not configured" blocks. The *chrome* is consistent by convention — a `--card-2`
  panel with a 3px left border, gold-dim for a caveat and crimson for a failure — but nothing
  enforces it.
- **`DataTable`'s scroll container is not keyboard-reachable.** `.dt-scroll` has no `tabindex="0"`
  and no `role="region"`, so a keyboard-only user cannot scroll a table wider than the viewport.
  `/rankings` gets this right by hand — `<div class="tbl-scroll" tabindex="0" role="region"
  aria-label="…">` in three places — which proves the pattern is known and simply did not reach the
  component.
- **`/unit` and `/admin` never got the `.tbl-scroll` affordance.** P1-14 added the edge-fade, the
  visible touch scrollbar and the `.tbl-hint` to "all 7 tables". Seven tables were missed: four on
  `/unit` (`min-width: 640px`) and three on `/admin` (`min-width: 760px / 780px / 820px`), all still
  on a bare `<div style="overflow-x:auto">`. On a phone those tables scroll with no cue that they
  scroll.

---

## 7. What is regression-tested

`tests/layout-guards.test.ts` asserts against the CSS source, so a rule cannot be deleted silently:

- `.btn` labels wrap below 620px (the P1-16 143px overflow)
- coarse-pointer targets are at least 44px, and `.nav-hamburger` is at least 44×44
- the nav grows with its content instead of clipping the wordmark (P1-13)
- scroll-reveal hiding is JS-gated and has a failsafe (P1-15)
- the footer uses explicit light values, not the ink tokens (P0-4)

Nothing else in the design system is tested. **There is no contrast test, no token test, no overflow
test, no skip-link test, and no test that any component handles any state.** That matters more now
than it did: the Q-28 pass fixed the two serious accessibility defects (`--muted`, the skip link) by
editing values that nothing asserts on, so both can regress silently on the next token edit. It is
recorded as DS-16.

---

## 8. Findings — design system

| # | Severity | Finding | Where |
|---|---|---|---|
| DS-1 | ~~Serious~~ **RESOLVED (working tree, untested)** | `--muted` was `#857E71` — 4.02 / 3.66 / 3.47:1, below AA on every surface, on 9.28–12.80px text in ~200 places. Q-28 changed it to `#706A5F` (**5.36 / 4.88 / 4.63:1**) and `--gold` from `#A07C1E` to `#86671A` (**5.29 / 4.81 / 4.57:1**). Recomputed and confirmed here. Nothing guards it — see DS-16. | `global.css` `:root`, 202 usages |
| DS-2 | **Serious** | `ListPanel`, the only CMS editing surface the federation office has, has no empty, loading, error or denied state; every failure is a 3.5-second toast with no reason. | `ListPanel.astro`, `admin/index.astro` |
| DS-3 | ~~Serious~~ **RESOLVED (working tree, untested)** | Q-28 added `.skip-link` in `a11y.css` and `Base.astro:112` renders it as the first focusable element, targeting `<main id="main-content" tabindex="-1">`. Confirmed in served HTML. Nothing guards it — see DS-16. | `Base.astro`, `a11y.css` |
| DS-4 | Moderate | `StatCard` collapses `error`, `denied` and out-of-scope into a single `unavailable` string, while `DataTable` on the same dashboard keeps them apart. | `StatCard.astro` |
| DS-5 | Moderate | `Icon` renders nothing for an unknown name — and icon names are admin-editable CMS data. | `Icon.astro`, `seed.ts` |
| DS-6 | Moderate | `DataTable`'s `.dt-scroll` is not keyboard-scrollable (no `tabindex` / `role="region"`), although `/rankings` implements exactly that by hand. | `DataTable.astro` |
| DS-7 | Moderate | Seven wide tables on `/unit` and `/admin` never received the `.tbl-scroll` affordance from P1-14. | `unit.astro`, `admin/index.astro` |
| DS-8 | Moderate | The federation's own name is set at 8.00px in the nav. | `Base.astro` `.nav-name-2` |
| DS-9 | Moderate | Twelve page files use stock photography (**14** `images.unsplash.com` URLs). **Four** photo IDs are reused; `photo-1591117207239` appears three times, and `/governance` shares its image with `/about`. | 12 page files under `src/pages` |
| DS-10 | Minor | No global `:disabled` style; a disabled `.btn-primary` looks identical to an enabled one. | `global.css` |
| DS-11 | Minor | `scroll-behavior: smooth` is not gated by `prefers-reduced-motion`. | `global.css` |
| DS-12 | Minor | `--muted-2` renders `.stat-void .stat-value` at 1.61:1 (mitigated: `aria-hidden`, with a full-contrast reason beneath). | `StatCard.astro` |
| DS-13 | Minor | `Crest`'s `showLabel` branch is unused and hard-codes `#BF900A` at 2.91:1 on the nav; the crest itself is an opaque JPEG with a drop-shadow tuned for a dark ground. | `Crest.astro` |
| DS-14 | Minor | Token names are inverted relics of the dark theme — `--white` is the darkest ink. | `global.css` |
| DS-15 | Minor | Nine copies of the admin shell CSS; 13 non-component table implementations; nine definition-list implementations; 21 hand-written "not configured" blocks. | admin pages, public pages |
| DS-16 | **Serious** | **The two accessibility fixes are unguarded and undocumented.** `tests/layout-guards.test.ts` (6 tests, run and passing) asserts the footer colours, `.btn` wrap, touch targets and nav height — it asserts **nothing** about `--muted`, `--gold`, `--control-border` or `.skip-link`, so any of them can be reverted without a test failing. Separately, `a11y.css` states that its findings "are recorded in `docs/ACCESSIBILITY.md`" and **that file does not exist in the repository**. | `tests/layout-guards.test.ts`, `src/styles/a11y.css` |

---

## 9. What this document does NOT cover

Stated plainly, because a document that lists only what it establishes is a liability.

- **No rendered measurement of anything.** Contrast is computed from hex values in `:root` against
  the surface each token is *declared* to sit on. Nothing was sampled from a rendered pixel, so a
  token composited over a photograph, a gradient, or an unexpected parent background is **not**
  covered — `.page-hero.has-img` and `footer` in particular put text on `#14120F` and are checked
  only against their own hard-coded values.
- **No accessibility audit.** This is a design-system inventory, not a WCAG conformance report.
  Contrast (1.4.3) and the presence of a skip link (2.4.1) are the only success criteria touched.
  Focus order, ARIA correctness, form labelling, heading hierarchy below `<h1>`, colour as the sole
  carrier of meaning, target size, and screen-reader behaviour were **not** examined at all.
- **No component testing.** The state matrix in §6 was built by reading each component's source. No
  component was driven into its loading, error or denied state and observed.
- **Per-page `<style>` blocks are only sampled.** The recurring patterns in §5 were found by
  grepping for known class prefixes. There is no complete inventory of page-local CSS, so the
  duplication counts are lower bounds.
- **The type scale is computed, not measured.** Sizes are `rem` × 16. Any page block that resets
  `font-size` on an ancestor would change the rendered result and is not accounted for.
- **Dark-mode, print and forced-colours are not covered** because the system does not implement
  them. `prefers-contrast` and Windows High Contrast were not tested.
- **The findings marked RESOLVED are resolved in an uncommitted working tree.** They were verified
  against the running dev server on 2026-08-12 and against `src/styles/*.css` as it stands on disk.
  If that work is not committed, the defects return and this document becomes wrong.
