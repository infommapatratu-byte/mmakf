# The three surfaces

`www.mmakf.in` · `learn.mmakf.in` · `admin.mmakf.in` — one application.

---

## Why one application and not three

The federation asked for three interfaces over **one platform**: one identity,
one database, one authorisation module, one audit trail.

Three deployments means three builds that can drift, three sets of environment
variables, and the standing question of which one is running the version of
`rbac.ts` you are reading.

So the routes live at `/learn/*` and `/admin/*` in a single app, and the
middleware rewrites `learn.mmakf.in/schools` → `/learn/schools`.

### The subdomains do not exist yet

No DNS record, no certificate. Everything works **today** at
`www.mmakf.in/learn/…` and starts answering on `learn.mmakf.in` the moment the
record is created — no code change, no redeploy.

A design that only worked once DNS was configured would be a design nobody could
test.

---

## Host resolution is an allowlist

```ts
const SURFACE_HOSTS = {
  'learn.mmakf.in': 'learn',
  'admin.mmakf.in': 'admin',
  'learn.localhost': 'learn',
  'admin.localhost': 'admin',
  …
};
```

The first version matched the leftmost label — `h.split('.')[0]` — with a comment
claiming it would refuse `admin.mmakf.in.evil.example`.

**It did not.** The leftmost label of that host is exactly `admin`.
`tests/navigation.test.ts` asserted the claim and the claim was false.

Anyone who can register a domain can put any label they like at the front of it,
so a rule about the front of a host is a rule an attacker writes. A rule about
the **whole** host is one only DNS can satisfy.

A trailing dot (`admin.mmakf.in.`, the fully-qualified form, which resolves
identically in DNS) is normalised away — otherwise it is a spelling of the admin
host the allowlist does not recognise, and an attacker-controlled way to change
which surface is served.

Anything unrecognised is **public**. An unknown host getting the public site is a
cosmetic surprise; an unknown host getting admin is an incident.

---

## The rewrite happens after the CSRF checks

It is tempting to rewrite at the top of the middleware and return early. Do not.

Whether Astro re-runs middleware for a rewritten route is a framework detail. If
it does not, an early return carries every POST to `learn.` and `admin.` straight
past the origin and content-type checks — **a hole that only opens on two of the
three hosts**, which is the hardest kind to notice.

```ts
const proceed = () => (target ? context.rewrite(target + url.search) : next());
// …all CSRF checks…
return proceed();
```

Re-entry is harmless either way, because `rewriteTarget()` is idempotent: an
already-prefixed path returns `null`.

---

## What is never rewritten

`/api`, `/_astro`, `/_image`, and anything with a file extension.

The API is shared **deliberately**: one set of endpoints, one authorisation choke
point. Rewriting `/api/auth/login` per host would give the three surfaces three
different login endpoints, which is exactly the duplication this design exists to
avoid.

---

## Canonicals

One page, one address. A page reachable at both `www.mmakf.in/learn/schools` and
`learn.mmakf.in/schools` that named itself differently depending on how you
arrived would be two pages competing for the same content.

`canonicalFor(surface, path)` always returns the surface's own origin.

`admin` sets `noindex, nofollow` as a response header **and** is excluded from
the sitemap. A header travels with the response and cannot be missed by a crawler
that never fetched `robots.txt`.

`learn` **is** indexable: its audience pages are how a school finds MMAKF at all,
and PART AN is explicit that discovery content must not sit behind a login.

---

## The admin navigation

`ADMIN_GROUPS` gates every module on an RBAC action. `adminNavFor(can)` filters
them and drops groups that empty out — a finance officer does not see
safeguarding, a training administrator does not see the disciplinary register.

**That is a courtesy, not the control.** It stops people clicking into refusals.
Every page repeats the check itself through `AdminShell`, because a menu is
markup and markup is not an authorisation system.

A refusal **names the action needed**:

> This page needs `engagement:read`, which this account does not hold in any
> scope.

"Forbidden" sends an administrator to ask somebody who also does not know. The
action name is the thing whoever grants roles actually needs to hear.

### Modules absent from the menu

Leads, programmes, quotes, bookings, venues, attendance and workflow inspection
all have their data model, their domain module and their tests — and no page yet.

They are **deliberately absent** rather than listed and broken. `/training` once
listed pages nobody had built, and they 404ed on production for as long as it was
live. `tests/navigation.test.ts` now asserts that every menu link resolves to a
route on disk.

---

## Mobile

PART AL: admin critical actions must work on mobile.

The 224px sidebar becomes a horizontal scroller above the content below 900px,
rather than being squeezed into a 360px screen — which would leave the workspace
about 100px wide.

Data tables are **recomposed as records**, not scrolled. Five columns of
Japanese technique names or nine columns of application metadata inside a 360px
viewport is unreadable however far it slides sideways. The table is hidden and
the same rows render as a definition list.

---

## Related

- `src/lib/surface.ts`, `src/middleware.ts`, `src/components/AdminShell.astro`
- `tests/navigation.test.ts` — 75 assertions covering hosts, rewriting,
  canonicals, menu filtering and link resolution
