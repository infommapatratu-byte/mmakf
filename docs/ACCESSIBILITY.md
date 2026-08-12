# ACCESSIBILITY — WCAG 2.2 AA audit

**Audit Q-28. Conducted 2026-08-12 against branch `wave-2b-federation`.**

This is the record of one audit: what was tested, how it was tested, what was found, what was
fixed, and — the section that matters most — **what is not covered**. Section 6 is not a footnote.
A reader who takes this document as a clean bill of health has misread it.

---

## 1. What was tested, and how

### 1.1 Every surface, rendered

The forty-four routes listed below were started with `npx astro dev` and **fetched over HTTP**,
then read as HTML. Forty-three return 200; `/404` returns 404 by design. Nothing was audited from a screenshot or from the source alone where the rendered form was
reachable.

Two things were done first so the audit saw the real screens rather than their degraded states:

- a **real Postgres** (`npm run dev:db`, PGlite over the wire protocol) was started and all four
  migrations applied, so `/api/health` reported `{"database":"ok"}`. Without it, half the admin
  console and the whole member area render only their "not configured on this deployment" panel;
- an **admin session and a personal SUPER_ADMIN account** were created (`npm run user:create`) and
  both cookies sent on every request, so the gated consoles rendered their actual markup.

| | Surfaces |
|---|---|
| Public | `/` `/about` `/academy` `/affiliation` `/application` `/athletes` `/belt-system` `/calendar` `/checkout` `/competitions` `/contact` `/dojos` `/events` `/facilities` `/faq` `/gallery` `/governance` `/live` `/officials` `/press` `/programs` `/rankings` `/registration` `/regulations` `/schedule` `/scoreboard` `/search` `/shop` `/unit` `/verify` `/404` |
| Member | `/my` `/my/passport` `/my/courses` |
| Admin | `/admin` `/admin/command` `/admin/dashboard` `/admin/grading` `/admin/competition` `/admin/governance` `/admin/approvals` `/admin/cases` `/admin/queue` `/admin/report` |

### 1.2 A real browser

**Chrome 151 headless, driven over the DevTools Protocol** — no new dependency was added to the
project; the driver scripts live outside the repository. This is how the layout and colour findings
were obtained, and it is why they are measurements rather than opinions:

| Measured | Method |
|---|---|
| **1.4.10** horizontal scroll at 320px | `Emulation.setDeviceMetricsOverride` to 320×900, then `documentElement.scrollWidth` **with `body{overflow-x:hidden}` temporarily lifted**. The site sets that rule globally, which *clips* overflow instead of reporting it — measuring without lifting it would have returned a clean 320 on every page and found nothing. |
| **1.4.3** text contrast | `getComputedStyle` on every element with its own text node: its `color`, and its effective background composited by walking ancestors through transparent layers. Compared against 4.5:1, or 3:1 where the computed `font-size`/`font-weight` made the text large. |
| **2.4.3 / 2.4.7** focus | Real `Tab` keypresses via `Input.dispatchKeyEvent`, recording `document.activeElement`, its computed `outline`/`box-shadow`, its box and its position, at 1280px and at 375px. |
| **2.5.8** target size | `getBoundingClientRect` on every `a[href]`, `button`, `input`, `select`, `textarea`, `summary` and `[tabindex]`. |
| **2.4.11** focus not obscured | Navigated to each in-page fragment link and measured the target's `top` against the fixed nav's `bottom`. |
| **2.4.1** skip link | Tab once, wait for the transition, read the box; press Enter; read where focus landed; Tab again and assert the next stop is inside `#main-content`. |

### 1.3 Static scanning

The rendered HTML of all 43 surfaces was scanned for `img` without `alt`, `svg` with no `aria-hidden`
or accessible name, controls without an accessible name, fields without an associated label, tables
without `th`/`scope`, heading-level skips, duplicate `id`s, positive `tabindex`, and missing skip
links. The same checks were then re-implemented against the **source** in
`tests/accessibility.test.ts` — see §4 for why the tests read the source and the audit read the HTML.

### 1.4 Contrast arithmetic

Every ratio in this document was computed from the WCAG 2.x relative-luminance formula, either from
the hex values declared in `src/styles/global.css` or from the `rgb()` values Chrome reported. None
was eyeballed. The arithmetic is checked against the two ratios WCAG states outright — black on
white is 21:1, a colour against itself is 1:1 — in `tests/accessibility.test.ts`.

---

## 2. Findings — fixed

Twenty-two defects. Each is stated with what was measured, not what was suspected.

### 1.4.3 Contrast (Minimum) — AA

| # | Finding | Measured | Fix |
|---|---|---|---|
| A1 | **`--muted: #857E71` fails on every surface it is used on.** It carries roughly 200 pieces of real text: every table header, every `.input-label`, every placeholder, every empty-state line, and most of the scoreboard's secondary type. | 4.02:1 on `--card`, 3.66:1 on `--bg`, **3.47:1 on `--card-2`** (which is what table headers sit on) | `--muted: #706A5F` — 5.36 / 4.88 / 4.63:1 |
| A2 | **`--gold: #A07C1E` fails as text**, and it is used as text in 86 rules — page eyebrows, card kickers, the admin brand line, hero card headers. | 3.89:1 on `--card`, 3.54:1 on `--bg` | `--gold: #86671A` — 5.29 / 4.81 / 4.57:1. On this paper ground there is exactly one gold that clears 4.5:1, so `--gold` and `--gold-2` now hold the same value; `--gold-3` remains the darker hover tone and `--gold-dim` stays decorative. |
| A3 | **`--muted-2: #C4BDAE` was promoted to a text colour** in five rules: the "no figure" value in `StatCard`, the two card arrows on `/`, and the search placeholder and result kicker on `/search`. | **1.87:1** on `--card` | switched to `--muted`; the token is now documented as decorative and a test forbids it as text |
| A4 | **`--red-3: #E5CFCB` painted the large ordinal numerals** ("01", "02", "03") on `/`, `/about`, `/academy`, `/affiliation` and `/belt-system`. Measured in Chrome on five surfaces. | **1.49:1** on `--card` — against a 3:1 large-text threshold, and 4.5:1 for the 21.7px `.kun-num` | new `--numeral: #95564F` — 5.64 / 5.13 / 4.87:1. `--red-3` stays as the hairline for error borders and pills, where 1.4.11 does not apply to it. |
| A5 | `/shop` `.prod-badge` is black text on `var(--gold)`. It passed at 5.40:1 against the old gold; darkening the gold for A2 would have dropped it. | 3.97:1 against the new gold | badge text is white — 5.29:1 |

The dark bands (footer, photo heroes, homepage ticker) were checked separately because they use
literal light values rather than the ink tokens: 12.42:1, 10.09:1, 7.39:1, 11.35:1, 5.32:1. All pass.

**One false positive, resolved by hand.** The homepage gallery-strip captions were reported at 1.06:1
and 1.60:1 because the effective background is a `linear-gradient` over a photograph, and a computed
`background-color` walk cannot see either. Worst case — the gradient's `rgba(16,14,11,0.85)` over a
pure white photograph — the ground is `rgb(52,50,48)`, giving **6.89:1** and **11.62:1**. No defect.

### 1.4.11 Non-text Contrast — AA

| # | Finding | Measured | Fix |
|---|---|---|---|
| B1 | **A text input's border was `--border-2`.** A card edge at that contrast is decoration; a text field has no other visible boundary, so its border *is* the information that identifies the control. | 1.54:1 on white, 1.40:1 on `--bg` | new `--control-border: #8C867A` — 3.62:1 / 3.29:1 — applied to `.input` |

`.btn-ghost` and `.btn-gold` also draw faint borders (1.40:1 and 1.67:1). They are **not** recorded
as failures: each carries a visible text label that identifies it, so the border is not required
information. This is a judgement, and it is written down here so it can be disagreed with.

### 2.4.1 Bypass Blocks — A

| # | Finding | Fix |
|---|---|---|
| C1 | **No skip link on any of the 43 surfaces.** Every page repeats a nav of nine links plus a wordmark before the content. | `.skip-link` in `src/styles/a11y.css`, rendered as the first element in `<body>` by `Base.astro`, targeting `<main id="main-content" tabindex="-1">`. **Verified by keyboard in Chrome:** one Tab focuses it and it slides to `top: 0` (44px tall); Enter moves focus to `MAIN#main-content`; the next Tab lands inside `#main-content`, past the whole nav. |

### 2.4.7 Focus Visible / 2.4.3 Focus Order — A

| # | Finding | Measured | Fix |
|---|---|---|---|
| D1 | **The collapsed mobile menu kept all ten of its links in the tab order.** `.nav-links` was hidden with `transform: translateY(-120%)` only, which moves an element but does not remove it from the tab sequence. | At 375px, ten links took focus at `y = -632` … `-115` — entirely off-screen, each painting a focus ring nobody can see — and the hamburger that opens them came *after* them, while `aria-expanded="false"` claimed the menu was closed | `visibility: hidden` on the closed panel, `visible` when open, with the visibility transition delayed by the length of the slide so the closing animation still plays. Re-measured at 375px: brand → hamburger → page content. Desktop unchanged. |
| D2 | **`.input:focus { outline: none }` removed the outline for keyboard focus too**, leaving a 1px border tint and a 0.12-alpha ring as the only indication. | — | added `.input:focus-visible { outline: 2px solid var(--gold-2) }` after it. Mouse focus is unchanged. |

Everything else focuses visibly: every stop in every tab walk reported
`outline = solid 2px rgb(134, 103, 26)`, which is 4.81:1 against `--bg`. `src/styles/global.css` is
the only file in the project that suppresses an outline, and it now declares a replacement.

### 2.1.2 No Keyboard Trap — A

| # | Finding | Fix |
|---|---|---|
| E1 | The mobile menu could be opened from the keyboard but not dismissed from it. | Escape closes it and returns focus to the hamburger. (The press-clipping lightbox uses `<dialog>.showModal()`, which already handles Escape natively — checked, not assumed.) |

### 2.4.11 Focus Not Obscured (Minimum) — AA, new in WCAG 2.2

| # | Finding | Measured | Fix |
|---|---|---|---|
| F1 | **`nav#mainNav` is `position: fixed` and no scroll padding was reserved for it.** Every in-page fragment link, and the browser's own scroll-into-view on Tab, aligns the target to the very top of the viewport — underneath the bar. | `/governance#documents` landed its target at `top: 0` with the nav's bottom edge at 73px: **73px of the target covered**. Same on `/registration#verify`, `/events#results`, `/contact#enroll`. | `html { scroll-padding-top: 96px }` (88px above 1080px). Re-measured: target at `top: 88`, covered by **0**. |

### 1.3.1 Info and Relationships — A

| # | Finding | Fix |
|---|---|---|
| G1 | **129 admin controls had no accessible name.** `ListPanel.astro` and the Federation Profile form on `/admin` rendered `<label class="input-label">Full name</label><input name="name">` — a label pointing at nothing. Clicking the label did not focus the field either. | `for`/`id` on all of them. The ids are scoped by panel (`${id}-${f.n}`) because one admin page renders about twenty panels and several share a field name. |
| G2 | **Ten surfaces nested a second `<main>` inside the layout's.** `Base.astro` already wraps the slot in `<main>`; each admin console and the scoreboard added `<main class="admin-main">` / `<main class="sb">` inside it. | inner element is a `<div>`; the layout's `<main>` is the only landmark. |
| G3 | **`/admin` had no `<h1>`** — its highest heading was `h2`. | a visually hidden `<h1>` naming the screen, plus `aria-label` on the sidebar nav. |
| G4 | **The six lesson tables on `/academy` had no header row at all.** Scanning the fourth column, "Free" and "Members library" mean nothing without the word "Access". | a real `<thead>` with `scope="col"`, styled to the site's existing table-header convention, plus a `sr-only` caption naming the course. |
| G5 | **123 `<th>` across twelve files had no `scope`** — `/affiliation`, `/belt-system`, `/events`, `/governance`, `/schedule`, `/competitions`, `/unit`, `/my`, `/my/passport`, `/admin`, `/admin/grading`, `/admin/competition`. Most were invisible to the rendered scan because their branch had no rows to draw; the source scan found them. | `scope="col"` throughout. Empty action-column headers got an `sr-only` name. |
| G6 | Eight public tables had no caption. | `sr-only` captions drawn from the section wording already on the page. Nothing was invented. |

`src/components/DataTable.astro` needed no change: it already carried `scope="col"`, a caption,
`aria-busy` while loading, and a `role="alert"` error state. It is the model the hand-rolled tables
should have followed.

### 1.4.10 Reflow — AA

| # | Finding | Measured at 320px | Fix |
|---|---|---|---|
| H1 | **The admin console scrolled sideways.** `.admin-wrap` is a grid; a grid item defaults to `min-width: auto`, so it cannot shrink below its content and the single-column mobile layout stayed as wide as its widest child. `dashboard` and `command` set `min-width: 0` and did not overflow; the other seven did not and did. | `/admin/approvals` **461px**, `/admin` **364px** | `.admin-wrap > * { min-width: 0 }` in all nine |
| H2 | `/admin`'s record list overflowed by a further 7px — `.lp-item` is a `1fr auto` grid and a long record name pushed the `1fr` track out. | 327px | `.lp-item-body { min-width: 0; overflow-wrap: anywhere }` |

**After the fixes, all 43 surfaces measure `scrollWidth = 320` at a 320px viewport.** Every wide
table was already wrapped in an `overflow-x` container, which is why the tables were never the cause.

### 2.5.8 Target Size (Minimum) — AA

| # | Finding | Measured | Fix |
|---|---|---|---|
| I1 | `/registration` consent checkboxes | 22×22 | 24×24 |
| I2 | `/admin/governance` and `/admin/cases` checkboxes | 20×20 | 24×24 |

### 2.2.2 Pause, Stop, Hide — A

| # | Finding | Fix |
|---|---|---|
| J1 | **The scoreboard polls every 12 seconds with no way to stop it**, alongside the rest of the page. | a Pause/Resume control that clears the interval, sets `aria-pressed`, and states in the existing `role="alert"` region that the figures are frozen. It is `hidden` in the markup and revealed by the script, so it never appears where it could not work. |

### 2.4.3 Focus Order — A

| # | Finding | Fix |
|---|---|---|
| K1 | **`/live` redraws the whole question board with `innerHTML` every 30 seconds.** A keyboard user with focus on an Upvote button loses it to `<body>` mid-poll, without warning. | a poll that arrives while the keyboard is inside the board is skipped; the next one catches up. |

### 4.1.2 Name, Role, Value — A

| # | Finding | Fix |
|---|---|---|
| L1 | The `/gallery` and `/shop` category filters conveyed their pressed state with a CSS class only. (`/dojos` already did this correctly, which is how the omission showed up.) | `aria-pressed`, set in markup and maintained in the script. |
| L2 | Every `/shop` product carried the identical button name "Add to basket". | `aria-label="Add to basket: {product}"`. The visible string is kept as the **first words** of the accessible name so **2.5.3 Label in Name** still holds for speech control — an `aria-label` of "Add {product} to basket" would have broken it. |

### 1.1.1 Non-text Content — A

| # | Finding | Fix |
|---|---|---|
| M1 | Two decorative map-pin SVGs on `/` and `/events` had no `aria-hidden`. | added. Every icon in `Icon.astro` was already correct. |

No `<img>` anywhere in the project is missing `alt`. The photo heroes use `alt=""` on an
`aria-hidden` wrapper, which is right.

### 3.3.8 Accessible Authentication (Minimum) — AA, new in WCAG 2.2

| # | Finding | Fix |
|---|---|---|
| N1 | The `/unit` access-code field is the only control on its page and carried `autocomplete="off"`, telling password managers to stay out of it. Signing in then depends on recalling and retyping a shared secret. | `autocomplete="current-password"`. Paste was already unblocked — nothing in the project intercepts a paste event. |

---

## 3. Findings — open, and why

These were found and are **not fixed**. They are recorded here rather than quietly dropped.

| # | Criterion | Finding | Why it is open |
|---|---|---|---|
| O1 | 2.2.2 | The homepage **ticker** scrolls on a 60-second infinite loop and the **hero slideshow** crossfades on a 24-second cycle, with no pause control. | Both honour `prefers-reduced-motion: reduce` and stop completely for anyone who has set it — which WCAG's own understanding document does *not* accept as satisfying 2.2.2. Fixing it properly means putting a visible control on the federation's homepage hero, which is a design decision for MMAKF and not one an audit should take unilaterally. The reduced-motion mitigation is guarded by a test so it cannot be deleted by accident. |
| O2 | 2.2.2 | The `/live` question board polls every 30 seconds with no pause control. | The concrete harm — focus destroyed under the user — is fixed (K1). A pause control is the remaining half. |
| O3 | 4.1.3 | Scoreboard **score changes are not announced.** | Deliberate. A live region updating every 12 seconds with two names and two numbers would make the page unusable with a screen reader. The states that *are* status messages — stale, paused, failed refresh — are announced through `role="alert"`. If the federation wants announced scores, the right design is an opt-in, not a default. |
| O4 | 2.5.8 | Three standalone links render 17–19px tall with a fine pointer: `← Competitions` (`/scoreboard`), `← Back to the federation site` (`/unit`), `View Site →` (`/admin`). | They **pass** 2.5.8 under the *Spacing* exception — no other target lies within a 24px circle of any of them — and `@media (pointer: coarse)` gives them a 44px minimum on touch devices. Recorded because the reasoning is not obvious from the code. |
| O5 | 1.3.1 | `/my/passport` draws its certificates and licences lists as single-column captioned `<table>`s. | Not a failure — a table with one cell per row has no column relationship to convey — but a `<ul>` would say what they are. The automated guard exempts single-column tables explicitly rather than pretending it checked them. |
| O6 | — | `/unit` and `/search` autofocus their single primary field. | Not a WCAG failure (3.2.1 concerns a change of context *on* focus, which does not happen), but it moves the viewport for a user who arrived deliberately at the top of the page. Left as-is; noted so the next audit does not re-litigate it. |
| O7 | 1.4.3 | Roughly 30 rules use `--red-3` and `--gold-dim` as borders at 1.4–1.7:1. | Not failures: these are decorative hairlines on controls that are identified by their own text. The tokens are now commented to say so, and a test forbids either being used as text. |

---

## 4. The automated guards

`tests/accessibility.test.ts`, run by `npm test`. The count is not fixed: one assertion is
generated per template for the `h1` check, so it rises whenever a surface is added. At the time of
writing it is 103.

**They read the source, not the rendered HTML, and this is deliberate.** The audit above read
rendered HTML because that is what a user receives. A regression guard cannot: rendering every route
inside vitest needs a running dev server, a database and a live session, which is slow and brittle,
and it would only ever see the branches that happened to render. Eleven of the twelve files with
unscoped `<th>` were invisible to the rendered scan because their tables had no rows in this
environment — the source scan found all of them. The source is also where every one of these defects
actually lived.

The cost is stated in the file's own header: a regex over Astro templates is not a parser. It cannot
resolve `alt={maybeUndefined}`, and it cannot see markup a client script builds with `innerHTML`.

**Every checker is proved to fail before it is trusted to pass.** Each pure function is first run
against a fixture carrying the exact shape of the defect found in this repository — the floating
`<label class="input-label">`, the header-less table, the icon-only button, the bare `outline: none`
— and the contrast suite asserts that the *original* `--muted` and `--gold` values still fail. The
whole-token guard was also mutation-tested: reverting `--muted` to `#857E71` in `global.css` fails
the suite with `--muted (#857E71) on --card-2 (#F1EEE7) is 3.47:1, needs 4.5:1`, and nothing else.

Covered: contrast ratios computed from the tokens; `--muted-2` and `--red-3` never used as text;
`--control-border` at 3:1; no `outline: none` without a replacement; no `<img>` without `alt`; no
`<svg>` that is neither hidden nor named; no `<label>` that points at nothing; no button without a
name; no table without scoped headers; no wide table outside a scroll container; the skip link's
existence, position, target and focusability; one `<main>` per page; an `h1` on every surface; no
positive `tabindex`; the collapsed mobile menu's `visibility`; Escape closing it; the `/live` focus
guard; the scoreboard pause; the reduced-motion mitigations; `aria-pressed` on all three filter bars;
`role="alert"` on every sign-in error container; `scroll-padding-top` for the fixed nav; no password
field with `autocomplete="off"`; no paste blocking; 24px checkboxes.

---

## 5. Files changed

| File | Why |
|---|---|
| `src/styles/global.css` | the four contrast tokens, `--control-border`, `--numeral`, the `.input` border and focus ring, `scroll-padding-top` |
| `src/styles/a11y.css` | **new.** `.sr-only` and `.skip-link` only — additive, no token or component redefinition, loaded immediately after `global.css` |
| `src/layouts/Base.astro` | the skip link, `<main id="main-content" tabindex="-1">`, the `a11y.css` import, the collapsed-menu `visibility`, Escape-to-close |
| `src/components/ListPanel.astro` | label association for 116 controls |
| `src/components/StatCard.astro` | the void value's colour |
| 9 × `src/pages/admin/*.astro` | nested `<main>`, grid `min-width`, scoped headers, 24px checkboxes, the `/admin` h1 and labels |
| `src/pages/{index,about,academy,affiliation,belt-system,events,governance,schedule,competitions,unit,search}.astro` | scoped headers, captions, numeral and arrow colours, decorative SVGs, the unit autocomplete |
| `src/pages/{gallery,shop}.astro` | `aria-pressed`, button names, badge contrast |
| `src/pages/{live,scoreboard,registration,my/index,my/passport}.astro` | focus preservation, the pause control, the nested `<main>`, checkbox size, scoped headers |
| `tests/accessibility.test.ts` | **new.** the guards |

---

## 6. What is NOT covered

Read this before quoting any number above.

| Gap | What it means |
|---|---|
| **No screen-reader testing.** | Nothing in this audit was *heard*. NVDA, JAWS, VoiceOver and TalkBack were not run. Every claim about what a screen reader will announce is inferred from the markup, and inference is not evidence. The `sr-only` captions and headings added here have never been listened to. |
| **No axe, Lighthouse or pa11y pass.** | The project takes no new dependencies, and none was added for this. The checks here are hand-written and therefore only catch what they were written to catch. An axe run would very likely find things this did not. |
| **One browser.** | Chrome 151 headless. No Firefox, no Safari, no WebKit, no real mobile browser. Layout, focus behaviour and `:focus-visible` heuristics differ between engines. |
| **No real users.** | No one who depends on assistive technology has used any of these screens. This is the most important gap in the list. |
| **No zoom testing.** | 1.4.4 Resize Text (200% text-only) and 1.4.10 at 400% browser zoom were **not** tested. A 320px viewport was measured, which covers the reflow width but not text-only enlargement. |
| **1.4.12 Text Spacing not tested.** | The user-stylesheet override for line height, letter spacing and word spacing was not applied. Several components use tight `letter-spacing` on uppercase display type and could clip. |
| **2.4.11 partially covered.** | The fragment-navigation case was measured and fixed. The other case — the browser scrolling a Tab-focused element to the viewport edge — could not be measured, because headless Chrome did not scroll focus into view under synthetic key events. `scroll-padding-top` should cover it, but that is reasoning, not a measurement. |
| **Captions and transcripts (1.2.x) not assessed.** | `/live` and `/academy` embed YouTube. Whether those videos carry captions or transcripts is the federation's responsibility and was not checked. If they do not, the site fails 1.2.2 and 1.2.4 regardless of anything in this document. |
| **3.1.2 Language of Parts not assessed.** | Japanese terms (kihon, kata, kumite, oss, dojo) are unmarked. Treated as naturalised English in context; a screen reader will pronounce them as English. |
| **Content that does not exist yet.** | The federation database is empty in production. Grading scorecards with real candidates, a draw with real bouts, a certificate with a real revocation — the busiest and most complex tables in the system — were audited **empty or with one seeded row**. Their headers and structure are verified; their behaviour at scale is not. |
| **No interaction beyond Tab and Escape.** | Arrow-key behaviour in the mat pickers, `<details>` disclosure groups, drag-free reordering, and the checkout flow end-to-end were not driven. |
| **One surface is not covered at all.** | `/admin/membership` was added by another stream after this audit ran. It is inside the source-level guards (they walk `src/pages`), but it was never rendered, never measured in a browser, and none of its markup was read by a person during this audit. |
| **The two "before" reflow figures are not reproducible from this repository alone.** | H1 records `/admin/approvals` at 461px and `/admin` at 364px before the fix. Reproducing them needs an admin console with records in it. On an empty database, removing the fix again leaves both at 320px, because nothing in the single-column grid is wide enough to push it. The fix is right and the after-state is verified; the before-state depends on data this repository does not carry. |
| **Nothing here proves conformance.** | This is an audit of one afternoon by one engineer with one browser. It found 22 defects and fixed them, and it lists 7 more it did not. A conformance claim needs the gaps in this table closed. |

---

## 7. Next, in order of value

1. **A screen-reader pass** — NVDA on Windows and VoiceOver on iOS, over `/registration`,
   `/verify`, `/checkout` and `/admin/grading`. Highest value of anything remaining.
2. **Text-only zoom to 200%** and the 1.4.12 text-spacing override, on the same four.
3. **Decide O1** — whether the homepage ticker and slideshow get pause controls. It is a design
   decision, not an engineering one.
4. **Re-audit once the database carries real records.** Half the admin console has never been seen
   with a full table.
5. **Audit `/admin/membership`.** It arrived after this audit and has only ever been seen by the
   source-level guards.

---

## 8. Independent review of this audit

A second engineer re-ran the audit's claims against the repository rather than reading them. What
follows is what that check found, including where it disagreed.

### Reproduced

- **Every contrast ratio in this document is arithmetically exact.** All fourteen tokens were
  recomputed from the WCAG relative-luminance formula against `--card`, `--bg` and `--card-2`, and
  every figure quoted above — the failing ones and the replacements — matched to two decimals.
- **43 surfaces return 200, `/404` returns 404.** Re-fetched from a fresh `astro dev`.
- **The rendered-HTML scan reproduces clean**, independently reimplemented over all 43 surfaces:
  no `<img>` without `alt`, no unmarked `<svg>`, no `<th>` without `scope`, no control without an
  accessible name, no duplicate `id`, no positive `tabindex`, exactly one `<main>` per page, a skip
  link on every page, no heading-level skips.
- **Reflow at 320px**, re-measured in Chrome 151 headless over the DevTools Protocol with the
  `body { overflow-x: hidden }` clip lifted, against a real Postgres with all migrations applied and
  a signed-in `SUPER_ADMIN` session so the admin consoles rendered their real markup rather than
  their sign-in screens: every surface reports `documentElement.scrollWidth = 320`.
- **The guards bite.** Eight were mutation-tested one at a time — `--muted` reverted, `scope`
  stripped from a `<th>`, the skip link deleted, `.input:focus-visible` renamed, the `/live` focus
  check removed, the scoreboard's `clearInterval` removed, `/unit` returned to `autocomplete="off"`,
  the registration checkbox returned to 22px. Each failed exactly the guard that names it.

### Corrected

Two guards did **not** bite, and both are now fixed and re-mutation-tested:

- **The collapsed-menu guard was satisfied by its own comment.** `expect(closed).toMatch(/visibility:
  hidden/)` read the raw file, and the comment above the declaration quotes the words
  `visibility: hidden`. Deleting the declaration — the fix for the worst keyboard defect in this
  audit, ten off-screen focusable links — left the test green. Guards that read CSS now strip block
  comments first (`cssCode`).
- **The `scroll-padding-top` guard accepted the media query alone.** It matched any `html {` block,
  so `@media (min-width: 1081px)` satisfied it and the unconditional rule could be deleted with the
  test still passing — losing the padding at exactly the widths where the bar is tallest. The base
  rule and the override are now asserted separately.

`docs/TESTING-STRATEGY.md` §7 still said "No accessibility automation", which this stream made
false. That row now names the suite and keeps the two halves that remain true: no axe pass, no
screen-reader testing.

### Not reproduced

The two "before" reflow figures (461px, 364px) — see §6. Everything about the fix and the
after-state checks out; the before-state needs an admin console with records in it.
