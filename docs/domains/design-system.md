# The design system

§71 / §99 — the tokens, the components, and the patterns that stop twenty-five
admin screens from becoming twenty-five opinions.

Everything below was read out of the source on 14 August 2026:
`src/styles/global.css`, `src/styles/a11y.css`, `src/components/PageHeader.astro`,
`src/components/DataTable/`, `src/components/Status.astro`,
`src/components/SidePanel.astro` and `src/components/states/*.astro`. Where a
component does not do something, that is recorded rather than implied.

> **This supersedes the token tables in [DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md)
> on the values, and only on the values.** That document was written against an
> earlier working tree and its radius scale is out of date — it records
> `--radius: 2px`, and the token is now `10px` with a seven-step scale around
> it. Its findings sections (stock photography, the 8px federation name) were
> not re-verified here and are not restated. Read this file for the API and the
> current values; read that one for the argument about institutional intent.

---

## 1. The tokens

One `:root` block in `src/styles/global.css`. There is no token build step, no
CSS framework and no UI dependency. A value that is not in this table is not a
token, and a component that invents one is the thing this file exists to stop.

### Colour

| Token | Value | What it is for |
|---|---|---|
| `--bg` | `#F6F4EF` | Warm paper ground. The public surface. |
| `--bg-2`, `--card` | `#FFFFFF` | Raised surfaces. |
| `--card-2` | `#F1EEE7` | A card on a card. |
| `--border` | `#E6E2D8` | Hairline. |
| `--border-2` | `#D5D0C3` | A heavier rule. **1.54:1 — decorative.** |
| `--control-border` | `#8C867A` | The boundary that identifies a control. Clears 3:1 (WCAG 1.4.11) on every surface a field sits on. |
| `--red` | `#8E1212` | The federation crimson. |
| `--red-2` | `#A61616` | The `live` tone. |
| `--red-3` | `#E5CFCB` | Pale hairline. **1.49:1 — borders only.** |
| `--numeral` | `#95564F` | Card ordinals and the `warn` tone. 5.64:1 on `--card`. |
| `--gold`, `--gold-2` | `#86671A` | Accent. Rules, eyebrows, seals — never a fill. |
| `--gold-3` | `#6B5213` | The text-safe gold. Used by the `good` and `waiting` tones. |
| `--gold-dim` | `rgba(160,124,30,0.45)` | Gold as a border. |
| `--white` | `#1A1713` | Primary ink. The name is a legacy of the abandoned dark theme. |
| `--off-white` | `#4C463C` | Secondary text. |
| `--muted` | `#706A5F` | Tertiary text, still at ratio. |
| `--muted-2` | `#C4BDAE` | **1.87:1 — decorative only.** |

**Two tokens are permanently barred from being text**, and
`tests/accessibility.test.ts` fails the build if either is promoted:

- `--muted-2` (1.87:1 on white)
- `--red-3` (1.49:1 on `--card`)

They exist for borders and dividers. The temptation is real — both read as
"a lighter grey" at a glance — which is why it is a test and not a convention.

### Scale

| Group | Tokens |
|---|---|
| Radius | `--radius-xs` 4 · `--radius-sm` 6 · `--radius` 10 · `--radius-md` 12 · `--radius-lg` 16 · `--radius-xl` 24 · `--radius-pill` 999 |
| Space (4px base) | `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 · `-16` 64 · `-20` 80 · `-24` 96 · `-32` 128 |
| Type | `--text-xs` .75rem · `-sm` .82 · `-base` .94 · `-md` 1.02 · `-lg` 1.15, then `--text-xl` … `--text-5xl` as `clamp()` |
| Leading | `--leading-tight` 1.12 · `-snug` 1.32 · `-normal` 1.6 · `-relaxed` 1.78 |
| Tracking | `--tracking-tight` −.015em · `-normal` · `-wide` .08em · `-caps` .22em |
| Elevation | `--shadow-1/-2`, `--shadow-sm/md/lg/xl`, `--shadow-focus` |
| Motion | `--dur-instant` 80ms · `-fast` 140 · `-base` 200 · `-slow` 320; `--ease-out`, `--ease-in-out`, `--ease-spring` |
| Layer | `--z-base` 0 · `-sticky` 100 · `-header` 200 · `-dropdown` 300 · `-drawer` 400 · `-overlay` 500 · `-modal` 600 · `-palette` 700 · `-toast` 800 |
| Breakpoint | `--bp-sm` 640 · `--bp-md` **900** · `--bp-lg` 1080 · `--bp-xl` 1320 |
| Layout | `--max-w` 1180 · `--max-w-wide` 1320 · `--max-w-prose` 68ch · `--gutter` 28 · `--shell-header-h` 60 · `--shell-sidebar-w` 248 |

`--radius` keeps the unsuffixed name because 58 files already reference it.
Renaming it for symmetry would be a rename with no reader on the other end.

`--bp-md` at 900px is the number that matters: it is where a wide table becomes
records (§54, PART AL), and it is the same 900 in every component.

### Two global rules that components rely on and must not repeat

- **`prefers-reduced-motion`** is honoured once, globally, in `global.css`. A
  component with an animation does not re-declare it — `Status.astro` says so in
  a comment where the `live` pulse is defined.
- **`:focus-visible`** declares the site-wide ring. A file that removes an
  outline must replace it *in the same file*; the accessibility test greps for
  exactly that and fails on a bare reset.

---

## 2. `Status.astro` — the only way a status is drawn

Full argument in [status-model.md](status-model.md). The API:

```astro
<Status value={run.status} domain="workflow" />
<Status value={lead.status} domain="lead" withMeaning={false} size="sm" bare />
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `string \| null \| undefined` | — | The **raw database value**. Never a pre-humanised label. |
| `domain` | `string` | — | Only for words that genuinely differ by context (`active`). |
| `withMeaning` | `boolean` | `true` | Renders the operational meaning as a `title` **and** as an `aria-describedby` target. |
| `size` | `'sm' \| 'md'` | `'md'` | |
| `bare` | `boolean` | `false` | Dot plus text, no chip outline. |

The component takes no colour, no label and no tone. All three come from
`src/lib/status.ts`, which is what makes changing how `partially_failed` reads
change it everywhere at once.

**DO** pass the raw enum value and let the dictionary decide.
**DON'T** write a chip by hand, pass a `tone`, or capitalise a label at the call
site. There is no prop for any of it, deliberately.

---

## 3. `PageHeader.astro` — §12 page structure

Breadcrumb, title, description, meta, one primary action, secondary actions,
tabs. In that order, on every major authenticated page.

```astro
<PageHeader
  breadcrumbs={[{ name: 'Admin', url: '/admin' }, { name: 'Coaches', url: '/admin/coaches' }]}
  title="Coaches"
  description="Everyone who has applied to coach for the federation."
  primary={{ label: 'Add a coach', href: '/admin/coaches/new' }}
  secondary={[{ label: 'Export', href: '#', unavailable: 'Export is not built yet.' }]}
  tabs={[{ label: 'All', href: '/admin/coaches' }, { label: 'Candidates', href: '?status=candidate' }]}
>
  <Fragment slot="meta"><Status value={row.status} domain="coach" /></Fragment>
</PageHeader>
```

| Prop | Type | Default |
|---|---|---|
| `breadcrumbs` | `Crumb[]` (from `@/lib/seo`) | `[]` |
| `title` | `string` | required |
| `headingLevel` | `'h1' \| 'h2'` | `'h1'` |
| `description` | `string` | — |
| `primary` | `PageAction` — **one object, not an array** | — |
| `secondary` | `PageAction[]` | `[]` |
| `collapseAfter` | `number` | `2` |
| `tabs` | `PageTab[]` | `[]` |
| `sticky` | `boolean` | `true` |
| `id` | `string` | — |
| slot `meta` | — | counts, chips, `<Status>` |

`PageAction` is `{ label, href, unavailable?, danger?, download? }`.
`PageTab` is `{ label, href, count?, current? }`.

**§13 is enforced by the type.** `primary` is a single object, so a page that
wants six dominant actions cannot express it. A comment would not have survived
a deadline; a type does.

### The three behaviours worth knowing

- **An unavailable action is refused, not hidden.** Pass `unavailable` with the
  reason and it renders as an `aria-disabled` button carrying that reason. It
  is never the `disabled` attribute — a disabled button cannot be focused, so
  the reason could never be read by the person most likely to need it.
- **Tabs are links, not `role="tablist"`.** They are separate URLs that survive
  a refresh and can be pasted to a colleague. Announcing them as ARIA tabs
  would promise script-swapped panels under one URL, which this does not do.
  The current tab is derived from `Astro.url` by specificity (a tab matches when
  its path matches and every parameter it names is satisfied), so a page cannot
  ship with two tabs current or none.
- **"More" is a native `<details>`/`<summary>`.** It works with JavaScript off
  and announces its own expanded state. Script only adds Escape, click-outside,
  focus restoration and arrow keys. There is **no focus trap**, on purpose: a
  disclosure is not an overlay, and trapping would strand the keyboard in a
  three-item list.

**DO** give it one primary action. **DO** point tabs at querystrings so the view
is shareable.
**DON'T** render a second `<h1>`. Under `AdminShell` there are two routes and
only one of them is yours to choose — see below.
**DON'T** invent a count for the meta slot. If the number would have to be made
up, the slot stays empty.

### Under `AdminShell`, pass the header as a prop

`AdminShell` takes a `header` prop. Give it one and the shell prints **no title
of its own** and renders `PageHeader` in its place at `headingLevel="h1"`:

```astro
<AdminShell title="Coaches" requires="coach:read" header={{
  breadcrumbs: [{ name: 'Admin', url: '/admin' }, { name: 'Coaches', url: '/admin/coaches' }],
  primary: { label: 'Add a coach', href: '/admin/coaches/new' },
}}>
```

`title` and `description` default to the shell's own `title` and `intro`, so a
page adopting the header does not restate what it has already said.

`headingLevel` is **not accepted** on that prop — the type omits it. That is
deliberate: the shell and the header cannot both decide, so exactly one `<h1>`
is printed on either route and there is no third path for a page to get wrong.

A page that passes **no** `header` gets the shell's own `<h1>`, unchanged. Only
in that case does a `PageHeader` placed in the default slot need
`headingLevel="h2"` — two `<h1>` on one page fails
`tests/accessibility.test.ts`.

---

## 4. `DataTable` — §97, the one shared table

`src/components/DataTable/Table.astro`, with `types.ts`, `query.ts` and
`local.ts` beside it. Seven nouns — athletes, competitions, registrations,
coaches, leads, grading panels, the disciplinary register — need the same seven
behaviours, so there is one component and not seven.

```astro
const query = readTableQuery(Astro.url, {
  sortable: ['name', 'submitted_at'],
  filters: ['status'],
  defaultSort: { key: 'submitted_at', dir: 'desc' },
});

<Table
  id="registrations"
  caption="Registrations"
  query={query}
  columns={columns}
  filters={filters}
  rows={rows}
  rowId={(r) => String(r.id)}
/>
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | Namespaces DOM ids **and** saved views. Must be stable. |
| `caption` | `string` | required | Becomes the `<caption>` and the accessible name. |
| `columns` | `Column[]` | required | |
| `rows` | `Row[]` | `[]` | |
| `dataset` | `'complete' \| 'page'` | `'complete'` | See below. |
| `state` | `'ready' \| 'loading' \| 'error' \| 'denied'` | `'ready'` | |
| `query` | `TableQuery` | reads the URL itself | Required in practice for `'page'`. |
| `filters` | `Filter[]` | `[]` | |
| `total` | `number \| null` | `null` | `null` is a legitimate answer and renders as a missing total, not a guess. |
| `rowId` | `(row) => string` | — | **No id, no checkbox.** |
| `bulk` | `Bulk \| null` | `null` | |
| `note` | `string \| null` | `null` | A qualification the reader needs before trusting the rows. |
| `emptyTitle` / `emptyBody` / `emptyAction` | | | |
| `errorTitle` / `errorSafe` / `errorId` / `errorDetail` | | | |
| `deniedMessage` / `deniedAction` | | | `deniedAction` names the rbac action that would have permitted the read. |
| `loadingLabel` | `string` | | §105 — never an indefinite "Loading". |
| `paramPrefix` | `string` | | For two tables on one page. |
| `savedViews` | `boolean` | on when there are filters | §83. |
| `defaultSort` | `Sort \| null` | | |
| `pageSize` | `boolean` | | |

### `dataset` is the decision that matters

- **`'complete'`** — you handed over every matching row. The table filters,
  sorts and pages **on the server at render time**, so it all works with
  JavaScript off. Correct for a register of a few hundred rows.
- **`'page'`** — you already filtered, sorted and paged, presumably in SQL. The
  table renders exactly what it is given. **The only correct answer once row
  counts leave the hundreds**, and the only one compatible with rule 6 —
  `visibleScopes()` applied as a SQL predicate.

### `Column`

`{ key, header, align?, width?, sortable?, initialDir?, numeric?, render?,
component?, componentProps?, status?, href?, primary?, hint? }`

- `status: true` (or `{ domain }`) routes the cell through `Status.astro`. It is
  shorthand, and it exists because roughly every federation table has exactly
  one status column.
- `render` returns text and is escaped like any Astro expression, which is what
  stops a member's name from becoming a script tag.
- `primary: true` keeps the column on screen when a row collapses to a record.
- `hint` renders under the header — never as a `title` tooltip.

### Filters, bulk and the states

`Filter` is `{ key, label, type?: 'select' | 'search' | 'date', options?,
placeholder?, anyLabel?, match? }`. `match` is only needed when the filter's
meaning is neither equality nor free-text search.

`Bulk` requires `action` — the endpoint the selection posts to. It is never
defaulted, because a component that guessed an endpoint would post real records
to a route nobody wrote. `BulkAction.destructive` styles the action differently
and asks before it runs; it does not make it the default.

The four non-`ready` states delegate to `src/components/states/` rather than
being redesigned here. There is **no Denied component**: a permission boundary
is prose naming the authority required, not an absence dressed up as one.

### What it does without JavaScript, and what it does not

Filters are a `<form method="get">`. Sortable headers are submit buttons on that
form. Pages are links. All of it lands in the querystring. Switch JavaScript off
and filtering, sorting and paging still work.

JavaScript adds only the genuinely optional: select-all, the running count, the
collapse to records below 900px, and saved views. Every one of those controls is
rendered `hidden` and revealed by the script that operates it, so a control that
cannot work is never on screen.

**DO** use this rather than re-solving mobile tables (rule 7).
**DON'T** filter rows in an array after the query — that is a disclosure with a
filter over it. Use `dataset="page"` and a SQL predicate.
**DON'T** pass a sample row. There is no sample row, default filter option or
placeholder name anywhere in this directory, and that is deliberate.

---

## 5. `SidePanel.astro` — §18 entity quick view

```astro
import SidePanel, { type PanelEntity } from '@/components/SidePanel.astro';
import { quickViewHref, token } from '@/lib/entities';

<td><a href={quickViewHref(Astro.url, ref)} data-sp-open={token(ref)}>{row.name}</a></td>
<SidePanel entities={quickViews} can={(a) => can(principal, a)} />
```

| Prop | Type | Default |
|---|---|---|
| `entities` | `PanelEntity[]` | required — nothing renders when empty |
| `can` | `(action: Action) => boolean` | — |
| `param` | `string` | `PANEL_PARAM` from `@/lib/entities` |
| `id` | `string` | `'sidepanel'` |

`PanelEntity` is `{ kind, id, title, identifier?, status?, photoUrl?, facts?,
activity?, fullProfileHref? }`, where `PanelFact` is `{ label, value, href? }`
and `PanelActivityItem` is `{ when, summary, by? }`.

**The data is already on the page and is not fetched.** Fetching a record on row
click would need an endpoint, and an endpoint needs its own authorisation, its
own scope filter and its own audit entry — a second door into the register,
opened so a drawer could animate. The list has already read and authorised these
rows. The cost is honest and belongs to the caller: pass the fields that decide
"is this the one", not the whole record.

**One ARIA claim is deliberately withheld.** `aria-modal="true"` is set *by the
script*, not by the server. Without JavaScript nothing traps focus, so the list
behind really is still reachable — announcing a modal boundary that does not
exist sends a screen-reader user looking for something they will never find. The
server renders an honest non-modal dialog and the script upgrades it at the
moment the trap, the scroll lock and the Escape handler all exist.

Omit `can` and the "administered in" link is simply not drawn. Most modules are
`/admin` routes, and a quick view on a public register must not name one.

---

## 6. The five state components

`src/components/states/`. Three of the five make a prop **required** that most
libraries make optional, and in each case the required prop is the argument.

| Component | Required props | The rule it enforces |
|---|---|---|
| `EmptyState` | `title`, **`action`** | §104 no dead ends. An empty state with no way forward does not compile. |
| `ErrorState` | `title`, **`safe`** | §57. An author who cannot say what survived the failure has not finished thinking about it. |
| `SuccessState` | `title`, **`next`** | §58. A confirmation with no way onward is where sessions end. |
| `Skeleton` | **`label`** | §105. Never an indefinite "Loading". |
| `OfflineBanner` | none | §59. |

### `EmptyState`

`{ title, body?, action, secondary?, compact?, class? }`, actions are
`{ label, href }`.

For a **true empty register only**. CONTENT-ARCHITECTURE §5.4 keeps four
absences apart and never substitutes one for another:

| The sentence | The fact | Rendered by |
|---|---|---|
| "No records" | a true empty register | `EmptyState` |
| "Not yours to see" | a permission boundary | prose naming the authority required |
| "Could not be read" | a failure | `ErrorState` |
| "Not configured" | no system of record here | prose |

If genuinely nothing can be created from here, the way forward is still real —
back to the register, back to the dashboard, or the page that explains why the
list is empty. "No action" is not a legitimate answer. There is no runtime throw
to match the type: crashing a live federation page over a missing link would
punish the reader for the author's mistake.

### `ErrorState`

`{ title, safe, body?, retryHref?, retryLabel?, secondary?, errorId?, detail?,
announce? }`.

`title` names what failed in the reader's terms — "We couldn't load your
ranking", never an exception class and never the error id. `safe` answers the
question every reader actually has: did my registration go through twice, was
my payment taken, is my profile still there. Retry defaults to this page's own
address and is a plain link, so it works on the connection that just failed;
pass `retryHref={null}` when retrying cannot help. The technical reference is
folded behind Details — it must be on the page, because it is what the reader
quotes when they ring the federation, and it must not be the first thing they
read.

### `SuccessState`

`{ title, body?, reference?, next, secondary?, announce?, class? }`.

`reference` is `{ label, value }` and is rendered large, selectable and with a
copy control. It is **never invented here** — the caller passes what the system
of record issued, or passes nothing. `body` is where "submitted is not accepted"
gets said; a reader who conflates the two will not chase it. `role="status"`,
not `alert`: nothing is wrong.

### `Skeleton`

`{ label, variant?, rows?, columns?, count?, … }` with variants `text`, `table`,
`cards`, `list`, `stats`, `form`, `detail`.

There is no generic `variant="box"`, because a skeleton that does not resemble
its content is a spinner wearing a rectangle. `label` is the operation, as a
phrase with no trailing punctuation — the ellipsis is added here so it is the
same ellipsis everywhere.

Every shimmering box sits inside one `aria-hidden` subtree; a table skeleton of
six by five is thirty-six empty elements, and a screen reader walking them is
materially worse than silence. The operation is carried once by a single
visually-hidden live region, which sits **outside** the `aria-busy` wrapper —
`aria-busy="true"` withholds updates from its subtree until it goes false, and
this wrapper never goes false because the skeleton is replaced wholesale. The
component is honest about the limit: a live region is announced when its
contents *change*, so on a server-rendered first paint the sentence is read on
navigation, not spoken at the reader.

### `OfflineBanner`

`{ stillWorks?, unavailable?, position?, class? }`, defaulting to `'bottom'`.

The defaults describe what `public/sw.js` actually does — network-first GET
navigations with a cache fallback, and it never touches `/api/` or `/admin`. **If
that service worker changes, this copy is wrong and must change with it.**

`navigator.onLine` reports whether the device has a network link, not whether
the federation is reachable, so the banner never claims the connection is good
and never polls to find out — a probe on a dying connection is a request that
hangs. This is the one component permitted to be JavaScript-only (§4): there is
no server render of a dropped connection to degrade to.

---

## 7. Patterns

| Pattern | Where | Rule |
|---|---|---|
| Every admin page renders through `AdminShell` | `src/components/AdminShell.astro` | Exactly one `<h1>`: the shell prints it, unless the page passes `header` and `PageHeader` prints it instead. §3. |
| Authorisation is a shell prop | `AdminShell` `requires` | Not an `if` in the template. |
| Scope is a SQL predicate | `visibleScopes()` | Never a post-query array filter. |
| A wide table becomes records below 900px | `DataTable` | Not a horizontal scroll. Do not re-solve it. |
| Client behaviour is vanilla JS in a `<script>` | everywhere | No React, no new dependencies. |
| Every page | | `export const prerender = false` |

---

## 8. What this system does not have

Stated because a design system that only lists what it has is a brochure.

- **No dark mode.** The tokens define one light institutional palette. There is
  no `prefers-color-scheme` block and no theme toggle.
- **No token build step and no generated artefacts.** Changing a token means
  editing `global.css`. There is no Figma export, no Style Dictionary, and
  nothing checks that a design file and the code agree.
- **No component gallery or Storybook.** The API documented here is the source
  of truth, and it was read from the components rather than generated.
- **No visual regression testing.** `tests/accessibility.test.ts` and
  `tests/layout-guards.test.ts` are static analyses of templates and
  stylesheets — they check contrast maths, focus rings, alt text, heading
  structure, table headers and landmarks. Nothing renders a page and compares
  pixels, so a layout can break without a test noticing.
- **No `Denied` state component**, by design (see §4).
- **The pre-existing public pages have not been rebuilt** to this system. The
  components here are used by the admin surfaces and the newer pages; the older
  public pages predate them and still carry per-page `<style>` blocks. That is
  in [IMPLEMENTATION-QUEUE.md](../IMPLEMENTATION-QUEUE.md), not fixed.

---

## Related

- [status-model.md](status-model.md) — the eight tones and the drift guard
- [../DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md) — the institutional argument, and
  findings not re-verified here
- [../ACCESSIBILITY.md](../ACCESSIBILITY.md) — the WCAG 2.2 AA audit
- [../RESPONSIVE-DESIGN.md](../RESPONSIVE-DESIGN.md)
