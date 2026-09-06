# MMAKF-SYSTEM-AUDIT

**Full reconnaissance of the repository against the National Federation Digital Operating System
directive.** Every subsystem the directive names, classified by what it actually is today.

| | |
|---|---|
| Audited | 2026-08-12 |
| Branch | `wave-2b-federation` (production still runs `6a44fdf`) |
| Method | Route enumeration, endpoint reading, schema inspection, test execution, live link verification, adversarial probing |
| Verified this pass | 254 tests passing · typecheck clean · build clean · 3 migrations / 25 tables applied to real Postgres · 28/28 external links live |

---

## 1. The single most important fact

**`DATABASE_URL` is not set in production.** `/api/health` reports
`{"redis":true,"database":"not_configured"}`.

Twenty-five relational tables, the RBAC engine, the audit spine, the order/payment/ledger spine and
the user-account system are **built, migrated and tested — and carry no data in production.** Every
subsystem in this directive that requires a system of record is blocked behind one environment
variable. Nothing else on this list is as consequential.

Redis holds the editorial content and four private submission lists. That is the *entire* live data
layer today.

---

## 2. Classification of every existing subsystem

Legend: **W** working · **PW** partially working · **S** stub · **M** mock · **H** hardcoded ·
**B** broken · **X** missing

### 2.1 Foundation — built this cycle

| Subsystem | State | Evidence |
|---|---|---|
| Relational schema (25 tables) | **W** | `drizzle/0000-0002`, applied to real Postgres, 5/5 runner checks |
| Migration runner | **W** | Transactional, checksummed, refuses edited history, `npm run db:verify` |
| RBAC policy engine | **W** | 16 roles, deny-by-default, scope-checked; 26 adversarial attacks all blocked |
| Audit spine | **W** | Actor, old value, new value, reason, authority; IP hashed never stored raw |
| Per-user authentication | **W** | scrypt, lockout, live role resolution, session epoch, bootstrap CLI |
| Identity choke point `identify()` | **W** | 13 tests; a revoked account cannot fall through to a shared credential |
| Commerce spine | **W** | Integer paise, server-side pricing, capture-only-means-paid, replay-guarded webhooks, double-entry ledger |
| Payment provider abstraction | **W** | Razorpay adapter signature-verified; manual-UPI honest about manual confirmation |
| Approval queue engine | **W** | 23 tests; authority per queue, reasons required, append-only history |
| Registration field model | **W** | 4 per-type field sets, minor detection, guardian consent; 27 tests |
| CSRF middleware | **W** | Origin + `Sec-Fetch-Site` + JSON content type; webhooks exempt by explicit path |
| Regulations register | **W** | 28/28 external links verified by content type and size, not status code |
| Link rot checker | **W** | `npm run links:check` — catches soft-404s that status checks call healthy |

### 2.2 Live but structurally wrong

| Subsystem | State | What is actually wrong |
|---|---|---|
| Editorial CMS (Redis, 25 keys) | **PW / ARCHITECTURALLY WRONG for federation records** | Correct for news and pages. Wrong for anything needing integrity — it is where `members` lives, which is why the register was a JSON blob a person hand-typed. |
| Member register / `/api/verify` | **H / MOCK** | Seven hand-typed rows in `seed.ts`. The credential-verification service a parent or employer is told to trust can only ever confirm seven people, and returns grades no examination record supports. **This is the most serious remaining integrity defect.** |
| Event register (`event-register.ts`) | **PW** | Entries bind to an event by display-title string equality. Renaming an event orphans every entry. Events have no identity. |
| Shop | **PW** | Real order spine exists behind it; the catalogue is still CMS rows, and the live site still takes UPI deep links because no gateway is configured. |
| Unit portal | **PW** | Level scoping now correct and fail-closed. But it remains a shared access code, not an account — no individual is attributable. |
| Enrolment leads | **W** | Genuinely works. Lowest-integrity workflow, so Redis is adequate. |

### 2.3 Named by the directive — NOT BUILT

Every one of these is **X — missing**. No schema, no route, no module.

| Domain | Directive section |
|---|---|
| **Competition engine** — events, categories, entries, draws, matches, live scoring, OVR, results, medals | Competition Management → Result Engine |
| **Ranking engine** — versioned rulesets, transparent per-athlete calculation | Ranking Engine, Ranking Auditability |
| **Grading engine** — versioned Kyu/Dan syllabus, candidates, scorecards, examiner workflow | Kyu/Dan Grading Engine |
| **Certificate engine** — issuance, QR, revocation without erasure | Certificate Engine |
| **Shotokan technical system** — Kihon, Kata, Kumite databases | Shotokan System |
| **Athlete registry + Athlete Passport** | Athlete Registry |
| **Officials registries** — referee, judge, examiner, technical delegate, CPD | Officials System |
| **Academy LMS** — course/module/lesson/quiz/assignment/progress | MMAKF Academy |
| **YouTube live integration** — channel registry, broadcast detection, live classes | Live Master Teacher System |
| **Media rights registry** | Media Rights |
| **Governance** — committees, meetings, motions, resolutions, elections | Governance |
| **Safeguarding case system** | Safeguarding |
| **Medical subsystem** | Medical |
| **Disciplinary + appeals + grievance** | Disciplinary System |
| **Sponsorship + partners** | Sponsorship |
| **Parent portal** | Parent Portal |
| **Attendance** | Attendance |
| **Training logs + sports science** | Athlete Development |
| **Research centre, Hall of Honour, historical archive** | Research Centre |
| **Annual report engine** | Annual Report Engine |
| **Domain event feed** (`RESULT_FINALIZED`, `RANKING_UPDATED`, …) | Olympic-Style Data Feed |
| **Notification engine** | Notification Engine |
| **National Command Centre** | National Command Centre |
| **Global search** | Global Search |
| **AI federation assistant** | AI Federation Assistant |

### 2.4 Security posture

| Control | State |
|---|---|
| CSRF, XSS headers, HSTS, CSP enforced | **W** |
| Rate limiting on every public write | **W** |
| RBAC scope isolation (IDOR) | **W** — adversarially verified |
| Audit logging on privileged mutations | **PW** — federation + content + queue covered; Redis-only writes partially |
| Secrets management | **W** — no secret in the repo; seeded portal credentials removed this cycle |
| MFA | **X** |
| Two-person control on sensitive operations | **X** — directive requires it for revocation, Dan approval, result correction |
| Malware scanning on upload | **X** — no upload subsystem exists yet |
| Backups / restore drill / DR runbook | **X** |
| Row-level security | **N/A** — enforcement is in the application policy layer, not Postgres RLS |

---

## 3. Defects found and fixed during this audit cycle

Recorded in full in `docs/AUDIT-REGISTER.md`. Summary of what was **live or about to ship**:

| | Defect |
|---|---|
| **P0** | Scope laundering — placement authorised against caller-supplied ids, so a district admin could file records into another state |
| **P0** | Concurrent promotion left **two active ranks**, making a member's current grade ambiguous |
| **P0** | `pushToList` silently **destroyed** the oldest record at its cap — the 2001st application deleted the 1st |
| **P0** | `/api/data` served the **entire member register** unauthenticated and CDN-cached |
| **P0** | Four **working portal access codes** committed to a public repository, re-enabled by any Redis failure |
| **P0** | **No scheduler at all** — a captured payment that failed to fulfil was money taken with nothing issued, invisible forever |
| **P1** | Audit-trail IDOR — a state officer could read every other state's history |
| **P1** | Unguarded role granting — a federation admin could mint a SUPER_ADMIN |
| **P1** | **No CSRF defence existed**; any subdomain could drive authenticated admin writes |
| **P1** | Unit portal ignored level — a club code read every applicant's name and phone in the state |
| **P1** | Record ids were `Date.now()`, colliding for batch submissions |
| **P2** | An agent published a rulebook link recording evidence it never measured; the URL returned 202 with a zero-byte body |

---

## 4. Content integrity

Recorded in `docs/CLAIMS-AUDIT.md`.

| Item | State |
|---|---|
| Instagram account | **VERIFIED** — confirmed by the federation and independently |
| Both official names (India / Bharat) | **VERIFIED** — declared as `alternateName` |
| Titles (Renshi/Shihan/Soke/Sensei) | **CONFIRMED** — now modelled as separate credentials from Dan grade |
| "Junior Tiger Lee" | **VERIFIED** as a conferred title, 2021 — the only third-party-corroborated fact found |
| Stock photography on named people | **FIXED** — 9 real photographs recovered and self-hosted |
| Sensei Vikas Pathak photograph | **PENDING** — none exists publicly; deliberately no image rather than a misattributed one |
| WKF affiliation | **REQUIRES MMAKF DECISION** — WKF recognises one federation per country; for India that is KIO |
| Limca / Guinness | **REQUIRES MMAKF DECISION** — traces to real clippings reporting the subject's own account |
| Legal registration | **NOT ESTABLISHED** — and required before any payment gateway will onboard MMAKF |
| Statistics (5,000+ / 130+ / 34) | **UNVERIFIED** — should be dated and attributed as federation records |
| Sensei Sumitra's name and grade | **REQUIRES MMAKF DECISION** — three sources disagree |

---

## 5. Build order

Sequenced so each step leaves the live site working, and so nothing is built on an unverifiable base.

1. **Shotokan technical system + grading engine + certificates** — the federation's core authority.
   The member register cannot be fixed without it: certificates must come from examinations.
2. **Competition engine + results + rankings** — the second pillar, and the largest single domain.
3. **YouTube live integration + Academy LMS** — specified concretely, and the channel is authorised.
4. **Officials, governance, safeguarding, medical, disciplinary** — the compliance spine.
5. **Domain event feed + notifications + command centre + analytics** — these consume everything
   above, so they come last by necessity rather than by preference.

**Blocked on MMAKF, not on engineering:** `DATABASE_URL`, a merchant account (which needs the
registration certificate), the syllabus content, the governance documents, and the claims decisions.
Schema and workflow are built regardless; they stay empty and say so until the federation supplies
the content, because inventing a grading syllabus or a constitution is the one failure this
directive treats as unforgivable.

---

# Addendum — 6 September 2026

## §1 above is STALE, and it is the headline of this document

**"`DATABASE_URL` is not set in production"** was true on 12 August 2026 and is
false now. `/api/health` reports `database: ok` on all three hosts, and
`docs/IMPLEMENTATION-STATUS.md` records the reversal with its evidence: the
health check's `ok` is the return value of `select 1 from _mmakf_migrations`,
which cannot succeed unless the migration ledger exists.

It is corrected here rather than edited above, because this file's own method
section claims a verification date and rewriting a finding under it would make
the date a lie. **What §1 still gets right is the shape of the argument** — a
subsystem with no system of record is blocked however well it is tested. That is
simply no longer the situation.

Every other figure in §2 (25 tables, 16 roles, 254 tests) is from the same
August pass and should be read as a floor, not a count. `IMPLEMENTATION-STATUS.md`
carries the current numbers and a record of having been found stale three times.

## Three subsystems the directive names that had no register at all

Audited 6 September 2026 by reading the schema and grepping for callers, not by
reading this document.

| Directive subsystem | Was | Now |
|---|---|---|
| Federation team / operational organisation (§1–3) | **X — missing.** Three registers of people existed (`committees`, `role_bindings`, `persons`) and none held the people who run the federation. `/people` reads the content store: an editorial page, not a register. | **W** — `departments`, `team_appointments`, `team_appointment_history` (migration 0056); `src/db/team.ts`; `/team`, `/admin/team`. 32 tests. |
| Black Belt register (§7) | **X — missing.** `publicRegister()` in `src/db/grading.ts` had been written, tested and left with **no caller anywhere in `src/`** since wave 2c — and returns kyu grades as well as Dan. | **W** — `blackBeltRegister()` / `blackBeltFacets()`; `/black-belts`, derived from active Dan rank records, filterable. 14 tests. |
| Teaching faculty (§9) | **X — missing surface.** The coach domain was complete — stages, qualifications, safeguarding exclusion, assignment, double-booking — with **no public page**. A visitor could not find out who teaches for MMAKF. | **W** — `publicFaculty()` / `facultyFacets()`; `/teachers`. 13 tests. |

## What this pass confirmed already exists, and did NOT rebuild

Checked against the source before writing anything, because the directive's
first instruction is not to duplicate what is there:

| Directive asks for | Already built |
|---|---|
| Public credential verification (§6) | `/verify` + `/api/verify` → `verifyCredential()`. Four provenances, never merged; a revoked credential reports as REVOKED **with its reason**. |
| Grading → credential pipeline (§8) | `src/db/grading.ts` — eligibility, application, examiner, scores, decision, certificate, revocation. |
| Enrolment engine (§13) | `training_enrolments`, `enrolments`, `applications`, `automations`, 20-step institutional intake that works with scripting off. |
| Recurring payment engine (§15–16) | `src/lib/payments/` with a provider abstraction, `razorpay.ts`, signature-verified idempotent webhooks, `payment_events`, `payment_intents`, the ledger. |
| **Training fees ≠ membership (§14)** | **Guaranteed structurally.** Migration 0045's header (`0045_training_products.sql`): there is NO foreign key between any training table and `memberships`, in either direction. "The check that must never be written has nothing to be written against." This is the directive's §14 already satisfied by construction. |
| Parent / minor (§19) | `person_relationships`, `guardian_authorizations`, `/my/family`, `/admin/guardianships`. |
| RBAC / ABAC (§25) | 32 roles, deny-by-default, scope as a SQL predicate, HR and medical outside `NATIONAL_FULL`. |
| Calendar (§22) | `src/lib/calendar.ts`, `calendar-feed.ts`, conflict detection in `coaches.ts` (half-open intervals). |
| Fee configuration (§34) | `src/db/fees.ts` — integer paise, immutable published frameworks, existing quotes keep their pricing version. |

## The largest gap this pass did NOT close

**Nothing consumes the domain-event feed.** It was already the biggest item in
`IMPLEMENTATION-QUEUE.md` (item 2) and this pass added six more producers to it.

Concretely, and worth stating plainly because the directive's §35 forbids fake
automation: `publishAppointment()` puts a named private individual's photograph
and biography on the public internet and **tells them nothing**. No claim of
automatic notification is made anywhere in the new code or the new surfaces. The
events are published; the consumer does not exist; both facts are recorded.
