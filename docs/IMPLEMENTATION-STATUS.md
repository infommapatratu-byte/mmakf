# IMPLEMENTATION-STATUS

Per-subsystem state. **No vague completion language** — every row carries one of:

`NOT_STARTED` · `RESEARCH` · `ARCHITECTURE` · `DATABASE` · `BACKEND` · `FRONTEND` ·
`INTEGRATION` · `TESTING` · `STAGING` · `PRODUCTION` · `VERIFIED` · `BLOCKED` ·
`NEEDS_REVIEW` · `DEPRECATED`

`DATABASE` means the schema exists and migrates. It does **not** mean anything uses it.
`VERIFIED` means proven on production, not "the tests pass".

Last updated 2026-08-13 · branch `wave-2b-federation` · production runs `6a44fdf`

**2045 tests passing · 65 test files · 117 tables · 10 migrations · tsc clean · build clean**

Measured on 2026-08-13: `npx tsc --noEmit` exits 0; `npx vitest run` reports
`Test Files 65 passed (65) / Tests 2045 passed (2045)`; `rm -rf .vercel/output && npx astro build`
reports `Server built in 20.88s / Complete!` with no error (the only output is the pre-existing
`@astrojs/vercel` warning that the local Node 25 is not the pinned Node 22 runtime).

A render sweep on 2026-08-13 fetched every route in `src/pages` against `astro dev` with a real
migrated Postgres behind it. Every route that should answer 200 answered 200. The only non-200s are
deliberate: `/404`; an unknown kata slug; `/athlete/[id]` and `/people/[slug]` for records an empty
database does not hold; `/api/verify` with no id (400); `GET /api/data/[key]`, which exports POST
only; and an unknown `/api/v1` resource, which names the five that exist.

---

## Foundation

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| SEC-001 | RBAC policy engine | **VERIFIED** | 16 roles, deny-by-default; 26 adversarial attacks blocked |
| SEC-002 | Audit spine | **BACKEND** | Actor/old/new/reason/authority; IP hashed. Wired into federation, content, queue |
| SEC-003 | Per-user authentication | **TESTING** | scrypt, lockout, live role resolution, session epoch. 35 tests. Blocked on DB for production |
| SEC-004 | Identity choke point `identify()` | **BACKEND** | 13 tests. Wired into `/api/data/[key]`, `/api/queue/decide` |
| SEC-005 | CSRF middleware | **BACKEND** | Origin + Sec-Fetch-Site + JSON content type |
| SEC-006 | Rate limiting | **PRODUCTION** | Redis fixed-window on every public write |
| SEC-007 | Security headers, CSP, HSTS | **VERIFIED** | Zero CSP violations across 17 pages, CDP-measured |
| SEC-008 | MFA | **TESTING** | TOTP verified against RFC 6238's own vectors. Constant-time verification proven by COUNTING comparisons, not by a stopwatch — the stopwatch measured machine load and failed at random. `MFA_REQUIRED_SCOPE` unset means nothing is required |
| SEC-009 | Two-person control | **TESTING** | `src/lib/approvals.ts`. Self-approval refused even for SUPER_ADMIN |
| SEC-010 | Backups / restore | **VERIFIED** | `npm run backup`. Cycle proven against real Postgres incl. tamper detection and refusal to overwrite live data. NO encryption at rest — see BACKUP-RESTORE §6 |
| SEC-011 | Data API lockdown | **DATABASE** | `drizzle/0010_data_api_lockdown.sql`, 25 tests across two suites. **The rule: a grant nobody remembers making is still a grant.** Revokes `anon`/`authenticated` on every table AND cancels the DEFAULT PRIVILEGES, so a table created tomorrow is not exposed either. Ships **no** policy — a policy would be a permission we cannot justify — and does not force RLS, which would lock the owner out of its own tables. Holds on a plain Postgres with no PostgREST roles present |
| DATA-001 | Migration runner | **VERIFIED** | Transactional, checksummed, refuses edited history. 6/6. **The rule: each FILE is transactional, the RUN is not.** A run that stops part way names the file that stopped it and counts what is committed against what was planned, because an operator told "rolled back" would go looking for an unchanged database and not find one. `--status` never creates the ledger: reporting must not be a write |
| DATA-002 | Local dev Postgres | **VERIFIED** | Real wire protocol, no Docker |
| DATA-003 | Vendor-neutral driver | **VERIFIED** | `postgres.js`. Neon removed at the federation's instruction |
| DATA-004 | Bootstrap CLI (`scripts/create-user.ts`) | **TESTING** | 5 tests. **The rule: an account is made whole or not at all.** User, role binding and audit row are ONE transaction, so a refused binding leaves no orphan user and the operator's corrective re-run succeeds instead of being told the email exists. Every exit path closes the pool — the old `process.exit(1)` on the duplicate branch abandoned a connection, which against a small pooler made the *next* run fail with a connection error rather than a message. The generated password is printed on the failure path too, because a lost COMMIT reply otherwise leaves an account carrying a credential nobody ever read |

## Federation core

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| ORG-001 | State / district / dojo hierarchy | **DATABASE** | Hierarchy validated before authorisation (scope-laundering fix) |
| MEM-001 | Person + membership records | **BACKEND** | One person, many roles. `createPerson`, `issueMembership` |
| MEM-002 | Rank records (append-only) | **BACKEND** | Partial unique index: one active rank per person per kind |
| MEM-003 | Credential separation (§33) | **DATABASE** | instructor/examiner/official/governance are separate tables |
| MEM-004 | Federation ID allocation | **BACKEND** | Atomic sequence, never time-derived. 40-way concurrency tested |
| ORG-002 | Affiliation lifecycle workflow | **TESTING** | `affiliation.ts`. Criteria are configuration; an unconfigured review says so |
| MEM-005 | Public member register | **BLOCKED ON MMAKF** | `publicRegister()` now derives it from active membership joined to active rank, with provenance. The 7 legacy rows remain the only DATA until the federation migrates them via `recordLegacyGrade()`, which requires a note of the evidence held for each. Engineering is done; the content is not. |

## Technical & grading

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| SHOT-001 | Kihon / Kata / Kumite databases | **DATABASE** | `techniques`, `kata`, `kumite_forms`. Empty — content is MMAKF's |
| SHOT-002 | Kata library — `/kata`, `/kata/[slug]` | **FRONTEND** | `src/data/kata.ts`, 42 tests. **The rule: an unknown slug is not a kata.** It 404s rather than rendering an empty page under a name nobody recognises. The 28 entries carry only what is common to Shotokan — name, meaning, movements, the belt at which it is commonly taught. **No MMAKF syllabus requirement is stated**, because which kata MMAKF requires at which grade is BLK-3 and has not been published |
| GRD-001 | Versioned syllabus engine | **DATABASE** | `syllabus_versions`, `grade_definitions`, `grade_requirements` |
| GRD-002 | Grading events + panel | **DATABASE** | Examiner authority frozen at assignment |
| GRD-003 | Candidates + eligibility | **DATABASE** | Decision and reasoning stored, not re-derived |
| GRD-004 | Scorecards | **DATABASE** | Per-examiner, so panel disagreement stays visible |
| GRD-005 | Grading workflow (application → certificate) | **TESTING** | `src/db/grading.ts`, 41 tests. Surfaces in build |
| CERT-001 | Certificate engine | **TESTING** | Issuance refuses anything but a recorded pass; idempotent; revocation revokes the rank it evidenced |
| CERT-002 | Public verification | **BACKEND** | Prefers authoritative records and reports provenance: examined / unverified_legacy / legacy_register. No silent fallback; a DB fault returns 503, never "not found" |

## Competition

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| CMP-001 | Events + lifecycle | **TESTING** | `competition.ts`, 76 tests. Legal-transition map corrected — it listed a move the code refuses |
| CMP-002 | Categories | **TESTING** | Hardcoded gender vocabulary REMOVED by review — it dictated which categories the federation may run |
| CMP-003 | Entries + eligibility | **TESTING** | Evaluated as of the event's first day, not the day the check runs. Quota enforcement NOT atomic — reported, needs a migration |
| CMP-004 | Draw engine | **TESTING** | `draws.ts`. Reproducibility proven: same seed, identical bracket |
| CMP-005 | Matches + live scoring | **TESTING** | `matches.ts`. Running score recomputed from the log so the cache cannot drift |
| CMP-006 | Kata scoring | **DATABASE** | Per-judge, hundredths as integers, discard flags |
| CMP-007 | Results + locking | **TESTING** | Lock was enforced in withdraw() and NOWHERE else — a weigh-in behind a published medal could be overwritten. Fixed |
| CMP-008 | Protests / appeals | **DATABASE** | |
| CMP-009 | Officials appointment | **DATABASE** | Licence snapshot frozen at appointment |
| CMP-010 | On-venue result system / command centre | **NOT_STARTED** | |
| RANK-001 | Ranking rulesets (versioned) | **DATABASE** | Points are data, never code |
| RANK-002 | Ranking calculation + explainability | **TESTING** | `rankings.ts`. Every point traces to a ruleset; exclusions carry their reason |
| NT-001 | National squads + selection basis | **DATABASE** | Selection reasoning recorded; AI cannot decide |

## Education & live

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| EDU-001 | Courses / modules / lessons | **TESTING** | `academy.ts`. Publishing refuses a course whose video is missing |
| EDU-002 | Quizzes + attempts | **DATABASE** | |
| EDU-003 | Enrolment + progress | **DATABASE** | |
| EDU-004 | Attendance (dojo + academy) | **DATABASE** | Presence only — never proficiency |
| LIVE-001 | Authorised media channel registry | **DATABASE** | Refresh tokens encrypted, server-side only |
| LIVE-002 | Broadcast detection | **NOT_STARTED** | Schema ready; poller not built. **Needs YouTube OAuth credentials** |
| LIVE-003 | Live classes + Q&A + resources | **DATABASE** | |
| LIVE-005 | `/live` failure disclosure | **TESTING** | 8 tests, against a real Postgres and a real `astro dev`. **The rule: a refusal is written for the person who hit it; anything else is a fact about the server and belongs in the log.** `readableError()` shows an `AcademyError`/`ForbiddenError` as written and replaces everything else with a summary naming no table, relation, generated statement, host or role — the driver's `relation "live_classes" does not exist` and drizzle's `Failed query` preamble with its bound parameters no longer reach an anonymous visitor. `identify()` and the person lookup moved INSIDE the guarded block: both are database reads and both sat outside it, so the same outage that showed a stranger a card gave a signed-in member a blank 500. On failure the page resets everything it learned, so it cannot render a half-gated list or a hidden-count taken from a list that stopped part way, and it no longer says "You are not signed in" — during a failed read that is a guess, and the wrong guess for exactly the member whose cookie could not be resolved |
| LIVE-004 | Recording association | **NOT_STARTED** | Recording is a different video id from the broadcast |
| MED-001 | Media assets + classification | **DATABASE** | Everything lands `pending_review` |
| MED-002 | Media rights tracking | **DATABASE** | Rights tracked separately from classification |

## Governance & compliance

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| GOV-001 | Committees + appointments | **TESTING** | `governance-ops.ts`. Office holders resolvable at any past date |
| GOV-002 | Document version control | **DATABASE** | SHA-256 so a published file cannot be swapped |
| GOV-003 | Meetings / motions / resolutions | **DATABASE** | Quorum recorded explicitly |
| GOV-004 | Conflict-of-interest declarations | **DATABASE** | |
| SAFE-001 | Safeguarding cases | **TESTING** | `cases.ts`. A FEDERATION_ADMIN cannot read one — proven by test |
| MED-003 | Medical records | **TESTING** | Unconfigured injury rule returns `undetermined`, never a finding under a rule nobody wrote |
| DISC-001 | Disciplinary + appeals | **DATABASE** | |
| SUP-001 | Support / grievance tickets | **DATABASE** | SLA measurable |
| GOV-005 | Elections | **NOT_STARTED** | |

## Money

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| FIN-001 | Order / payment / ledger spine | **TESTING** | 44 tests. Integer paise, double-entry |
| FIN-002 | Provider abstraction | **BACKEND** | Razorpay + manual UPI |
| FIN-003 | Razorpay adapter | **TESTING** | Signature verified over raw body. **BLOCKED on merchant account** |
| FIN-004 | Checkout + webhook endpoints | **BACKEND** | Built, not deployed |
| FIN-005 | Reconciliation cron | **BACKEND** | Hourly; retries captured-but-unfulfilled payments |
| FIN-006 | Fee schedule | **DATABASE** | Amounts are MMAKF's; unpublished fee refuses the order |
| COM-001 | Shop on real orders | **NEEDS_REVIEW** | Rebuilt by agent; under review |

## Onboarding & marketplace

| ID | Subsystem | Status | Evidence |
|---|---|---|---|
| ONB-001 | Registration + role applications | **TESTING** | `src/db/onboarding.ts`, `/register`, `/portal/applications`, 37 tests + 15 security tests. **The rule: registration grants nothing.** A new account holds zero role bindings, so under the deny-by-default engine it reaches exactly one thing — its own record. It **will not write a role binding itself**: an approval calls `grantRole()` gated by `canGrantRole()`, the same path an administrator uses by hand, because a queue with its own private insert into `role_bindings` is privilege escalation wearing an admin screen. Nobody decides their own application, not even SUPER_ADMIN. The binding is made at the scope written on the APPLICATION, never one the reviewer types |
| ONB-002 | Onboarding queue — `/admin/onboarding` | **FRONTEND** | The screen where authority is conferred or refused, with the evidence and a recorded reason. **It does not decide who qualifies** — what grade or licence makes somebody a coach is a federation decision MMAKF has not published, so `evidence` is captured verbatim and judged by a person |
| MKT-001 | Sellers and listings | **TESTING** | `src/db/marketplace.ts`, 51 tests. **The rule: being approved to SELL is not permission to put something in front of the public.** Two gates, deliberately: approving a seller says we know who this is; approving a listing says we have seen THIS item, at THIS price, with THESE photographs. **And the rule that gets forgotten: editing an approved listing returns it to review**, enforced by a content hash, or the second gate is theatre. Public visibility has one definition, `publicListingPredicate()`, and it is SQL — nothing filters after the fetch. It requires the seller to be approved too, so suspending a seller withdraws every listing in the same instant |
| MKT-002 | Seller portal — `/portal/listings` | **FRONTEND** | 38 tests. **The rule: one conversion, one direction.** Rupees reach paise through a single `rupeesToPaise()` that never touches a fractional value — the rupee and padded paise digits are joined as text and read once — and `paiseToRupeeInput()` is the only way back. Two duplicate helpers were deleted. The page takes no seller id from anywhere: the caller's session resolves the shop inside the query |
| MKT-003 | Marketplace review — `/admin/listings` | **FRONTEND** | Both gates on one screen, scoped in SQL to the reviewer's own state, and a seller cannot review their own shop |
| MKT-004 | Commission, fees, categories, turnaround | **BLOCKED ON MMAKF** | Every one of these belongs to the federation and none has a plausible default. Captured or reported as unset — `LISTING_REVIEW_TURNAROUND_NOT_SET` is a named constant so no screen can quietly promise a review time |

## Public surfaces

| ID | Surface | Status | Note |
|---|---|---|---|
| WEB-001 | Home, about, governance, contact | **PRODUCTION** |
| WEB-002 | Registration (4 per-type forms) | **NEEDS_REVIEW** |
| WEB-003 | `/application` status lookup | **NEEDS_REVIEW** |
| WEB-004 | `/regulations` | **NEEDS_REVIEW** — 28/28 links verified |
| WEB-005 | `/press` | **NEEDS_REVIEW** |
| WEB-006 | `/checkout` | **NEEDS_REVIEW** |
| WEB-007 | Admin approval queue | **NEEDS_REVIEW** |
| WEB-008 | Athlete profiles / passport | **FRONTEND** |
| WEB-009 | Dojo directory | **NOT_STARTED** |
| WEB-010 | National command centre | **FRONTEND** |
| WEB-011 | Global search — `/search` | **FRONTEND** | Renders `skipped` and `notices`, not only `hits`. An empty result says which of "nothing here", "not yours to see" and "no rule has been set" it is |
| WEB-012 | Individual profiles — `/people/[slug]` | **FRONTEND** | Grade and titles held apart. Honours render with their source. A clipping appears only where the printed text names that person |
| WEB-013 | Federation calendar — `/calendar`, `/calendar.ics` | **FRONTEND** | Championships, gradings and courses in one place. An undated announcement is never placed on a day, and never enters the feed |
| WEB-014 | Annual report — `/admin/report` | **FRONTEND** | A section with no records prints no zeros. Every figure carries its table, column and filter, on screen and on paper |
| WEB-015 | Portal — `/portal` | **FRONTEND** | 26 tests. **The rule: no role appears anywhere in the catalogue.** Every entry declares the ACTIONS its destination needs and asks `rbac.ts` whether the caller holds one, so widening a role moves the menu on the next request with no edit here. Fails closed — an absent fact reads as false, so a seller record that failed to load hides the control rather than offering one the server would refuse. **The menu is never the control**; each destination re-checks. Route existence is now asserted against the filesystem, which is what caught `/portal/selling` and `/portal/review` being offered and never built |
| WEB-016 | SEO — sitemap, robots, JSON-LD | **TESTING** | `src/pages/sitemap.xml.ts`, `robots.txt.ts`, `StructuredData.astro`, 52 tests across two suites. **The rule: the route list comes from the files, never from a list somebody typed.** The hand-written list had drifted twelve public pages behind the code without anything going wrong. Enumerated by `import.meta.glob` so it is baked in at build time and is correct for exactly the code deployed. **Every page is classified deliberately**: a section declared neither public nor private is `unclassified`, is not advertised, and fails the suite until somebody decides — failing the build beats leaking the URL. Every exclusion carries a written reason, and no page that tells crawlers not to index it is ever advertised. The JSON-LD carries **no rating, no award and no membership count** |

## Cross-cutting

| ID | Subsystem | Status | Note |
|---|---|---|---|
| EVT-001 | Domain event feed | **TESTING** | `src/lib/domain-events.ts`. Cursor-based consumers; a failing consumer does not advance or block others |
| NOT-001 | Notification engine | **TESTING** | `src/lib/notifications.ts`, 25 tests. Allow-list; essential messages unsuppressable; deduplicated on `domainEventId`. **Still no transport** — messages QUEUE rather than fail, and `transportStatus()` says which channels are unconfigured rather than letting the federation believe it is emailing members |
| NOT-002 | Web push | **BACKEND — NOT WIRED** | `src/lib/push.ts`, 34 tests. **The rule: a push system that silently fails to encrypt is worse than none, because the federation would believe members were told.** RFC 8291 §5 and RFC 8188 §3.1 are reproduced BYTE FOR BYTE from the RFCs' own published vectors — not recorded from this implementation, which would prove only that the code has not changed. Proven to bite: moving the last-record delimiter from `0x02` to `0x01`, and swapping the HKDF salt and keying material, each fail the vector. VAPID signs in the flat r||s form JWS needs and scopes `aud` to the endpoint ORIGIN. **`push_devices` exists (migration 0007) but NOTHING IMPORTS THIS MODULE**: there is no subscribe route, no settings surface, and `push` is not a channel in `notifications.ts`. Needs VAPID keys (see queue) |
| ENG-001 | Coach diaries and bookings | **TESTING** | `src/db/booking.ts`, 21 tests. **The rule: the check and the insert are one transaction.** Proven to bite: hoisting the free-slot check out of the transaction turns the two-way race into 2 bookings and the five-way race into 5. **Read the caveat before reading the green run as more than that** — PGlite serialises transactions in-engine, so these tests establish the transaction boundary, NOT that `pg_advisory_xact_lock` excludes two real backends; that needs two connections to a server Postgres and nothing in this repository can do it. IST is handled explicitly: `istInstant()` is what stops a 07:00 Tuesday class appearing on Monday. Session length, notice period, cancellation window and fee are federation policy and **none has a default here** |
| API-001 | Documented public API | **TESTING** | `/api/v1`, `docs/API-ARCHITECTURE.md`, `docs/api/OPENAPI.md`, 35 tests. States plainly that **no API key scheme exists** and what that means for writes |
| RT-001 | Real-time (live scores, live classes) | **TESTING** | `src/lib/realtime.ts` over the domain-event spine, `/api/stream/[channel]`, 42 tests. Authorised at subscribe time, bounded to four minutes so a revoked principal cannot hold a stream |
| AI-001 | Federation assistant | **NOT_STARTED** | Deliberately last — requires authoritative data first |
| A11Y-001 | Accessibility | **TESTING** | WCAG 2.2 AA audit across 43 surfaces, 22 defects fixed, 103 automated guards, `docs/ACCESSIBILITY.md`. Contrast is COMPUTED from the tokens, so reverting one fails the suite with the ratio. Still no axe pass and **no screen-reader testing** — nothing in the audit was ever *heard* |
| OBS-001 | Observability | **BACKEND** | `src/lib/observability.ts`. Secrets and personal data redacted by key substring; probes time out |
| CAL-001 | Federation calendar | **TESTING** | `src/lib/calendar.ts`, 41 tests. Registration answered *as at a date*; sanction carried onto the entry and into the iCalendar feed; RFC 5545 folding at 75 **octets** |
| MEM-004 | Membership standing, renewal, lapse | **TESTING** | `src/db/membership.ts`, 42 tests. Standing is **derived, never stored** — a nightly job that fails on a Friday would have the register calling lapsed members active all weekend, and a stored flag can never answer "was this person covered on the day of the incident" |
