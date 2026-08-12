# API-ARCHITECTURE

**The contract every MMAKF HTTP endpoint is held to — and an honest register of where the existing
endpoints do not keep it.**

Read this before adding an endpoint. Read [`docs/api/OPENAPI.md`](api/OPENAPI.md) before calling one:
that document lists every endpoint that exists, with the request and response shapes taken from the
code rather than from intention.

Two facts frame everything below.

1. **Most of these endpoints predate this contract.** They were written one at a time, over several
   waves, each internally consistent and collectively not. Section 12 lists every divergence found
   by reading the code, so that a reader who hits one knows it is known rather than believing the
   document over the implementation. **A specification that disagrees with the implementation is
   worse than none**, because people trust it.
2. **`/api/v1/*` is the only endpoint written against this contract from the start**, and it is
   deliberately read-only. Everything else is the site talking to itself.

---

## 1. The two surfaces

| | `/api/v1/*` | Everything else under `/api/*` |
|---|---|---|
| Audience | Anyone, from anywhere | This site's own pages, in a browser |
| Methods | `GET`, `OPTIONS` | `GET` and `POST` |
| Authentication | None — everything served is already public | Session cookie |
| CORS | `Access-Control-Allow-Origin: *` | None sent, so same-origin only |
| Versioned | Yes | No |
| Stability | Contractual | May change with the page that calls it |

The second column is **not a public API**, and treating it as one is the mistake this document
exists to prevent. Those endpoints exist to serve the federation's own screens. Their shapes change
when a screen changes, they are authenticated by a cookie a third party cannot obtain honestly, and
they are protected from other origins by the CSRF middleware described in §7.

---

## 2. Authentication

### 2.1 There is no API key scheme

**None. Not partially, not planned-and-stubbed — none.** No endpoint reads an `Authorization`
header, an `X-API-Key`, or a bearer token, with one exception: `/api/cron/reconcile` compares
`Authorization: Bearer <CRON_SECRET>` against a single shared environment variable, which is a
deployment secret rather than an issued credential.

That absence is why `/api/v1/*` is read-only. A public write API needs four things that do not
exist here:

- per-key identity, so an act can be attributed in the audit trail to something other than "the
  internet";
- quotas per key, so one integration cannot consume the whole rate budget;
- a revocation path, so a leaked key can be killed without a deploy;
- an abuse story for what happens when a key is used to spray entries at a championship.

Building the endpoints first and the key scheme "later" would mean shipping either unauthenticated
writes into the federation's system of record, or writes authenticated by the session cookie — which
would make every consumer a CSRF vector and every integration a headless browser. So `/api/v1`
answers `405` to every write method, with the reason in the body.

### 2.2 Session cookies

Three cookies, in descending trust. `identify()` in `src/lib/session.ts` is **the only** place a
request becomes an identity; no endpoint reads a cookie of its own.

| Cookie | Proves | Shared | Notes |
|---|---|---|---|
| `mmakf_user` | A per-person account | No | Roles read from `role_bindings` on every request |
| `mmakf_admin` | The legacy shared office password | Yes | Audited as `shared:legacy-admin`; retires itself once the first account exists |
| `mmakf_unit` | A shared unit access code | Yes | State/district/club scope only |

All three are `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Max-Age=604800`, and are signed
with an audience-separated key — a unit token replayed as an admin token fails twice over. See
`docs/SECURITY-ARCHITECTURE.md §2`.

`/api/unit/submit` is the one endpoint that reads the unit cookie directly, through
`getUnitSession()` rather than `identify()`.

### 2.3 What "signed in" is worth

Nothing on its own. Every endpoint that touches a federation record calls `can()` /
`assertCan()` from `src/lib/rbac.ts` afterwards. A valid cookie with no binding for the action, or a
binding in the wrong scope, is refused with `403`.

---

## 3. Authorisation

**Deny by default, and scope is always checked.** Knowing a record id is never authority over it.

Three shapes appear in the code, and the difference matters:

| Call | Question it answers | Correct for |
|---|---|---|
| `can(principal, action, placement)` | May this principal do this to a record in *this* unit? | A write addressed by id |
| `canAnywhere(principal, action)` | Does this principal hold the action in *any* scope? | Deciding whether to offer a list |
| `assertCan(...)` | As `can`, throwing `ForbiddenError` | The common case |

`/api/grading/*` resolves the row behind the id and re-checks scope with `can()` before delegating,
because `src/db/grading.ts` gates its writes with `assertCanAnywhere()` — the right question for a
list and the wrong one for a write addressed by id. That extra check is documented in the route.

Where an endpoint must distinguish "you do not hold this permission" from "you hold it, but not
here", it does: `/api/grading/*` returns `reason: "action_not_held"` or `reason: "out_of_scope"`
beside the `403`.

---

## 4. Error shape

### 4.1 The contract

```jsonc
{ "error": "A sentence written to be read by a person.", "code": "machine_token" }
```

- **`error` is for humans.** Where the failure came from a domain module, the module's own message is
  returned verbatim — it was written to be read by the person who hit it, and paraphrasing it at the
  edge is how the two come to disagree.
- **`code` is for programs.** Branch on this, never on the sentence.
- **A stack trace never reaches the wire.** Every route ends in a `catch` that logs the detail
  server-side and returns a flat sentence. Table names, SQL and file positions are not part of any
  error body.
- `/api/v1/*` adds `apiVersion` and keeps the same two keys (§9).

### 4.2 Where the code comes from

Not from the route. Each domain module throws a typed error carrying a closed set of codes —
`GradingError`, `CompetitionError`, `DrawError`, `MatchError`, `GovernanceError`, `CaseError`,
`ApprovalError`, `OrderError`, `QueueError`, `AcademyError`, `AffiliationError`, `OfficialsError` —
and the route maps the code to a status. It never inspects a message to decide a status.

Two mapping styles are in use, and the difference is deliberate:

- **`/api/competition/*` matches by pattern**: `unknown_*` → 404, `already_*`/`duplicate_*` → 409.
  The module authors keep the naming rule, so the map does not go stale when a case is added.
- **`/api/governance/*`, `/api/academy/*`, `/api/grading/*` list codes explicitly**, because a
  substring rule would get them wrong. `conflict_of_interest` is a refusal of bad input (400), not a
  state clash (409), and a rule matching "conflict" would have mapped it to 409.

Neither is wrong; a new route should pick one and say which.

---

## 5. Status codes, and what each one means here

| Code | Meaning in this system |
|---|---|
| `200` | Done. Reads, and writes that changed an existing record. |
| `201` | A record was created. Used by grading `apply` / `assign-examiner` / `issue-certificate`, and competition `create-event` / `add-category` / `enter` / `generate-draw` / `score` / `reverse-score`. |
| `204` | Preflight only (`OPTIONS /api/v1/*`). |
| `400` | The request is malformed or incomplete. Includes field-level validation: `/api/register` returns `fields: { … }`. |
| `401` | Not signed in, or the credential no longer resolves. Never used for "signed in but not permitted". |
| `403` | Signed in and refused: authorisation, scope, a shared credential where a person is required, or the CSRF middleware. |
| `404` | No such record, or no such action on this route. Also returned where confirming existence would itself be a disclosure — an unpublished event and a non-existent one are indistinguishable. |
| `405` | `/api/v1/*` only, for a write method. It carries `Allow: GET, HEAD, OPTIONS` and an explanation of why there is no write path — but see divergence 25: a caller sending no `Origin` is stopped at `403` by the CSRF middleware and never reaches it. |
| `409` | The record exists and its state refuses the request: already entered, already decided, results locked, out of stock. |
| `413` | Body over the endpoint's cap (§6.2). |
| `423` | The account is locked after repeated failed sign-ins. `/api/auth/login` only, and the one refusal that is deliberately disclosed — the user has to be told why waiting is required. |
| `429` | Rate limited. Carries `Retry-After` in seconds. |
| `500` | Unexpected. The body says the request could not be completed and nothing else. |
| `502` | An upstream the federation does not control failed — the payment provider. |
| `503` | A dependency is **not configured**, which is a real state and not a failure: no `DATABASE_URL`, no payment provider. Reported as such rather than as a 500 or a silent empty result. |

**`503` is load-bearing.** `DATABASE_URL` is not set in production. Every endpoint that touches a
federation record checks `isConfigured()` first and says so plainly, because a control that silently
does nothing is worse than one that refuses.

---

## 6. Limits

### 6.1 Rate limits — the real numbers

Fixed window, Redis `INCR`+`EXPIRE` keyed on a **hashed client IP**, from `src/lib/ratelimit.ts`.
Without Redis it falls back to an in-process map: degraded across lambdas, but it never fails a
request. **On any infrastructure error the request is allowed through** — availability over
strictness, deliberately.

Every window below is 60 seconds.

| Endpoint | Bucket | Requests / min |
|---|---|---|
| `POST /api/auth/login` | `admin-login` | **5** |
| `POST /api/unit/login` | `unit-login` | **5** |
| `POST /api/enroll` | `enroll` | 10 |
| `POST /api/register` | `register` | 10 |
| `POST /api/event-register` | `event-register` | 10 |
| `POST /api/payments/checkout` | `checkout` | 10 |
| `GET /api/application` | `application-status` | 20 |
| `POST /api/unit/submit` | `unit-submit` | 20 |
| `GET /api/verify` | `verify` | 30 |
| `GET /api/stream/{channel}` | `stream-open` | 30 **opens** (plus a concurrency cap of 3 live streams per client, 64 in total) |
| `POST /api/queue/decide` | `queue-decide` | 60 |
| `POST /api/grading/{action}` | `grading-{action}` | 60 **per action** |
| `POST /api/academy/{action}` | `academy-{action}` | 60 **per action** |
| `POST /api/governance/{action}` | `governance-write` | 60 |
| `POST /api/approvals/{action}` | `approvals-decide` | 60 |
| `POST /api/competition/{action}` | `competition-write` | 90 |
| `GET /api/academy/questions` | `academy-questions` | 120 |
| `GET /api/v1/*` | `api-v1` | 120 |
| `GET /api/competition/{action}` | `competition-public` / `competition-read` | 240 |
| `POST /api/competition/score`, `reverse-score` | `competition-score` | 300 |

Three things a reader should know rather than infer:

- **Per-action buckets are per-action budgets.** Grading's eight actions carry 60 each, so a single
  client can make 480 grading requests a minute across them. That is intentional for a panel working
  a grading on a tablet; it is not a 60/min ceiling on the route.
- **`GET /api/verify` is rate-limited twice through `/api/v1`.** `/api/v1/verify/{number}` calls the
  same handler, so a caller spends both the `api-v1` budget and the `verify` budget. The versioned
  route is deliberately not a way around the limiter that protects the register.
- **Seven endpoints have no rate limit at all**: `/api/health`, `/api/data`, `/api/data/{key}`,
  `/api/auth/logout`, `/api/unit/logout`, `/api/payments/webhook` and `/api/cron/reconcile`. The last
  two are authenticated by signature and by shared secret respectively. `/api/data` is an
  unauthenticated CDN-cached read; `/api/data/{key}` is an authenticated unbounded write. Both are
  listed in §12.

### 6.2 Body size caps

Enforced by reading `request.text()` and measuring before parsing, so an oversized body is refused
without being deserialised.

| Endpoint | Cap |
|---|---|
| `POST /api/auth/login` | 4 KB |
| `POST /api/enroll` | 8 KB |
| `POST /api/queue/decide` | 8 KB |
| `POST /api/approvals/{action}` | 8 KB |
| `POST /api/event-register` | 16 KB |
| `POST /api/grading/{action}` | 16 KB |
| `POST /api/academy/{action}` | 16 KB |
| `POST /api/competition/{action}` | 16 KB (64 KB for `set-ruleset`) |
| `POST /api/register` | 32 KB |
| `POST /api/payments/checkout` | 32 KB |
| `POST /api/governance/{action}` | 64 KB |
| `POST /api/data/{key}` | **none** |
| `POST /api/unit/login`, `POST /api/unit/submit` | **none** (they call `request.json()` directly) |
| `POST /api/payments/webhook` | **none** (`request.text()`, unbounded) |

`/api/payments/webhook` deserves naming rather than leaving off the table. It is the only endpoint
that is **both** uncapped **and** unrate-limited **and** exempt from the CSRF middleware, and the
body is read in full *before* the signature is checked — it has to be, because the signature is
computed over the raw bytes. Anyone who can reach the URL can therefore make the server buffer an
arbitrary body. The signature check means they cannot make it *do* anything, so this is a resource
limit missing, not an authorisation hole; it is listed again as divergence 24.

---

## 7. CSRF and content type

`src/middleware.ts` runs two checks on every `POST`/`PUT`/`PATCH`/`DELETE`:

1. **Origin.** `Sec-Fetch-Site: same-origin` is trusted where the browser sends it; otherwise
   `Origin` must match the host the request arrived on. A request with **neither** is refused —
   "no Origin" is exactly what a forged cross-site form produces. A sibling subdomain is *not* the
   same origin, which is the hole `SameSite=Lax` leaves open.
2. **Content type.** Anything under `/api/` must be sent `application/json`. The three content types
   a cross-site `<form>` can produce without triggering a preflight are refused.

Refusal is `403 { "error": "Request refused" }`, deliberately terse, with the reason logged
server-side.

`/api/payments/webhook` is the only exemption, listed explicitly in the middleware. It is
server-to-server, legitimately carries no `Origin`, and is authenticated by signature over the
**raw, un-re-serialised** body instead.

`GET` requests are not checked, which is correct for reads — and is why `GET /api/cron/reconcile`,
which mutates, is authorised by `Authorization: Bearer <CRON_SECRET>` and refuses outright when the
variable is unset. An unset secret must never mean "allow".

---

## 8. CORS

**Unversioned endpoints send no CORS headers at all.** A browser on another origin therefore cannot
read their responses. That is the intended posture: they are cookie-authenticated, and a permissive
policy on a cookie-authenticated endpoint is a session-replay hole.

**`/api/v1/*` sends `Access-Control-Allow-Origin: *`** — and is safe to, *because* it is anonymous:

- the route never calls `identify()` and never reads a cookie;
- `Access-Control-Allow-Credentials` is deliberately absent (with it, browsers would reject the
  wildcard anyway, and without the wildcard a signed-in visitor's session could be replayed by any
  site they happen to visit);
- consequently every response is identical for every caller, which is also what makes it cacheable
  at the edge.

`OPTIONS /api/v1/*` answers `204` with `Allow-Methods: GET, HEAD, OPTIONS` and a 24-hour
`Access-Control-Max-Age`. `HEAD` is answered as the `GET` with the body dropped — same status, same
headers — because a monitor or a link checker issues one and every other endpoint on the site
answers it `200`.

**A caveat for anyone verifying this locally.** Under `astro dev`, Vite answers the `OPTIONS`
preflight itself before the route is reached, and returns its own
`Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`. That is the dev server, not this
route. Measured on `astro dev`: `OPTIONS /api/v1/events` → `204` **from Vite**; `HEAD /api/v1` →
`200` with `access-control-allow-methods: GET, HEAD, OPTIONS` from the route. The route's own
`OPTIONS` handler is covered by `tests/api-contract.test.ts`, which calls it directly, and cannot be
confirmed over the wire without a production build.

---

## 9. The `/api/v1` envelope

Every `200`:

```jsonc
{
  "apiVersion": "1",
  "data": [ … ] | { … },
  "meta": {
    "generatedAt": "2026-08-12T08:42:37.095Z",  // when the ORIGIN built it, not when you got it
    "count": 12                                  // collections only
    // …resource-specific keys
  },
  "page": { "limit": 50, "nextCursor": "…" | null, "next": "/api/v1/events?limit=50&cursor=…" }
}
```

Every error:

```jsonc
{ "apiVersion": "1", "error": "…", "code": "invalid_cursor" }
```

`generatedAt` is the origin's generation time on purpose. A response served from an edge cache
carries the timestamp of the generation it came from, which is the honest reading of a cached
document; a "now" stamped at delivery would make a stale body look fresh.

---

## 10. Pagination

### 10.1 `/api/v1` uses cursors

`?limit=` (default 50, max 200) and `?cursor=`. Every cursor is a **keyset** — the sort key of the
last row returned, base64url-encoded — not an offset.

The reason is not neatness. An offset page re-reads the table from the top, so a row inserted
between two requests shifts everything after it and the consumer walking the list silently **skips**
a record. Nobody notices until a medal is missing from someone's table. A keyset boundary cannot
move under an insertion elsewhere.

| Resource | Sort key |
|---|---|
| `/api/v1/events` | `coalesce(starts_on, '9999-12-31')`, then `id` — an undated event sorts last |
| `/api/v1/rankings` | `published_at` desc, then `id` desc |
| `/api/v1/rankings/{id}` | `rank`, then `person_id` — because ranks tie |
| `/api/v1/dojos` | unit `code` |
| `/api/v1/officials` | `federationId\|grantedOn\|level` — one person may hold two licences in a registry |

A cursor the API did not issue is refused with `400 invalid_cursor` rather than ignored. Ignoring it
would restart the walk silently: the caller receives page 1 believing it is page 4, duplicating
records with nothing to indicate it happened.

Cursors are **not secrets and are not signed.** They encode only values already present in the
response body; the encoding exists to discourage clients from constructing one by hand.

### 10.2 Nothing else paginates

The pre-existing endpoints use **caps, not pages**, and a register larger than the cap is silently
truncated:

| Read | Cap |
|---|---|
| `publicDirectory()` as called by `/dojos` | 500 units per kind |
| `publicEvents()` | 200 (`/competitions` asks for 120, `/scoreboard` for 60) |
| `listEvents()` via `GET /api/competition/events` | 200 |
| `getList('registrations' \| 'eventEntries')` in `/api/application` | 5 000 |
| `pushToList` retention | leads 500, registrations 2 000, eventRegs 1 000, submissions 500 |

None of these tells the caller it truncated. The 501st affiliated dojo is not in the directory and
nothing says so. This is a known gap, not a design.

---

## 11. Idempotency

**No endpoint accepts a client-supplied idempotency key.** There is no `Idempotency-Key` header
anywhere in this codebase, and a client cannot make a POST safely retryable by asking.

What actually protects against a double submission, in descending strength:

1. **The payment webhook replay guard.** `recordWebhook()` returns `fresh: false` for a provider
   event id already stored, and the handler acknowledges without re-fulfilling. Fulfilling twice is
   worse than fulfilling late. This is the only true idempotency in the system, and it is the place
   that needs it most.
2. **A server-minted provider idempotency key.** `/api/payments/checkout` generates a
   `crypto.randomUUID()` and passes it to the provider so a retried *provider* call does not create a
   second order. It is not exposed to the client and cannot be supplied by one.
3. **Domain state machines.** A repeated act hits `already_entered`, `already_approved_by_you`,
   `already_locked`, `already_decided`, `duplicate_committee` and so on, and is refused with `409`.
   This is a *duplicate detector*, not idempotency: the second call fails rather than returning the
   first call's result.
4. **Nothing at all**, for the list-append endpoints. `POST /api/enroll` submitted twice creates two
   leads. `POST /api/event-register` submitted twice creates two entries with different references.

`POST /api/auth/logout` and `POST /api/unit/logout` are naturally idempotent.

Safe to retry blindly: every `GET`, both logouts, and any request that failed with `429` or `503`
(nothing was written). **Not** safe to retry blindly: any `POST` that returned `500`, because the
route cannot promise the write did not land — the domain module's transaction decides, and the
caller should read the record back rather than resend.

---

## 12. Where the existing endpoints do not follow this contract

Written down because a reader who hits one of these needs to know it is known. Nothing here is a
proposal; it is what the code does today.

### 12.1 Response shape

| # | Endpoint | Divergence |
|---|---|---|
| 1 | `GET /api/data` | Returns the content object at the top level — no envelope, no `ok`. It is a CMS dump consumed by the site's own pages. |
| 2 | `GET /api/health` | Returns `{ ok, redis, database, version }`. Deliberate: monitors parse it, and an envelope would break them. |
| 3 | `GET /api/verify` | Answers "no such credential" as **`200 { "found": false }`**, where every other endpoint uses `404`. Its `400` also mixes the shapes: `{ found: false, error }`. `/api/v1/verify/{number}` translates this to `404 credential_not_found`. |
| 4 | `GET /api/verify` | The success shape differs by kind: a certificate lookup returns `credential: {…}`, a member lookup returns `member: {…}`. A caller must branch on `kind`. |
| 5 | `POST /api/payments/webhook` | Returns `{ received: true }`, and answers `200` even when fulfilment threw — the event is durably recorded with its error and a provider retry would hit the replay guard and change nothing. Deliberate. |
| 6 | `GET /api/cron/reconcile` | Returns a free-form report object (`ordersExpired`, `fulfilmentRetried`, `stillFailing`, …). It is a job log, not an API response. |
| 7 | `POST /api/competition/enter`, `weigh-in`, `generate-draw`, `score`, `reverse-score`, `complete-match`, `finalise-results` | Return the module's result object at the top level; sibling actions return it wrapped (`{ event }`, `{ entry }`, `{ match }`, `{ draw }`, `{ category }`). The route is inconsistent with itself. |

### 12.2 Error `code`

`code` is present on `/api/competition/*`, `/api/grading/*`, `/api/academy/*`, `/api/governance/*`,
`/api/approvals/*`, `/api/queue/decide`, `/api/payments/checkout` and `/api/v1/*`.

It is **absent** on `/api/enroll`, `/api/register`, `/api/event-register`, `/api/application`,
`/api/data`, `/api/data/{key}`, `/api/auth/*` and `/api/unit/*`. Those return `{ error }` alone, and
a client must match on the sentence.

### 12.3 Headers

| # | Endpoint | Divergence |
|---|---|---|
| 8 | `POST /api/enroll` | The `413` and all three `400` branches omit `Content-Type: application/json`. The `200` sets it. |
| 9 | `POST /api/event-register` | Same: `413` and the two early `400`s omit it. |
| 10 | `POST /api/unit/login`, `POST /api/unit/submit` | The invalid-JSON `400` omits it. |
| 11 | `POST /api/enroll`, `POST /api/event-register`, `POST /api/unit/*` | Set no `Cache-Control` at all. Every other endpoint sets `no-store` (or, for `/api/data`, a public lifetime). |

None of these is exploitable — they are inconsistencies a client library will trip over.

### 12.4 Rate limiting and size

| # | Endpoint | Divergence |
|---|---|---|
| 12 | `POST /api/data/{key}` | **No rate limit and no body-size cap.** It parses `request.json()` unbounded and writes a whole content key. It is authenticated and requires `content:write`, so this is a robustness gap rather than an authorisation one. |
| 13 | `POST /api/unit/login`, `POST /api/unit/submit` | Rate-limited but not size-capped; both call `request.json()` directly. |
| 14 | `GET /api/data` | No rate limit. Mitigated by `s-maxage=300` at the CDN. |
| 15 | `GET /api/competition/*` | `rateLimit(request, isPublic ? 'competition-public' : 'competition-read', isPublic ? 240 : 240, 60)` — the second ternary evaluates to 240 either way, so the public and admin read paths have the same budget in separate buckets. The ternary reads as though they differ. |
| 16 | `POST /api/academy/{action}` | The bucket is `academy-${action}` built from the **raw** path segment, so an unrecognised action mints a fresh counter per made-up name. `/api/grading/*` deliberately collapses unknown actions into one `grading-unknown` bucket for exactly this reason. |
| 24 | `POST /api/payments/webhook` | **No rate limit and no body-size cap**, and it is the one path exempted from the CSRF middleware. `request.text()` reads the whole body before the signature is checked, which is unavoidable — the signature covers the raw bytes — but the absence of any ceiling on those bytes is not. |
| 26 | `GET /api/v1/officials`, `/officials` | `publicOfficialsDirectory()` takes neither a limit nor a cursor: both surfaces read the **entire** licensed register on every request and filter expiry in JavaScript. `/api/v1/officials` therefore materialises the whole register to return fifty rows, at up to 120 requests a minute. No cap was added, because a silent cut would drop a licensed official out of the public register; the fix belongs in `src/db/officials.ts`. |

### 12.5 Structure

| # | Divergence |
|---|---|
| 17 | **No endpoint paginates** except `/api/v1/*`. See §10.2 for the caps that stand in for it. |
| 18 | **No `PUT`, `PATCH` or `DELETE` exists anywhere.** Every write is a `POST` to a verb-named action. This is a deliberate fit to the domain — `transition-event`, `revoke-certificate` and `finalise-results` are acts, not row edits — but a REST-shaped client will not find what it expects. |
| 19 | **Casework writes live under `/api/governance/case/*`.** They belong to `src/db/cases.ts`, not to governance; the route says so and explains that inventing a third route was the worse option. |
| 20 | **`GET /api/cron/reconcile` mutates.** A `GET` that writes is wrong on principle and correct in practice: Vercel Cron issues `GET`. It is therefore outside the middleware's CSRF check and is protected by `CRON_SECRET` instead. |
| 21 | **`/api/approvals` has no `GET`** and no `request` action. Reading an approval is a server-rendered page loader; raising one belongs to the subsystem that will execute it. Both absences are argued in the route header. |
| 22 | **`PUBLIC_EVENT_STATUSES` is defined three times** — privately in `src/pages/api/competition/[...action].ts`, exported from `src/lib/search.ts`, and mirrored again in `src/lib/realtime.ts`. The latter two each carry a note saying so, and `realtime.ts` cross-checks its copy against `publicEventDetail()` **by behaviour** at every status in the enum. `/api/v1` imports the exported copy rather than adding a fourth. It wants one home: exporting the competition route's constant would let the other three be deleted. |
| 23 | **`GET /api/stream/{channel}` answers `text/event-stream` on success**, so the `{ error, code }` contract applies only to its failures. It is the single non-JSON success shape on the site, and correctly so — see [OPENAPI §13](api/OPENAPI.md#13-live-updates). |
| 25 | **The `405 read_only` explanation is unreachable for the caller it is written for.** `src/middleware.ts` refuses every state-changing request carrying no `Origin`, `Referer` or `Sec-Fetch-Site` — which is exactly what a plain `curl -X POST` sends — so an outside integrator probing `POST /api/v1/events` gets `403 {"error":"Request refused"}` from the middleware, not the sentence explaining where the write path is. **Measured** on `astro dev`: header-less `POST` → `403`; `POST` with a same-origin `Origin` → `405 read_only`; `POST` with a foreign `Origin` → `403`. Making the explanation reachable would mean exempting `/api/v1` from the middleware, which is not obviously worth it for a route that has no write path to forge. Recorded so no one repeats the probe and concludes the route is broken. |

---

## 13. Adding an endpoint

1. **Does it need to exist?** If a page can server-render the read, it should. `/api/approvals` has
   no `GET` for this reason: a second read path is a second gate to keep in step.
2. **Put the policy in a module under `src/db/`, never in the route.** The route identifies, rate
   limits, caps, parses, delegates, and maps the module's typed error to a status. If it decides
   anything else, the module and the endpoint will disagree — and the endpoint will win, silently.
3. **`identify()` for identity. `can()` for authority. `writeAudit()` for the record.** Never a
   cookie read, never a local permission check, never an unaudited write to a federation record.
4. **Check `isConfigured()` and say so.** `503` with a reason, not `500`, and never a silent empty
   result.
5. **Rate limit before you recognise the action**, so an unknown path cannot be hammered for free,
   and collapse unknown actions into one bucket.
6. **Cap the body by length before parsing it.**
7. **`{ error, code }` on every failure. No stack traces.**
8. **Public data only, from the function that already owns the definition of "public".** Do not write
   a second, more generous one.
9. **Test the refusals, not the happy path.** See `tests/api-contract.test.ts` and
   `docs/TESTING-STRATEGY.md`.

---

## 14. What this document does not cover, and what has not been measured

A document that lists only what works is a liability. These are the limits of this one, and of the
`/api/v1` implementation it describes.

**Not measured.**

- **No `/api/v1` route has ever run against a real deployment.** `DATABASE_URL` is not set in
  production, so every data route there answers `503`. The read paths are exercised against real
  Postgres via PGlite in `tests/api-contract.test.ts`, but never through the `postgres.js` driver and
  never against Supabase. The keyset predicates use Postgres row-value comparison with explicit
  `::date` / `::timestamptz` casts; PGlite and Supabase are *expected* to agree, which is not the
  same as knowing they do.
- **The route's own `OPTIONS` handler has not been confirmed over the wire.** Under `astro dev`, Vite
  answers the preflight first (§8). It is covered by a direct unit call only.
- **Nothing here has been load-tested.** The rate limits in §6.1 are the numbers in the code, not
  numbers derived from a measured capacity, and §6.1's fallback ("on any infrastructure error the
  request is allowed through") has not been exercised under a real Redis outage.
- **The `423` lockout, the payment webhook replay guard and `CRON_SECRET` are described from the
  code**, not from a live provider or a live cron invocation.

**Out of scope of this document.** Authentication internals (session issue, rotation, lockout
thresholds) belong to `docs/SECURITY-ARCHITECTURE.md`; the domain rules the endpoints delegate to
belong to `docs/MASTER-SPECIFICATION.md`; how the tests are constructed belongs to
`docs/TESTING-STRATEGY.md`. This document covers only the HTTP boundary.

**Known to be incomplete.**

- §12 is what was found by reading the code once, endpoint by endpoint. It is not a proof that
  nothing else diverges, and the count is not a metric.
- `docs/API.md` still exists, documents seven endpoints, and predates most of the system. Nothing in
  this workflow retired it, because nothing in this workflow owns it. Someone has to decide whether
  it is deleted or trimmed to a quick-start that points here.
- Two open questions are federation decisions, not engineering ones, and are recorded rather than
  answered: whether the per-competitor entry roster should be published on `/api/v1/events/{id}`
  (§ OPENAPI 1), and whether `/api/v1/officials` should take a public state-code filter.

---

## 15. Related documents

| Document | For |
|---|---|
| [`docs/api/OPENAPI.md`](api/OPENAPI.md) | Every endpoint, with request and response shapes from the code |
| [`docs/API.md`](API.md) | The original short reference. Covers seven endpoints and predates most of the system |
| [`docs/SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md) | Threat model, session design, every control and every gap |
| [`docs/MASTER-SPECIFICATION.md`](MASTER-SPECIFICATION.md) | The canonical specification |
| [`docs/TESTING-STRATEGY.md`](TESTING-STRATEGY.md) | How tests are written here, and what is not covered |
