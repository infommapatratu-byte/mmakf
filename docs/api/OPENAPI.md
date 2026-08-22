# OPENAPI — every MMAKF endpoint that exists

**Taken from the code, not from intention.** Where an endpoint's shape disagrees with its
neighbours, this document says so instead of describing an idealised version. Those divergences are
collected and numbered in [`docs/API-ARCHITECTURE.md §12`](../API-ARCHITECTURE.md#12-where-the-existing-endpoints-do-not-follow-this-contract);
individual entries below point back at them.

Read [`docs/API-ARCHITECTURE.md`](../API-ARCHITECTURE.md) first for the contract: authentication,
error shape, status codes, the real rate limits, CORS and pagination.

**Conventions used below**

- Base URL is the site origin (`https://www.mmakf.in`). All bodies are JSON.
- `429` is possible on every rate-limited endpoint and is not repeated in each table. It carries
  `Retry-After` in seconds.
- `403 { "error": "Request refused" }` is possible on every `POST` — the CSRF middleware refuses a
  cross-origin request or a non-`application/json` content type before the handler runs.
- **`503`** on any endpoint touching federation records means `DATABASE_URL` is unset. It is a
  configuration state, not a fault, and is the normal answer in production today.

---

## Index

| Surface | Endpoints |
|---|---|
| [Public API v1](#1-public-api-v1) | `GET /api/v1/*` — 8 resources, read-only |
| [Content](#2-content) | `GET /api/data`, `POST /api/data/{key}` |
| [Public forms](#3-public-forms) | `POST /api/enroll`, `/api/register`, `/api/event-register`, `GET /api/application` |
| [Verification](#4-verification) | `GET /api/verify` |
| [Sessions](#5-sessions) | `POST /api/auth/login`, `/api/auth/logout`, `/api/unit/login`, `/api/unit/logout`, `/api/unit/submit` |
| [Grading](#6-grading) | `POST /api/grading/{action}` — 8 actions |
| [Competition](#7-competition) | `GET`/`POST /api/competition/{action}` — 8 reads, 17 writes |
| [Academy](#8-academy) | `GET /api/academy/questions`, `POST /api/academy/{action}` — 8 actions |
| [Governance & casework](#9-governance-and-casework) | `POST /api/governance/{action}` — 29 actions |
| [Approvals](#10-approvals) | `POST /api/approvals/approve\|reject` |
| [Queue](#11-queue) | `POST /api/queue/decide` |
| [Payments](#12-payments) | `POST /api/payments/checkout`, `/api/payments/webhook` |
| [Live updates](#13-live-updates) | `GET /api/stream/{channel}` — Server-Sent Events |
| [Operations](#14-operations) | `GET /api/health`, `GET /api/cron/reconcile` |
| [Not an API endpoint](#15-not-an-api-endpoint) | `GET /sitemap.xml` |

---

## 1. Public API v1

`src/pages/api/v1/[...route].ts`. The only versioned surface, the only one with CORS, the only one
that paginates, and the only one written against the contract from the start.

**Read-only by decision.** No `POST`/`PUT`/`PATCH`/`DELETE`. See API-ARCHITECTURE §2.1.

**What a write attempt actually returns depends on your headers, and this trips people up.** The
route answers `405 { "code": "read_only" }` with an explanation — but `src/middleware.ts` refuses
every state-changing request that carries no `Origin`, `Referer` or `Sec-Fetch-Site` header, which
is exactly what a plain `curl -X POST` sends. Measured against a running server:

| Request | Answer |
|---|---|
| `curl -X POST /api/v1/events` (no `Origin`) | `403 { "error": "Request refused" }` — from the middleware |
| `POST` with a same-origin `Origin` | `405 { "code": "read_only" }` — from this route |
| `POST` with a foreign `Origin` | `403 { "error": "Request refused" }` |
| a browser `fetch()` from another origin | blocked at the preflight; `POST` is not in `Allow-Methods` |

Either way there is no write path. Recorded as divergence 25 so nobody probes it and concludes the
route is broken.

**Methods:** `GET`, `HEAD`, `OPTIONS`. `HEAD` returns the `GET`'s status and headers with no body.

**Authentication:** none. Cookies are ignored; sending one changes nothing.
**Rate limit:** 120 / min (bucket `api-v1`). `/api/v1/verify/*` additionally spends the `verify`
budget of 30 / min.
**CORS:** `Access-Control-Allow-Origin: *`, no credentials, `Allow-Methods: GET, HEAD, OPTIONS`.
`OPTIONS` → `204`. Under `astro dev` the preflight is answered by Vite before the route is reached,
so the `Allow-Methods` you observe locally is the dev server's, not this route's.

### Envelope

```jsonc
// 200
{ "apiVersion": "1", "data": …, "meta": { "generatedAt": "…", "count": 12, … },
  "page": { "limit": 50, "nextCursor": "…"|null, "next": "/api/v1/…"|null } }

// error
{ "apiVersion": "1", "error": "…", "code": "…" }
```

`page` appears on collections only. Error codes: `invalid_limit`, `invalid_cursor`, `invalid_id`,
`invalid_status`, `invalid_kind`, `invalid_registry`, `invalid_request`, `not_found`,
`credential_not_found`, `unknown_route`, `read_only`, `rate_limited`, `database_not_configured`,
`service_unavailable`, `upstream_error`, `internal_error`.

### `GET /api/v1`

Service description: resources, methods, pagination parameters, and an explicit statement that there
is no write path and no authentication.

`documentation` names a **repository path**, not a URL. `docs/` is not copied into the deployed
output, so `/docs/api/OPENAPI.md` resolves under `astro dev` (which serves the project root) and
`404`s on the deployment. Advertising it as a link would be a dead link everywhere it mattered.

### `GET /api/v1/events`

Competition events the federation has published. Cache `public, max-age=60, s-maxage=300`.

| Query | |
|---|---|
| `limit` | 1–200, default 50 |
| `cursor` | keyset on `coalesce(starts_on,'9999-12-31')`, then `id` |
| `status` | comma-separated; each value must be one of the eight public statuses, else `400 invalid_status` with `allowed: […]` |

Public statuses: `published`, `registration_open`, `registration_closed`, `check_in`, `live`,
`results_pending`, `results_final`, `archived`. **A `draft`, `technical_review`, `sanction_review`,
`approved`, `cancelled` or `postponed` event is not served, and the status filter refuses to name
one** — otherwise the filter would be an oracle for the unpublished calendar.

```jsonc
"data": [{
  "id": 1, "code": "MMAKF-EVT-2026-000001", "title": "…", "kind": "open_national",
  "status": "results_final", "startsOn": "2026-03-01", "endsOn": "2026-03-02",
  "venue": "…", "city": "…",
  "registrationOpensAt": "…", "registrationClosesAt": "…",
  "sanctionReference": "MMAKF/SANC/2026/001", "sanctionedAt": "…",
  "rulesetVersion": "…", "contactEmail": "…", "contactPhone": "…",
  "description": "…", "resultsFinalisedAt": "…"
}]
```

An event with no `startsOn` sorts **last**, not first.

### `GET /api/v1/events/{id}`

One published event, its categories and its **locked** results. Cache `public, max-age=30,
s-maxage=60` — an event's status moves through the day it is run.

```jsonc
"data": {
  "event": { …as above… },
  "categories": [{
    "id": 1, "code": "…", "label": "…",          // the federation's own code and label
    "discipline": "kumite", "gender": "male", "ageGroup": "senior",
    "drawFormat": null, "maxEntries": null, "entryCount": 3,
    "results": [{ "placing": 1, "medal": "gold", "status": "final", "corrected": false,
                  "matchesWon": 0, "matchesLost": 0,
                  "competitor": { "entryNo": "MMAKF-ENT-2026-000001", "name": "…", "dojo": "…" } }]
  }]
}
"meta": { "resultsIncluded": "final and corrected placings only…", "entryRosterIncluded": false }
```

`404 not_found` for an unpublished event **and** for one that does not exist, with an identical
body: distinguishing them would confirm an event the federation has not announced.

**Narrower than the page on purpose.** `/competitions` publishes the per-competitor entry roster
once entries close; this API serves `entryCount` instead. A JSON roster of names, dojos and implied
ages is a bulk export in a way an HTML table is not, and no consumer has asked for one.

### `GET /api/v1/events/{id}/results`

Locked results only. Cache `public, max-age=300, s-maxage=3600` — a locked result never changes,
because a correction inserts a **new** row that supersedes the old one.

```jsonc
"data": {
  "event": { "id": 1, "code": "…", "title": "…", "status": "results_final", "resultsFinalisedAt": "…" },
  "categories": [{ "categoryId": 1, "code": "…", "label": "…", "discipline": "…",
                   "gender": "…", "ageGroup": "…", "placings": [ … ] }]
}
"meta": { "categoriesWithoutLockedResults": 1 }
```

**`status` is only ever `final` or `corrected`. A `provisional` placing is never served by any
route in this API**, and a category with nothing locked is omitted rather than returned with an
empty list — "no placings" must not be readable as "no medals were awarded".
Asserted in `tests/api-contract.test.ts`.

Not paginated: one event's locked results are bounded by its category list.

### `GET /api/v1/rankings`

Ranking tables the federation has **published**. A computed-but-unpublished table is a working
document: computing is arithmetic, publishing is a statement, and only the statement is public.
Cache `public, max-age=300, s-maxage=3600`.

`limit`, `cursor` (keyset on `published_at` desc, then `id` desc).

```jsonc
"data": [{ "id": 1, "label": "2026 Q1", "categoryKey": "kumite|male|senior|*",
           "computedAt": "…", "publishedAt": "…", "athleteCount": 7, "eventCount": 1,
           "rulesetCode": "…", "rulesetTitle": "…" }]
"meta": { "categoryKeyFormat": "discipline|gender|ageGroup|weightGrams, with * meaning \"any\"" }
```

### `GET /api/v1/rankings/{id}`

One published table. `limit`, `cursor` (keyset on `rank`, then `person_id` — **ranks tie**).

```jsonc
"data": { "period": { …as above… },
          "entries": [{ "rank": 1, "points": 1000, "previousRank": null,
                        "name": "…", "federationId": "MMAKF-MEM-2026-000001" }] }
"meta": { "workingAvailable": false, "workingNote": "…" }
```

The internal `personId` is the cursor key and is **not** published; `federationId` is the identifier
to quote. The *working* behind each total (`ranking_entries.contributions`) requires `result:read`
and is shown on `/rankings` to a caller who holds it. It is not public, and `meta` says so rather
than leaving a consumer to wonder.

`404 not_found` for an unpublished period and for a missing one, identically.

### `GET /api/v1/dojos`

The affiliated units directory. Cache `public, max-age=60, s-maxage=300` — short, because a charter
can be **suspended** and a directory that keeps saying otherwise for an hour is the failure that
matters here.

| Query | |
|---|---|
| `kind` | `dojo` (default), `district`, `state` |
| `includeFormer` | default **true**; `false` to list current affiliations only |
| `limit`, `cursor` | keyset on unit `code` |

```jsonc
"data": [{ "kind": "dojo", "code": "…", "name": "…", "city": "…", "state": "Jharkhand",
           "district": "…", "standing": "chartered|provisional|lapsed|suspended|revoked",
           "affiliated": true, "affiliatedSince": "2024-01-01",
           "charterValidUntil": "2030-01-01", "charterCurrent": true, "note": null,
           // The club's public page is /clubs/<slug>. Null until an administrator sets one;
           // never minted from the name, because a URL derived from a name moves the next
           // time somebody corrects a spelling. An address, not a contact detail.
           "slug": "mmakf-patratu" }]
"meta": { "kind": "dojo", "includeFormer": true, "matched": 8, "scanTruncated": false,
          "contactDetailsIncluded": false }
```

`matched` is what this request's scan saw and `scanTruncated` says whether that is the whole
register: `publicDirectory()` takes a cap, not a cursor, so every page re-reads the register from the
top and stops at 5 000 units. It is reported rather than presented as a `total` the federation cannot
stand behind.

**No address line, telephone number or email — ever.** A lapsed unit is **listed and labelled**, not
hidden: the person most in need of this data is a parent whose child already trains somewhere, and a
vanished club reads as a typing mistake rather than an expired affiliation. A unit that never
reached at least provisional affiliation is not listed under any option.

### `GET /api/v1/officials`

The licensed register. Cache `public, max-age=60, s-maxage=300`.

| Query | |
|---|---|
| `registry` | `official` (default), `examiner`, `instructor` |
| `limit`, `cursor` | keyset on `federationId\|grantedOn\|level` |

**This collection is paged, but the read behind it is not.** `publicOfficialsDirectory()` takes
neither a limit nor a cursor, so every page reads the **entire** licensed register and filters
expiry in JavaScript. `total` is therefore exact; the cost is that a fifty-row page does a
whole-register scan, at up to 120 requests a minute. Divergence 26; the fix belongs in
`src/db/officials.ts`.

```jsonc
"data": [{ "name": "…", "federationId": "MMAKF-MEM-2026-000001", "registry": "official",
           "level": "…", "state": "Jharkhand",
           "grantedOn": "2024-01-01", "expiresOn": "2030-01-01", "openEnded": false }]
"meta": { "registry": "official", "validAsAt": "2026-08-12", "total": 3,
          "contactDetailsIncluded": false, "note": "Validity is answered for the date shown…" }
```

**`validAsAt` is part of the answer.** The register is queried "valid as at a date", and this API can
only answer for today. A licence current today may have lapsed by the date of a future
championship — appoint against the day of the event, not against this response.

`openEnded: true` means the federation has recorded **no** expiry. That may be deliberate or may be
an omission in the register, and only the office can tell; it is surfaced rather than rendered as an
unqualified tick.

`level` is **free text** in `src/db/officials.schema.ts` — the federation writes whatever it uses,
and there is no enumeration of licence grades anywhere in this system. Do not key on it, and do not
expect a fixed vocabulary; this document deliberately shows no example value, because printing a
plausible one here would be inventing a federation grade.

`kind` (referee / judge / technical delegate) is a column *inside* the official register, not a
separate registry. The API exposes the three registries the module defines and invents no finer
split.

### `GET /api/v1/verify/{number}`

Credential verification by federation member id or certificate number.
`Cache-Control: no-store` — a revocation must be visible immediately.

Delegates to the `/api/verify` handler, so the provenance labelling cannot drift between the two
surfaces. Available even without `DATABASE_URL`, because that handler falls back to the legacy
register (and says so in `provenance`).

```jsonc
"data": { "found": true, "kind": "member"|"certificate",
          "provenance": "examined"|"unverified_legacy"|"legacy_register"|null,
          "note": "…", "credential": {…}|null, "member": {…}|null }
"meta": { "provenanceNote": "…" }
```

**`provenance` is the field that matters, and the one a naive consumer will skip.** The three values
are not equivalent claims — `examined` is traced to a recorded examination, `unverified_legacy`
predates digital examination records, `legacy_register` comes from a register maintained by hand.
A verification service that cannot say how it knows is not a verification service.

| Status | |
|---|---|
| `404 credential_not_found` | Nothing matches. **Divergence #3:** the upstream `/api/verify` answers this as `200 { found: false }`; v1 translates it to a `404` so a client can branch on the status line. |
| `400 invalid_request` | Empty, or over 60 characters |
| `503 service_unavailable` | The database is configured but the lookup failed. **This is not a result about that credential** — it must never be read as "not found". |

---

## 2. Content

### `GET /api/data`

`src/pages/api/data.ts`. Editorial CMS content. No auth, no rate limit.
Cache `public, max-age=60, s-maxage=300`.

Returns the stored keys **minus `PRIVATE_KEYS`**, filtered on the way out so a key added to that
list is excluded automatically. Currently 24 keys: `federation`, `stats`, `leadership`, `programs`,
`schedule`, `events`, `news`, `products`, `achievements`, `testimonials`, `beltGrading`,
`facilities`, `faqs`, `gallery`, `syllabus`, `branches`, `stateUnits`, `documents`, `results`,
`courses`, `lessons`, `circulars`, `social`, `press`.

**`members` is excluded.** It is the federation register; returning it here made this a bulk export
of the membership — unauthenticated, and cached at the CDN for five minutes. Verification is a
lookup of one identifier via `/api/verify`, which is rate-limited.

`200` → the object at the top level. **Divergence #1:** no envelope, no `ok`.

### `POST /api/data/{key}`

`src/pages/api/data/[key].ts`. Replace one content key wholesale.

**Auth:** session cookie + `content:write` at **national** scope. Site-wide content has no unit
location, so a state, district or club credential is refused by scope.
**Rate limit / size cap: none — divergences #12.**

`{key}` must be one of the **25** keys in `KEYS` — the 24 above **plus `members`**, which is
writable here although it is never served by `GET /api/data` — or `unitAccess`, which is admin-only
and holds the unit portal credentials.
Body is the complete new value: an object for `federation` / `beltGrading`, an array for the rest.

| Status | |
|---|---|
| `200` | `{ "ok": true, "key": "faqs" }` |
| `400` | `{ "error": "Invalid key" }`, `{ "error": "Invalid JSON" }`, or `"\"faqs\" is stored as a list and must stay that way."` — the array/object shape may not flip, because the pages that render it assume one or the other and a flipped shape breaks the public site rather than the admin panel where the mistake was made |
| `401` | Not signed in |
| `403` | Signed in without national `content:write` |

Every write is audited with both the old and the new value, which is what makes a bad edit
recoverable. An audit failure is logged and does not fail the write.

---

## 3. Public forms

### `POST /api/enroll`

`src/pages/api/enroll.ts`. An enrolment enquiry. No auth. 10 / min. 8 KB cap.

```jsonc
{ "name": "…", "phone": "…", "program": "…" }   // trimmed to 120 / 32 / 120 chars
→ 200 { "ok": true }
→ 400 { "error": "Invalid JSON" | "Invalid request" | "Name & phone required" }
→ 413 { "error": "Request too large" }
```

Appended to the private `leads` list (newest first, capped at 500). Never served by `/api/data`.
Not idempotent: two submissions create two leads.
**Divergences #8, #11** — the `4xx` branches omit `Content-Type`, and no branch sets `Cache-Control`.

### `POST /api/register`

`src/pages/api/register.ts`. A membership application. No auth. 10 / min. 32 KB cap.

Fields are validated by `validateApplication()` in `src/lib/registration.ts` and **differ by
membership type** — an athlete, an instructor, a dojo and an official are not asked the same six
questions. Rules the endpoint enforces rather than assumes:

- an email address is collected, so the office can reply;
- date of birth is collected, so an age category can be derived and minors identified. Under-18
  applicants must supply guardian details and guardian consent;
- `state` is validated against the federation's own `stateUnits` list — the unit portal matches on
  exact equality, so a free-text typo made an application permanently invisible to the unit meant to
  verify it;
- over-length input is **rejected, not silently truncated**.

```jsonc
→ 200 { "ok": true, "appNo": "MMAKF-R-2026-J7QK2M4P", "isMinor": false,
        "statusUrl": "/application?ref=…&token=…" }
→ 400 { "error": "Please correct the highlighted fields.", "fields": { "email": "…" } }
→ 400 { "error": "Invalid JSON" | "Invalid request" }
→ 413 { "error": "Request too large" }
```

The reference **and** an access token are returned. Both halves are needed to look the application
up, so a guessed or overheard reference discloses nothing. Stored privately in `registrations`.

### `POST /api/event-register`

`src/pages/api/event-register.ts`. An event entry. No auth. 10 / min. 16 KB cap.

```jsonc
{ "event": "…", "name": "…", "phone": "…", "unit": "…" }   // 160 / 120 / 32 / 120 chars
→ 200 { "ok": true, "ref": "MMAKF-E-2026-J7QK2M4P" }
→ 400 { "error": "Event, name and phone are required" | "Invalid JSON" | "Invalid request" }
→ 409 { "error": "That event is not open for entries." }
→ 413 { "error": "Request too large" }
```

The named event must exist in the `events` content list and still be upcoming — eligibility is
checked server-side, never frontend-only.

> **Known gap, and the office is told about it in the admin panel.** This endpoint appends to the
> `eventRegs` list under the field name `ref`. `GET /api/application` searches `registrations` and
> `eventEntries` matching on `appNo`, and the approval engine (`src/lib/queue.ts`) works
> `eventEntries`. So an entry reference issued here can be looked up by **neither** — wrong list and
> wrong field. `/admin/queue` detects stranded `eventRegs` rows and prints a count with the
> explanation rather than showing the operator an empty queue. Documented here because a caller
> reading only the happy path would expect the reference to resolve.

### `GET /api/application`

`src/pages/api/application.ts`. Application status lookup. No auth. 20 / min.

`?ref=` **and** `?token=` — both required. Authorisation is the pair: references are
sequential-looking and get quoted in messages, so a leaked reference discloses nothing without the
token issued with it. The token is compared in **constant time**.

```jsonc
→ 200 { "ok": true, "reference": "…", "submittedOn": "…", "status": "Received",
        "decidedOn": null, "note": null, "type": "…", "name": "…" }
→ 400 { "error": "A reference and access code are both required." }
→ 404 { "error": "No application matches that reference and access code." }
```

**"No such reference" and "wrong code" return an identical `404`**, so the endpoint cannot be used
to discover which references exist. Only what the applicant submitted plus the outcome is returned —
no internal notes, no reviewer identity, no other applicant's data.

---

## 4. Verification

### `GET /api/verify`

`src/pages/api/verify.ts`. The bonafide check for employers, organisers and parents. No auth.
30 / min. `Cache-Control: no-store`.

`?id=` — a federation member id, or a certificate number matching `^MMAKF-CERT-`. Max 60 characters.

Three lookup paths, in this order:

1. **Certificate number, database configured** → `verifyCredential()`, returning `credential: {…}`
   with `certificateNo`, `name`, `federationId`, `grade`, `awardedOn`, `issuingAuthority`,
   `syllabusVersion`, `status`, `revokedReason`.
2. **Member id, database configured** → the person joined to their *active* rank record, returning
   `member: { id, name, grade, gradeKind, awardedOn, syllabusVersion, state, city, status }`.
   Every lookup is written to `verification_log` with a **hashed** IP.
3. **No database configured** → the legacy hand-typed `members` register, returning
   `member: { id, name, type, grade, state, unit, status, validTill }`.

**When a database IS configured and nothing matches, the endpoint does not fall back to the legacy
list** — that would let a superseded hand-typed row override the authoritative answer.

`provenance` and its plain-English `note` are the point of the endpoint:

| Value | Means |
|---|---|
| `examined` | Traced to a recorded examination with examiner scores behind it |
| `unverified_legacy` | A real grade predating digital examination records; the federation holds evidence, but no examination scorecard exists in this system |
| `legacy_register` | From the hand-maintained register — the weakest claim the service can make |

Absent when there is no grade to claim.

| Status | |
|---|---|
| `200 { "found": true, "kind": …, "provenance": …, "note": …, … }` | |
| `200 { "found": false }` | Nothing matched. **Divergence #3** — this is a `200`, not a `404` |
| `400 { "found": false, "error": "Provide a member ID or certificate number" }` | **Divergence #3** — mixes the success and error shapes |
| `503 { "found": false, "error": "…temporarily unavailable…", "unavailable": true }` | A database fault. Deliberately **not** reported as "no such member" |

---

## 5. Sessions

### `POST /api/auth/login`

`src/pages/api/auth/login.ts`. 5 / min (bucket `admin-login`). 4 KB cap.

Two paths. Send `email` to use the first; omit it to use the second.

**1 — a real account.** `{ "email": "…", "password": "…" }`

```jsonc
→ 200 { "ok": true, "email": "…", "mustChangePassword": false }
       + Set-Cookie: mmakf_user=…
→ 401 { "error": "Invalid email or password" }
→ 423 { "error": "This account is temporarily locked after repeated failed attempts. Try again in 15 minutes." }
→ 503 { "error": "Account sign-in is not available yet on this deployment" }
```

**2 — the legacy shared office password.** `{ "password": "…" }`

```jsonc
→ 200 { "ok": true, "shared": true } + Set-Cookie: mmakf_admin=…
→ 401 { "error": "Invalid email or password" }        // after a 400 ms delay
→ 403 { "error": "The shared password has been retired. Sign in with your own email address and password." }
→ 500 { "error": "Server not configured" }            // production without ADMIN_* env vars
```

`sharedPasswordAllowed()` retires path 2 automatically once the first user account exists. If the
database is configured but unreachable, the account count reports `1` rather than `0` — an outage
must never silently re-enable the shared password.

**A wrong password, an unknown email and a disabled account are indistinguishable**: same `401`,
same message, comparable timing. Only the lockout is disclosed, because the user has to be told why
waiting is required.

### `POST /api/auth/logout` · `POST /api/unit/logout`

`200 { "ok": true }` + a clearing `Set-Cookie`. No auth, no rate limit, idempotent.

### `POST /api/unit/login`

`src/pages/api/unit/login.ts`. 5 / min. **No size cap — divergence #13.**

```jsonc
{ "code": "…" }
→ 200 { "ok": true, "name": "…", "level": "…", "state": "…" } + Set-Cookie: mmakf_unit=…
→ 401 { "error": "Invalid or disabled access code" }   // after a 400 ms delay
→ 400 { "error": "Invalid request" }                   // no Content-Type — divergence #10
```

Codes live in the admin-only `unitAccess` key; a code whose `status` is not `Active` cannot sign in.

### `POST /api/unit/submit`

`src/pages/api/unit/submit.ts`. Requires the unit cookie. 20 / min. **No size cap.**

```jsonc
{ "kind": "Result report"|"News report"|"Event proposal"|"Grading report",
  "title": "…",   // ≤160
  "detail": "…" } // ≤2000
→ 200 { "ok": true }
→ 400 { "error": "A valid kind and a title are required" }
→ 401 { "error": "Unauthorized" }
```

The record is stamped with the unit's identity **server-side** — a unit can only ever submit as
itself. Stored privately in `submissions`, worked from `/admin/queue`.

---

## 6. Grading

`src/pages/api/grading/[...action].ts`. `POST /api/grading/{action}`.
Session cookie required. 60 / min **per action**. 16 KB cap.

The chain: **eligibility → application → panel → scorecard → decision → certificate → lock.**
Every action is one call into `src/db/grading.ts`. No grading policy is decided at the edge — not a
pass mark, not a minimum interval, not who may examine.

Scope is re-checked at the route against the row behind the id, because the module gates its writes
with "does this principal hold the action *anywhere*", which never looks at *which* grading is being
written to. Knowing an id is not authority over it.

| Action | Body | Success |
|---|---|---|
| `eligibility` | `personId`, `gradeDefinitionId` | `200` the eligibility report |
| `apply` | `gradingEventId`, `personId`, `gradeDefinitionId`, `presentedByPersonId?`, `dojoId?` | `201` the candidate row |
| `assign-examiner` | `gradingEventId`, `personId`, `role` (`chief\|examiner\|assessor\|observer`) | `201` the panel row |
| `score` | `candidateId`, `examinerPersonId`, `component`, `score`, `maxScore?`, `gradeRequirementId?`, `comment?` | `200 { score, summary }` |
| `decide` | `candidateId`, `outcome` (`pass\|fail\|refer`), `referredComponents?[]`, `examinerNotes?`, `candidateFeedback?` | `200` the decision row |
| `issue-certificate` | `candidateId` | `201` the certificate |
| `revoke-certificate` | `certificateId`, `reason` (**required**) | `200 { ok, certificateId, status:"revoked", reason }` |
| `lock` | `gradingEventId` | `200 { ok, gradingEventId, status:"locked" }` |

`reason` on any action travels on the audit context.

**Errors.** `{ error, code }`. `404` — `unknown_person`, `unknown_grade`, `unknown_event`,
`unknown_candidate`, `unknown_certificate`, and `unknown_action` (with `actions: […]`, only for a
signed-in caller — an anonymous one gets `401` first and cannot enumerate the admin surface).
`409` — `registration_closed`, `already_entered`, `already_on_panel`, `already_locked`, `locked`,
`examiner_not_authorised`, `not_on_panel`, `observer_cannot_score`, `ineligible`, `no_scores`,
`not_passed`, `candidates_undecided`.
`400` — `syllabus_mismatch`, `bad_score`, `refer_needs_components`, `evidence_required`,
`reason_required`, `invalid_request`.

`examiner_not_authorised` is **409, not 403**: the caller *is* permitted to appoint examiners — it is
the appointee's licence that conflicts.

`403` carries `action` and `reason: "out_of_scope" | "action_not_held"`, so a caller can tell "ask
for the role" from "this is not yours to touch".

---

## 7. Competition

`src/pages/api/competition/[...action].ts`. Reads and writes over
`src/db/competition.ts`, `src/db/draws.ts` and `src/db/matches.ts`.

Error codes map by **pattern**: `unknown_*` → 404; `already_*` / `duplicate_*` → 409; also 409 for
`no_change`, `results_exist`, `superseded`, `log_inconsistent`, `sequence_contention`,
`results_finalised`, `match_closed`, `entries_locked`; everything else 400. `403` carries
`code: "forbidden"` and `action`. `503` carries `code: "database_not_configured"`.

### Reads — `GET /api/competition/{action}`

240 / min. Three are public (no session); the rest require one.

| Action | Query | Returns |
|---|---|---|
| `public-events` | `limit` (≤200) | `{ events: [ … ] }` — published statuses only |
| `public-event` | `event` or `id` | Event, categories, entry roster (once entries close), published brackets, **locked results only** |
| `scoreboard` | `event` or `id`, `mat?` | `{ event, mats, byMat: [{ mat, current, next, recent, queued }], refreshedAt, note }` — matches in **published** draws only |
| `events` | `status?` (comma-separated) | `{ events }`, scoped to the caller |
| `event` | `id` | Admin detail, with `visibility: { mayWrite, mayEnterResults, officialsWithheld }` |
| `category` | `id` | Category, entries, draws, matches, results, `visibility`. A caller without `competition:write` or `result:enter` sees **published draws only** and results narrowed to the public fields |
| `match` | `id` | `explainMatch()` plus `allowedTransitions`. Requires `result:enter` **or** `competition:write` — the log names the official who signalled every action and carries their working notes, which `competition:read` (held by every athlete and instructor) does not entitle anyone to read |
| `draw` | `id` | `readDraw()` — refuses an unpublished draw to a caller who may not see it |

Anything else → `404 { "error": "Unknown competition endpoint." }`.

### Writes — `POST /api/competition/{action}`

90 / min (`score` and `reverse-score`: 300 / min). 16 KB cap; 64 KB for `set-ruleset`.

| Action | Body | Success |
|---|---|---|
| `create-event` | `title`, `kind`, `startsOn?`, `endsOn?`, `venue?`, `city?`, `stateUnitId?`, `districtUnitId?`, `organiserDojoId?`, `registrationOpensAt?`, `registrationClosesAt?`, `contactEmail?`, `contactPhone?`, `description?`, `rulesetVersion?` | `201 { event }` |
| `transition-event` | `eventId`, `to`, `reason` (**required**) | `200 { event }` |
| `sanction-event` | `eventId`, `sanctionedByPersonId`, `sanctionReference`, `rulesetVersion?` | `200 { event }` |
| `add-category` | `eventId`, `code`, `label`, `discipline`, + the optional age/weight/grade/format limits | `201 { category }` |
| `enter` | `categoryId`, `personId?`, `dojoId?`, `orderId?` | `201` the entry with its eligibility evidence |
| `check-in` | `entryId` | `200 { entry }` |
| `weigh-in` | `entryId`, `grams`, `officialPersonId` | `200` the result |
| `withdraw` | `entryId`, `reason` (**required**) | `200 { entry }` |
| `generate-draw` | `categoryId`, `format?`, `seed?` | `201` the draw |
| `publish-draw` | `drawId` | `200 { draw }` |
| `set-ruleset` | `eventId`, the ruleset, `authority?` | `200 { stored }` |
| `transition-match` | `matchId`, `to`, `winnerEntryId?`, `winMethod?` | `200 { match }` |
| `assign-mat` | `matchId`, `mat?`, `scheduledAt?` | `200 { match }` |
| `score` | `matchId`, `scoringAction`, `officialPersonId`, `clockSeconds?`, `penaltyCode?`, `note?` | `201` the event and the running score |
| `reverse-score` | `matchEventId`, `reason` (**required**), `officialPersonId`, `clockSeconds?` | `201` the reversal |
| `complete-match` | `matchId` | `200` the completion |
| `finalise-results` | `categoryId` | `200` the locked results |

Anything else → `404 { "error": "Unknown competition endpoint." }`.
**Divergence #7:** `enter`, `weigh-in`, `score`, `reverse-score`, `complete-match`,
`finalise-results` and `generate-draw` return the module's object at the top level; the others wrap
it in `{ event }` / `{ entry }` / `{ match }` / `{ draw }`.

**Two things the route documents about itself.** `assign-mat` writes `matches.mat` and
`matches.scheduled_at` directly because no module function owns it yet — authorisation still goes
through rbac and the change is still audited, but the write belongs in `src/db/matches.ts`. And the
**scoring ruleset lives in the shared store, per event**, because there is no
`competition_rulesets` table: point values, tie-breaks and placings are MMAKF competition
regulation, and the route refuses to invent them. A client never supplies point values on a scoring
request — the server loads the recorded ruleset itself.

---

## 8. Academy

`src/pages/api/academy/[...action].ts`.

Everything here is the **caller acting on their own learning record**. The person is resolved from
the session and is never read from the request body: an endpoint that accepts a `personId` is one
that will eventually be sent somebody else's.

A **shared** credential resolves to no person and is refused with `403` — a shared credential cannot
say whose lesson was completed. An account not linked to a member record is refused with `403` for
the same reason.

### `GET /api/academy/questions`

120 / min. `?code=` (a live-class code, ≤64 chars). Anonymous callers are allowed; authorisation is
`liveClassQuestions()`'s own, including its withholding of the asker's identity on a public class.

`200 { questions: [ … ] }` · `400` no code · `404` unknown class · `403` class not open to you.
Any other action on `GET` → `404 { "error": "Unknown action" }`.

### `POST /api/academy/{action}`

60 / min **per action** (**divergence #16:** the bucket is built from the raw path segment, so an
unrecognised action mints a fresh counter). 16 KB cap.

| Action | Body | Success |
|---|---|---|
| `enrol` | `courseId` | `200 { ok, enrolment }` |
| `lesson-complete` | `enrolmentId`, `lessonId`, `watchedSeconds?` | `200 { ok, … }` |
| `quiz-start` | `quizId`, `enrolmentId` | `200 { ok, … }` — the **student** view; correct answers are not in the shape the module returns, so nothing has to be filtered here and nothing can be forgotten here |
| `quiz-submit` | `attemptId`, `responses` (object) | `200 { ok, … }` |
| `live-join` | `code`, `watchedSeconds?` | `200 { ok, … }` |
| `live-leave` | `code`, `watchedSeconds?` | `200 { ok, attendance }` |
| `question-ask` | `code`, `question` (≤2000) | `200 { ok, question }` |
| `question-upvote` | `questionId` | `200 { ok, … }` — carries `uniquenessEnforced: false`, because the schema holds a bare counter with no per-person vote row. It is a count of **votes**, not of people |

**No policy argument is ever sent.** MMAKF has published no minimum watch time and no attendance
threshold; the module reports `watchTime.minimum` and `threshold` as unset rather than defaulting
one in.

**Errors.** `404` — every `unknown_*`. `403` — `not_enrolled`, `class_not_published`,
`question_hidden`. `409` — `already_enrolled`, `already_submitted`, `attempt_in_flight`,
`attempts_exhausted`, `enrolment_not_active`, `enrolment_expired`, `enrolment_not_pending`,
`course_not_published`, `course_not_editable`, `lesson_unavailable`, `class_not_available`,
`watch_time_below_minimum`. Everything else `400`. Unknown action → `404`.

`AcademyError.detail` is deliberately **not** forwarded to the caller.

---

## 9. Governance and casework

`src/pages/api/governance/[...action].ts`. `POST /api/governance/{action}`.
Session cookie required. 60 / min (`governance-write`). 64 KB cap.

Every branch is a thin dispatch onto `src/db/governance-ops.ts` or `src/db/cases.ts`. All return
`200 { "ok": true, "result": … }`.

`reason` on the body travels on the audit context, where several of these functions **require** it —
every disciplinary step refuses without one.

| Group | Actions |
|---|---|
| Committees & office | `committee/constitute`, `committee/quorum`, `committee/appoint`, `committee/end-appointment`, `committee/void-appointment` |
| Documents | `document/register`, `document/publish` |
| Meetings | `meeting/open`, `meeting/attendance`, `meeting/quorum`, `meeting/resolution` (+ `meetingId`) |
| Action items | `action/raise`, `action/complete` |
| Interests | `interest/declare`, `interest/withdraw`, `interest/check` |
| Casework | `case/note`, `case/safeguarding/assign`, `case/safeguarding/action`, `case/safeguarding/refer`, `case/safeguarding/close`, `case/disciplinary/raise`, `case/disciplinary/investigate`, `case/disciplinary/hearing`, `case/disciplinary/decide`, `case/disciplinary/appeal` |
| Tickets | `ticket/assign`, `ticket/respond`, `ticket/resolve` |

`document/publish` accepts the **text** form only. A binary upload would have to travel as base64
through a JSON body, and a transcoding step between the operator's file and the bytes that get
hashed defeats the point of hashing them. The checksum is computed over exactly what is stored.

**Deliberately absent, and it is not an oversight:**

- **`reportConcern`** — raising a safeguarding concern is ungated by design and belongs on a public
  form, not behind an admin session.
- **Anything medical** — `recordClearance`, `recordInjury`, `fitnessToCompete`, `medicalHistory`.
  Clinical data has no place on a governance or case console and is not reachable from this route
  at all.
- **Editing or deleting a case note.** There is no such function in `cases.ts` and there must never
  be one here.

**Why casework lives here (divergence #19):** this workflow owns two API routes, and the case
consoles need a write path. Inventing a third route it does not own was the worse option. The
authority for each act is still `cases.ts`'s own, unchanged.

**Errors.** `404` — `unknown_committee`, `unknown_appointment`, `unknown_document`,
`unknown_version`, `unknown_meeting`, `unknown_resolution`, `unknown_action_item`, `unknown_person`,
`unknown_declaration`, `unknown_case`, `unknown_ticket`.
`409` — `duplicate_committee`, `duplicate_meeting`, `duplicate_version`, `already_ended`,
`already_completed`, `already_referred`, `already_closed`, `already_decided`, `already_resolved`,
`appeal_already_decided`, `appointment_void`, `case_closed`, `case_no_conflict`,
`ticket_no_conflict`, `overlapping_appointment`, `version_exists`.
Everything else `400` — including `conflict_of_interest`, which is a refusal of bad input and not a
state clash. Unknown action → `404 { "error": "Unknown governance action" }`.

---

## 10. Approvals

`src/pages/api/approvals/[...action].ts`. `POST /api/approvals/approve` and
`POST /api/approvals/reject`. Session cookie required. 60 / min. 8 KB cap.

```jsonc
{ "requestId": "MMAKF-APR-2026-000001", "reason": "…" }   // reason required to reject
→ 200 { "ok": true, "result": { …approval state… } }
→ 400 { "error": "Give the request identifier, for example MMAKF-APR-2026-000001." }
→ 401 · 403 forbidden | self_approval | unidentified_principal
→ 404 unknown_request
→ 409 not_pending | already_approved_by_you
→ 503 unavailable
```

**The one rule this route serves: the approver must not be the requester.** It is enforced in
`src/lib/approvals.ts` against identity, under a row lock, for every role including `SUPER_ADMIN`.
Nothing here re-checks it and nothing here could weaken it.

`self_approval` is **403, not 409**: it is a refusal of authority, not a state clash. The queue never
offers the button that produces it, so a caller reaching that line has gone round the UI.

`approve` takes no reason — agreement is evidenced by the approver's identity in the event log.
`reject` requires one.

**No `GET`, and no `request` action (divergence #21).** Reading one request is `approvalState()`,
called by `/admin/approvals` in its own page loader — server-rendered, so the screen works without
JavaScript and the read is gated by the same authority the act requires. And a generic "raise a
request" form would mint requests no handler is wired to execute: they would be approved, sit at
`approved`, and never happen. That is a control that cannot work, so it is not offered.

---

## 11. Queue

### `POST /api/queue/decide`

`src/pages/api/queue/decide.ts`. Session cookie required. 60 / min. 8 KB cap.

```jsonc
{ "queue": "registrations"|"eventEntries"|"submissions",
  "recordId": "…", "toStatus": "…", "reason": "…", "applicantNote": "…" }
→ 200 { "ok": true, "recordId": "…", "from": "Received", "to": "Approved" }
→ 400 { "error": "Unknown queue" | "Invalid request" }  ·  bad_status, reason_required
→ 401 · 403 forbidden · 404 not_found · 409 already_decided | no_change
```

| Queue | Authority | States |
|---|---|---|
| `registrations` | `membership:issue` | Received, Under review, Verified by unit, Approved, Rejected, Withdrawn |
| `eventEntries` | `competition:write` | Received, Under review, Accepted, Rejected, Withdrawn |
| `submissions` | `content:write` | Pending, Under review, Published, Returned, Rejected |

**A rejection requires a reason.** A record at a terminal state cannot be silently re-decided —
reopening is an explicit move back to "Under review". The decision is **appended** to the record's
own history, never overwriting what came before, so it is durable even when no database is
configured; a missing database delays the audit trail rather than losing the decision.

---

## 12. Payments

### `POST /api/payments/checkout`

`src/pages/api/payments/checkout.ts`. No auth. 10 / min. 32 KB cap.

```jsonc
{ "name": "…", "email": "…", "phone": "…", "shipTo": { … },
  "lines": [{ "kind": "product|membership|affiliation|event_entry|grading|course|certificate|donation",
              "description": "…", "quantity": 1,
              "variantId": 12, "feeCode": "…", "refType": "…", "refId": 34,
              "amountPaise": 50000 }] }   // amountPaise honoured for `donation` only
→ 200 { "ok": true, "orderNo": "…", "amountPaise": 250000, "provider": "razorpay",
        "checkout": { …public parameters only, never a secret… } }
→ 400 an OrderError, or "Invalid request"
→ 409 out_of_stock
→ 413 · 502 provider_error · 503 no_database | no_provider
```

**The client names what it is buying and never sends a price.** Every amount is looked up
server-side from the catalogue or the published fee schedule; a price, tax rate or discount on the
wire is dropped before it reaches the pricing code. Donation is the single exception, because the
payer chooses the amount, and the pricing code accepts that field for that kind only.

Money is integer **paise** everywhere, never a float. At most 50 lines.

### `POST /api/payments/webhook`

`src/pages/api/payments/webhook.ts`. `?provider=` (default `razorpay`). No session, no rate limit.

**The only authoritative confirmation that money was taken.** The browser redirect after checkout is
a convenience the customer controls and proves nothing.

Exempt from the middleware origin check — it is server-to-server and legitimately carries no
`Origin` — and authenticated by **signature** instead. The raw body is read verbatim and never
re-serialised: re-encoding JSON changes the bytes and the signature stops matching, which is the
usual reason webhooks begin "randomly" failing after a refactor.

```jsonc
→ 200 { "received": true }
→ 401 { "error": "Invalid signature" }   // still recorded, so a misconfigured secret is visible
→ 503 { "error": "Not available" }       // unknown provider, or no database
```

**`200` is returned even when fulfilment throws (divergence #5).** The event is on record with its
error for a human to reconcile, and a provider retry would hit the replay guard and change nothing.
A repeated provider event id is acknowledged without re-fulfilling: fulfilling twice is worse than
fulfilling late. The exceptions queue is `GET /api/cron/reconcile`.

---

## 13. Live updates

### `GET /api/stream/{channel}`

`src/pages/api/stream/[channel].ts`, over `src/lib/realtime.ts`.
**The one endpoint on this site that does not answer JSON on success.**

Server-Sent Events, deliberately rather than WebSockets: the feed is one-way, `EventSource` is built
into the browser and reconnects with `Last-Event-ID` on its own, a duplex transport would create a
second unaudited write path, and rule 3 of this project forbids new dependencies. A venue's guest
wifi or a school proxy also breaks a WebSocket upgrade far more often than it breaks
`text/event-stream` over ordinary HTTPS.

**Channel grammar:** `^(scoreboard|live-class|admin):subject$`. `scoreboard` and `live-class` take a
numeric subject; `admin` takes a named scope (`operations`, `competition`, …).

| | |
|---|---|
| Rate limit | 30 opens / min (`stream-open`) |
| Concurrency | 3 streams per client, 64 in total — refused with `429 too_many_streams` |
| Connection life | recycled after 4 minutes; heartbeat every 20 s; polled every 2 s; ≤200 events per batch |
| Resume | `Last-Event-ID` header, or `?lastEventId=` |

**Success is `200 text/event-stream`** with `Cache-Control: no-store, no-transform` and
`X-Accel-Buffering: no`. `no-transform` and the nginx header both exist to stop an intermediary
"optimising" the stream by buffering it, which turns a live feed into four minutes of silence
followed by everything at once.

**Failures are JSON**, in the `{ error, code }` shape:

| Status | |
|---|---|
| `403` / `404` | From `authoriseChannel()`. A competition the federation has not published is **not a channel** — otherwise a draft competition's matches would stream to anyone who guessed the id while `/scoreboard` showed nothing, and the two surfaces would disagree in public |
| `429 too_many_streams` | Concurrency cap, with `Retry-After` |
| `503 database_not_configured` | Carries `fallback: "polling"` |
| `503 unavailable` | Authorisation could not be **decided** — reported as unavailable, not as a refusal, so an operator is not sent looking at role bindings for a database that was simply unreachable |

**A non-200 kills an `EventSource` permanently** — the browser fails the connection and does not
reconnect. So a `503` produces one error event and then silence, not a retry storm, and the page
must notice, start polling, and *say* it is polling rather than sit on a dead stream looking live.

A public channel carries the **public projection** of each domain event, never the raw event; a
`raw` channel is clamped to the principal's clearance by `readFeed()` and is never given to an
anonymous subscriber.

---

## 14. Operations

### `GET /api/health`

`src/pages/api/health.ts`. No auth, no rate limit. `Cache-Control: no-store`.
**Always `200` — monitors alert on the payload, not the status line.**

```jsonc
{ "ok": true, "redis": true|false,
  "database": "ok"|"error"|"not_configured",
  "version": "<git sha>|dev" }
```

`not_configured` is a real state and must never be reported as healthy. In production today this
endpoint returns `{"redis": true, "database": "not_configured"}`.

**Divergence #2:** no envelope, deliberately — an envelope would break the monitors that parse it.

### `GET /api/cron/reconcile`

`src/pages/api/cron/reconcile.ts`. Invoked by Vercel Cron (see `vercel.json`).

**Auth:** `Authorization: Bearer <CRON_SECRET>`, compared against the environment variable. **An
unset secret means the job cannot be triggered at all**, not that it is open — an unset variable
must never mean "allow". An unauthenticated endpoint that mutates orders is one an attacker can use
to expire everyone's checkout.

`401 { "error": "Unauthorized" }` · `200 { "ok": true, "skipped": "no database configured" }`

```jsonc
→ 200 { "ok": true, "ordersExpired": 3, "fulfilmentRetried": 2, "fulfilmentRecovered": 1,
        "stillFailing": ["evt_x: …"], "inconsistentOrders": [] }
```

Three jobs:

1. **Expire stale orders**, releasing the stock reservations they hold. Without this, an abandoned
   checkout held the last gi forever and the item showed as out of stock while sitting on the shelf.
2. **Retry failed fulfilments** — at most 25 per run. The payment is **re-read from the provider**
   rather than trusted from the stored payload: by then the truth may have moved on, and the
   provider is the authority on whether money was taken. Anything still failing is surfaced in
   `stillFailing` rather than swallowed, because it needs a human.
3. **Report inconsistent orders** — a `paid` order with no `paidAt` should be impossible, so it is
   reported rather than repaired silently.

**Divergences #6, #20:** the response is a job log rather than an API shape, and a `GET` mutates —
correct in practice because Vercel Cron issues `GET`, which also puts it outside the middleware's
CSRF check and is why `CRON_SECRET` exists.

---

## 15. Not an API endpoint

`GET /sitemap.xml` — XML sitemap of the public routes. Cache: 1 h browser / 24 h edge.
