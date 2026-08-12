CREATE TYPE "public"."candidate_status" AS ENUM('applied', 'eligibility_check', 'eligible', 'ineligible', 'fee_pending', 'confirmed', 'withdrawn', 'absent', 'examined', 'passed', 'failed', 'referred');--> statement-breakpoint
CREATE TYPE "public"."certificate_kind" AS ENUM('kyu_grade', 'dan_grade', 'instructor', 'examiner', 'official', 'course_completion', 'affiliation', 'event_participation', 'other');--> statement-breakpoint
CREATE TYPE "public"."certificate_status" AS ENUM('issued', 'reissued', 'suspended', 'revoked', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."grading_status" AS ENUM('draft', 'scheduled', 'registration_open', 'registration_closed', 'in_progress', 'scoring', 'awaiting_approval', 'approved', 'locked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."kumite_system" AS ENUM('kihon_kumite', 'yakusoku_kumite', 'gohon_kumite', 'sanbon_kumite', 'ippon_kumite', 'jiyu_ippon_kumite', 'jiyu_kumite', 'shiai_kumite', 'other');--> statement-breakpoint
CREATE TYPE "public"."syllabus_status" AS ENUM('draft', 'under_review', 'approved', 'active', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."technique_category" AS ENUM('dachi', 'uke', 'tsuki', 'uchi', 'geri', 'tai_sabaki', 'ukemi', 'other');--> statement-breakpoint
CREATE TYPE "public"."discipline_kind" AS ENUM('kata', 'kumite', 'team_kata', 'team_kumite');--> statement-breakpoint
CREATE TYPE "public"."draw_format" AS ENUM('single_elimination', 'single_elimination_repechage', 'round_robin', 'pool_then_elimination', 'kata_flag', 'kata_scoring', 'team_elimination');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('draft', 'submitted', 'eligibility_check', 'ineligible', 'fee_pending', 'confirmed', 'checked_in', 'weighed_in', 'withdrawn', 'disqualified', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('national_championship', 'open_national', 'state_championship', 'district_championship', 'selection_trial', 'seminar', 'camp', 'grading', 'technical_course', 'referee_course', 'other');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'technical_review', 'sanction_review', 'approved', 'published', 'registration_open', 'registration_closed', 'check_in', 'live', 'results_pending', 'results_final', 'archived', 'cancelled', 'postponed');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('scheduled', 'called', 'in_progress', 'paused', 'completed', 'walkover', 'disqualification', 'cancelled', 'under_protest');--> statement-breakpoint
CREATE TYPE "public"."medal_kind" AS ENUM('gold', 'silver', 'bronze', 'participation');--> statement-breakpoint
CREATE TYPE "public"."protest_status" AS ENUM('lodged', 'fee_pending', 'under_review', 'upheld', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."result_status" AS ENUM('provisional', 'final', 'corrected', 'voided');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('upcoming', 'live', 'ended', 'recording_processing', 'recorded', 'archived', 'cancelled', 'missing');--> statement-breakpoint
CREATE TYPE "public"."course_status" AS ENUM('draft', 'review', 'published', 'archived', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."enrolment_status" AS ENUM('pending_payment', 'active', 'completed', 'expired', 'withdrawn', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."lesson_kind" AS ENUM('video', 'live_class', 'reading', 'quiz', 'assignment', 'practical', 'assessment');--> statement-breakpoint
CREATE TYPE "public"."media_class" AS ENUM('federation_official', 'federation_relevant', 'master_teaching', 'shotokan_technical', 'seminar', 'competition', 'historical', 'personal', 'other', 'pending_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('cleared', 'federation_owned', 'licensed', 'permission_pending', 'restricted', 'not_cleared');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('received', 'triage', 'under_investigation', 'hearing_scheduled', 'heard', 'decided', 'appealed', 'appeal_heard', 'closed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."data_class" AS ENUM('public', 'member', 'official', 'confidential', 'restricted', 'highly_restricted');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'under_review', 'approved', 'published', 'superseded', 'withdrawn', 'archived');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'notice_issued', 'held', 'minutes_draft', 'minutes_approved', 'cancelled', 'adjourned');--> statement-breakpoint
CREATE TYPE "public"."motion_outcome" AS ENUM('carried', 'defeated', 'withdrawn', 'deferred', 'referred');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'awaiting_member', 'in_progress', 'escalated', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"certificate_no" text NOT NULL,
	"kind" "certificate_kind" NOT NULL,
	"person_id" integer NOT NULL,
	"title" text NOT NULL,
	"issued_on" date NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"syllabus_version_id" integer,
	"grading_event_id" integer,
	"rank_record_id" integer,
	"issuing_authority" text NOT NULL,
	"signed_by_person_id" integer,
	"status" "certificate_status" DEFAULT 'issued' NOT NULL,
	"revoked_on" date,
	"revoked_reason" text,
	"superseded_by_id" integer,
	"verify_token" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"syllabus_version_id" integer NOT NULL,
	"kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text NOT NULL,
	"belt_colour" text,
	"belt_hex" text,
	"min_age_years" integer,
	"min_months_since_previous" integer,
	"min_sessions_since_previous" integer,
	"previous_grade_ordinal" integer,
	"requires_national_approval" boolean DEFAULT false NOT NULL,
	"examiner_min_level" text,
	"notes" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grade_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"grade_definition_id" integer NOT NULL,
	"component" text NOT NULL,
	"technique_id" integer,
	"kata_id" integer,
	"kumite_form_id" integer,
	"requirement" text NOT NULL,
	"detail" text,
	"weight" integer,
	"mandatory" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"grading_event_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"grade_definition_id" integer NOT NULL,
	"status" "candidate_status" DEFAULT 'applied' NOT NULL,
	"eligibility_checked_at" timestamp with time zone,
	"eligibility_result" jsonb,
	"ineligible_reason" text,
	"presented_by_person_id" integer,
	"dojo_id" integer,
	"order_id" integer,
	"overall_score" integer,
	"outcome" text,
	"referred_components" jsonb,
	"examiner_notes" text,
	"candidate_feedback" text,
	"decided_at" timestamp with time zone,
	"rank_record_id" integer,
	"certificate_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"syllabus_version_id" integer NOT NULL,
	"status" "grading_status" DEFAULT 'draft' NOT NULL,
	"held_on" date,
	"venue" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"dojo_id" integer,
	"registration_opens_on" date,
	"registration_closes_on" date,
	"chief_examiner_person_id" integer,
	"locked_at" timestamp with time zone,
	"locked_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_panel" (
	"id" serial PRIMARY KEY NOT NULL,
	"grading_event_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text NOT NULL,
	"qualification_snapshot" jsonb,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grading_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"examiner_person_id" integer NOT NULL,
	"grade_requirement_id" integer,
	"component" text NOT NULL,
	"score" integer,
	"max_score" integer,
	"comment" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kata" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_ja" text,
	"name_romaji" text NOT NULL,
	"meaning" text,
	"family" text,
	"movement_count" integer,
	"embusen" text,
	"characteristics" text,
	"history" text,
	"sequence" jsonb,
	"bunkai" jsonb,
	"common_errors" jsonb,
	"source_kind" text DEFAULT 'reference' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kumite_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"system" "kumite_system" NOT NULL,
	"name_romaji" text NOT NULL,
	"purpose" text,
	"progression" text,
	"principles" text,
	"safety_notes" text,
	"drills" jsonb,
	"source_kind" text DEFAULT 'reference' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "syllabus_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"status" "syllabus_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"supersedes_id" integer,
	"approved_by_person_id" integer,
	"approved_on" date,
	"adopted_under" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "techniques" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_ja" text,
	"name_romaji" text NOT NULL,
	"name_en" text,
	"category" "technique_category" NOT NULL,
	"description" text,
	"execution" text,
	"purpose" text,
	"breathing" text,
	"common_errors" jsonb,
	"corrections" jsonb,
	"beginner_adaptation" text,
	"advanced_interpretation" text,
	"source_kind" text DEFAULT 'reference' NOT NULL,
	"authored_by_person_id" integer,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"lookup_kind" text NOT NULL,
	"lookup_value" text NOT NULL,
	"found" boolean NOT NULL,
	"result_status" text,
	"ip_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"venue" text,
	"city" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"sanctioned_by_person_id" integer,
	"sanctioned_at" timestamp with time zone,
	"sanction_reference" text,
	"ruleset_version" text,
	"organiser_dojo_id" integer,
	"contact_email" text,
	"contact_phone" text,
	"description" text,
	"results_finalised_at" timestamp with time zone,
	"results_finalised_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"person_id" integer,
	"placing" integer NOT NULL,
	"medal" "medal_kind",
	"matches_won" integer DEFAULT 0 NOT NULL,
	"matches_lost" integer DEFAULT 0 NOT NULL,
	"points_for" integer DEFAULT 0 NOT NULL,
	"points_against" integer DEFAULT 0 NOT NULL,
	"status" "result_status" DEFAULT 'provisional' NOT NULL,
	"finalised_at" timestamp with time zone,
	"finalised_by_user_id" integer,
	"supersedes_result_id" integer,
	"correction_reason" text,
	"correction_authorised_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draws" (
	"id" serial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"format" "draw_format" NOT NULL,
	"rounds_count" integer,
	"entry_count" integer NOT NULL,
	"random_seed" text,
	"seed_input" jsonb,
	"algorithm_version" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_user_id" integer,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"supersedes_draw_id" integer,
	"regeneration_reason" text
);
--> statement-breakpoint
CREATE TABLE "entry_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text,
	"position" integer
);
--> statement-breakpoint
CREATE TABLE "event_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"discipline" "discipline_kind" NOT NULL,
	"gender" text,
	"age_group" text,
	"min_age_years" integer,
	"max_age_years" integer,
	"born_on_or_after" date,
	"born_on_or_before" date,
	"min_weight_grams" integer,
	"max_weight_grams" integer,
	"min_grade_ordinal" integer,
	"min_grade_kind" text,
	"team_size" integer,
	"draw_format" "draw_format",
	"max_entries" integer,
	"entries_per_dojo" integer,
	"fee_code" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_no" text NOT NULL,
	"event_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"person_id" integer,
	"dojo_id" integer,
	"state_unit_id" integer,
	"status" "entry_status" DEFAULT 'draft' NOT NULL,
	"eligibility_checked_at" timestamp with time zone,
	"eligibility_snapshot" jsonb,
	"ineligible_reason" text,
	"checked_in_at" timestamp with time zone,
	"weigh_in_grams" integer,
	"weigh_in_at" timestamp with time zone,
	"weigh_in_by_person_id" integer,
	"seed" integer,
	"draw_position" integer,
	"order_id" integer,
	"withdrawn_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_officials" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text NOT NULL,
	"mat" text,
	"licence_snapshot" jsonb,
	"appointed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluation" jsonb
);
--> statement-breakpoint
CREATE TABLE "kata_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer,
	"entry_id" integer NOT NULL,
	"kata_id" integer,
	"kata_name" text,
	"judge_person_id" integer,
	"judge_position" integer,
	"technical_score" integer,
	"athletic_score" integer,
	"total_score" integer,
	"discarded" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"side" text,
	"action" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"penalty_code" text,
	"clock_seconds" integer,
	"official_person_id" integer,
	"reverses_event_id" integer,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"draw_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"match_no" text NOT NULL,
	"round" text NOT NULL,
	"round_order" integer DEFAULT 0 NOT NULL,
	"pool_label" text,
	"red_entry_id" integer,
	"blue_entry_id" integer,
	"mat" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"status" "match_status" DEFAULT 'scheduled' NOT NULL,
	"red_score" integer DEFAULT 0 NOT NULL,
	"blue_score" integer DEFAULT 0 NOT NULL,
	"red_penalties" jsonb,
	"blue_penalties" jsonb,
	"winner_entry_id" integer,
	"win_method" text,
	"advances_to_match_id" integer,
	"advances_to_slot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "national_squads" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"season" text NOT NULL,
	"discipline" "discipline_kind",
	"age_group" text,
	"selection_criteria" text,
	"selected_on" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"head_coach_person_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protests" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"match_id" integer,
	"category_id" integer,
	"lodged_by_person_id" integer,
	"on_behalf_of_entry_id" integer,
	"grounds" text NOT NULL,
	"status" "protest_status" DEFAULT 'lodged' NOT NULL,
	"fee_order_id" integer,
	"decision" text,
	"decided_by_person_id" integer,
	"decided_at" timestamp with time zone,
	"lodged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranking_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"period_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"points" integer NOT NULL,
	"previous_rank" integer,
	"contributions" jsonb NOT NULL,
	"state_unit_id" integer,
	"dojo_id" integer
);
--> statement-breakpoint
CREATE TABLE "ranking_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"ruleset_id" integer NOT NULL,
	"label" text NOT NULL,
	"category_key" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"event_count" integer,
	"athlete_count" integer
);
--> statement-breakpoint
CREATE TABLE "ranking_rulesets" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"discipline" "discipline_kind",
	"rules" jsonb NOT NULL,
	"window_months" integer,
	"best_n_results" integer,
	"tie_break" jsonb,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"approved_by_person_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squad_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"squad_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text DEFAULT 'athlete' NOT NULL,
	"category" text,
	"selection_basis" jsonb,
	"decided_by_body" text,
	"status" text DEFAULT 'selected' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"status" "broadcast_status" DEFAULT 'upcoming' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"thumbnail_url" text,
	"scheduled_start_at" timestamp with time zone,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"concurrent_viewers" integer,
	"recording_asset_id" integer,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "course_modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"description" text,
	"category" text,
	"level" text,
	"cover_image_url" text,
	"status" "course_status" DEFAULT 'draft' NOT NULL,
	"fee_code" text,
	"has_free_preview" boolean DEFAULT false NOT NULL,
	"lead_teacher_person_id" integer,
	"estimated_hours" integer,
	"certificate_on_completion" boolean DEFAULT false NOT NULL,
	"pass_mark_percent" integer,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolments" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"status" "enrolment_status" DEFAULT 'pending_payment' NOT NULL,
	"order_id" integer,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"final_score_percent" integer,
	"certificate_id" integer
);
--> statement-breakpoint
CREATE TABLE "lesson_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"enrolment_id" integer NOT NULL,
	"lesson_id" integer NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"watched_seconds" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"module_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" "lesson_kind" NOT NULL,
	"body" text,
	"media_asset_id" integer,
	"live_class_id" integer,
	"duration_minutes" integer,
	"is_preview" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_class_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"live_class_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"watched_seconds" integer DEFAULT 0 NOT NULL,
	"attended_live" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_class_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"live_class_id" integer NOT NULL,
	"person_id" integer,
	"question" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_by_person_id" integer,
	"answer" text,
	"answered_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_class_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"live_class_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"technique_id" integer,
	"kata_id" integer,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"broadcast_id" integer,
	"title" text NOT NULL,
	"summary" text,
	"teacher_person_id" integer,
	"course_id" integer,
	"module_id" integer,
	"lesson_id" integer,
	"topic" text,
	"grade_relevance" text,
	"status" "broadcast_status" DEFAULT 'upcoming' NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"visibility" text DEFAULT 'members' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"recording_asset_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer,
	"platform" text DEFAULT 'youtube' NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"thumbnail_url" text,
	"duration_seconds" integer,
	"published_at" timestamp with time zone,
	"classification" "media_class" DEFAULT 'pending_review' NOT NULL,
	"classified_by_user_id" integer,
	"classified_at" timestamp with time zone,
	"rights" "rights_status" DEFAULT 'not_cleared' NOT NULL,
	"rights_holder" text,
	"rights_note" text,
	"consent_evidence" text,
	"teacher_person_id" integer,
	"topic" text,
	"grade_relevance" text,
	"published" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text DEFAULT 'youtube' NOT NULL,
	"external_id" text NOT NULL,
	"handle" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"owner_person_id" integer,
	"owner_kind" text DEFAULT 'person' NOT NULL,
	"authorised" boolean DEFAULT false NOT NULL,
	"authorised_by_user_id" integer,
	"authorised_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"refresh_token_encrypted" text,
	"token_status" text DEFAULT 'none' NOT NULL,
	"scopes" jsonb,
	"default_live_class" "media_class" DEFAULT 'pending_review' NOT NULL,
	"auto_publish_live" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"enrolment_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"answers" jsonb,
	"score_percent" integer,
	"passed" boolean,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"prompt" text NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"options" jsonb,
	"correct_answer" jsonb,
	"explanation" text,
	"marks" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer,
	"course_id" integer NOT NULL,
	"title" text NOT NULL,
	"pass_mark_percent" integer DEFAULT 60 NOT NULL,
	"attempts_allowed" integer,
	"time_limit_minutes" integer
);
--> statement-breakpoint
CREATE TABLE "session_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"note" text,
	"recorded_by_person_id" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"dojo_id" integer,
	"title" text,
	"held_on" date NOT NULL,
	"starts_at" text,
	"ends_at" text,
	"instructor_person_id" integer,
	"focus" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer,
	"resolution_id" integer,
	"description" text NOT NULL,
	"owner_person_id" integer,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_on" date,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_kind" text NOT NULL,
	"case_id" integer NOT NULL,
	"author_person_id" integer,
	"author_user_id" integer,
	"note" text NOT NULL,
	"classification" "data_class" DEFAULT 'confidential' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committee_appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"committee_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"office" text NOT NULL,
	"term_from" date NOT NULL,
	"term_to" date,
	"appointed_under" text,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "committees" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"remit" text,
	"constituted_under" text,
	"scope_type" text DEFAULT 'national' NOT NULL,
	"scope_id" integer,
	"parent_committee_id" integer,
	"quorum" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disciplinary_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_no" text NOT NULL,
	"status" "case_status" DEFAULT 'received' NOT NULL,
	"classification" "data_class" DEFAULT 'confidential' NOT NULL,
	"subject_person_id" integer,
	"subject_dojo_id" integer,
	"complainant_person_id" integer,
	"anonymous_complainant" boolean DEFAULT false NOT NULL,
	"summary" text NOT NULL,
	"alleged_breach_of" text,
	"received_on" date NOT NULL,
	"investigator_person_id" integer,
	"panel_committee_id" integer,
	"hearing_on" date,
	"decision" text,
	"sanction" text,
	"sanction_from" date,
	"sanction_to" date,
	"decided_on" date,
	"decided_by_committee_id" integer,
	"appeal_lodged_on" date,
	"appeal_outcome" text,
	"appeal_decided_on" date,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"version" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"file_url" text,
	"file_size_bytes" integer,
	"file_content_type" text,
	"file_sha256" text,
	"body_markdown" text,
	"effective_from" date,
	"effective_to" date,
	"approved_by_committee_id" integer,
	"approved_by_person_id" integer,
	"approved_on" date,
	"approved_under" text,
	"supersedes_version_id" integer,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"classification" "data_class" DEFAULT 'member' NOT NULL,
	"actor_user_id" integer,
	"actor_label" text,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interest_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"related_person_id" integer,
	"related_dojo_id" integer,
	"declared_on" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"classification" "data_class" DEFAULT 'restricted' NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"recorded_on" date NOT NULL,
	"clearance_status" text,
	"clearance_valid_to" date,
	"injury_site" text,
	"injury_occurred_on" date,
	"event_id" integer,
	"return_to_play_on" date,
	"recorded_by_person_id" integer,
	"document_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" text,
	"present" boolean DEFAULT true NOT NULL,
	"apologies" boolean DEFAULT false NOT NULL,
	"proxy_for_person_id" integer
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"committee_id" integer,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"held_on" date,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"venue" text,
	"notice_issued_on" date,
	"quorum_required" integer,
	"quorum_present" integer,
	"quorum_met" boolean,
	"chair_person_id" integer,
	"minutes_document_version_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer,
	"user_id" integer,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_url" text,
	"domain_event_id" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "official_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"summary" text,
	"issuing_body" text DEFAULT 'MMAKF' NOT NULL,
	"classification" "data_class" DEFAULT 'public' NOT NULL,
	"current_version_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text,
	"logo_url" text,
	"website_url" text,
	"contact_name" text,
	"contact_email" text,
	"agreement_from" date,
	"agreement_to" date,
	"deliverables" jsonb,
	"status" text DEFAULT 'prospective' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"number" text NOT NULL,
	"text" text NOT NULL,
	"moved_by_person_id" integer,
	"seconded_by_person_id" integer,
	"votes_for" integer,
	"votes_against" integer,
	"abstentions" integer,
	"outcome" "motion_outcome" NOT NULL,
	"effective_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguarding_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_no" text NOT NULL,
	"status" "case_status" DEFAULT 'received' NOT NULL,
	"classification" "data_class" DEFAULT 'highly_restricted' NOT NULL,
	"concern_summary" text NOT NULL,
	"concern_kind" text,
	"received_on" date NOT NULL,
	"received_via" text,
	"reporter_name" text,
	"reporter_contact" text,
	"reporter_anonymous" boolean DEFAULT false NOT NULL,
	"subject_description" text,
	"subject_is_minor" boolean,
	"subject_person_id" integer,
	"about_person_id" integer,
	"assigned_officer_person_id" integer,
	"referred_to_authority" boolean DEFAULT false NOT NULL,
	"referred_on" date,
	"referred_to" text,
	"actions_taken" text,
	"outcome" text,
	"closed_on" date,
	"review_due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_no" text NOT NULL,
	"category" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"raised_by_person_id" integer,
	"contact_email" text,
	"contact_phone" text,
	"confidential" boolean DEFAULT false NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"assigned_to_user_id" integer,
	"department" text,
	"sla_due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_syllabus_version_id_syllabus_versions_id_fk" FOREIGN KEY ("syllabus_version_id") REFERENCES "public"."syllabus_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_grading_event_id_grading_events_id_fk" FOREIGN KEY ("grading_event_id") REFERENCES "public"."grading_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_signed_by_person_id_persons_id_fk" FOREIGN KEY ("signed_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_definitions" ADD CONSTRAINT "grade_definitions_syllabus_version_id_syllabus_versions_id_fk" FOREIGN KEY ("syllabus_version_id") REFERENCES "public"."syllabus_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_requirements" ADD CONSTRAINT "grade_requirements_grade_definition_id_grade_definitions_id_fk" FOREIGN KEY ("grade_definition_id") REFERENCES "public"."grade_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_requirements" ADD CONSTRAINT "grade_requirements_technique_id_techniques_id_fk" FOREIGN KEY ("technique_id") REFERENCES "public"."techniques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_requirements" ADD CONSTRAINT "grade_requirements_kata_id_kata_id_fk" FOREIGN KEY ("kata_id") REFERENCES "public"."kata"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_requirements" ADD CONSTRAINT "grade_requirements_kumite_form_id_kumite_forms_id_fk" FOREIGN KEY ("kumite_form_id") REFERENCES "public"."kumite_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_candidates" ADD CONSTRAINT "grading_candidates_grading_event_id_grading_events_id_fk" FOREIGN KEY ("grading_event_id") REFERENCES "public"."grading_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_candidates" ADD CONSTRAINT "grading_candidates_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_candidates" ADD CONSTRAINT "grading_candidates_grade_definition_id_grade_definitions_id_fk" FOREIGN KEY ("grade_definition_id") REFERENCES "public"."grade_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_candidates" ADD CONSTRAINT "grading_candidates_presented_by_person_id_persons_id_fk" FOREIGN KEY ("presented_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_candidates" ADD CONSTRAINT "grading_candidates_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_events" ADD CONSTRAINT "grading_events_syllabus_version_id_syllabus_versions_id_fk" FOREIGN KEY ("syllabus_version_id") REFERENCES "public"."syllabus_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_events" ADD CONSTRAINT "grading_events_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_events" ADD CONSTRAINT "grading_events_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_events" ADD CONSTRAINT "grading_events_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_events" ADD CONSTRAINT "grading_events_chief_examiner_person_id_persons_id_fk" FOREIGN KEY ("chief_examiner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_panel" ADD CONSTRAINT "grading_panel_grading_event_id_grading_events_id_fk" FOREIGN KEY ("grading_event_id") REFERENCES "public"."grading_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_panel" ADD CONSTRAINT "grading_panel_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_scores" ADD CONSTRAINT "grading_scores_candidate_id_grading_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."grading_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_scores" ADD CONSTRAINT "grading_scores_examiner_person_id_persons_id_fk" FOREIGN KEY ("examiner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_scores" ADD CONSTRAINT "grading_scores_grade_requirement_id_grade_requirements_id_fk" FOREIGN KEY ("grade_requirement_id") REFERENCES "public"."grade_requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syllabus_versions" ADD CONSTRAINT "syllabus_versions_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "techniques" ADD CONSTRAINT "techniques_authored_by_person_id_persons_id_fk" FOREIGN KEY ("authored_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_sanctioned_by_person_id_persons_id_fk" FOREIGN KEY ("sanctioned_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_organiser_dojo_id_dojos_id_fk" FOREIGN KEY ("organiser_dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_category_id_event_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."event_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_entry_id_event_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draws" ADD CONSTRAINT "draws_category_id_event_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."event_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_entry_id_event_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_category_id_event_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."event_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_weigh_in_by_person_id_persons_id_fk" FOREIGN KEY ("weigh_in_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_officials" ADD CONSTRAINT "event_officials_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_officials" ADD CONSTRAINT "event_officials_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_scores" ADD CONSTRAINT "kata_scores_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_scores" ADD CONSTRAINT "kata_scores_entry_id_event_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_scores" ADD CONSTRAINT "kata_scores_judge_person_id_persons_id_fk" FOREIGN KEY ("judge_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_official_person_id_persons_id_fk" FOREIGN KEY ("official_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_draw_id_draws_id_fk" FOREIGN KEY ("draw_id") REFERENCES "public"."draws"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_category_id_event_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."event_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_red_entry_id_event_entries_id_fk" FOREIGN KEY ("red_entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_blue_entry_id_event_entries_id_fk" FOREIGN KEY ("blue_entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_entry_id_event_entries_id_fk" FOREIGN KEY ("winner_entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_squads" ADD CONSTRAINT "national_squads_head_coach_person_id_persons_id_fk" FOREIGN KEY ("head_coach_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_event_id_competition_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_category_id_event_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."event_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_lodged_by_person_id_persons_id_fk" FOREIGN KEY ("lodged_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_on_behalf_of_entry_id_event_entries_id_fk" FOREIGN KEY ("on_behalf_of_entry_id") REFERENCES "public"."event_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protests" ADD CONSTRAINT "protests_decided_by_person_id_persons_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_period_id_ranking_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."ranking_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_periods" ADD CONSTRAINT "ranking_periods_ruleset_id_ranking_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."ranking_rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_rulesets" ADD CONSTRAINT "ranking_rulesets_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_squad_id_national_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."national_squads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_channel_id_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."media_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_recording_asset_id_media_assets_id_fk" FOREIGN KEY ("recording_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_lead_teacher_person_id_persons_id_fk" FOREIGN KEY ("lead_teacher_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_course_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."course_modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_live_class_id_live_classes_id_fk" FOREIGN KEY ("live_class_id") REFERENCES "public"."live_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_attendance" ADD CONSTRAINT "live_class_attendance_live_class_id_live_classes_id_fk" FOREIGN KEY ("live_class_id") REFERENCES "public"."live_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_attendance" ADD CONSTRAINT "live_class_attendance_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_questions" ADD CONSTRAINT "live_class_questions_live_class_id_live_classes_id_fk" FOREIGN KEY ("live_class_id") REFERENCES "public"."live_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_questions" ADD CONSTRAINT "live_class_questions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_questions" ADD CONSTRAINT "live_class_questions_answered_by_person_id_persons_id_fk" FOREIGN KEY ("answered_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_class_resources" ADD CONSTRAINT "live_class_resources_live_class_id_live_classes_id_fk" FOREIGN KEY ("live_class_id") REFERENCES "public"."live_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_teacher_person_id_persons_id_fk" FOREIGN KEY ("teacher_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_classes" ADD CONSTRAINT "live_classes_recording_asset_id_media_assets_id_fk" FOREIGN KEY ("recording_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_channel_id_media_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."media_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_teacher_person_id_persons_id_fk" FOREIGN KEY ("teacher_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_channels" ADD CONSTRAINT "media_channels_owner_person_id_persons_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_session_id_training_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attendance" ADD CONSTRAINT "session_attendance_recorded_by_person_id_persons_id_fk" FOREIGN KEY ("recorded_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_instructor_person_id_persons_id_fk" FOREIGN KEY ("instructor_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_resolution_id_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_owner_person_id_persons_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_author_person_id_persons_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_appointments" ADD CONSTRAINT "committee_appointments_committee_id_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "committee_appointments" ADD CONSTRAINT "committee_appointments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_subject_person_id_persons_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_subject_dojo_id_dojos_id_fk" FOREIGN KEY ("subject_dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_complainant_person_id_persons_id_fk" FOREIGN KEY ("complainant_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_investigator_person_id_persons_id_fk" FOREIGN KEY ("investigator_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_panel_committee_id_committees_id_fk" FOREIGN KEY ("panel_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disciplinary_cases" ADD CONSTRAINT "disciplinary_cases_decided_by_committee_id_committees_id_fk" FOREIGN KEY ("decided_by_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_official_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."official_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_approved_by_committee_id_committees_id_fk" FOREIGN KEY ("approved_by_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_declarations" ADD CONSTRAINT "interest_declarations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_declarations" ADD CONSTRAINT "interest_declarations_related_person_id_persons_id_fk" FOREIGN KEY ("related_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_declarations" ADD CONSTRAINT "interest_declarations_related_dojo_id_dojos_id_fk" FOREIGN KEY ("related_dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_recorded_by_person_id_persons_id_fk" FOREIGN KEY ("recorded_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_proxy_for_person_id_persons_id_fk" FOREIGN KEY ("proxy_for_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_committee_id_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_chair_person_id_persons_id_fk" FOREIGN KEY ("chair_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_minutes_document_version_id_document_versions_id_fk" FOREIGN KEY ("minutes_document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_domain_event_id_domain_events_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_moved_by_person_id_persons_id_fk" FOREIGN KEY ("moved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_seconded_by_person_id_persons_id_fk" FOREIGN KEY ("seconded_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_subject_person_id_persons_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_about_person_id_persons_id_fk" FOREIGN KEY ("about_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_assigned_officer_person_id_persons_id_fk" FOREIGN KEY ("assigned_officer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_raised_by_person_id_persons_id_fk" FOREIGN KEY ("raised_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_no_uk" ON "certificates" USING btree ("certificate_no");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_token_uk" ON "certificates" USING btree ("verify_token");--> statement-breakpoint
CREATE INDEX "certificates_person_idx" ON "certificates" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "certificates_status_idx" ON "certificates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "grade_definitions_uk" ON "grade_definitions" USING btree ("syllabus_version_id","kind","ordinal");--> statement-breakpoint
CREATE INDEX "grade_definitions_version_idx" ON "grade_definitions" USING btree ("syllabus_version_id");--> statement-breakpoint
CREATE INDEX "grade_requirements_grade_idx" ON "grade_requirements" USING btree ("grade_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_candidates_uk" ON "grading_candidates" USING btree ("grading_event_id","person_id");--> statement-breakpoint
CREATE INDEX "grading_candidates_person_idx" ON "grading_candidates" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "grading_candidates_status_idx" ON "grading_candidates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_events_code_uk" ON "grading_events" USING btree ("code");--> statement-breakpoint
CREATE INDEX "grading_events_status_idx" ON "grading_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grading_events_date_idx" ON "grading_events" USING btree ("held_on");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_panel_uk" ON "grading_panel" USING btree ("grading_event_id","person_id");--> statement-breakpoint
CREATE INDEX "grading_scores_candidate_idx" ON "grading_scores" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grading_scores_component_uk" ON "grading_scores" USING btree ("candidate_id","examiner_person_id","component") WHERE grade_requirement_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grading_scores_requirement_uk" ON "grading_scores" USING btree ("candidate_id","examiner_person_id","grade_requirement_id") WHERE grade_requirement_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kata_slug_uk" ON "kata" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "kumite_forms_slug_uk" ON "kumite_forms" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "syllabus_versions_code_uk" ON "syllabus_versions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "syllabus_versions_status_idx" ON "syllabus_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "techniques_slug_uk" ON "techniques" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "techniques_category_idx" ON "techniques" USING btree ("category");--> statement-breakpoint
CREATE INDEX "verification_log_at_idx" ON "verification_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "verification_log_value_idx" ON "verification_log" USING btree ("lookup_value");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_events_code_uk" ON "competition_events" USING btree ("code");--> statement-breakpoint
CREATE INDEX "competition_events_status_idx" ON "competition_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "competition_events_date_idx" ON "competition_events" USING btree ("starts_on");--> statement-breakpoint
CREATE INDEX "competition_results_category_idx" ON "competition_results" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "competition_results_person_idx" ON "competition_results" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "competition_results_event_idx" ON "competition_results" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "draws_category_idx" ON "draws" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_members_uk" ON "entry_members" USING btree ("entry_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_categories_uk" ON "event_categories" USING btree ("event_id","code");--> statement-breakpoint
CREATE INDEX "event_categories_event_idx" ON "event_categories" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_entries_no_uk" ON "event_entries" USING btree ("entry_no");--> statement-breakpoint
CREATE UNIQUE INDEX "event_entries_person_uk" ON "event_entries" USING btree ("category_id","person_id");--> statement-breakpoint
CREATE INDEX "event_entries_event_idx" ON "event_entries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_entries_status_idx" ON "event_entries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "event_officials_uk" ON "event_officials" USING btree ("event_id","person_id","role");--> statement-breakpoint
CREATE INDEX "kata_scores_entry_idx" ON "kata_scores" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_events_seq_uk" ON "match_events" USING btree ("match_id","sequence");--> statement-breakpoint
CREATE INDEX "match_events_match_idx" ON "match_events" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_no_uk" ON "matches" USING btree ("event_id","match_no");--> statement-breakpoint
CREATE INDEX "matches_draw_idx" ON "matches" USING btree ("draw_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "matches_mat_idx" ON "matches" USING btree ("event_id","mat","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "national_squads_code_uk" ON "national_squads" USING btree ("code");--> statement-breakpoint
CREATE INDEX "protests_event_idx" ON "protests" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_entries_uk" ON "ranking_entries" USING btree ("period_id","person_id");--> statement-breakpoint
CREATE INDEX "ranking_entries_period_idx" ON "ranking_entries" USING btree ("period_id","rank");--> statement-breakpoint
CREATE INDEX "ranking_entries_person_idx" ON "ranking_entries" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_periods_uk" ON "ranking_periods" USING btree ("ruleset_id","label","category_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_rulesets_code_uk" ON "ranking_rulesets" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "squad_members_uk" ON "squad_members" USING btree ("squad_id","person_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcasts_external_uk" ON "broadcasts" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "course_modules_course_idx" ON "course_modules" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courses_slug_uk" ON "courses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "courses_status_idx" ON "courses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "enrolments_uk" ON "enrolments" USING btree ("course_id","person_id");--> statement-breakpoint
CREATE INDEX "enrolments_person_idx" ON "enrolments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_progress_uk" ON "lesson_progress" USING btree ("enrolment_id","lesson_id");--> statement-breakpoint
CREATE INDEX "lessons_module_idx" ON "lessons" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "lessons_course_idx" ON "lessons" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_class_attendance_uk" ON "live_class_attendance" USING btree ("live_class_id","person_id");--> statement-breakpoint
CREATE INDEX "live_class_attendance_class_idx" ON "live_class_attendance" USING btree ("live_class_id");--> statement-breakpoint
CREATE INDEX "live_class_questions_class_idx" ON "live_class_questions" USING btree ("live_class_id");--> statement-breakpoint
CREATE INDEX "live_class_resources_class_idx" ON "live_class_resources" USING btree ("live_class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_classes_code_uk" ON "live_classes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "live_classes_status_idx" ON "live_classes" USING btree ("status","scheduled_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_external_uk" ON "media_assets" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "media_assets_class_idx" ON "media_assets" USING btree ("classification","published");--> statement-breakpoint
CREATE INDEX "media_assets_channel_idx" ON "media_assets" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_channels_external_uk" ON "media_channels" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "media_channels_owner_idx" ON "media_channels" USING btree ("owner_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_uk" ON "quiz_attempts" USING btree ("quiz_id","enrolment_id","attempt_no");--> statement-breakpoint
CREATE INDEX "quiz_questions_quiz_idx" ON "quiz_questions" USING btree ("quiz_id");--> statement-breakpoint
CREATE INDEX "quizzes_course_idx" ON "quizzes" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_attendance_uk" ON "session_attendance" USING btree ("session_id","person_id");--> statement-breakpoint
CREATE INDEX "session_attendance_person_idx" ON "session_attendance" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "training_sessions_dojo_date_idx" ON "training_sessions" USING btree ("dojo_id","held_on");--> statement-breakpoint
CREATE INDEX "action_items_owner_idx" ON "action_items" USING btree ("owner_person_id","status");--> statement-breakpoint
CREATE INDEX "case_notes_case_idx" ON "case_notes" USING btree ("case_kind","case_id");--> statement-breakpoint
CREATE INDEX "committee_appointments_committee_idx" ON "committee_appointments" USING btree ("committee_id");--> statement-breakpoint
CREATE INDEX "committee_appointments_person_idx" ON "committee_appointments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "committees_code_uk" ON "committees" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "disciplinary_cases_no_uk" ON "disciplinary_cases" USING btree ("case_no");--> statement-breakpoint
CREATE INDEX "disciplinary_cases_status_idx" ON "disciplinary_cases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_uk" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "domain_events_type_idx" ON "domain_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_entity_idx" ON "domain_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "domain_events_unpublished_idx" ON "domain_events" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "interest_declarations_person_idx" ON "interest_declarations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "medical_records_person_idx" ON "medical_records" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_uk" ON "meeting_attendance" USING btree ("meeting_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_code_uk" ON "meetings" USING btree ("code");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "notifications_queue_idx" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "official_documents_code_uk" ON "official_documents" USING btree ("code");--> statement-breakpoint
CREATE INDEX "partners_status_idx" ON "partners" USING btree ("status","published");--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_uk" ON "resolutions" USING btree ("meeting_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "safeguarding_cases_no_uk" ON "safeguarding_cases" USING btree ("case_no");--> statement-breakpoint
CREATE INDEX "safeguarding_cases_officer_idx" ON "safeguarding_cases" USING btree ("assigned_officer_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_no_uk" ON "support_tickets" USING btree ("ticket_no");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","sla_due_at");