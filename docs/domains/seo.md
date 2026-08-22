# SEO

§P. `src/lib/seo.ts` holds the policy as pure functions; `src/pages/sitemap.xml.ts`
and `src/pages/robots.txt.ts` are the endpoints; `tests/seo.test.ts` and
`tests/seo-live.test.ts` are the proof.

---

## Two failures shape every line of it

**A sitemap is not a description of a site. It is an invitation.** Every `<loc>`
is the federation telling a crawler *index this, and keep it*.

The endpoint this replaced held `const ROUTES = [...]` — fifteen paths typed by
hand. Twelve public pages had been built since (`/athletes`, `/officials`,
`/dojos`, `/competitions`, `/rankings`, `/regulations`, `/press`, `/calendar`,
`/search`, `/verify`, `/scoreboard`, `/live`) and not one of them was in it.
Nothing had gone wrong; **a hand-written list does not stay true, it stays
written.**

**An enumerated list fails in the opposite direction.** The moment somebody adds
`src/pages/moderation/queue.astro`, an enumerator that defaults to "public"
publishes the location of the moderation queue to Google.

So: routes are enumerated from the files that exist, and the only thing typed by
hand is the **refusals**, each carrying the reason it was refused.

---

## How a route is classified

`classifyRoute()` returns one of five kinds and the reason, so the endpoint can
be debugged without reading the module.

| Kind | Test | Advertised |
|---|---|---|
| `private` | inside `PRIVATE_PREFIXES` | never |
| `excluded` | named in `EXCLUSIONS` | never — with a written reason |
| `dynamic` | the route still contains `[` | only via a policy in `DYNAMIC_ROUTE_POLICY` |
| `unclassified` | a nested route whose section is declared neither public nor private | **never, and the test fails** |
| `public` | everything else | yes |

`PRIVATE_PREFIXES` is `/admin`, `/api`, `/my`, `/portal`. `/portal` is reserved
although the directory does not exist: it is the name the federation uses for
member surfaces, and reserving it costs nothing.

`PUBLIC_SECTIONS` is `/athlete`, `/people`, `/learn`, `/training`, `/kata`.

**`unclassified` is the load-bearing state.** Every private area in this codebase
is a *directory*, so a directory is the unit of decision. A nested route in an
undeclared section is not advertised and `tests/seo.test.ts` fails until a human
classifies it. The build fails loudly instead of the site leaking quietly.

`isPrivatePath()` compares **segments**, not prefixes. A plain
`startsWith('/admin')` would also swallow a future public `/administration`
page, which would then be missing from search with nobody able to say why.

---

## What is built

### `/sitemap.xml`

Routes come from `import.meta.glob('./**/*.{astro,md,mdx,ts,js}')` — **keys
only**, so no page module is ever imported and no page's dependencies are
dragged into the endpoint. `glob` rather than `readdir` because this is SSR on
Vercel: at request time there is no `src/pages` on disk, only a bundle. Vite
resolves the glob at build time, so the route list is baked in and is correct
for exactly the code that was deployed.

`routeFromPageFile()` mirrors Astro's own rules: any segment beginning with an
underscore produces no route, `/index` collapses, and `calendar.ics.ts` keeps
its `.ics` because that is genuinely part of the URL.

`renderSitemap()` **re-applies the private-path filter**. Classification is the
gate; this is the last thing standing between a mistake upstream and a published
admin URL. Cached `s-maxage=86400`.

**No `lastmod`, no `changefreq`, no `priority`.** Nothing in this system records
when a page's content last changed, so a `lastmod` could only be the time the
request was served — a measurement nobody took, restated to Google on every
fetch. Google ignores `changefreq` and `priority` outright. Omitting all three
is both more honest and no less effective.

### `/robots.txt`

`Allow: /`, then `Disallow:` for each private prefix plus `/unit`, `/checkout`
and `/application`, then the sitemap location.

What it deliberately does **not** contain: `Disallow: /` (which would remove the
federation from search entirely — the single most expensive typo available
here), and `Crawl-delay`, which is an operational policy MMAKF has never set and
which Google ignores anyway.

Disallow is not a security control. It is a request, and it publishes the list
of paths worth trying — so it is used only for paths already obvious from the
site's own footer, which links to `/admin` and `/unit`.

### Structured data

Five builders in `src/lib/seo.ts`, each of which returns `null` rather than
guessing.

| Builder | Emits | Returns null when |
|---|---|---|
| `organizationGraph()` | `SportsOrganization` | never |
| `breadcrumbGraph(trail)` | `BreadcrumbList` | fewer than two crumbs |
| `eventGraph(e)` | `SportsEvent` | no name, no place, or no parseable date |
| `activityLocationGraph(unit)` | `SportsActivityLocation` | the unit is not currently affiliated |
| `faqGraph(faqs)` | `FAQPage` | no entry carries both a question and an answer |

**What `organizationGraph` deliberately omits** is the interesting part. No
`aggregateRating` — there are no reviews, and inventing one is both a fabricated
measurement and a documented Google penalty. No membership or staff count, since
the federation has published no total. No `award` at organisation level: honours
belong to *people* and are recorded with the source they came from, on their own
profile, and attaching them here would strip the source.

**No telephone number.** The number that was there is Sensei's personal mobile
and the federation asked twice for it to be removed. Structured data is *more*
exposed than a page, not less — a search engine republishes it into a knowledge
panel, which is far harder to withdraw than a web page.

`breadcrumbGraph` returning null is the common case and is the point. A
breadcrumb describes a hierarchy; a top-level page has none, and emitting
`MMAKF > About` so the page carries one more block of markup is exactly the SEO
spam the federation asked not to become. The same threshold is used by
`PageHeader`, which is why a page declares its trail once.

`eventGraph` refuses a fixture without a parseable date. The record carries a
District Championship at Ramgarh whose exact date is explicitly not known; a
builder that filled in a plausible day would send somebody to a venue on the
wrong date, which is the worst thing this site can do to anybody. No `offers`
either — a fee this system has not been told is not zero, it is unknown.

`faqGraph` strips markup out of an answer instead of passing it through. The
answers are edited from `/admin` in a textarea, so a pasted `<a href>` would
otherwise be republished as the answer's own text — and a stray `</script>` in
one would end the `<script>` element the graph is serialised into.

---

## The dynamic-route expansion policy

A dynamic route contributes **nothing** unless `DYNAMIC_ROUTE_POLICY` names it.
That is the safe default: an unexpanded page is merely undiscovered, while a
wrongly expanded one publishes records the federation did not agree to publish
in bulk.

### Expanded

| Route | Source | Why it is safe |
|---|---|---|
| `/people/[slug]` | the `leadership` editorial key | Published editorial records, already linked from `/governance`. The slug is computed with the **same `slugify`** the profile page matches on — a second implementation would advertise URLs that 404. |
| `/learn/[audience]` | `AUDIENCES` in `src/data/audiences.ts` | Six substantive pages describing what MMAKF does for schools, corporates, universities, government bodies, communities and individuals. The set is small, fixed and editorial, with **no register of real people behind it**. PART AN is explicit that discovery content must not sit behind a login or out of the index. |

Both expand from the same array or key the pages render from, so the sitemap
cannot advertise a slug that returns 404 — which is precisely what happened
twice in the navigation before the route list was derived rather than
hand-written.

`peopleRoutes()` swallows a storage failure and returns `[]`. A sitemap that
500s because the editorial store blinked is worse than one missing six profiles;
the static routes are still worth serving.

### Deliberately not expanded

| Route | Why |
|---|---|
| `/athlete/[id]` | **The public register is a lookup** — one identifier, one person. Many of its subjects are children (see [PRIVACY.md](../PRIVACY.md)). Turning it into a bulk crawl of every athlete is a decision for the federation, not for this endpoint. The profiles remain reachable and are linked from `/athletes`. |
| `/learn/applications/[ref]` | Each URL is one institution's own submission, reachable only with the private token issued to it. Listing them would publish the reference numbers of every applicant. |

---

## Pages that exist and are excluded, with the reason

`EXCLUSIONS` requires a reason for each, because an exclusion nobody can justify
later gets deleted by somebody tidying up, and the page reappears in the index.

| Path | Reason |
|---|---|
| `/404` | Indexing it puts a "page not found" result in search for the federation. |
| `/learn/apply` | The twenty-step form. Indexing it sends a school into step one without ever reading what MMAKF does for schools. `/karate-for-schools` and `/learn/schools` should meet a searcher, and both link here. |
| `/application` | Sets `X-Robots-Tag: noindex` on its own response; a sitemap entry would contradict the page. |
| `/learn/portal` | A per-tenant surface, and `noindex` on its own response. |
| `/checkout` | Only means anything with a basket behind it. |
| `/unit` | An access-code gate, the same class of surface as `/admin`. |
| `/calendar.ics` | A subscription feed, not a page. `/calendar` is what a reader should find. |
| `/sitemap.xml`, `/robots.txt` | A sitemap does not list itself; a crawler directive is not content. |

`/api/*` additionally carries `X-Robots-Tag: noindex, nofollow` from
`vercel.json`.

---

## What is not built

- **No `lastmod`**, and no way to produce an honest one. It needs a
  content-changed timestamp that nothing records.
- **No `hreflang`, no alternate locales.** The site is English-only.
- **No `Article`, `Course` or `Person` structured data**, although `/press` and
  `/people/[slug]` would each support one.
- **`activityLocationGraph()` now reaches a page.** It is rendered by
  `src/pages/clubs/[slug].astro` through `StructuredData`, which until then was
  imported by no file at all — the builder was written, tested and wired to
  nothing. It still EMITS nothing until the register holds a currently-affiliated
  dojo carrying a slug an administrator set, and that remains the correct output
  for the reasons below; what changed is that the day a real club is slugged, its
  page describes itself instead of staying silent. No "karate classes in <city>"
  page exists to emit it on. A location
  page is legitimate only where a real dojo exists; a national footprint
  assembled from cities MMAKF does not operate in would be the doorway-page
  pattern the federation explicitly refused. A **lapsed** unit returns null on
  purpose — `/dojos` lists lapsed clubs with their standing stated in words,
  because a parent needs to see them, but telling a search engine that a lapsed
  club is an MMAKF location states the opposite of what the page says.
- **`organizationGraph()` is not yet the single source.** `src/layouts/Base.astro`
  emits its own copy of the organisation graph on every page. The builder exists
  so there is one tested definition, and the module records the exact edit that
  would make `Base.astro` call it. Until that edit lands, two definitions exist
  and can drift.
- **Nineteen of the twenty-two SEO landing pages in the directive are not
  built.** Three exist. See [IMPLEMENTATION-QUEUE.md](../IMPLEMENTATION-QUEUE.md)
  for which of the rest are defensible and why city pages are not.
- **No analytics-driven SEO work of any kind.** No keyword data, no ranking
  data, no Search Console integration. Nothing in this repository knows how the
  site performs in search.

---

## Rules

**DO** add a new nested section to `PUBLIC_SECTIONS` or `PRIVATE_PREFIXES` in
the same change that creates it — the test will fail otherwise, which is the
intent.
**DO** write the reason when you exclude a path.
**DO** expand a dynamic route from the same array or key the page renders from.

**DON'T** expand a dynamic route over a register of real people without the
federation deciding it.
**DON'T** add `lastmod` until something records content changes.
**DON'T** treat `Disallow` as access control. It is a request that publishes the
path.

---

## Related

- [../PRIVACY.md](../PRIVACY.md) — why `/athlete/[id]` is a lookup
- [design-system.md](design-system.md) — `PageHeader` shares the `Crumb` type
- `tests/seo.test.ts` (pure), `tests/seo-live.test.ts` (fetched)
