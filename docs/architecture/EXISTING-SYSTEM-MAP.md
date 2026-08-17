# EXISTING-SYSTEM-MAP

**PATCH 001 — repository audit, performed before any code was written.**

This file answers one question: *what already exists, and where?* It is the
precondition the directive sets for every later patch — "FIRST AUDIT EXISTING
DATABASE · DO NOT DUPLICATE Person, User, Organization, Membership, Event,
Payment, Document, Audit, Workflow, Notification."

Nothing here is aspirational. Every number was produced by running a command in
this working tree on the date below, and the command is printed beside it so it
can be re-run rather than believed.

| | |
|---|---|
| Audited | 2026-08-17 |
| Branch | `technical-knowledge-system` |
| HEAD | `d45a239` |
| Working tree | **DIRTY — and being written to by another process during this audit.** See §0. |

---

## 0. THE FINDING THAT BLOCKS EVERY OTHER PATCH

> **UPDATE, 2026-08-17 10:43 — partially resolved.** The other session
> committed its work as `e685c7b` ("wip: finance, payments, identity, policy and
> technical library — from stopped workflows") and `fbc814f`, moved to `main`,
> and the tree went from ~70 dirty paths to 15. Migrations now run to `0033b`.
>
> It is **still writing** — `src/db/engagement.schema.ts`, `src/db/schema.ts`
> and `src/db/seller-registry.ts` were all touched within ten minutes of that
> timestamp — so the rule below still holds for the main tree. What changed is
> that its work is now recoverable from git rather than living only on disk.
>
> That session also left `docs/parallel/PATCH-CONFLICTS.md`, which records the
> same class of problem from the other side. A collision it did **not** catch —
> two definitions of the `source_tier` enum — is described in
> [PATCH-003-DISCIPLINE-REGISTRY.md](./PATCH-003-DISCIPLINE-REGISTRY.md) §4a,
> along with its fix.

**A second process is writing to `src/db` in this working tree right now.**

This is not the ordinary "uncommitted work" the directive's MIGRATION SAFETY
section anticipates. It is concurrent authorship. Evidence, all from this tree:

| File | Written at | Observed |
|---|---|---|
| `src/db/catalogue.schema.ts` | 08:42:19 | Did not exist when this audit began at 08:40 |
| `src/db/inventory.schema.ts` | 08:43:26 | Appeared mid-audit |
| `src/db/marketplace-orders.schema.ts` | 08:45:44 | Appeared mid-audit |
| `src/db/geography.ts` | 09:44:30 | Written 29 seconds before a `date` call at 09:44:59 |

Three `node.exe` processes are resident. The branch also moved during the
session: the harness recorded `main` at session start; `git rev-parse` returns
`technical-knowledge-system`.

**Consequence for the build.** Any patch that writes to `src/db`, `src/lib`,
`drizzle/` or `src/pages` will race the other writer. Two agents generating
Drizzle migrations against the same `drizzle/meta/_journal.json` produce a
journal that matches neither, and the migration runner in this repository
*refuses edited history by design* — so the failure surfaces as an unrunnable
migration set, after both bodies of work already exist.

**This document was written to `docs/architecture/`, a path that did not
previously exist, precisely so that producing it could not collide with
anything.**

The counts below are therefore a snapshot of a moving tree. Re-run the commands
before citing them.

---

## 1. NUMBERS

```
grep -rho "pgTable(" src/db | wc -l                      197   table declarations
grep -rhoE "pgTable\('[a-z0-9_]+'" src/db | sort -u      190   distinct table names
grep -h 'CREATE TABLE' drizzle/*.sql | wc -l             185   tables in migrations
ls drizzle/*.sql | wc -l                                  26   migration files
find src/pages -type f | wc -l                           134   route files
find src/pages/api -type f | wc -l                        33   API endpoints
find src/pages/admin -type f | wc -l                      31   admin surfaces
ls tests/*.test.ts | wc -l                                87   test files
```

Plus, read from source:

- **32** RBAC roles, **91** distinct `domain:action` permissions (`src/lib/rbac.ts`)
- **74** domain event types, **1** registered consumer (`src/lib/domain-events.ts`)
- **3** product surfaces — `public`, `learn`, `admin` (`src/lib/surface.ts`)

The figures above are for the **working tree**. The **committed** tree at
`d45a239` is smaller, and the difference is entirely the uncommitted commerce
and identity work described in §0:

| | Committed (`d45a239`) | Working tree |
|---|---|---|
| Distinct tables | 144 | 190 |
| Migrations | 13 | 26 |
| Test files | 79 | 87 |
| Tests passing | **2,670 / 2,670** (`npx vitest run`, 88s, verified this pass) | not run — tree is being written to |

`docs/IMPLEMENTATION-STATUS.md` cites 144 tables / 79 test files / 2,670 tests.
**Those figures are correct for the committed tree** and were re-verified here.
They are not wrong; they simply predate the uncommitted work.

---

## 2. CANONICAL ENTITY REGISTER

The directive's ten protected entities, plus the domain spines a later patch
would otherwise be tempted to re-create.

| Canonical entity | Table(s) | Schema file | Service | API | UI | Status | Duplicates | Gaps |
|---|---|---|---|---|---|---|---|---|
| **Person** | `persons` | `src/db/schema.ts:123` | `src/db/*.ts` (broad), `src/lib/people.ts` | `/api/data`, `/api/v1/*` | `/people`, `/people/[slug]`, `/admin/*` | **CANONICAL — do not re-create** | None. `identity.schema.ts` opens with a written prohibition on a second person row | No effective-dating on the person row itself |
| Person satellites | `person_contacts`, `person_addresses`, `person_relationships`, `guardian_authorizations`, `consent_records`, `duplicate_candidates`, `profile_change_requests` | `src/db/identity.schema.ts` | — | — | — | **NEW, UNCOMMITTED, migration unregistered** | — | Not in `_journal.json`; see §3 |
| **User / auth** | `users`, `role_bindings` | `src/db/schema.ts:306,344` | `src/lib/auth.ts`, `session.ts`, `mfa.ts`, `password.ts` | `/api/auth/*`, `/api/unit/*` | `/portal`, `/my` | **CANONICAL** | None | No SSO, no passkeys, no device register |
| **Organization** | `state_units`, `district_units`, `dojos`, `institutions` | `src/db/schema.ts`, `onboarding.schema.ts` | `src/db/affiliation.ts`, `federation.ts` | `/api/unit/*` | `/dojos`, `/network`, `/admin/onboarding` | **CANONICAL for the federation hierarchy** | None | No generic department/team node; no matrix or dotted-line reporting |
| **Membership** | `memberships` | `src/db/schema.ts:194` | `src/db/membership.ts` | `/api/register`, `/api/start/individual` | `/join`, `/register`, `/admin/membership` | **CANONICAL** | None | — |
| **Event (competition)** | `competition_events`, `event_categories`, `event_entries`, `entry_members`, `draws`, `matches`, `match_events`, `kata_scores`, `competition_results`, `protests`, `event_officials` | `src/db/competition.schema.ts` | `competition.ts`, `draws.ts`, `matches.ts`, `rankings.ts` | `/api/competition/*` | `/competitions`, `/scoreboard`, `/admin/competition` | **CANONICAL and deep** | None | Single implicit ruleset; no per-discipline format — see §4 |
| **Payment / money** | `orders`, `order_lines`, `invoices`, `payments`, `payment_intents`, `payment_attempts`, `payment_events`, `refunds`, `ledger_entries`, `settlements`, `payout_accounts`, `gateway_*` | `commerce.schema.ts`, `reconciliation.schema.ts` | `orders.ts`, `fees.ts`, `reconciliation.ts`, `src/lib/payments/*` | `/api/payments/*` | `/checkout`, `/admin/finance`, `/admin/reconciliation` | **CANONICAL — integer paise, double-entry ledger** | None | In-flight; see §3 |
| **Document** | `client_documents`, `document_versions`, `coach_documents`, `official_documents`, `seller_documents`, `certificates` | `operations.schema.ts`, `technical.schema.ts`, others | `src/lib/uploads.ts`, `storage.ts` | `/api/export/[kind]` | `/documents`, `/verify` | **CANONICAL (versioned)** | Per-role document tables are near-parallel; acceptable, but a seventh would be a smell | No generated-letter templates |
| **Audit** | `audit_events` | `src/db/schema.ts:361` | written throughout | `/api/data` | `/admin/audit` | **CANONICAL — actor, before, after, reason, authority; IP hashed** | None | — |
| **Workflow** | `workflow_definitions`, `workflow_runs`, `workflow_steps` | `operations.schema.ts` | `src/lib/workflow.ts` — `runWorkflow`, `dispatch`, `sweepRetries`, `backoffMs`, `installWorkflow` | — | `/admin/workflows` | **CANONICAL, GENERIC — the directive's workflow engine already exists** | `src/lib/queue.ts` is a second, Redis-backed approval queue over a different store | Delegation and SLA escalation not evidenced |
| **Notification** | `notifications`, `notification_deliveries`, `notification_preferences`, `push_devices` | `engagement.schema.ts`, `operations.schema.ts` | `src/lib/notifications.ts`, `push.ts` | — | `/my/notifications`, `/admin/notifications` | **CANONICAL** | None | SMS / WhatsApp adapters not present |
| **Outbox / events** | `domain_events` | `src/db/schema.ts` | `src/lib/domain-events.ts` — `publish`, `consume`, cursors, `resetCursor`, `cursorReport`, `catalogueDefects` | `/api/stream/[channel]` | — | **CANONICAL — real outbox with per-consumer cursors and classification floors** | None | **74 event types, 1 consumer.** The directive requires every event to have a real consumer |

### Domain spines that also already exist

| Domain | Tables | Note |
|---|---|---|
| Grading / ranks | `syllabus_versions`, `grade_definitions`, `grade_requirements`, `grading_events`, `grading_panel`, `grading_candidates`, `grading_scores`, `rank_records`, `certificates`, `verification_log` | **Already version-scoped** — a grade definition hangs off a syllabus version, which is the directive's "historical exams stay linked to the curriculum version that existed at the time" rule, already built |
| Technical knowledge | `techniques`, `kata`, `kumite_forms` | Shotokan-shaped, provenance-tracked (`source_kind`, `authored_by_person_id`, `published`) |
| Learning | `courses`, `course_modules`, `lessons`, `quizzes`, `quiz_questions`, `quiz_attempts`, `enrolments`, `lesson_progress`, `live_classes`, `live_class_*`, `training_sessions`, `session_attendance` | |
| Media ingestion | `media_channels`, `media_assets`, `broadcasts` | **Rights model already exists** — `rights` enum, rights holder, consent evidence, tracked separately from classification |
| Coaches | `coach_profiles`, `coach_qualifications`, `coach_availability`, `coach_assignments`, `coach_cpd`, `coach_performance`, `coach_applications`, `coach_documents`, `coach_stage_events` | The richest people-domain in the repo |
| Officials / athletes | `official_quals`, `official_documents`, `instructor_quals`, `examiner_quals`, `national_squads`, `squad_members`, `ranking_*` | |
| Governance | `committees`, `committee_appointments`, `meetings`, `meeting_attendance`, `resolutions`, `proposals`, `action_items`, `interest_declarations`, `policy_versions` | |
| Safeguarding / cases | `safeguarding_cases`, `disciplinary_cases`, `case_notes`, `medical_records` | **Already separated** from ordinary disciplinary data, as the directive requires |
| Facilities | `venues`, `venue_blackouts`, `bookings`, `booking_resources` | |
| Marketplace | `sellers`, `seller_*` (8), `listings`, `listing_media`, `listing_revisions`, `products`, `product_variants`, `brands`, `brand_authorisations`, `marketplace_policies` | |
| Engagement / institutional | `leads`, `lead_activities`, `quotes`, `quote_versions`, `quote_lines`, `contracts`, `training_requests`, `training_programs`, `program_templates`, `program_sessions`, `program_participants`, `program_attendance`, `institution_*` | |
| Support / tasks | `support_tickets`, `ticket_messages`, `tasks`, `task_templates`, `task_events`, `task_dependencies` | |
| Finance configuration | `fee_frameworks`, `fee_rules`, `fee_schedule`, `fee_catalogue_entries`, `fee_benchmarks`, `fee_benchmark_*`, `tax_*`, `currencies`, `fx_rates`, `discount_*` (6), `concession_*` (3), `entitlements`, `entitlement_terms` | Mostly in-flight and uncommitted |
| Geography | `countries`, `admin_areas`, `postal_codes`, `geo_aliases`, `addresses` | New, uncommitted |

---

## 3. MIGRATION INTEGRITY — TWO DEFECTS

**3.1 `0025` and `0026` exist on disk but are absent from the drizzle journal.**

`drizzle/meta/_journal.json` ends at `idx: 23` / `0024_data_api_lockdown`. On
disk there are also `0025_identity_and_geography.sql` and
`0026_data_api_lockdown.sql`, both untracked.

**This does not stop them being applied.** `scripts/migrate.mjs:158` and
`scripts/verify-migrate.mjs:22` both do

```js
readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()
```

— neither reads `_journal.json`. The runner's ledger is the `_mmakf_migrations`
table, keyed by filename and checksum. So `npm run db:migrate` *will* apply 0025
and 0026, and the identity and geography tables will exist.

The drift still matters, in one specific way: `drizzle-kit generate` reads the
journal, so the next generated migration will be numbered as though 0025 and
0026 do not exist, and will collide with them by name. **The journal is the
other session's to reconcile, not this one's**, because repairing it by hand
would rewrite a file that process is still editing.

No test asserts agreement between the journal and the migration directory
(`grep -rn journal tests/` returns nothing). That is why the drift went
unnoticed, and it is worth a test in a later patch.

**3.2 `0008` does not exist.**

The journal runs `0007` → `0009` with a contiguous `idx` sequence (0…23), so the
runner is satisfied. The gap is historical, not corrupt. It is recorded here so
that a later patch does not "helpfully" renumber — the directive explicitly
forbids that, and the runner checksums applied history.

---

## 4. GAP ANALYSIS AGAINST THE DIRECTIVE

Verified by name search across every `pgTable` declaration in `src/db`.

### 4.1 Absent entirely — no table, no service

| Directive requirement | Search result |
|---|---|
| `Discipline`, `DisciplineVersion` | **ABSENT** |
| `Style`, `StyleVersion`, `Lineage` | **ABSENT** |
| `GoverningBody`, `TechnicalSystem` | **ABSENT** |
| `CompetitionFormat` (per-discipline ruleset) | **ABSENT** — only `ranking_rulesets` |
| `Curriculum`, `CurriculumVersion` | **ABSENT** — `syllabus_versions` is the nearest, and is grading-scoped |
| `KataMovement`, sequence, embusen, stance/transition graph | **ABSENT** — `kata.sequence` is a single `jsonb` column |
| Weapons | **ABSENT** |
| Knowledge-graph edges | **ABSENT** |
| Employment, Position, PositionVersion, PositionBudget | **ABSENT** |
| Payroll, payslip, pay component | **ABSENT** |
| Leave, balance, policy | **ABSENT** |
| Employee attendance / timesheet / shift | **ABSENT** (`session_attendance` and `program_attendance` are student-side) |
| Expense, travel | **ABSENT** |
| Goals, skills, succession | **ABSENT** |
| ATS: job, requisition, candidate, interview, offer | **ABSENT** (`coach_applications`, `role_applications`, `institution_applications` are role-intake, not an ATS) |
| `employee.mmakf.in`, `careers.mmakf.in` | **ABSENT** — `src/lib/surface.ts` defines exactly three surfaces |

### 4.2 Present but single-discipline

`techniques`, `kata`, `kumite_forms`, `grade_definitions` and
`competition_events` are Shotokan-shaped: no `discipline_id`, no `style_id`. They
are good tables. Making the platform discipline-agnostic is therefore an
**additive migration over existing tables**, not a rewrite — which is the single
most important architectural finding in this audit, and the reason PATCH 003
must precede PATCHES 005–011.

### 4.3 Present and stronger than the directive assumes

Worth stating plainly, because these are things a later patch might otherwise
rebuild from scratch:

- A **real outbox** with per-consumer cursors, replay, and data-classification
  floors on every event type.
- A **real generic workflow engine** with retry, backoff and a sweep.
- **RBAC with scope checking** — 32 roles, 91 actions, deny-by-default, with a
  dedicated adversarial test file (`tests/rbac-adversarial.test.ts`).
- **A rights model on ingested media** that already separates rights from
  editorial classification.
- **Version-scoped grading**, so historical exams cannot silently re-point at a
  newer syllabus.
- **Integer-paise money with a double-entry ledger.**

The directive's "NO FAKE …" list is, on this evidence, largely already honoured.

---

## 5. DUPLICATION RISKS FOR LATER PATCHES

1. **Employee is not a new person table.** `persons` is canonical and
   `identity.schema.ts` opens with a written prohibition on a second one. An
   `employments` table must reference `persons.id`.
2. **Coach is already modelled.** Nine `coach_*` tables exist. PATCH 021 extends
   them; it does not introduce a parallel coach record.
3. **Two approval engines exist.** `src/lib/workflow.ts` (Postgres) and
   `src/lib/queue.ts` (Redis). New work should target the Postgres engine, and
   the Redis queue should be scheduled for retirement rather than extended.
4. **Six near-parallel document tables.** Adding a seventh per-role table is the
   wrong direction.
5. **`syllabus_versions` versus a generic `Curriculum`.** These will overlap. The
   correct move is to generalise the existing table, not to add a second
   versioned-curriculum concept beside it.

---

## 6. WHAT THIS MEANS FOR THE PATCH SEQUENCE

The directive's 41 patches remain the right decomposition. This audit changes
their ordering in three places:

- **PATCH 002 (identity / person audit) is already done in code and
  half-migrated.** It needs its migration registered and committed — by the
  session that wrote it.
- **PATCH 003 (discipline registry) is the true foundation**, not one item among
  forty. Every technical patch (005–011) hangs off `discipline_id`. Building
  kata depth before the discipline registry means migrating it twice.
- **PATCHES 022–023 (employee, HR / ATS) are genuinely greenfield** — roughly
  forty tables with no existing counterpart, and the largest single body of new
  work in the directive.

**No patch after 001 can begin while §0 holds.**

---

## 7. HOW TO RE-VERIFY THIS DOCUMENT

```bash
git rev-parse --abbrev-ref HEAD && git status --porcelain | wc -l
grep -rhoE "pgTable\('[a-z0-9_]+'" src/db | sort -u | wc -l
grep -o '"tag"' drizzle/meta/_journal.json | wc -l && ls drizzle/*.sql | wc -l
npx vitest run
find src drizzle -type f -newermt '-10 minutes'    # §0: must be empty
```

The last line is the one that matters before any build begins.
