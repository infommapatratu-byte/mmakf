# DATA-ARCHITECTURE

The 87-table relational model, the rules that shape it, and why each non-obvious decision was made.

If you are changing the schema, read §2 first. Those five rules explain most of what looks unusual.

---

## 1. Two stores, deliberately

| Store | Holds | Why |
|---|---|---|
| **Redis (Upstash)** | Editorial CMS content — news, pages, gallery, FAQs, programmes | No integrity requirements. The office edits it directly and it works. |
| **Postgres** | Every federation record | Needs foreign keys, transactions, immutable history and role-scoped queries. JSON blobs provide none of these. |

**One system of record per fact.** A fact lives in exactly one store. Where both could plausibly hold
something — a member's name, say — Postgres wins and Redis is not permitted a copy, because two
copies drift and neither is then authoritative.

**The driver is vendor-neutral by instruction.** `postgres.js` over plain TCP. `DATABASE_URL` is the
only input, so Supabase, Railway, Render, Fly, RDS or self-hosted are drop-in. **Never reintroduce
Neon or Vercel Postgres** — the federation rejected it, and the decision is recorded in
`PROJECT-CONTEXT.md`.

Serverless connection settings, documented where they are set in `src/db/index.ts`:
`max: 1` (an instance-per-invocation model cannot afford a pool each) and `prepare: false` (required
through a transaction-mode pooler, whose backend swaps underneath a prepared statement — the classic
"prepared statement does not exist" failure under load).

---

## 2. The five rules that shape everything

### 2.1 Structure is engineering; content is the federation's

The schema defines the **shape** of a syllabus, a ranking ruleset, a fee, a quorum. It never contains
the **values**. Not one technique, minimum interval, pass mark, points table, attendance threshold or
rupee figure is in code.

Every such column is nullable and unset by default. **An unset rule is not checked, and the result
says it was not set** — never "failed" against a threshold nobody approved.

This is the rule most likely to be broken by an agent trying to be helpful, and the one whose breach
does most damage: an invented grading syllabus is fraud.

### 2.2 Version anything that changes meaning

A 2026 grading must keep the meaning it had in 2026. Revising a syllabus in place would silently
rewrite every certificate already issued under it.

Versioned: syllabus, grade definitions and requirements, ranking rulesets, official documents,
competition rulesets, certificates, courses.

A published version is **never edited**. Revision creates a new version and marks the old superseded.

### 2.3 Derive rather than store

Current rank is derived from the append-only rank ledger. Progress is derived from completed lessons.
Medal counts are derived from final results. Rankings are computed and snapshotted, never
incrementally patched.

A stored copy survives a correction. A medal tally that contradicts the results register is worse
than a slow query.

**Where a snapshot IS stored, it is frozen deliberately** — a certificate's printed contents, an
examiner's qualification at appointment, an eligibility decision with its evidence. These are records
of *what was true then*, and must not follow later edits.

### 2.4 Append, never overwrite

| Table | Instead of an update |
|---|---|
| `rank_records` | A promotion supersedes; the previous row stays |
| `match_events` | A correction appends a reversing event |
| `competition_results` | A correction supersedes, with authority and reason |
| `case_notes` | No edit path exists |
| `audit_events` | Append-only by contract |
| `document_versions` | A new version; the old stays readable |
| `domain_events` | The feed itself |

**Revocation never deletes.** A vanished credential is indistinguishable from one that never existed
— which is exactly what a holder of a revoked certificate would prefer.

### 2.5 Integers only

Money in **paise**. Weight in **grams**. Kata scores in **hundredths**. Never a float, anywhere.

`paise(0.1) + paise(0.2) === paise(0.3)` is a test. A federation's accounts cannot drift by rounding,
and a kata score that fails to sum reliably decides a medal.

---

## 3. Domains

87 tables across four migrations.

### 3.1 Federation core — 14 tables

`state_units` · `district_units` · `dojos` · `persons` · `memberships` · `rank_records` ·
`instructor_quals` · `examiner_quals` · `official_quals` · `governance_posts` · `users` ·
`role_bindings` · `audit_events` · `id_sequences`

**One person, many roles.** A person who is an athlete, an instructor and an examiner is **one**
`persons` row with three credentials. Duplicating them would make it impossible to answer "what is
this person's history".

**Credentials are separate tables, not one `rank` column.** A Dan grade is a grade. An instructor
licence is permission to teach. An examiner authority is permission to grade others. An officiating
licence is permission to referee. A governance post is an office. They are awarded by different
bodies, expire differently and are withdrawn independently. Collapsing them is how a federation ends
up unable to say whether someone may examine.

**Identifiers come from `id_sequences`, allocated atomically.** Never `Date.now()` — a dojo entering
a batch of students produced colliding ids and silently overwrote its own records. Tested to 40-way
concurrency.

### 3.2 Commerce — 11 tables

`products` · `product_variants` · `fee_schedule` · `orders` · `order_lines` · `payments` ·
`payment_events` · `refunds` · `invoices` · `settlements` · `ledger_entries`

**One order spine for every money flow.** Membership, affiliation, event entry, grading, course,
certificate and shop are order-line *kinds*, not six mechanisms each with its own half-built receipt.

**Payment attempts are append-only.** A failed card followed by a successful UPI leaves two rows. A
failed attempt is evidence.

**Invoices number in their own unbroken series**, separate from orders — orders are abandoned before
payment constantly, and a tax document series with gaps is a problem at audit.

**Stock reserves before payment** and releases on expiry, so an abandoned checkout cannot hold the
last gi indefinitely.

### 3.3 Technical & grading — 13 tables

`syllabus_versions` · `techniques` · `kata` · `kumite_forms` · `grade_definitions` ·
`grade_requirements` · `grading_events` · `grading_panel` · `grading_candidates` · `grading_scores` ·
`certificates` · `verification_log`

**Reference material and grading requirements are separate.** `techniques` describes Shotokan
technique; `grade_requirements` says which are examined at which grade under which syllabus version.
A teacher's interpretation is not federation doctrine, and `sourceKind` records which it is.

**Scores are per examiner.** Never merged on the way in, so a panel disagreement stays visible and an
appeal can see who marked what.

> `grading_scores` uses **two partial unique indexes** rather than one. `grade_requirement_id` is
> nullable — NULL means a whole-component score — and Postgres treats NULLs as *distinct*, so a
> single four-column index never matched an existing component row: re-scoring inserted a duplicate
> and double-counted that examiner. `NULLS NOT DISTINCT` would fix it but this Drizzle version cannot
> express it, and a hand-written index would drift from the schema.

### 3.4 Competition — 17 tables

`competition_events` · `event_categories` · `event_entries` · `entry_members` · `draws` · `matches` ·
`match_events` · `kata_scores` · `competition_results` · `protests` · `event_officials` ·
`ranking_rulesets` · `ranking_periods` · `ranking_entries` · `national_squads` · `squad_members`

**Entries bind to an immutable event code**, never a display title. Renaming an event previously
orphaned every entry attached to it.

**Draws store `randomSeed` and `seedInput`** so a bracket is reproducible. A draw nobody can
reproduce is a draw nobody can defend when a coach alleges it was rigged.

**Age by birth-year bounds** (`bornOnOrAfter` / `bornOnOrBefore`), because karate regulations define
age by year of birth on the day of competition, not by exact age.

**`ranking_entries.contributions`** holds every event that fed a total, with placing, points and the
rule that produced them. Without it a ranking is an assertion — and rankings are what athletes
dispute most.

### 3.5 Education & media — 16 tables

`media_channels` · `media_assets` · `broadcasts` · `live_classes` · `live_class_attendance` ·
`live_class_questions` · `live_class_resources` · `courses` · `course_modules` · `lessons` ·
`quizzes` · `quiz_questions` · `enrolments` · `lesson_progress` · `quiz_attempts` ·
`training_sessions` · `session_attendance`

**Broadcast and live class are separate.** A broadcast is a fact about YouTube; a class is a fact
about MMAKF. Conflating them would tie the federation's curriculum to another platform's lifecycle.

**Classification and rights are independent columns.** A video can be entirely federation-relevant
and still not be MMAKF's to publish. Treating relevance as permission is how a federation ends up
republishing someone else's footage.

**Attendance records presence, never proficiency.** Conflating them is how attendance quietly becomes
a grading criterion nobody approved.

### 3.6 Governance & operations — 16 tables

`committees` · `committee_appointments` · `official_documents` · `document_versions` · `meetings` ·
`meeting_attendance` · `resolutions` · `action_items` · `interest_declarations` ·
`disciplinary_cases` · `safeguarding_cases` · `case_notes` · `medical_records` · `support_tickets` ·
`partners` · `domain_events` · `notifications`

**Safeguarding is a separate table from disciplinary, by design.** Merging them puts child-protection
material one careless join from a general admin list, and the two carry different lawful bases,
different retention and a different readership. **A safeguarding subject need not be a member** — the
schema does not require a `persons` row for them.

**Medical is deliberately minimal**: fitness to compete and emergency contact, not a clinical record.
Collecting more than the purpose requires is itself the risk.

**`domain_events` is the internal feed** so notifications, analytics, the scoreboard and any future
mobile app stay consistent instead of each computing its own version of the truth.

---

## 4. Migrations

Forward-only SQL in `drizzle/`, applied in filename order by `scripts/migrate.mjs`.

| Property | How |
|---|---|
| Atomic | Each file applies inside a transaction. Postgres DDL is transactional, so a half-failed migration leaves the database exactly as it was |
| Checksummed | An applied migration that was **edited** is a hard error. Editing applied history is how environments silently diverge |
| Explicit target | Refuses to run without `DATABASE_URL`. No fallback — pointing migrations at the wrong environment is worse than failing |
| Explicit schema | `search_path` is set rather than inherited. A pooler or a previous session can leave it pointing somewhere unexpected |
| Verified | `npm run db:verify` runs the real runner against a real Postgres server: pending detection, apply, idempotent re-run, and refusal of edited history |

```bash
npm run dev:db      # real Postgres on 127.0.0.1:5433, no Docker
npm run db:migrate
npm run db:verify
```

**Never reconstruct the schema by hand in a provider's dashboard.** The migration chain is the only
sanctioned path, and a manually-created production schema cannot be reasoned about afterwards.

---

## 5. Data quality is a first-class concern

The system knows where its own records are weak, and says so rather than presenting everything with
equal confidence.

**Provenance travels with every credential claim:**

| | |
|---|---|
| `examined` | Traced to a grading with examiner scores behind it |
| `unverified_legacy` | A real grade predating digital records; evidence held, no examination record |
| `legacy_register` | The hand-typed list — used only while no database is configured |

Reporting all three identically is what made the old verification endpoint misleading.

**Legacy records are admitted, never disguised.** Decades of real gradings predate any digital
record, and refusing them would erase the federation's history. `recordLegacyGrade()` admits them
with **no invented grading event**, marks them `UNVERIFIED_LEGACY_RECORD`, and requires a note of
what evidence the office actually holds.

---

## 6. Known limitations

| | |
|---|---|
| **No Postgres row-level security.** Enforcement is entirely in the application policy layer — correct and adversarially tested, but a direct database connection bypasses it. Matters once a second system touches the database. |
| **Redis has no transactions across keys.** List writes are atomic (`LPUSH`/`RPOPLPUSH`); whole-key writes are read-modify-write, which is why queue decisions are serialised through one function. |
| **`domain_events` has no publisher yet.** The table exists and is empty. |
| **No archival or retention policy.** Data protection requires one; the classification column is the foundation, the policy is not written. |
| **No partitioning.** `audit_events`, `match_events` and `verification_log` grow without bound. Fine at federation scale for years; worth revisiting before it is urgent. |
