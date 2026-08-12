# IMPLEMENTATION-STATUS

Per-subsystem state. **No vague completion language** — every row carries one of:

`NOT_STARTED` · `RESEARCH` · `ARCHITECTURE` · `DATABASE` · `BACKEND` · `FRONTEND` ·
`INTEGRATION` · `TESTING` · `STAGING` · `PRODUCTION` · `VERIFIED` · `BLOCKED` ·
`NEEDS_REVIEW` · `DEPRECATED`

`DATABASE` means the schema exists and migrates. It does **not** mean anything uses it.
`VERIFIED` means proven on production, not "the tests pass".

Last updated 2026-08-12 · branch `wave-2b-federation` · production runs `6a44fdf`

**1103 tests passing · 87 tables · tsc clean · build clean · migrations 5/5**

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
| SEC-008 | MFA | **NOT_STARTED** | |
| SEC-009 | Two-person control | **TESTING** | `src/lib/approvals.ts`. Self-approval refused even for SUPER_ADMIN |
| SEC-010 | Backups / restore | **VERIFIED** | `npm run backup`. Cycle proven against real Postgres incl. tamper detection and refusal to overwrite live data. NO encryption at rest — see BACKUP-RESTORE §6 |
| DATA-001 | Migration runner | **VERIFIED** | Transactional, checksummed, refuses edited history. 5/5 |
| DATA-002 | Local dev Postgres | **VERIFIED** | Real wire protocol, no Docker |
| DATA-003 | Vendor-neutral driver | **VERIFIED** | `postgres.js`. Neon removed at the federation's instruction |

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

## Public surfaces

| ID | Surface | Status |
|---|---|---|
| WEB-001 | Home, about, governance, contact | **PRODUCTION** |
| WEB-002 | Registration (4 per-type forms) | **NEEDS_REVIEW** |
| WEB-003 | `/application` status lookup | **NEEDS_REVIEW** |
| WEB-004 | `/regulations` | **NEEDS_REVIEW** — 28/28 links verified |
| WEB-005 | `/press` | **NEEDS_REVIEW** |
| WEB-006 | `/checkout` | **NEEDS_REVIEW** |
| WEB-007 | Admin approval queue | **NEEDS_REVIEW** |
| WEB-008 | Athlete profiles / passport | **NOT_STARTED** |
| WEB-009 | Dojo directory | **NOT_STARTED** |
| WEB-010 | National command centre | **FRONTEND** |
| WEB-011 | Global search | **TESTING** | `src/lib/search.ts`. Certificates findable by number, never by holder name |

## Cross-cutting

| ID | Subsystem | Status | Note |
|---|---|---|---|
| EVT-001 | Domain event feed | **TESTING** | `src/lib/domain-events.ts`. Cursor-based consumers; a failing consumer does not advance or block others |
| NOT-001 | Notification engine | **DATABASE** | No transport configured — no email or SMS dependency exists |
| API-001 | Documented public API | **NOT_STARTED** | |
| RT-001 | Real-time (live scores, live classes) | **NOT_STARTED** | |
| AI-001 | Federation assistant | **NOT_STARTED** | Deliberately last — requires authoritative data first |
| A11Y-001 | Accessibility | **PARTIALLY** | Specific fixes made. No systematic WCAG 2.2 AA pass yet (Q-28) |
| OBS-001 | Observability | **BACKEND** | `src/lib/observability.ts`. Secrets and personal data redacted by key substring; probes time out |
