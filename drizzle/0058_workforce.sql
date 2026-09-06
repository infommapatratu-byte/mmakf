-- THE WORKFORCE — employment, leave, time, expenses, and recruitment.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT WAS HERE BEFORE: `hr:read`, `hr:write`, `HR_OFFICER`, AND NO TABLES
-- ═════════════════════════════════════════════════════════════════════════════
--
-- src/lib/rbac.ts has carried `hr:read` / `hr:write` and an `HR_OFFICER` role
-- since the operations wave. Both sit deliberately OUTSIDE `NATIONAL_FULL`, and
-- `HR_OFFICER` is in `RESTRICTED_ROLES` so a federation administrator cannot
-- mint one and read the data through it.
--
-- All of that guarded nothing. There was no employment record, no leave, no
-- vacancy, no candidate — the permission existed and the data did not. This
-- migration is what those actions have been protecting all along.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ONE PERSON. STILL ONE PERSON.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `employments.person_id` REFERENCES `persons`. There is no `employees` table
-- carrying a name, a date of birth or an email, because the federation's
-- Technical Director is very often also a 5th Dan, an examiner, a club owner and
-- a member — and a second identity record for the same human being is a second
-- spelling, a second date of birth, and a certificate issued against the wrong
-- row.
--
-- `team_appointments` (0056) says WHAT SOMEBODY DOES in public.
-- `employments` (here) says THE FEDERATION EMPLOYS THEM, and is private.
--
-- Those are different facts and they are deliberately different tables. A
-- volunteer regional coordinator appears on /team and is not employed. A payroll
-- clerk is employed and never appears on /team. Merging them would force one of
-- those two to be misrepresented, and the public table would inherit the private
-- table's columns — which is exactly the leak 0056 was built to make impossible.
--
-- THERE IS NO FOREIGN KEY BETWEEN `employments` AND `team_appointments`, in
-- either direction. They meet at `persons.id` and nowhere else.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- A CANDIDATE IS NOT YET A PERSON, AND THAT IS THE EXISTING PATTERN
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `job_applications` holds the applicant's own details and a NULLABLE
-- `person_id`. Somebody who applies for a job at MMAKF and is not hired must not
-- appear in the federation's people register — that register is members,
-- coaches, officials and athletes, and filing every unsuccessful applicant into
-- it would make the national member count a number nobody could defend.
--
-- This mirrors what the repository already does for institutional intake:
-- `applications` collects a submission, and `provisionFromRegistration()` in
-- src/db/provisioning.ts creates the `persons` row at APPROVAL, not at
-- submission. Hiring follows the same shape — the person row is created or
-- linked when an offer is ACCEPTED, and `src/db/workforce.ts` is where that
-- happens.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION REFUSES TO DECIDE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- IT HOLDS NO SALARY FIGURE AND NO BANK DETAIL. `employments` has a
-- `pay_band_code` — a reference to a band MMAKF defines elsewhere — and no
-- amount. Payroll is a regulated system with statutory obligations (PF, ESI,
-- TDS, Form 16) that this repository cannot discharge, and a half-built payroll
-- that computes a figure somebody pays a real person is worse than none. §25
-- asks for a PAYROLL INTERFACE, and an interface to a payroll system is what
-- this is: the establishment, the person, the band and the approved time.
--
-- IT SEEDS NO LEAVE TYPE. Casual, sick, earned, maternity, bereavement — their
-- names, their entitlements and their accrual rules are MMAKF's employment
-- policy, and a plausible seeded row is indistinguishable six months later from
-- one an officer confirmed. `leave_types` ships EMPTY and every surface says the
-- federation has not published its leave policy, which is true.
--
-- IT DEFINES NO NOTICE PERIOD, NO PROBATION LENGTH AND NO WORKING WEEK.

-- ── Vocabulary ──────────────────────────────────────────────────────────────

CREATE TYPE "public"."employment_type" AS ENUM(
  'permanent', 'fixed_term', 'contract', 'consultant',
  'intern', 'apprentice', 'volunteer', 'secondment'
);--> statement-breakpoint

-- The EMPLOYMENT's lifecycle. Not the person's, and not the login's — ending an
-- employment does not disable a `users` row, because a departing employee is
-- routinely still a member and still holds a rank.
CREATE TYPE "public"."employment_status" AS ENUM(
  'offered', 'onboarding', 'active', 'on_leave',
  'suspended', 'notice', 'ended'
);--> statement-breakpoint

CREATE TYPE "public"."position_status" AS ENUM(
  'draft', 'open', 'filled', 'frozen', 'closed'
);--> statement-breakpoint

CREATE TYPE "public"."leave_request_status" AS ENUM(
  'draft', 'submitted', 'approved', 'rejected', 'cancelled', 'withdrawn'
);--> statement-breakpoint

CREATE TYPE "public"."expense_claim_status" AS ENUM(
  'draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled'
);--> statement-breakpoint

CREATE TYPE "public"."vacancy_status" AS ENUM(
  'draft', 'open', 'closed', 'filled', 'withdrawn'
);--> statement-breakpoint

CREATE TYPE "public"."job_application_status" AS ENUM(
  'received', 'screening', 'shortlisted', 'interviewing',
  'offered', 'accepted', 'declined', 'rejected', 'withdrawn'
);--> statement-breakpoint

CREATE TYPE "public"."work_record_status" AS ENUM(
  'draft', 'submitted', 'approved', 'rejected'
);--> statement-breakpoint

-- ── The establishment ───────────────────────────────────────────────────────
--
-- A POSITION is a SLOT, not a person. "Competition Operations Manager" exists
-- whether or not anybody currently holds it, which is what lets the federation
-- carry a vacancy, a reporting line and a headcount without inventing a
-- placeholder employee to hang them from.
CREATE TABLE "positions" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "title" text NOT NULL,
  -- Reuses `departments` from migration 0056 rather than minting a second
  -- organisational tree. The team register and the establishment describe the
  -- same organisation and must not disagree about what its departments are.
  "department_id" integer REFERENCES "departments"("id"),
  -- Reuses the `org_level` enum from 0056, for the same reason.
  "org_level" "org_level" NOT NULL,
  "reports_to_position_id" integer REFERENCES "positions"("id"),
  -- How many people this position may hold at once. Usually 1; a "Regional
  -- Coordinator" position may legitimately be 12.
  "headcount" integer DEFAULT 1 NOT NULL,
  "status" "position_status" DEFAULT 'draft' NOT NULL,
  -- A REFERENCE, NOT AN AMOUNT. See the header: no rupee figure lives in this
  -- migration. MMAKF's band table is MMAKF's.
  "pay_band_code" text,
  "scope_type" "scope_type" DEFAULT 'national' NOT NULL,
  "scope_state_unit_id" integer REFERENCES "state_units"("id"),
  "description" text,
  "responsibilities" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "positions_headcount_ck" CHECK ("headcount" >= 1),
  CONSTRAINT "positions_not_self_report_ck"
    CHECK ("reports_to_position_id" IS NULL OR "reports_to_position_id" <> "id"),
  CONSTRAINT "positions_scope_ck" CHECK (
    ("scope_type" = 'national' AND "scope_state_unit_id" IS NULL)
    OR ("scope_type" = 'state' AND "scope_state_unit_id" IS NOT NULL)
    OR ("scope_type" NOT IN ('national', 'state'))
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "positions_code_uk" ON "positions" ("code");--> statement-breakpoint
CREATE INDEX "positions_dept_idx" ON "positions" ("department_id");--> statement-breakpoint
CREATE INDEX "positions_reports_idx" ON "positions" ("reports_to_position_id");--> statement-breakpoint

-- ── Employment ──────────────────────────────────────────────────────────────
CREATE TABLE "employments" (
  "id" serial PRIMARY KEY NOT NULL,
  -- THE CANONICAL PERSON. Never a name. See the header.
  "person_id" integer NOT NULL REFERENCES "persons"("id"),
  "position_id" integer REFERENCES "positions"("id"),
  -- Stable, human-quotable, allocated by the domain module.
  "employee_no" text NOT NULL,
  "employment_type" "employment_type" NOT NULL,
  "status" "employment_status" DEFAULT 'offered' NOT NULL,

  -- THE LINE MANAGER, as a PERSON not a position. A position's
  -- `reports_to_position_id` is the establishment's shape; this is who actually
  -- approves this employee's leave today, which during a vacancy is somebody
  -- else entirely. Both are needed and they are not the same fact.
  "manager_person_id" integer REFERENCES "persons"("id"),

  "started_on" date NOT NULL,
  "ended_on" date,
  "probation_ends_on" date,
  "notice_ends_on" date,
  "work_location" text,
  "weekly_hours" integer,
  "pay_band_code" text,

  -- Why they left, as a controlled vocabulary the domain module enforces:
  -- resigned | retired | contract_ended | dismissed | redundancy | deceased |
  -- transferred. NOT free text — an exit reason is read in aggregate, and free
  -- text makes that impossible.
  "exit_reason" text,
  "exit_note" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "employments_period_ck" CHECK ("ended_on" IS NULL OR "ended_on" >= "started_on"),
  -- An ended employment has an end date and a live one does not. Without this a
  -- row could read 'ended' with no date, which is an employee the federation
  -- cannot say when it stopped employing — the same defect
  -- `team_appointments_ended_ck` prevents on the public side.
  CONSTRAINT "employments_ended_ck" CHECK (("status" = 'ended') = ("ended_on" IS NOT NULL)),
  CONSTRAINT "employments_hours_ck" CHECK ("weekly_hours" IS NULL OR ("weekly_hours" > 0 AND "weekly_hours" <= 168)),
  CONSTRAINT "employments_not_own_manager_ck"
    CHECK ("manager_person_id" IS NULL OR "manager_person_id" <> "person_id")
);--> statement-breakpoint

CREATE UNIQUE INDEX "employments_employee_no_uk" ON "employments" ("employee_no");--> statement-breakpoint
CREATE INDEX "employments_person_idx" ON "employments" ("person_id");--> statement-breakpoint
CREATE INDEX "employments_manager_idx" ON "employments" ("manager_person_id");--> statement-breakpoint
CREATE INDEX "employments_position_idx" ON "employments" ("position_id");--> statement-breakpoint
CREATE INDEX "employments_status_idx" ON "employments" ("status");--> statement-breakpoint

-- ONE LIVE EMPLOYMENT PER PERSON.
--
-- A person may be re-employed after leaving, so this is partial rather than a
-- plain unique index — the closed rows stay and are the employment history.
-- Without it, a retried onboarding creates a second live employment and every
-- leave balance, every approval route and every headcount doubles silently.
CREATE UNIQUE INDEX "employments_one_live_uk" ON "employments" ("person_id")
  WHERE "status" <> 'ended';--> statement-breakpoint

-- The employment record's own history. Append-only; `src/db/workforce.ts`
-- issues no UPDATE and no DELETE against it, and a test asserts that by reading
-- the module's source.
CREATE TABLE "employment_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "employment_id" integer NOT NULL REFERENCES "employments"("id"),
  -- 'offered' | 'accepted' | 'onboarded' | 'confirmed' | 'promoted'
  -- | 'transferred' | 'manager_changed' | 'suspended' | 'reinstated'
  -- | 'notice_given' | 'ended'
  "kind" text NOT NULL,
  "effective_on" date NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL,
  "reason" text,
  "actor_user_id" integer,
  "actor_label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "employment_events_emp_idx" ON "employment_events" ("employment_id", "id");--> statement-breakpoint

-- ── Leave ───────────────────────────────────────────────────────────────────
--
-- SHIPS EMPTY. Casual, sick, earned, maternity — their names, entitlements and
-- accrual rules are MMAKF's employment policy, not a developer's guess.
CREATE TABLE "leave_types" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "paid" boolean DEFAULT true NOT NULL,
  -- Whether a request may exceed the recorded entitlement. Some federations
  -- allow negative balances against earned leave; MMAKF decides.
  "allows_negative" boolean DEFAULT false NOT NULL,
  -- Whether approval requires the HR office as well as the line manager.
  "requires_hr_approval" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "leave_types_code_uk" ON "leave_types" ("code");--> statement-breakpoint

-- What somebody is entitled to, for one leave year. Effective-dated by
-- `leave_year` rather than a validity window, because leave is accounted by year
-- and a window makes "how many days do I have left this year" a range query
-- nobody gets right twice.
CREATE TABLE "leave_entitlements" (
  "id" serial PRIMARY KEY NOT NULL,
  "employment_id" integer NOT NULL REFERENCES "employments"("id"),
  "leave_type_id" integer NOT NULL REFERENCES "leave_types"("id"),
  "leave_year" integer NOT NULL,
  -- Stored in HALF-DAYS as an integer, never a float. A half day off is the
  -- smallest unit any of this needs, and 0.5 in floating point is the kind of
  -- thing that makes a balance read 4.499999999.
  "entitled_half_days" integer DEFAULT 0 NOT NULL,
  "carried_half_days" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "leave_entitlements_nonneg_ck"
    CHECK ("entitled_half_days" >= 0 AND "carried_half_days" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "leave_entitlements_uk"
  ON "leave_entitlements" ("employment_id", "leave_type_id", "leave_year");--> statement-breakpoint

CREATE TABLE "leave_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "employment_id" integer NOT NULL REFERENCES "employments"("id"),
  "leave_type_id" integer NOT NULL REFERENCES "leave_types"("id"),
  "reference" text NOT NULL,
  "from_date" date NOT NULL,
  "to_date" date NOT NULL,
  -- Half-days, as above. Computed by the domain module from the dates and the
  -- half-day flags, never supplied by the client — a request that could name its
  -- own duration is a request that can be 0.5 days long and 30 days wide.
  "half_days" integer NOT NULL,
  "first_day_half" boolean DEFAULT false NOT NULL,
  "last_day_half" boolean DEFAULT false NOT NULL,
  "status" "leave_request_status" DEFAULT 'draft' NOT NULL,
  "reason" text,
  -- The manager's decision.
  "decided_by_user_id" integer,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  -- The HR office's second decision, where the leave type demands one.
  "hr_decided_by_user_id" integer,
  "hr_decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "leave_requests_period_ck" CHECK ("to_date" >= "from_date"),
  CONSTRAINT "leave_requests_days_ck" CHECK ("half_days" > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "leave_requests_reference_uk" ON "leave_requests" ("reference");--> statement-breakpoint
CREATE INDEX "leave_requests_emp_idx" ON "leave_requests" ("employment_id", "from_date");--> statement-breakpoint
CREATE INDEX "leave_requests_status_idx" ON "leave_requests" ("status");--> statement-breakpoint

-- ── Time ────────────────────────────────────────────────────────────────────
--
-- DELIBERATELY NOT `session_attendance` OR `attendance_records`. Those exist and
-- are a CLASS REGISTER — which student turned up to which training session.
-- This is an EMPLOYEE's working time. Conflating them would put a payroll
-- question and a safeguarding question in one table.
CREATE TABLE "work_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "employment_id" integer NOT NULL REFERENCES "employments"("id"),
  "work_date" date NOT NULL,
  -- MINUTES, integer. Not hours-as-decimal, for the reason leave is half-days:
  -- 7.5 hours is exact, 7.4999999 is what a float eventually reads.
  "minutes" integer NOT NULL,
  "status" "work_record_status" DEFAULT 'draft' NOT NULL,
  "note" text,
  "approved_by_user_id" integer,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "work_records_minutes_ck" CHECK ("minutes" > 0 AND "minutes" <= 1440)
);--> statement-breakpoint

CREATE UNIQUE INDEX "work_records_uk" ON "work_records" ("employment_id", "work_date");--> statement-breakpoint
CREATE INDEX "work_records_status_idx" ON "work_records" ("status");--> statement-breakpoint

-- ── Expenses ────────────────────────────────────────────────────────────────
CREATE TABLE "expense_claims" (
  "id" serial PRIMARY KEY NOT NULL,
  "employment_id" integer NOT NULL REFERENCES "employments"("id"),
  "reference" text NOT NULL,
  "title" text NOT NULL,
  -- INTEGER PAISE, like every other money column in this repository
  -- (src/db/fees.ts, src/db/orders.ts). Never a decimal, never rupees.
  "total_minor" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "status" "expense_claim_status" DEFAULT 'draft' NOT NULL,
  "submitted_at" timestamp with time zone,
  "decided_by_user_id" integer,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  -- Set when finance records the payment. NOT a payment integration: the
  -- federation pays an employee expense through its own banking, and inventing
  -- a gateway path for it would be fake automation.
  "paid_on" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "expense_claims_total_ck" CHECK ("total_minor" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "expense_claims_reference_uk" ON "expense_claims" ("reference");--> statement-breakpoint
CREATE INDEX "expense_claims_emp_idx" ON "expense_claims" ("employment_id");--> statement-breakpoint
CREATE INDEX "expense_claims_status_idx" ON "expense_claims" ("status");--> statement-breakpoint

CREATE TABLE "expense_claim_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "claim_id" integer NOT NULL REFERENCES "expense_claims"("id"),
  "spent_on" date NOT NULL,
  -- travel | accommodation | meals | equipment | training | other
  "category" text NOT NULL,
  "description" text NOT NULL,
  "amount_minor" integer NOT NULL,
  -- A pointer into the existing upload store, never a file in the database.
  "receipt_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "expense_claim_lines_amount_ck" CHECK ("amount_minor" > 0)
);--> statement-breakpoint

CREATE INDEX "expense_claim_lines_claim_idx" ON "expense_claim_lines" ("claim_id");--> statement-breakpoint

-- ── Recruitment ─────────────────────────────────────────────────────────────
CREATE TABLE "vacancies" (
  "id" serial PRIMARY KEY NOT NULL,
  "position_id" integer REFERENCES "positions"("id"),
  "reference" text NOT NULL,
  "title" text NOT NULL,
  "department_id" integer REFERENCES "departments"("id"),
  "slug" text,
  "summary" text,
  "description" text,
  "requirements" text,
  "employment_type" "employment_type" NOT NULL,
  "location" text,
  "scope_type" "scope_type" DEFAULT 'national' NOT NULL,
  "scope_state_unit_id" integer REFERENCES "state_units"("id"),
  "openings" integer DEFAULT 1 NOT NULL,
  "status" "vacancy_status" DEFAULT 'draft' NOT NULL,
  -- PUBLICATION IS AN ACT, as it is for a team appointment. Creating a vacancy
  -- does not advertise it on the public careers page.
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "opens_on" date,
  "closes_on" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "vacancies_openings_ck" CHECK ("openings" >= 1),
  CONSTRAINT "vacancies_window_ck" CHECK ("closes_on" IS NULL OR "opens_on" IS NULL OR "closes_on" >= "opens_on"),
  -- Only an OPEN vacancy may be advertised. A draft, a closed one and a
  -- withdrawn one on the public careers page are three different false
  -- statements, and the last invites applications nobody will read.
  CONSTRAINT "vacancies_publish_ck" CHECK (NOT "published" OR "status" = 'open')
);--> statement-breakpoint

CREATE UNIQUE INDEX "vacancies_reference_uk" ON "vacancies" ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "vacancies_slug_uk" ON "vacancies" ("slug") WHERE "slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vacancies_public_idx" ON "vacancies" ("published", "status");--> statement-breakpoint

-- An APPLICANT, who is not yet a person in the federation register. See the
-- header: the `persons` row is created when an offer is ACCEPTED, mirroring
-- provisionFromRegistration() on the institutional intake path.
CREATE TABLE "job_applications" (
  "id" serial PRIMARY KEY NOT NULL,
  "vacancy_id" integer NOT NULL REFERENCES "vacancies"("id"),
  "reference" text NOT NULL,
  -- The applicant as they described themselves. PRIVATE, every column.
  "applicant_name" text NOT NULL,
  "applicant_email" text NOT NULL,
  "applicant_phone" text,
  "cover_note" text,
  "cv_ref" text,
  "current_employer" text,
  "years_experience" integer,
  -- Null until hired. THE JOIN TO THE ONE CANONICAL PERSON.
  "person_id" integer REFERENCES "persons"("id"),
  "status" "job_application_status" DEFAULT 'received' NOT NULL,
  "rejected_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "job_applications_experience_ck"
    CHECK ("years_experience" IS NULL OR ("years_experience" >= 0 AND "years_experience" <= 80))
);--> statement-breakpoint

CREATE UNIQUE INDEX "job_applications_reference_uk" ON "job_applications" ("reference");--> statement-breakpoint
-- ONE APPLICATION PER EMAIL PER VACANCY. A double-submitted form must not
-- create two candidates for one person — the second submission is refused and
-- the applicant told their application is already on file, rather than being
-- silently duplicated into a panel's shortlist twice.
CREATE UNIQUE INDEX "job_applications_one_per_email_uk"
  ON "job_applications" ("vacancy_id", lower("applicant_email"));--> statement-breakpoint
CREATE INDEX "job_applications_status_idx" ON "job_applications" ("status");--> statement-breakpoint

CREATE TABLE "job_application_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "application_id" integer NOT NULL REFERENCES "job_applications"("id"),
  "kind" text NOT NULL,
  "note" text,
  "actor_user_id" integer,
  "actor_label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "job_application_events_app_idx" ON "job_application_events" ("application_id", "id");--> statement-breakpoint

CREATE TABLE "interviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "application_id" integer NOT NULL REFERENCES "job_applications"("id"),
  "round" integer DEFAULT 1 NOT NULL,
  "scheduled_at" timestamp with time zone,
  "duration_minutes" integer,
  "mode" text,
  "location" text,
  -- scheduled | held | cancelled | no_show
  "status" text DEFAULT 'scheduled' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "interviews_round_ck" CHECK ("round" >= 1),
  CONSTRAINT "interviews_duration_ck"
    CHECK ("duration_minutes" IS NULL OR ("duration_minutes" > 0 AND "duration_minutes" <= 600))
);--> statement-breakpoint

CREATE UNIQUE INDEX "interviews_round_uk" ON "interviews" ("application_id", "round");--> statement-breakpoint

CREATE TABLE "interview_panellists" (
  "id" serial PRIMARY KEY NOT NULL,
  "interview_id" integer NOT NULL REFERENCES "interviews"("id"),
  "person_id" integer NOT NULL REFERENCES "persons"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "interview_panellists_uk" ON "interview_panellists" ("interview_id", "person_id");--> statement-breakpoint

-- ONE PANELLIST, ONE OPINION, RECORDED BEFORE THEY SEE THE OTHERS.
--
-- `interview_feedback` is written per panellist and the domain module refuses a
-- second write from the same one. That is not bureaucracy: a panel whose members
-- can revise their scores after reading each other's is a panel with one
-- opinion, and the whole purpose of a panel is that it has several.
CREATE TABLE "interview_feedback" (
  "id" serial PRIMARY KEY NOT NULL,
  "interview_id" integer NOT NULL REFERENCES "interviews"("id"),
  "panellist_person_id" integer NOT NULL REFERENCES "persons"("id"),
  -- 1..5. Deliberately coarse: a 1-100 scale invites a spurious precision no
  -- interviewer actually has.
  "score" integer,
  -- strong_yes | yes | no | strong_no
  "recommendation" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "interview_feedback_score_ck"
    CHECK ("score" IS NULL OR ("score" >= 1 AND "score" <= 5))
);--> statement-breakpoint

CREATE UNIQUE INDEX "interview_feedback_one_per_panellist_uk"
  ON "interview_feedback" ("interview_id", "panellist_person_id");--> statement-breakpoint

CREATE TABLE "job_offers" (
  "id" serial PRIMARY KEY NOT NULL,
  "application_id" integer NOT NULL REFERENCES "job_applications"("id"),
  "position_id" integer REFERENCES "positions"("id"),
  "reference" text NOT NULL,
  "employment_type" "employment_type" NOT NULL,
  "pay_band_code" text,
  "proposed_start_on" date NOT NULL,
  -- draft | issued | accepted | declined | withdrawn | lapsed
  "status" text DEFAULT 'draft' NOT NULL,
  "issued_at" timestamp with time zone,
  "responded_at" timestamp with time zone,
  "expires_on" date,
  "note" text,
  -- Set when acceptance creates the employment. The join that closes the loop
  -- from vacancy to employee.
  "employment_id" integer REFERENCES "employments"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX "job_offers_reference_uk" ON "job_offers" ("reference");--> statement-breakpoint
-- At most one live offer per application. Two outstanding offers for one
-- candidate is a contract dispute waiting to happen.
CREATE UNIQUE INDEX "job_offers_one_live_uk" ON "job_offers" ("application_id")
  WHERE "status" IN ('draft', 'issued', 'accepted');--> statement-breakpoint
