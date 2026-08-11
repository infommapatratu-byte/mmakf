# MMAKF Federation OS — Data & System Architecture

**Phase 2 · Step 4 deliverable · baseline `914cabd`**

> Governing principle (Directive §71 — *database-first*): for every entity we answer
> **what creates it · who owns it · who may modify it · who approves it · who may view it ·
> its lifecycle · expiry · revocation · audit history** — *before* any UI is built.
>
> Governing principle (Directive §70): **no UI for data that does not exist.** A module ships
> either with its backend or behind an explicit "configuration required" state.

---

## 0. Where we are, honestly

`914cabd` is a **content platform with three real write-workflows** (enrolment leads, member
registration applications, event entries) on a **Redis JSON key-value store**. It is not yet a
federation OS. The gap is not UI — it is that federation records (people, ranks, certificates,
results) require *relational integrity, immutable history and role-scoped authority*, which
JSON blobs cannot provide (Directive §54).

This document specifies that foundation and the migration path to it.

---

## 1. Storage decision

### 1.1 The constraint

| Requirement (Directive) | Redis JSON today | Needed |
|---|---|---|
| Foreign keys, unique constraints (§54) | none | enforced at DB |
| Immutable grading history (§31) | last-write-wins overwrites | append-only rows |
| Audit log with old/new value (§52) | none | dedicated table + triggers |
| Concurrent writes (§5 adversarial) | read-modify-write race | transactions |
| Role-scoped queries (§38, §75) | full-blob reads | row-level filters |
| Reporting/aggregation (§51) | client-side over blobs | SQL |

**Decision: PostgreSQL** (Neon or Supabase — both are Vercel-marketplace one-click, both give
branching for the DEVELOPMENT/STAGING/PRODUCTION separation Directive §56 requires).
Drizzle ORM for typed schema + migrations (§55).

### 1.2 Coexistence, not big-bang

Redis **stays** as the CMS store for editorial content (news, gallery, facilities, FAQs,
programs, documents metadata). It works, the office knows it, and none of it needs relational
integrity. Postgres takes **federation records only**. One system of record per fact (§72).

| Domain | Store | Rationale |
|---|---|---|
| Editorial/marketing content | Redis (existing 23 keys) | no integrity requirements; admin CMS already works |
| People, dojos, units, ranks, gradings, certificates, events, entries, orders, results, rankings, audit | **Postgres** | integrity, history, RBAC, reporting |
| Sessions | signed cookies (existing) | stateless, already timing-safe |
| Files (certificates, documents, video) | Vercel Blob | not yet provisioned — see §9 |

---

## 2. Identity & ID scheme (§73)

All federation IDs are **immutable, never reused**, allocated from a Postgres sequence per type
and year — not from `Date.now()` (the current event-reference scheme is guessable, Directive §5).

| Entity | Format | Example |
|---|---|---|
| Person (member) | `MMAKF-MEM-{yyyy}-{6}` | `MMAKF-MEM-2026-000001` |
| Athlete registration | `MMAKF-ATH-{yyyy}-{6}` | `MMAKF-ATH-2026-000018` |
| Dojo | `MMAKF-DOJO-{ST}-{DIST}-{3}` | `MMAKF-DOJO-JH-RMG-001` |
| State unit | `MMAKF-ST-{ST}` | `MMAKF-ST-JH` |
| District unit | `MMAKF-DIST-{ST}-{DIST}` | `MMAKF-DIST-JH-RMG` |
| Grading event | `MMAKF-GRD-{yyyy}-{6}` | `MMAKF-GRD-2026-000004` |
| Certificate | `MMAKF-CERT-{yyyy}-{6}` | `MMAKF-CERT-2026-000127` |
| Competition | `MMAKF-EVT-{yyyy}-{6}` | `MMAKF-EVT-2026-000009` |
| Event entry | `MMAKF-E-{yyyy}-{6}` | `MMAKF-E-2026-000042` |
| Order | `MMAKF-ORD-{yyyy}-{6}` | `MMAKF-ORD-2026-000311` |

**Security note:** sequential IDs are enumerable by design (they are public register keys). The
protection is that verification returns *only* public register fields (name, rank, status,
issuing authority) and never PII — plus rate limiting (§8.3). Private records (applications,
entries, orders) get a **separate unguessable access token** for the applicant's own receipt URL.

---

## 3. Core schema

### 3.1 Federation hierarchy (§36)

```
national_federation (singleton)
   └── state_units            (MMAKF-ST-JH)
         └── district_units   (MMAKF-DIST-JH-RMG)
               └── dojos      (MMAKF-DOJO-JH-RMG-001)
                     └── memberships → persons
```

```sql
state_units      (id pk, code uk, name, hq_city, status, chartered_on, charter_expires_on,
                  created_at, updated_at, deleted_at)
district_units   (id pk, code uk, state_unit_id fk→state_units, name, status, chartered_on, ...)
dojos            (id pk, code uk, district_unit_id fk, state_unit_id fk, name,
                  chief_instructor_person_id fk→persons, address, city, status,
                  affiliated_on, affiliation_expires_on, ...)
```

`status ∈ (draft, provisional, active, suspended, expired, revoked)` — never deleted (§78).

### 3.2 People and credentials — the separation rule (§33)

A person holds **independent** credentials. Rank ≠ instructor ≠ examiner ≠ referee ≠ office.

```sql
persons          (id pk, federation_id uk, full_name, dob, gender, photo_url,
                  email, phone, city, state_unit_id, district_unit_id, dojo_id,
                  status, created_at, updated_at, deleted_at)

memberships      (id pk, person_id fk, category ∈ (athlete,instructor,dojo,official),
                  valid_from, valid_to, status ∈ (pending,active,expired,suspended,revoked),
                  issued_by_user_id, ...)                    -- renewable, historical rows kept

rank_records     (id pk, person_id fk, kind ∈ (kyu,dan),
                  grade_id fk→grading_levels, awarded_on, grading_event_id fk,
                  examiner_panel_id fk, syllabus_version_id fk, certificate_id fk,
                  score numeric, status ∈ (active,superseded,revoked),
                  APPEND-ONLY: no UPDATE of awarded facts)   -- §31 immutable history

instructor_quals (id pk, person_id fk, level ∈ (assistant,instructor,senior,chief),
                  granted_on, expires_on, status, authority_user_id)
examiner_quals   (id pk, person_id fk, level ∈ (A,B,C,senior,chief),
                  scope ∈ (kyu_low,kyu_high,dan), granted_on, expires_on, status)
official_quals   (id pk, person_id fk, kind ∈ (judge,referee,technical_delegate),
                  level, granted_on, expires_on, cpd_due_on, status)
governance_posts (id pk, person_id fk, office, body ∈ (national,state,district,committee),
                  term_from, term_to, appointed_by, status)
```

**Current rank is derived**, never stored twice (§72):
`SELECT … FROM rank_records WHERE person_id=? AND status='active' ORDER BY awarded_on DESC LIMIT 1`

### 3.3 Shotokan technical system (§24–§26)

Configurable — the Technical Committee owns the content; code owns only the structure.
**No MMAKF syllabus content is invented** (Directive §68): rows ship empty with
`status='awaiting_technical_committee'` and the UI renders that state explicitly.

```sql
syllabus_versions   (id pk, code uk, effective_from, approved_on, approved_by, status)
grading_levels      (id pk, kind ∈ (kyu,dan), ordinal, label, belt_colour, jp_name,
                     syllabus_version_id fk, min_age, min_months_at_previous,
                     min_attendance, pass_threshold, examiner_level_required, active)
kihon_techniques    (id pk, jp_name, romaji, english, category, syllabus_version_id)
kata                (id pk, name, jp_name, romaji, level_hint, embusen_note,
                     technical_notes, video_asset_id fk, syllabus_version_id)
kumite_drills       (id pk, name, jp_name, stage ∈ (gohon,sanbon,kihon_ippon,jiyu_ippon,jiyu))
theory_topics       (id pk, title, body, applies_from_level_id)
grading_requirements(id pk, grading_level_id fk, component ∈ (kihon,kata,kumite,bunkai,theory,reigi),
                     requirement_ref_id, weight_pct, mandatory)
assessment_components(id pk, grading_level_id fk, name, weight_pct, max_score)
```

### 3.4 Grading engine (§27–§32)

```sql
grading_events      (id pk, federation_id uk, title, host_dojo_id fk, state_unit_id fk,
                     held_on, syllabus_version_id fk,
                     status ∈ (draft,announced,entries_open,entries_closed,in_progress,
                               scored,under_review,approved,certificates_issued,archived),
                     approved_by_user_id, approved_at)
grading_candidates  (id pk, grading_event_id fk, person_id fk,
                     current_rank_id fk, target_level_id fk,
                     eligibility_json, eligibility_status, fee_status,
                     status ∈ (applied,eligible,ineligible,withdrawn,examined))
grading_panels      (id pk, grading_event_id fk)
grading_panel_members(panel_id fk, person_id fk, examiner_qual_id fk, role)
grading_scores      (id pk, candidate_id fk, panel_member_id fk, component,
                     score numeric, max numeric, remarks,
                     submitted_at, UNIQUE(candidate_id, panel_member_id, component))
grading_results     (id pk, candidate_id uk, total numeric, decision ∈
                     (pass,conditional_pass,re_examination,fail),
                     status ∈ (draft,submitted,under_review,approved,rejected,finalized,
                               certificate_issued,appealed),
                     finalized_at, finalized_by, LOCKED once finalized — corrections
                     require a new audit_events row + amendment record)
grading_appeals     (id pk, result_id fk, filed_by, reason, status, decision, decided_by)
```

**Result integrity (§44):** `grading_results` and `competition_results` are locked on
finalisation via a DB trigger that rejects `UPDATE` unless an accompanying
`audit_events` row with `reason` and `authority_user_id` exists in the same transaction.

### 3.5 Certificates & verification (§34–§35)

```sql
certificates     (id pk, federation_id uk, kind ∈ (rank,instructor,examiner,official,
                                                   affiliation,participation,merit),
                  person_id fk NULL, dojo_id fk NULL,
                  subject_summary, issued_on, valid_to, issuing_authority,
                  signatory_person_id fk, source_record_type, source_record_id,
                  pdf_asset_id fk, qr_token uk,
                  status ∈ (issued,active,expired,revoked,superseded),
                  revoked_reason, revoked_by, revoked_at)
verification_log (id pk, certificate_id fk NULL, query, result, ip_hash, at)
```

Public verification (`/verify/{federation_id}` and QR → same URL) returns exactly:
**VERIFIED · NOT VERIFIED · REVOKED · EXPIRED** plus the public register fields. Never PII (§66).

### 3.6 Competition engine (§43–§46)

```sql
competitions       (id pk, federation_id uk, title, description, type, organiser_unit_id fk,
                    sanctioning_authority, venue, address, city, state_unit_id fk,
                    starts_on, ends_on, registration_opens_at, registration_closes_at,
                    capacity, fee_minor int, regulations_document_id fk,
                    safeguarding_note, medical_note, refund_policy,
                    status ∈ (draft,published,registration_open,registration_closing,
                              registration_closed,live,completed,results_published,archived),
                    published_at, created_by)
competition_categories (id pk, competition_id fk, name, discipline ∈ (kata,kumite,team_kata,team_kumite),
                    gender, age_min, age_max, weight_min, weight_max, grade_min_id, grade_max_id,
                    capacity)
competition_entries (id pk, federation_id uk, competition_id fk, category_id fk,
                    person_id fk NULL, applicant_name, applicant_phone, dojo_id fk NULL,
                    state_unit_id fk, age_category, gender, grade_id fk,
                    eligibility_status, eligibility_reasons_json,
                    payment_status ∈ (unpaid,initiated,pending,paid,refunded,waived),
                    consent_json, checked_in_at, athlete_number,
                    status ∈ (submitted,under_review,accepted,waitlisted,rejected,
                              withdrawn,cancelled),
                    access_token uk,          -- unguessable receipt URL
                    submitted_at, updated_at)
draws / matches / competition_results / medals / rankings …  (Phase 2c — see §11 roadmap)
```

**Event status engine (§8 of directive)** is the `competitions.status` enum above; transitions
are enforced by a state-machine guard in the service layer, and registration endpoints reject
entries unless status = `registration_open` **server-side** (never frontend-only, §12).

### 3.7 Commerce (§15–§18)

```sql
products (id pk, sku uk, title, category, description, status, tax_rate)
variants (id pk, product_id fk, sku uk, name, price_minor int, stock_qty int NULL)
   -- stock_qty NULL = "not tracked" and the UI says nothing about stock (§16: no fake stock)
carts / cart_items (session-scoped)
orders   (id pk, federation_id uk, customer_person_id fk NULL, email, phone,
          subtotal_minor, shipping_minor, total_minor, currency,
          status ∈ (created,awaiting_payment,paid,packed,shipped,delivered,
                    cancelled,refunded,partially_refunded),
          placed_at, ...)
order_items (id pk, order_id fk, variant_id fk, qty, unit_price_minor, line_total_minor)
payments (id pk, payable_type, payable_id, provider ∈ (upi_manual,razorpay,manual),
          provider_ref, amount_minor, purpose ∈ (membership,grading,competition,
          course,shop,affiliation,certification),          -- §50: every payment has a why
          status ∈ (initiated,pending,success,failed,cancelled,refunded,partially_refunded),
          initiated_at, settled_at, raw_payload_json)
refunds / shipments / invoices …
```

**Payment provider abstraction (§17):** a `PaymentProvider` interface with
`createIntent()`, `verifyCallback()`, `refund()`; UPI-manual and Razorpay as first
implementations. No page couples to a provider.

### 3.8 Academy (§19–§23)

```sql
courses (id pk, slug uk, title, level, syllabus_version_id fk, status, published_at)
modules (id pk, course_id fk, position, title)
lessons (id pk, module_id fk, position, title, duration_seconds int NULL,
         access ∈ (free_preview,enrolled,members_only),
         video_asset_id fk NULL, document_asset_id fk NULL, transcript, captions_url)
   -- §22/§23: a lesson may ONLY be labelled "Free preview" when access='free_preview'
   --          AND video_asset_id IS NOT NULL. Enforced by a CHECK constraint.
enrollments (id pk, person_id fk, course_id fk, status, enrolled_at, completed_at)
lesson_progress (id pk, enrollment_id fk, lesson_id fk, watched_seconds, completed_at,
                 last_accessed_at, UNIQUE(enrollment_id, lesson_id))
quizzes / questions / quiz_attempts / assessments  (Phase 2d)
```

### 3.9 Governance, policy, safeguarding (§39–§42)

```sql
documents        (id pk, code uk, title, category, version, effective_from, approved_on,
                  approved_by, supersedes_id fk, asset_id fk,
                  status ∈ (draft,under_review,approved,superseded,withdrawn))
committees       (id pk, name, remit, parent_body)
committee_members(committee_id fk, person_id fk, role, term_from, term_to)
meetings / minutes / resolutions (id pk, body, held_on, ref, document_id fk, status)

-- RESTRICTED schema, never exposed via public API, separate RBAC scope:
safeguarding_cases (id pk, case_ref uk, severity, reported_at, reporter_role,
                    subject_person_id fk, officer_person_id fk,
                    status ∈ (reported,triage,investigating,action,resolved,appealed,closed),
                    resolution, closed_at)
safeguarding_notes (id pk, case_id fk, author_user_id, body, created_at)   -- append-only
guardians          (id pk, person_id fk, name, relationship, phone, email,
                    consent_photography bool, consent_medical bool,
                    emergency_contact bool, authorized_pickup bool)
```

### 3.10 Audit (§52) — the spine

```sql
audit_events (id pk, at timestamptz, actor_user_id, actor_role, actor_ip_hash,
              entity_type, entity_id, action ∈ (create,update,delete,approve,reject,
                                                revoke,finalize,login,export),
              old_value_json, new_value_json, reason, authority, request_id)
```

Every privileged mutation writes one row **in the same transaction** as the mutation.
Finalised records (results, certificates, ranks) cannot be mutated without one.

---

## 4. Authentication & RBAC (§38, §65, §75)

### 4.1 Principals

Today: one shared admin password + per-unit access codes. That cannot support role separation,
attribution in audit logs, or per-person dashboards.

**Target:** `users` table with per-person credentials (email + password hash (argon2id) or OTP),
sessions remain signed-cookie but carry `user_id` + `role_bindings` version.

```sql
users         (id pk, person_id fk NULL, email uk, password_hash, status,
               last_login_at, failed_attempts, locked_until)
roles         (id pk, code uk)   -- SUPER_ADMIN, FEDERATION_ADMIN, PRESIDENT, GENERAL_SECRETARY,
                                 -- TECHNICAL_DIRECTOR, STATE_ADMIN, DISTRICT_ADMIN, DOJO_ADMIN,
                                 -- INSTRUCTOR, EXAMINER, REFEREE, JUDGE, ATHLETE, MEMBER, FINANCE,
                                 -- SAFEGUARDING_OFFICER
role_bindings (id pk, user_id fk, role_id fk,
               scope_type ∈ (national,state,district,dojo), scope_id,
               granted_by, granted_at, expires_at, status)
```

### 4.2 Authorisation rule (single choke point)

```
can(user, action, resource) :=
    binding ∈ user.role_bindings
    ∧ binding.role permits action
    ∧ resource is within binding.scope        -- state admin ⇒ only their state's rows
    ∧ binding.status = active ∧ not expired
```

Enforced in **one** server-side policy module used by every endpoint and every page loader.
No page-level `if (isAdmin)` scattering. Least privilege; deny by default.

### 4.3 Migration from today

The existing admin password becomes a `SUPER_ADMIN` seed user; each `unitAccess` code becomes a
`STATE_ADMIN`/`DISTRICT_ADMIN`/`DOJO_ADMIN` binding on a real user. Codes keep working during
transition (dual-path auth), then are retired.

---

## 5. Approval engine (§76) — generic

One reusable workflow, not seven bespoke ones:

```sql
approval_requests (id pk, subject_type, subject_id, workflow_code,
                   status ∈ (submitted,under_review,changes_requested,approved,rejected,
                             appealed,finalized),
                   submitted_by, current_stage, created_at, decided_at)
approval_steps    (id pk, request_id fk, stage, actor_user_id, decision, comment, at)
```

Used by: dojo affiliation · grading results · certificate issuance · official appointments ·
competition sanction · policy publication.

---

## 6. Versioning (§77)

`syllabus_versions`, `documents.version`, `ranking_rule_sets.version`, `certificate_templates.version`.
Every historical record stores the **version id that applied at the time** — so a 2019 grading
always renders against the 2019 syllabus, not today's.

---

## 7. Revocation (§78)

Never delete. `status → revoked` + `revoked_reason`, `revoked_by`, `revoked_at`, audit row.
Applies to memberships, affiliations, certificates, qualifications, and (where formally
authorised) rank records — which supersede rather than erase.

---

## 8. Security architecture (§53)

| Control | Design |
|---|---|
| AuthN | argon2id password hashing, OTP option, lockout after N failures, timing-safe compare (already present for legacy paths) |
| AuthZ | single policy module, deny-by-default, scope-checked on every query (prevents IDOR) |
| Session | HttpOnly, SameSite=Lax, Secure in prod, 7-day, rotation on privilege change; server-side revocation list for compromised sessions |
| CSRF | SameSite=Lax + JSON-only content type + origin check on state-changing endpoints |
| XSS | Astro auto-escaping; **`set:html` restricted to page-literal strings only**; admin renders via `esc()`; CSP tightened from report-only to enforcing |
| Injection | parameterised queries only (Drizzle); no string SQL |
| Rate limiting | Upstash Ratelimit on `/api/*` — login 5/min/IP, public writes 10/min/IP, verify 30/min/IP |
| Enumeration | sequential public IDs are register keys by design; private receipts use unguessable tokens; verify returns no PII and is rate-limited |
| Uploads | allow-list MIME, size cap, re-encode images, random object names, served from Blob domain, never executable |
| Secrets | env only; no secret in repo or client bundle; rotation runbook |
| Audit | every privileged mutation → `audit_events` in-transaction |

---

## 9. Files & media (§22, §34)

Vercel Blob. `assets (id pk, kind, mime, bytes, url, checksum, uploaded_by, created_at)`.
Certificates render server-side to PDF and are stored as assets with the certificate row.
Video: `video_assets` supports uploaded, external-authorised URL, or future streaming provider —
with the CHECK constraint from §3.8 preventing "free preview" labels on lessons with no video.

---

## 10. Environments & migrations (§55, §56)

| Env | DB | Deploy |
|---|---|---|
| development | Postgres branch `dev` (or local) | local `npm run dev` |
| staging | Postgres branch `staging` | Vercel preview on PR |
| production | Postgres `main` | Vercel production on `main` |

Drizzle migrations, forward-only, each with a documented rollback. Never run destructive
migrations against production without a verified backup. Seeds are idempotent and never
overwrite production data.

---

## 11. Build order (mapped to Directive §84 priority)

| Wave | Contents | Directive priority |
|---|---|---|
| **2a** | Postgres provisioning · schema core (`persons`, units, dojos, memberships, `audit_events`) · users/roles/RBAC policy module · rate limiting · CSP enforcing | P0/P1 |
| **2b** | Federation registry UI + role dashboards · membership lifecycle · public verification centre backed by real records · certificates (records + PDF + QR) | P1 |
| **2c** | Grading engine: syllabus config → grading events → candidates → examiner scorecards → approval → certificate → immutable history | P1 |
| **2d** | Competition: entities, status engine, eligibility rules, entries, officials, draws, results (locked), rankings (configurable rules) | P2 |
| **2e** | Academy (courses/modules/lessons/progress/quizzes) · Commerce (cart/orders/payment abstraction) · Finance | P2 |
| **2f** | Governance/policy/safeguarding modules · reporting · analytics | P2/P3 |

Each wave ships **UI + backend + DB + authorization + validation + lifecycle + error handling +
auditability + production verification** — the Directive's definition of DONE — or it does not ship.

---

## 12. Decisions requiring MMAKF (never invented — Directive §68, §82)

| # | Decision needed | Blocks |
|---|---|---|
| D-1 | Official Kyu syllabus per grade (kihon/kata/kumite/theory, time-in-grade, min age) | grading config content |
| D-2 | Dan requirements per rank, and which Dan ranks MMAKF formally awards | Dan module |
| D-3 | Examiner authority levels and who holds them | examiner quals |
| D-4 | Official fee schedule (membership, grading, competition, affiliation) | payments, all fee displays |
| D-5 | Statutory office bearers (President, General Secretary, Treasurer…) and current holders | governance register |
| D-6 | Which policies are formally approved vs draft (safeguarding, anti-doping, code of conduct) | policy centre publication |
| D-7 | Evidence for recognitions (Limca, Guinness-linked, WKF pathway status) | claims audit resolution |
| D-8 | Real state/district/dojo register data and charter dates | federation registry seeding |
| D-9 | Ranking rules (event weighting, placement points) | ranking engine |
| D-10 | Payment provider account (Razorpay) + settlement/refund policy | commerce checkout |

Until each is supplied, the corresponding surface renders an explicit
**"Awaiting federation confirmation"** state — never invented content.
