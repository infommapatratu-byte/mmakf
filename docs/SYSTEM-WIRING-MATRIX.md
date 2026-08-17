# System wiring matrix

**What is actually connected to what, traced by reading the code.**

Tracing pinned to `802daf7` (`wave-2b-federation`); verification re-run at
`eb1004e`. Audited 16 August 2026. The working
tree was being edited by other work during this audit; where a finding changed
under me it is recorded twice — what was there, and what is there now — because
the historical state is the evidence for the finding and the current state is
what ships.

---

## How to read this

Every feature is traced through fifteen links. A link is REAL only if a specific
file does the work; the presence of a button, a route file, a table or a tested
function is not evidence that anything is joined to anything.

| Link | The question it answers |
|---|---|
| PUBLIC UI | Is there a surface a visitor can reach? |
| AUTH | Who is the caller, and is that established before the work? |
| API | Is there an endpoint, or does a page handle its own POST? |
| VALIDATION | Is the input checked server-side, by one definition? |
| SERVICE | Is there a domain function, or does the route do it inline? |
| DATABASE | Which store — Postgres, Redis, or neither? |
| EVENT | Is a `domain_events` row published? |
| WORKFLOW | Does `lib/workflow.ts` run anything? |
| AUTOMATION | Is a follow-on action taken without a human? |
| NOTIFICATION | Is anybody told, and by what transport? |
| CALENDAR | Does it reach `/calendar` or `/calendar.ics`? |
| AUDIT | Is an `audit_events` row written? |
| ADMIN UI | Can an administrator see it — and act on it? |
| USER UI | Can the person who submitted it see where it got to? |
| TEST | Is the chain covered, or only the function? |

Classifications used: **REAL+WIRED**, **REAL+PARTIALLY WIRED**, **UI ONLY**,
**MOCK**, **STATIC**, **STUB**, **DEAD CODE**, **UNUSED**, **BROKEN**,
**DUPLICATED**, **UNVERIFIED**.

A missing link makes the feature INCOMPLETE. That is stated in every row where
it applies, with the file the missing link should live in.

---

## Verification actually run

Run twice, because the tree moved under the audit. Every number below is copied
from the command's own output.

At `802daf7`, when the tracing was done:

```
npx astro build
  -> exit 0. Server built in 27.67s. Complete!

npx vitest run tests/accessibility.test.ts tests/layout-guards.test.ts
  -> exit 0. Test Files 2 passed (2). Tests 156 passed (156).
```

Re-run at `eb1004e`, the tree as it stands:

```
npx astro build
  -> exit 0. Server built in 35.50s. Complete!

npx vitest run tests/accessibility.test.ts tests/layout-guards.test.ts
  -> exit 0. Test Files 2 passed (2). Tests 158 passed (158).
```

The re-run failed twice before succeeding, with
`EEXIST: mkdir '.vercel/output/server'` and a libuv assertion. That is a stale
artefact from a concurrent build on Windows, not a source error: removing
`.vercel/output` and rebuilding gave the clean pass above. Recorded so nobody
re-runs it, hits the same crash, and reads it as a real failure.

`tests/` contains **77** `*.test.ts` files at `eb1004e` (75 at `802daf7`). The
full suite was not run for this audit; the two suites the brief names were.

Nothing in this document was taken from `docs/IMPLEMENTATION-STATUS.md` or any
other document. Where the two disagree, see the last section.

---

# Part 1 — the four traces the federation named

## 1.1 The enquiry form → `/api/enroll` → `pushToList`

**Classification: BROKEN (historic), now RETIRED — with one residual dead read.**

### Did an enquiry submitted there ever reach an administrator?

**No. Not once, by either path, for reasons that are independent of each other
and both provable from the source.**

The form in `src/components/EnrollCTA.astro` collected three fields:

```
name        <input name="name">
email       <input name="email">
program     <select name="program">
```

`src/pages/api/enroll.ts` built its record from a different set:

```ts
const lead = { id, name: str(body?.name), phone: str(body?.phone), program: ..., ts };
if (!lead.name || !lead.phone) {
  return new Response(JSON.stringify({ error: 'Name & phone required' }), { status: 400 });
}
```

There was **no phone field on the form**, so `body.phone` was always
`undefined`, `str()` returned `''`, and the guard returned **400 on every
scripted submission**. The component's own script treats a non-OK status as
failure and showed "Could not submit. Please email admin@mmakf.in."

The `<noscript>` block claimed *"This form works without JavaScript."* It did
not. A native form POST sends `application/x-www-form-urlencoded`; the handler
only ever called `JSON.parse(raw)`, which throws on that body and returns
**400 Invalid JSON**. Additionally `src/middleware.ts` requires
`application/json` on every mutating `/api/` path, so the unscripted path was
refused before it reached the handler at all.

**And had a submission succeeded, it still reached nobody.** `pushToList('leads', …)`
writes a Redis list at `mmakf:list:leads`. `captureLead()` in `src/db/engagement.ts`
— the function that creates the Postgres `leads` row `/admin/leads` renders — is
called from exactly one place in the codebase:

```
src/db/applications.ts:798   const lead = await captureLead(db, ctx, { … });
```

`/api/enroll` never called it. The two stores never met.

### Where the Redis list was read

`src/pages/admin/index.astro:19` — `leadList = await getList('leads', 500)` —
renders an "Enrolment Leads" panel at line 400 with a column headed **Phone**,
bound to `l.phone`, the field that could never be populated. That page is the
legacy shared-password console, not the RBAC admin surface, and it is not in the
`src/lib/surface.ts` navigation.

### Current state

Both ends have been retired during this run. `src/components/EnrollCTA.astro` is
now a link band to `/learn/request` with no form and no script.
`src/pages/api/enroll.ts` now answers **410 Gone** on every method with a
pointer to `/learn/request`. No caller for `/api/enroll` remains in `src/`.

### Residual, still present at this commit

| Link | State |
|---|---|
| PUBLIC UI | REAL — `EnrollCTA.astro`, eleven pages, links only, no intake |
| API | RETIRED — `/api/enroll` returns 410 |
| DATABASE | Redis list `mmakf:list:leads` — **nothing writes it any more** |
| ADMIN UI | **DEAD READ** — `src/pages/admin/index.astro:19` still calls `getList('leads', 500)` and renders a panel that can now only ever be empty |
| TEST | **NONE.** No test in `tests/` references `/api/enroll`. The 400-on-every-submission defect was invisible to the suite for its entire life |

**Missing link:** the dead panel. It should be removed from
`src/pages/admin/index.astro`, or repointed at `leadPipeline()` in
`src/db/engagement.ts` — which is what `/admin/leads` already does properly.

---

## 1.2 `/learn/apply` → `submitApplication()`

**Classification: REAL+WIRED for intake. REAL+PARTIALLY WIRED overall — there
is no way to decide an application once it arrives.**

### The chain, verified

| Link | Where | State |
|---|---|---|
| PUBLIC UI | `src/pages/learn/apply.astro:222` `<form method="POST">`, server-rendered steps, draft token in the URL | REAL. Works with JavaScript off — the page handles its own POST at line 73 |
| AUTH | None required, correctly. Origin-checked by `src/middleware.ts` | REAL |
| API | `src/pages/api/learn/application.ts` — `POST` for JSON callers, `submitApplicationRequest()` exported so the page shares one handler. One rate limit, not two | REAL |
| VALIDATION | `validateSubmission()` + `WIZARD_STEPS`, `src/db/applications.ts:144,314`. Single definition; the wizard renders from it and the server validates against it | REAL |
| SERVICE | `submitApplicationWithAutomation()` → `submitApplication()` | REAL |
| DATABASE | Postgres | REAL |
| EVENT | `record_event` step publishes `INSTITUTION_APPLICATION_SUBMITTED` via `src/lib/domain-events.ts` | REAL |
| WORKFLOW | `INSTITUTION_APPLICATION_INTAKE` in `src/db/automations.ts`, six steps, `maxAttempts: 4` | REAL |
| AUTOMATION | Status → `acknowledged`; timeline entry; task created; message queued; role notified | REAL |
| NOTIFICATION | **QUEUED ONLY** — see the missing link below |
| CALENDAR | Not applicable |
| AUDIT | `writeAudit(… 'institution_application', 'create' …)` at the end of `submitApplication()` | REAL |
| ADMIN UI | `/admin/applications` list + `/admin/applications/[id]` detail — **both read-only. No decision, no assignment** | INCOMPLETE |
| USER UI | `/learn/applications/[ref].astro` → `applicantStatus()`, requires ref **and** token | REAL |
| TEST | `tests/operations.test.ts` exercises submit, automation, idempotency, duplicate detection | REAL |

### Is it one transaction? No — and the code is right not to be

The brief asks this directly. **`submitApplication()` opens no transaction.**
There is no `db.transaction(...)` anywhere in `src/db/applications.ts`. It is a
sequence of independent statements, each of the derivation steps wrapped in its
own `try/catch` that records a failure event rather than aborting:

- institution fails → `applicationEvents` row `kind: 'institution_failed'`
- lead fails → `kind: 'lead_failed'`
- training request fails → `kind: 'request_deferred'`
- the whole automation fails to start → `kind: 'automation_failed'`

The file's own header calls it "one transaction-per-step run that can be
replayed safely", which is accurate; "one transaction" is not. The ordering is
deliberate and documented: the application row is written **first**, so a
derivation failure leaves the school's submission intact and recoverable rather
than losing it to a rollback.

### Every record one submission creates

1. `institution_applications` — one row, `status: 'submitted'`, with `ref`
   allocated by `allocateFederationId(db, 'APP', year)` and a random 24-byte
   `accessToken`.
2. `application_events` — `kind: 'submitted'`, visible to the applicant.
3. `institutions` — via `resolveInstitution()`, with duplicate detection.
   May also touch `persons`/contacts inside that function.
4. `leads` — via `captureLead()`; folded into an existing open lead when the
   contact already has one, so this is **not always a new row**.
5. `training_requests` — via `submitTrainingRequest()`, **only when
   `participantCount` is not null**.
6. `institution_applications` — updated with `institutionId`, `leadId`,
   `requestId`, `ownerRole`, `ownerUserId`, `leadScore`.
7. `application_events` — `kind: 'routed'`, carrying the routing explanation and
   the score.
8. `application_events` — `kind: 'possible_duplicate'`, when `findDuplicate()`
   matched on name + city among live applications. **Reported, never merged.**
9. `audit_events` — one row.

Then the workflow adds:

10. `domain_events` — `INSTITUTION_APPLICATION_SUBMITTED`.
11. `institution_applications.status` → `acknowledged`, `acknowledgedAt` set.
12. `application_events` — `kind: 'acknowledged'`, visible to the applicant.
13. `tasks` — `REVIEW_INSTITUTION_APPLICATION`, `dueInHours: null`, idempotent on
    `wf:{runId}:task:…`.
14. `notifications` — `application_received`, `status: 'queued'`, only when
    `contactEmail` is present.
15. `notifications` — one in-app row per active holder of `ownerRole`.
16. `workflow_runs` and its step rows.

### The missing links, named

**(a) An application still cannot be decided.** `src/db/applications.ts` exports
three functions for the review side: `applicationDetail()` (line 1117),
`reviewApplication()` (977) and `assignApplication()` (1046).

`src/pages/admin/applications/[id].astro` was added during this run and calls
**`applicationDetail()` only**. It has no `<form>` and no
`request.method === 'POST'` branch. `src/pages/admin/applications.astro` is
likewise a filtered list of `applicationQueue()` rows with no actions.

So `reviewApplication()` and `assignApplication()` still have **no caller
anywhere in `src/pages`**. The only `reviewApplication` a page does call is a
different function of the same name in `src/db/onboarding.ts`, used by
`/admin/onboarding` for unit onboarding — a different domain.

An administrator can now open an application and read its full timeline. They
still cannot accept it, refuse it, or assign it to anybody.

*Missing link:* a POST branch in `src/pages/admin/applications/[id].astro`
calling `reviewApplication()` and `assignApplication()`. The detail view that
would host it now exists; the decision does not.

**(b) The administrator's notification link — RESOLVED during this run.**
`src/db/automations.ts` builds the context value:

```ts
adminUrl: `${PUBLIC_ORIGIN}/admin/applications/${result.applicationId}`,
```

At `802daf7` there was no `src/pages/admin/applications/[id].astro` and every
in-app notification raised by `notify_role` on this workflow carried a link to
the 404 page. That page now exists, so the link resolves. Recorded because it
was a live defect for the life of the workflow and the fix is one commit old.

**(c) The task created is not actionable.** `src/db/tasks.ts` exports
`claimTask`, `startTask`, `blockTask`, `completeTask` and `cancelTask`. None has
a caller in `src/pages`. `/admin/tasks` has no POST branch. The task can be seen
and cannot be worked. See §2.9.

**(d) The queued message is never sent.** See §1.4 and §2.11.

---

## 1.3 The fee engine

**Classification: REAL+WIRED, and correctly empty. This is the healthiest chain
in the system.**

### What a caller actually gets today

`activeFramework(db, asAt)` (`src/db/fees.ts:430`) selects `fee_frameworks`
where `status = 'published'` and the date window is open. **Nothing in the
codebase creates a framework except an authenticated administrator using
`/admin/fees`** — `createFramework()`, `addRule()` and `publishFramework()` have
no other callers, and no seed, migration or bootstrap inserts one. So on a fresh
database:

```
activeFramework(...)  ->  null
```

Every caller handles `null` explicitly rather than defaulting to a number:

| Caller | Behaviour with no framework |
|---|---|
| `src/pages/training/estimate.astro:67` | Skips `computeFee()` entirely; the page says a quotation is prepared |
| `src/pages/training.astro:50` (via `src/lib/training-fee-state.ts`) | Same |
| `src/pages/admin/leads.astro:202` | Reads it to describe the state, asserts nothing |
| `src/pages/admin/quotes.astro:635` | Same |
| `src/pages/admin/fees.astro:458` | Renders the authoring surface and states that nothing is published |

If a framework somehow existed with no rules, `computeFee()` still returns a
figure of zero **flagged**, not a price:

```ts
requiresManualQuote: !priced,
manualReason: rules.length === 0
  ? `Fee framework ${framework.code} has no rules. The federation has not published a fee for this, so no figure can be shown.`
  : 'No published fee rule covers this combination of requirements. …'
```

A draft framework is refused outright (`framework_not_published`), so a figure
the federation has not approved cannot leak out of a work-in-progress.

| Link | State |
|---|---|
| PUBLIC UI | REAL — `/training/estimate`, `/training` |
| AUTH | REAL — `assertCan('feeframework:write' \| 'finance:write')` inside the module |
| API | Page-level POST on `/admin/fees` and `/admin/quotes` (progressive enhancement, no JSON endpoint) |
| VALIDATION | REAL — rule completeness checked at authoring *and* at compute |
| SERVICE | REAL — `computeFee()` pure w.r.t. the DB, `issueQuote()` persists |
| DATABASE | REAL — Postgres, integer paise, BigInt PPM multiply |
| EVENT | **NONE** — issuing or approving a quotation publishes no `domain_events` row |
| WORKFLOW | Not applicable |
| AUTOMATION | Not applicable |
| NOTIFICATION | **NONE** — rejecting a quotation tells the institution nothing |
| CALENDAR | Not applicable |
| AUDIT | REAL |
| ADMIN UI | REAL and actionable — author, add rules, publish, issue, approve, reject |
| USER UI | REAL — estimator states it is an estimate or says nothing |
| TEST | REAL — `tests/fees.test.ts` |

**Verified separately:** the two-person control on approval is genuine.
`approveQuoteVersion()` compares `userId` against the issuer and refuses a
principal with no `userId`, so holding both `quote:issue` and `quote:approve`
(as `TRAINING_DIRECTOR` does) is not sufficient.

---

## 1.4 Web push

**Classification: DEAD CODE. A complete, correct, 1,386-line implementation that
no request can reach.**

All four things the brief asks about:

| Question | Answer | Evidence |
|---|---|---|
| Is there a service worker? | Yes, and it has no push handler | `public/sw.js` is 49 lines of precache and fetch strategy. `grep -c "addEventListener('push'\|notificationclick" public/sw.js` → **0** |
| Is there a VAPID key path? | The function exists; nothing calls it | `vapidPublicKey()` at `src/lib/push.ts:434`. No caller anywhere in `src/`. There is no route a browser can fetch the application server key from |
| Is there a real subscribe? | No | `subscribe()` at `src/lib/push.ts:587` has no caller in `src/`. No page calls `pushManager.subscribe()`; `grep -rn "pushManager" src/` finds only the comment at `push.ts:428` |
| Does anything send? | No | `sendToUser()`, `sendTestToSelf()`, `deliverPushForNotifications()`, `deliverQueuedPush()`, `myDevices()`, `setPreference()`, `pushHealth()` — zero callers in `src/pages` |

The **only** import of `@/lib/push` in the entire `src/` tree is:

```
src/pages/admin/notifications.astro:64   import { pushStatus } from '@/lib/push';
```

— which reads the status and correctly reports push as unconfigured.

`src/layouts/Base.astro:657` does register the service worker
(`navigator.serviceWorker.register('/sw.js')`), so the offline caching is live.
That is the whole of what the worker does.

| Link | State |
|---|---|
| PUBLIC UI | **MISSING** — no permission prompt, no settings surface |
| API | **MISSING** — no `/api/push/subscribe`, no key endpoint |
| SERVICE | REAL and complete — RFC 8188 content encoding, RFC 8291 encryption, RFC 8292 VAPID ES256 |
| DATABASE | Schema present — `push_devices`, `notification_deliveries`, preferences |
| NOTIFICATION | **MISSING** — nothing calls the sender |
| TEST | REAL — `tests/push.test.ts`, including RFC test vectors |

**Missing links, named:** a `push` and `notificationclick` handler in
`public/sw.js`; an endpoint exposing `vapidPublicKey()`; a client that calls
`pushManager.subscribe()` and posts the subscription to a route calling
`subscribe()`; and a call to `deliverQueuedPush()` from
`src/pages/api/cron/reconcile.ts`. Four links, all absent. The engine is
unreachable until all four exist.

---

# Part 2 — the rest of the system

## 2.1 Membership registration (public)

**Classification: BROKEN AS A CHAIN — DUPLICATED store, and approval creates no
member.**

| Link | Where | State |
|---|---|---|
| PUBLIC UI | `src/pages/registration.astro` | REAL |
| AUTH | None (correct for public intake) | REAL |
| API | `src/pages/api/register.ts` | REAL |
| VALIDATION | `validateApplication()`, `src/lib/registration.ts` — per-type questions, DOB, guardian consent for minors, state validated against the federation's own list | REAL |
| SERVICE | **NONE** — the route builds the record inline | INLINE |
| DATABASE | **Redis list `registrations`** via `pushToList(…, 2000)` — **not Postgres** | DUPLICATED |
| EVENT | NONE | MISSING |
| WORKFLOW | NONE | MISSING |
| AUTOMATION | NONE | MISSING |
| NOTIFICATION | NONE | MISSING |
| AUDIT | On decision only, via `/api/queue/decide` | PARTIAL |
| ADMIN UI | `/admin/queue` → `QUEUES.registrations`, gated on `membership:issue` | REAL |
| USER UI | `/application?ref=…&token=…` — both halves required | REAL |
| TEST | `tests/registration.test.ts`, `tests/queue.test.ts` | REAL |

**The break.** `decide()` in `src/lib/queue.ts` changes a string on a Redis JSON
record and appends to its `history` array. That is all it does:

```ts
rows[index] = { ...record, status: toStatus, decidedOn: …, history: [...] };
await storageSet(decision.queue, rows);
```

Approving a membership application therefore creates **no `persons` row, no
`memberships` row and no federation ID**. Meanwhile:

- `/admin/membership` queries `schema.persons` / `schema.memberships` in Postgres.
- `/api/verify` → `verifyCredential()` queries Postgres.

**So a member who registers on the public site and is approved by an
administrator remains invisible to `/verify` and to `/admin/membership` for
ever.** There is a real membership domain in `src/db/membership.ts` (633 lines)
and the public registration path does not touch it.

*Missing link:* `decide()` — or a handler wrapping it — must call into
`src/db/membership.ts` to create the person and the membership when a
registration reaches `Approved`. The Redis list is an intake buffer that was
never joined to the register.

---

## 2.2 Affiliation

**Classification: PUBLIC PAGE IS STATIC; the domain module is real and reachable
only for reads.**

| Link | Where | State |
|---|---|---|
| PUBLIC UI | `src/pages/affiliation.astro` — imports only `get` from `@/lib/storage` | **STATIC** — editorial content, no form, no intake |
| SERVICE | `src/db/affiliation.ts`, 1,649 lines | REAL but barely reached |
| ADMIN UI | No `/admin/affiliation` page exists | MISSING |
| Read path | `publicDirectory()` used by `src/pages/dojos.astro:34` and `src/pages/api/v1/[...route].ts:69` | REAL |

`src/db/affiliation.ts` is imported by exactly two files in `src/pages`, both for
the public directory read. Everything else it exports — the affiliation
lifecycle — has no surface.

*Missing link:* there is **no way to apply for affiliation**. `/affiliation`
describes the process and links onward; no route accepts an affiliation
application. `EnrollCTA.astro` links to `/affiliation` as one of three paths,
and that path terminates in prose.

---

## 2.3 Credential verification

**Classification: REAL+WIRED. Exemplary.**

`/verify` and `/registration` → `/api/verify?id=` → `verifyCredential()` in
`src/db/grading.ts`, with a Redis legacy-register fallback when
`isConfigured()` is false. Rate-limited 30/60s. The enquirer's IP is hashed, not
stored. Crucially it **reports its provenance** — `examined`,
`unverified_legacy`, `legacy_register` — rather than presenting three different
strengths of claim identically.

Missing: no `audit_events` row per lookup (a hashed record is written, but a
verification is a read and this is defensible).

---

## 2.4 Grading

**Classification: REAL+WIRED (admin), no user-facing surface.**

`/admin/grading` → `/api/grading/[...action]` with nine actions: `eligibility`,
`apply`, `assign-examiner`, `score`, `decide`, `issue-certificate`,
`revoke-certificate`, `lock`. Service in `src/db/grading.ts`, audited, and the
result feeds `/verify`.

| Missing link | Where it should be |
|---|---|
| EVENT | `GRADING_APPROVED`, `CERTIFICATE_ISSUED`, `CERTIFICATE_REVOKED` are declared in `EVENT_TYPES` (`src/lib/domain-events.ts:175,190,195`) and in `NOTIFIABLE` (`src/lib/notifications.ts`), but **`src/db/grading.ts` never calls `publish()`**. The events are defined and never emitted |
| NOTIFICATION | Consequently, a candidate is never told their result. See §2.11 |
| USER UI | `/my/passport` shows ranks; there is no "your grading" surface |

---

## 2.5 Competition

**Classification: REAL+WIRED, the most complete admin chain in the system.**

`/admin/competition` → `/api/competition/[...action]` with seventeen actions
(`create-event` … `finalise-results`), plus three public ones
(`public-events`, `public-event`, `scoreboard`).

Public: `/competitions` and `/scoreboard` import `publicEvents`,
`publicEventDetail`, `publicScoreboard` **directly from the API route file** —
one definition of what is public, shared rather than duplicated. `/scoreboard`
also polls `/api/competition/scoreboard` client-side.

| Missing link | Detail |
|---|---|
| EVENT | `ENTRY_CONFIRMED`, `DRAW_PUBLISHED`, `RESULT_FINALIZED`, `RANKING_UPDATED` are in `NOTIFIABLE`; `src/db/competition.ts`, `draws.ts`, `matches.ts` and `rankings.ts` publish no domain events |
| NOTIFICATION | No entrant is ever told an entry was confirmed or a draw published |
| REALTIME | `/scoreboard` polls. `/api/stream/[channel]` exists and **nothing subscribes** — see §2.13 |

---

## 2.6 Marketplace

**Classification: REAL+WIRED.**

`/portal/listings`, `/portal/listings/[id]`, `/admin/listings` →
`/api/marketplace/[...action]`: `seller/apply`, `seller/withdraw`,
`listing/create|update|stock|submit|withdraw`, and the review side
`seller/approve|reject|suspend|reinstate`, `listing/review|delist`. Service in
`src/db/marketplace.ts`, audited, scope-filtered.

Missing: EVENT and NOTIFICATION. A seller whose listing is rejected learns it by
returning to the portal.

---

## 2.7 Governance, safeguarding and discipline

**Classification: REAL+WIRED for everything except raising a ticket.**

`/admin/governance` and `/admin/cases` → `/api/governance/[...action]`, which
registers 25 handlers across committees, documents, meetings, resolutions,
action items, interest declarations, safeguarding cases, disciplinary cases and
support tickets.

**One specific hole.** `raiseTicket()` lives at `src/db/cases.ts:1212`. The
governance router exposes `ticket/assign`, `ticket/respond` and `ticket/resolve`
— but **not `ticket/raise`**. A grep for `raiseTicket` across `src/` finds only
its definition and two comments; the only callers are in `tests/cases.test.ts`.

`/contact` offers `mailto:` links and no form.

**So there is no route by which a member of the public, or a member of the
federation, can open a support ticket.** `/admin/support` (§2.9) renders a desk
that nothing can put work into.

*Missing link:* a `'ticket/raise'` entry in the `HANDLERS` map of
`src/pages/api/governance/[...action].ts`, and a form somewhere — `/contact` is
the obvious place.

---

## 2.8 Approvals (two-person control)

**Classification: REAL+WIRED.**

`/admin/approvals` → `/api/approvals/[...action]` → `src/lib/approvals.ts`.
Refuses self-approval and unidentified principals with distinct codes
(`self_approval`, `unidentified_principal` → 403;
`already_approved_by_you` → 409). Audited. `tests/approvals.test.ts` and
`tests/rbac-adversarial.test.ts` cover it.

---

## 2.9 Tasks and support desk

**Classification: UI ONLY — read-only surfaces over real engines.**

| | Tasks | Support |
|---|---|---|
| SERVICE | `src/db/tasks.ts` — `claimTask`, `startTask`, `blockTask`, `completeTask`, `cancelTask`, `addDependency` | `src/db/support.ts` — `postTicketMessage`, `linkTicketToInstitution`, `reopenTicket` |
| ADMIN UI | `/admin/tasks` — `taskQueue()`, `taskCounts()`. **No POST branch, no form** | `/admin/support` — `supportDesk()`, `supportCounts()`. **No POST branch, no form** |
| Callers of the write functions in `src/pages` | **none** | **none** |

Tasks *are* created — by the `create_task` workflow action — and escalated, by
`escalateOverdueTasks()` from the daily cron. But `dueInHours` is `null` on every
standard template, so **nothing is ever overdue and the escalation sweep can
never fire**. That is correct behaviour under the no-invented-service-standard
rule, and it means the only automatic movement a task can experience is
unreachable.

**Net effect: a task can be created and read, and cannot be completed by anybody.**

*Missing links:* a POST branch in `src/pages/admin/tasks.astro` calling
`claimTask`/`completeTask`; a POST branch in `src/pages/admin/support.astro`
calling `postTicketMessage`/`reopenTicket`.

---

## 2.10 Leads and CRM

**Classification: REAL+PARTIALLY WIRED — read-only, and this is documented in
the page itself.**

`/admin/leads` → `leadPipeline()`, `leadDetail()`, `sourceAttribution()` in
`src/db/engagement.ts`, scope-filtered in SQL through `visibleScopes()`. Rows
arrive only from `submitApplication()` → `captureLead()`.

`identifyLead()` — the function that attaches a lead to a canonical institution
or person — has **no caller in `src/pages`**. So a lead cannot be identified,
assigned an owner, moved through the nine pipeline stages, or annotated. The
pipeline tab strip renders nine stages that nothing can move a row between.

*Missing link:* `engagement:write` handlers. There is no POST endpoint for
leads anywhere in `src/pages/api`.

---

## 2.11 Notifications

**Classification: REAL+PARTIALLY WIRED, with the fan-out entirely absent.**

### What is real

- One table. `s.notifications` and `g.notifications` are the **same** table —
  `src/db/schema.ts:341` re-exports `./governance.schema`. Verified; not a
  duplicate.
- `/my/notifications` is a real inbox: `src/db/notifications-inbox.ts` →
  `inbox()`, `unreadCount()`, `markAllRead()`, `markRead()`. It takes no
  identifier of any kind; the recipient is resolved from the session inside the
  module. Marking read is a form POST, so it works without JavaScript.
  `safeLink()` validates any stored link before redirecting.
- `/admin/notifications` reports transport status honestly via
  `transportStatus()` and `pushStatus()`.
- `send_message` and `notify_role` workflow actions really do insert rows,
  deduplicated by a unique index on `dedupeKey`.

### What is missing, precisely

**(a) Nothing drains the queue.** `deliverQueued()` (`src/lib/notifications.ts:190`)
has **no caller outside `tests/notifications.test.ts`**.
`src/pages/api/cron/reconcile.ts` runs `expireStaleOrders`, payment retries and
`runDailySweeps()` (workflow retries, task escalation, ticket escalation) — and
does not call `deliverQueued`.

Consequence beyond email: `deliverQueued()` is also what flips an `in_app`
notification from `queued` to `sent`. In-app rows therefore sit at `queued` for
ever. `/my/notifications` renders them anyway (`notifications-inbox.ts:373` maps
`queued` → `waiting`), so the inbox works — but the queue never empties and
`queueHealth()` would report a permanently growing backlog if anything called it.

**(b) The event → notification fan-out has no consumer.** `notifyForEvent()`
(`src/lib/notifications.ts:400`) has **no caller anywhere in `src/`**. Nothing
walks the `domain_events` feed.

**(c) And if a consumer existed, it would find nothing to act on.** This is the
sharpest finding in this section. `NOTIFIABLE` lists twelve event types:

```
GRADING_APPROVED, CERTIFICATE_ISSUED, CERTIFICATE_REVOKED, MEMBERSHIP_EXPIRING,
ENTRY_CONFIRMED, RESULT_FINALIZED, DRAW_PUBLISHED, RANKING_UPDATED,
LIVE_STARTED, AFFILIATION_EXPIRING, CASE_ACKNOWLEDGED, APPROVAL_REQUESTED
```

`publish()` from `src/lib/domain-events.ts` is called from exactly one place in
production code: the `record_event` action in `src/db/automations.ts`. The only
event types any workflow passes to it are:

```
INSTITUTION_APPLICATION_SUBMITTED, COACH_APPLICATION_SUBMITTED,
COACH_ASSIGNMENT_RECOMMENDED
```

**The intersection of those two sets is empty.** Wiring `notifyForEvent()` to the
feed today would produce zero notifications, because no domain module —
grading, competition, membership, rankings, cases, affiliation — publishes a
domain event at all. They write `audit_events` instead.

*Missing links, in order of dependency:* `publish()` calls inside
`src/db/grading.ts`, `src/db/competition.ts`, `src/db/membership.ts`,
`src/db/rankings.ts`, `src/db/cases.ts` and `src/db/affiliation.ts`; then a
consumer calling `notifyForEvent()`; then a `deliverQueued()` line in
`src/pages/api/cron/reconcile.ts`; then an `EMAIL_PROVIDER_URL`.

**(d) Superseded and now unused:** `myNotifications()` and `queueHealth()` in
`src/lib/notifications.ts` have no callers — `src/db/notifications-inbox.ts`
replaced the read side and correctly re-exports `markRead` from the engine
rather than copying it.

---

## 2.12 Calendar

**Classification: REAL+WIRED.**

`/calendar` → `federationCalendar()` in `src/lib/calendar.ts` with the caller's
principal. `/calendar.ics` → the same function with a **null principal**,
deliberately, and a documented refusal to read the session cookie: a subscribed
feed URL that leaked would otherwise disclose another unit's draft fixtures.
Returns 503, not an empty calendar, when unconfigured — so a client shows an
error rather than "no events".

Undated announcements are excluded from the `.ics` and kept on `/calendar`.

Missing: external calendar sync (`calendarConnections`, `calendarEvents`,
`calendarSyncLog` exist as tables with no OAuth). SCAFFOLDED.

---

## 2.13 Realtime (SSE)

**Classification: UNUSED — server complete, no client.**

`/api/stream/[channel]` is a careful implementation: rate limit, configuration
check, `identify()`, `authoriseChannel()`, concurrency slot, `Last-Event-ID`
resume. `src/lib/realtime.ts` is 1,018 lines with `tests/realtime.test.ts`.

`grep -rn "EventSource" src/` returns **nothing**. No page subscribes.
`/scoreboard` polls `/api/competition/scoreboard` on a timer instead.

And per §2.11(c), the feed the stream reads from carries only three event types
in practice.

---

## 2.14 Export

**Classification: REAL+WIRED at the endpoint; no surface.**

`/api/export/[kind]` → `runExport()` in `src/lib/export.ts`. Two gates
(`export:run` **and** the kind's own read action), scope as a SQL predicate,
`audit_events` row per file, formula injection neutralised, UTF-8 BOM, money as
integer paise. Origin checked even on the GET, with the reason documented.
`tests/export.test.ts` and `tests/export-route.test.ts`.

*Missing link:* nothing in `src/lib/surface.ts` navigation links to it. An
administrator cannot run an export without constructing the URL by hand.
CSV and JSON only; XLSX and PDF are refused by name rather than silently
substituted.

---

## 2.15 Payments and commerce

**Classification: REAL+WIRED, with a genuine exceptions queue.**

`/shop` → `/checkout` → `/api/payments/checkout` → provider →
`/api/payments/webhook` (signature-authenticated, exempt from the Origin check
by an explicit allow-list in `src/middleware.ts`) → `confirmPayment()` in
`src/db/orders.ts`.

The webhook returns 200 on a fulfilment failure — deliberately, since a provider
retry would hit the replay guard — and `/api/cron/reconcile` re-reads the
payment **from the provider** and retries. Anything still failing is reported in
`stillFailing`, surfaced rather than swallowed.

---

## 2.16 Academy and live classes

**Classification: REAL+WIRED.**

`/academy`, `/live`, `/my/courses` → `/api/academy/[...action]`: `enrol`,
`lesson-complete`, `quiz-start`, `quiz-submit`, `live-join`, `live-leave`,
`question-ask`, `question-upvote`. Service in `src/db/academy.ts` (2,506 lines),
`tests/academy.test.ts`.

Missing: `LIVE_STARTED` is in `NOTIFIABLE` and is never published (§2.11c).

---

## 2.17 Unit portal

**Classification: REAL, but on the Redis side of the split.**

`/unit` → `/api/unit/login|logout|submit`. `submit` stamps the unit identity
server-side from the session, so a unit can only submit as itself. Writes to
Redis list `submissions`, reviewed at `/admin/queue` under `QUEUES.submissions`.
Never in `PUBLIC_KEYS`.

Same structural issue as §2.1: `decide()` moves a string in Redis. Publishing a
unit's news report does not put it anywhere the public site reads from.

---

## 2.18 Editorial CMS

**Classification: REAL+WIRED.**

`/admin` (shared-password console) → `/api/data/[key]` → `set()` → Redis.
Public read via `/api/data`, which filters `PRIVATE_KEYS` **on the way out**, so
a key added to that list is excluded automatically. `getAll()` is one MGET.
`guardShape()` falls back to seed when a stored value's broad shape disagrees, so
a bad admin save cannot crash a public page. Covered by
`tests/data-api-exposure.test.ts` and `tests/data-api-lockdown.test.ts`.

Around a dozen public pages are STATIC over this store: `/network`,
`/documents`, `/governance`, `/academy`, `/affiliation`, and others import only
`get` from `@/lib/storage`.

---

## 2.19 Audit

**Classification: REAL+WIRED.**

`writeAudit()` is called from 23 domain modules. `/admin/audit` reads
`s.auditEvents` with filters on entity type, action, entity id, actor and date
range, and renders a **diff** — only the fields that changed — rather than raw
jsonb.

Not audited: `src/db/analytics.ts`, `src/db/athletes.ts`,
`src/db/notifications-inbox.ts` — all read-only modules, correctly.

*Missing link:* `/admin/audit` has no export, so an external auditor cannot be
given an extract. The export engine exists (§2.14) and the two are not joined.

---

## 2.20 Event entries

**Classification: BROKEN — the intake and the queue read two different keys.**

`/events` → `/api/event-register` → `pushToList('eventRegs', record, 1000)`.

`src/lib/queue.ts` defines the queue as `QUEUES.eventEntries`, and both
`queueSummary()` and `openItems()` call `getList(queue)` using the queue's **own
name** as the storage key. So the approval engine reads a list called
`eventEntries` and the intake writes one called `eventRegs`. **No event entry
submitted by the public can ever be decided.**

This is a name mismatch, not a missing feature, and the codebase already knows
about it: `src/pages/admin/queue.astro:81` deliberately reads the `eventRegs`
list when the `eventEntries` queue comes back empty and tells the operator, in
words, that the entries are stranded and why. That is the right behaviour for a
surface that cannot fix the underlying bug — but the feature is still broken.

*Missing link:* the two names must agree. Either `QUEUES.eventEntries` gains an
explicit storage key of `eventRegs`, or `src/pages/api/event-register.ts:78`
writes to `eventEntries`. The second choice strands whatever is already stored,
so the first is the safe one.

`tests/queue.test.ts` exists and did not catch this, because it exercises
`decide()` against a list it seeds itself rather than against the key the intake
route actually writes.

---

## 2.21 Search, commands, analytics

- **Search.** `/search`, `/api/search/global` → `src/lib/global-search.ts` +
  `src/lib/search.ts`. REAL+WIRED, scope-filtered.
- **Command palette.** `src/lib/commands.ts` (1,028 lines) →
  `CommandPalette.astro`, 27 kB of client script. REAL+WIRED. Several of its
  destinations are read-only pages (§2.9, §2.10), so the palette can navigate to
  work that cannot be done.
- **Analytics.** `/admin/report` → `annualReport()` in `src/db/analytics.ts`.
  REAL+WIRED, read-only by design.

---

# Part 3 — registers

## 2.22 The location engine and the identity foundation

**Added 17 August 2026 (migration 0025). Classification: REAL+PARTIALLY WIRED —
complete at the domain layer, UNWIRED at every surface.**

Stated first because it is what a reader most needs to know: `src/db/geography.ts`
and `src/db/identity.ts` are gated, audited and covered by 99 passing tests, and
**no file under `src/pages` imports either of them.** By this document's own
rule — a link is REAL only if a specific file does the work — the public and
admin links below are absent, not weak.

| Link | State |
|---|---|
| PUBLIC UI | **ABSENT.** Registration still collects a free-text city (`src/lib/registration.ts` `CORE_FIELDS`). |
| AUTH | n/a at the domain layer; every write takes an `AuditContext` carrying a `Principal`. |
| API | **ABSENT.** No endpoint. |
| VALIDATION | REAL — `GeographyError` / `IdentityError` with codes and fields, one normaliser used on both sides of every lookup. |
| SERVICE | REAL — `geography.ts` (≈17 exported functions), `identity.ts` (≈28). |
| DATABASE | REAL — Postgres, 12 tables + 8 columns on `persons`. RLS enabled by `0026_data_api_lockdown.sql`. |
| EVENT | **ABSENT.** No `domain_events` row is published. `PersonVerified`, `RoleAssigned` and the rest named in the brief are not emitted. |
| WORKFLOW | **ABSENT.** |
| AUTOMATION | PARTIAL — `detectPersonDuplicates()` raises candidates, and nothing calls it on the intake path yet. |
| NOTIFICATION | **ABSENT.** |
| CALENDAR | n/a. |
| AUDIT | REAL — `writeAudit()` on every privileged mutation, and **deliberately without the payload**: contact values and address lines are excluded, because an audit trail is read by more people than the record itself. |
| ADMIN UI | **ABSENT.** `duplicateQueue()` and `profileChangeQueue()` have no page. |
| USER UI | **ABSENT.** No parent surface; the `PARENT` role still has nowhere to go. |
| TEST | REAL — `tests/geography.test.ts` (37), `tests/identity.test.ts` (62). |

### The separation this domain is built on

`state_units` / `district_units` are the register of CHARTERED MMAKF BODIES.
`countries` / `admin_areas` are a map. **No foreign key joins the two ladders in
either direction**, and `tests/geography.test.ts` asserts that structurally by
reading `information_schema`. The day somebody adds one, a member living in a
state MMAKF has not chartered becomes unrecordable again — which is exactly the
state this migration was written to end.

*Missing links, named:* no surface, no endpoint, no domain event, no
notification. Items 0a–0c in IMPLEMENTATION-QUEUE.md are these four.

---

## 3.1 Unreachable production code

Real, tested modules and functions with **no caller in `src/`**:

| Symbol | File | Notes |
|---|---|---|
| everything except `pushStatus()` | `src/lib/push.ts` | 1,386 lines. §1.4 |
| `notifyForEvent()` | `src/lib/notifications.ts:400` | The fan-out |
| `deliverQueued()` | `src/lib/notifications.ts:190` | Tests only |
| `myNotifications()`, `queueHealth()` | `src/lib/notifications.ts:306,366` | Superseded by `notifications-inbox.ts` |
| `reviewApplication()`, `assignApplication()` | `src/db/applications.ts:977,1046` | Detail page exists and is read-only |
| `claimTask`, `startTask`, `blockTask`, `completeTask`, `cancelTask`, `addDependency` | `src/db/tasks.ts` | No task actions |
| `postTicketMessage`, `linkTicketToInstitution`, `reopenTicket` | `src/db/support.ts` | Read-only desk |
| `raiseTicket()` | `src/db/cases.ts:1212` | No route raises a ticket |
| `identifyLead()` | `src/db/engagement.ts:307` | No `engagement:write` endpoint |
| `src/lib/mfa.ts` (316 lines) | — | No importer in `src/` at all |
| `src/lib/uploads.ts` (322 lines) | — | No importer in `src/` at all |
| SSE client | — | `/api/stream` has no subscriber |

## 3.2 Two intakes, two stores

The system has a Postgres spine and a Redis spine, and public intake is split
across both. This is the single largest structural finding.

| Intake | Store | Reaches the Postgres register? |
|---|---|---|
| `/learn/apply` → `submitApplication()` | Postgres | **Yes** |
| `/api/register` (membership) | Redis `registrations` | **No** — §2.1 |
| `/api/event-register` | Redis `eventRegs` | **No** — and not even reachable by its own queue, §2.20 |
| `/api/unit/submit` | Redis `submissions` | **No** — §2.17 |
| `/api/enroll` | Redis `leads` | Retired this run — §1.1 |

`/admin/queue` decides all of the Redis ones and its decisions never leave
Redis. Rule 74 — no duplicate organisation, person or coach entity — is
respected *within* Postgres and broken *across* the two stores: a school can
exist as a Redis registration and as a Postgres institution with nothing joining
them.

## 3.3 Missing links, consolidated

Ordered by what a federation would feel first.

1. **An approved membership creates no member.** `src/lib/queue.ts` → `src/db/membership.ts`.
2. **No event entry can be decided.** `eventRegs` vs `eventEntries` — §2.20.
3. **An institutional application cannot be decided.** A decision surface calling `reviewApplication()`.
4. **A task cannot be completed.** POST branch in `src/pages/admin/tasks.astro`.
5. **Nobody can raise a support ticket.** `'ticket/raise'` in the governance router; a form on `/contact`.
6. **No message is ever sent.** `deliverQueued()` in the cron; a provider.
7. **No domain module publishes a domain event**, so the notification allow-list, the fan-out and the SSE feed all have nothing to work on.
8. **Web push needs four separate links** before a single push can be delivered.
9. **No export screen.** The endpoint is audited and unlinked.
10. **No affiliation application route.** `/affiliation` is prose.
11. **Dead lead panel** on `src/pages/admin/index.astro`.

---

# Part 4 — where this contradicts `docs/IMPLEMENTATION-STATUS.md`

That file is more honest than most documents of its kind — its entries on web
push, `notifyForEvent()` and `deliverQueued()` match what I found by reading the
code, and it says plainly that the fee engine ships empty. The following are the
places it is **stale, overstated, or silent where it should not be**.

### Overstated

**1. "Full derivation from one submission … Institution, lead, request, owner,
task, timeline, acknowledgement. Proved idempotent."**
The derivation is real and the idempotency is real. But the row implies a single
atomic operation and there is **no transaction** — see §1.2. Three of the seven
named records are created inside `try/catch` blocks that record a failure event
and continue, so "full derivation" is the success path, not a guarantee. The row
should say so.

**2. "Admin: applications, tasks, coaches, support — Scope-filtered in SQL;
menu filtered by RBAC; recomposed for phones." Listed under BUILT.**
All three claims are true and none of them is the important fact.
**`/admin/applications`, `/admin/tasks` and `/admin/support` are read-only.**
The file explicitly flags `/admin/leads` as read-only and does not extend the
same disclosure to these three, which reads as if they are actionable. They are
not: no POST branch, no form, and the decision functions for all three have no
caller. An administrator cannot review an application, complete a task or answer
a ticket anywhere in this system.

**3. "Live 404s from links the site publishes: 0".**
True for published page links, which is what the metric measures. It does not
cover links the *system* generates: `adminUrl` in `src/db/automations.ts` resolves
to `/admin/applications/{id}`, which does not exist. Every role notification
raised on an institutional application carries it.

### Stale

**4. "In-app notifications … Missing: A surface. There is no bell and no
notification centre, so a member cannot read an in-app notification." Listed
under SCAFFOLDED.**
**No longer true.** `src/pages/my/notifications.astro` is a complete inbox built
on `src/db/notifications-inbox.ts` — filtering, topics, unread count, mark-read
and mark-all-read as form POSTs, `safeLink()` guarding the deep link.
`/admin/notifications` renders the delivery overview. The functions the file
names (`myNotifications()`, `markRead()`, `queueHealth()`) are indeed uncalled,
but because a better read side superseded them, not because no surface exists.
There is still **no bell** — no layout renders `unreadCount()` — so the entry is
half right for the wrong reason.

**5. The numbers table.** It says **73** test files; there are **75** at this
commit. The file's own instruction — "re-run the commands before citing a number
from it" — is correct and was not followed by whoever last edited it. I did not
re-count tables, migrations, routes or statuses.

### Silent where it should not be

**6. Nothing in the file discloses the Redis/Postgres intake split (§3.2).**
"Never invent a federation fact" is stated as standing rule 1, and the split
produces a worse failure than an invented fact: an approved membership
application that creates no member, reported to the applicant as approved. This
is the gap most likely to be discovered by a member rather than by a developer,
and it is not mentioned anywhere in the status document.

**7. Nothing discloses that no domain module publishes a domain event.**
The file describes the notification gap as "a consumer" — one missing link. It
is two: the consumer, and the producers. §2.11(c) shows that the set of event
types actually published and the set of event types `NOTIFIABLE` acts on do not
intersect at all, so building the consumer alone would deliver nothing and would
look, from the test suite, as though it worked.

**8. Nothing discloses that no task can ever escalate.**
The file lists task escalation under BUILT and separately notes that every
deadline is NULL. Both are true; together they mean `escalateOverdueTasks()` —
which the daily cron calls — has no reachable code path. That is the correct
behaviour under the no-service-standard rule and it should be stated as a
consequence rather than left for a reader to derive from two distant rows.

---

## What this audit did not verify

Stated so that no reader takes silence for confirmation.

- The full test suite was not run; only the two suites named in the brief.
- Nothing was exercised against a live Postgres or a live Redis. Every finding
  above is from reading source at `802daf7`.
- Table, migration, route and status counts were not re-counted.
- RLS policies and migration contents were not read.
- The working tree was changing during this audit. §1.1 in particular describes
  a component and an endpoint that were rewritten while it was being written,
  and both states are recorded.

---

## Technical knowledge library (added with migration 0031)

| Layer | Wired to | Enforced where |
|---|---|---|
| `technical_sources` → `technical_citations` | Every library record, polymorphically | `CHECK (source_id IS NOT NULL OR source_url IS NOT NULL)` — a citation citing nothing is refused |
| `media_assets.rights` → learner surfaces | `mediaUse()` in `src/db/library.ts` | Write path (`reviewLink`) refuses approval on unresolved rights; read path (`mediaFor`) filters again |
| `media_technical_links.state` → `/admin/technical-library` | `reviewQueue()` | `technical:read` to see, `technical:review` to decide |
| Approval → a named person | `kata_applications`, `media_technical_links` | DB `CHECK`: approved rows must carry both an approver and a timestamp. A classifier has no person id and therefore cannot write one |
| Reviewer identity | `users.person_id` via the session | Resolved server-side in the admin page; the posted value is ignored, so a decision cannot be attributed to a colleague |
| `reference_curricula` → grading engine | **Deliberately not wired** | The grading engine reads `grade_requirements`; it has no path to `reference_curricula`. Another federation's syllabus cannot become examinable by being loaded |
| `sport_kumite_rulesets` → `kumite_forms` | **Deliberately not wired** | Sport regulation and traditional teaching progression are separate tables so neither can be rendered as the other |
| `src/data/shotokan/terminology.ts` → `technical_terms` | `importTerminology()` | One-way projection. The file stays canonical; the database is a searchable copy, not a competing definition |

**Not wired, and why.** No learner route consumes any of this yet — see conflict
4 in [parallel/PATCH-CONFLICTS.md](parallel/PATCH-CONFLICTS.md). The video
register in `src/data/shotokan/video-register.ts` is not yet imported into
`media_assets`; that importer is the next dependency-safe step and is described
in the same document.

---

# Addendum — the marketplace platform (migration 0029)

Traced 17 August 2026 by reading the code.

**The headline finding, stated plainly: the marketplace engine is REAL and the
SURFACES DO NOT EXIST.** Every row below is honest about which links are joined.

| Feature | PUBLIC UI | AUTH | API | VALIDATION | DB | AUDIT | TEST |
|---|---|---|---|---|---|---|---|
| Seller registration | ✗ none | ✓ | ✗ | ✓ `registerAsSeller` | ✓ | ✓ | ✓ |
| Seller verification | ✗ none | ✓ `marketplace:verify` | ✗ | ✓ reason required on refusal | ✓ | ✓ | partial |
| Brand authorisation | ✗ none | ✓ `marketplace:brand` | ✗ | ✓ claim ≠ verified | ✓ | ✓ | ✓ |
| Badges | ✗ none | ✓ `marketplace:review` | ✗ | ✓ derived cannot be granted | ✓ | ✓ | ✓ |
| Taxonomy + product policy | ✗ none | ✓ `marketplace:review` | ✗ | ✓ strictest ancestor | ✓ | ✓ | ✓ |
| Variants | ✗ none | ✓ owner-only | ✗ | ✓ returns listing to review | ✓ | ✓ | ✓ |
| Inventory | ✗ none | ✓ owner-only | ✗ | ✓ CHECK + conditional UPDATE | ✓ | ✓ | ✓ |
| Multi-seller checkout | ✗ none | ✓ | ✗ | ✓ server-priced, public predicate | ✓ | ✓ | ✓ |
| Fulfilment lifecycle | ✗ none | ✓ owner-only | ✗ | ✓ transition table | ✓ | ✓ | ✓ |
| Commission | ✗ none | ✓ `marketplace:commission` | ✗ | ✓ basis required, publish separate | ✓ | ✓ | ✓ |
| Settlement + payout | ✗ none | ✓ `marketplace:settle` | ✗ | ✓ blocked on unresolved commission | ✓ | ✓ | ✓ |
| Returns | ✗ none | ✓ buyer / owner | ✗ | ✓ frozen eligibility, refund ceiling | ✓ | ✓ | ✗ |
| Disputes | ✗ none | ✓ `marketplace:dispute` | ✗ | ✓ reasons required | ✓ | ✓ | ✗ |
| Quarantine | ✗ n/a — removal | ✓ `marketplace:suspend` | ✗ | ✓ reason required | ✓ | ✓ | ✓ |
| Reviews / performance | ✗ none | — | ✗ | schema only | ✓ tables | — | ✗ |
| Public storefront | ✗ none | n/a | ✗ | ✓ allow-list, not redaction | ✓ | n/a | ✗ |

## The links that ARE joined, and are worth recording

**Public visibility is one SQL predicate, used by both the shop and checkout.**
`publicListingPredicate()` has five conditions and `checkout()` resolves the
cart against it — not against a re-implementation. An item that cannot be seen
cannot be bought by guessing its id, and the two rules cannot drift apart
because there is only one of them. Asserted for both suspension and quarantine.

**Seller isolation is a SQL filter on a denormalised column**, applied twice on
the order path (`seller_orders.seller_id` and `order_lines.seller_id`). No
seller-facing function takes a `sellerId`.

**The oversell guard is in the engine, not the application.** A CHECK constraint
plus a conditional UPDATE. The test bypasses every function in the module,
writes the bad state directly, and asserts the database refuses it.

**Money that nobody has priced does not move.** An unresolved commission leaves
`commission_minor` NULL — not 0 — and `closeSettlement()` refuses. Asserted.

## The links that are NOT joined

**PUBLIC UI is absent for every row.** No `.astro` page, no API route. The
engine is reachable only from tests. This is recorded as a finding, not as a
plan: at the time of writing, a seller cannot apply and an administrator cannot
approve one through any surface that exists.

**`src/db/returns.ts` has no test file.** The only 0029 module without one.
