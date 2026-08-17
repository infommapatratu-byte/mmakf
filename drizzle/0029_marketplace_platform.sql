-- 0029 — the MMAKF marketplace platform.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS REPOSITORY HAD, AND WHY IT WAS NOT A MARKETPLACE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Migration 0009 built a shop with tenants. It had `sellers`, it had `listings`,
-- and it had the two review gates that matter — a seller is approved separately
-- from each of their items, and editing an approved item returns it to review.
-- Those gates are good and this migration does not touch them.
--
-- What it did not have was any of the machinery that makes a multi-seller
-- marketplace different from a shop:
--
--   · A listing had ONE price and ONE stock number. No sizes, no colours, no
--     warehouse — so the last 170cm gi and the last 190cm gi were the same
--     number, and two buyers could have it.
--
--   · An order had no notion of a seller. A basket containing goods from two
--     sellers produced one undifferentiated order, so there was nothing to
--     accept, nothing to dispatch, nothing to settle and nothing to refund
--     without touching the other seller's money.
--
--   · There was no commission at all — not a wrong rate, none — so a payment
--     cleared and the entire basket total sat in the federation's account with
--     no record of what any seller was owed.
--
--   · A seller was a trading name and five nullable fields. Nothing recorded
--     what had been verified, by whom, against which document, or when it
--     expires. `bank_account_number` was stored in the clear.
--
--   · "Authorized Adidas Distributor" was a string a seller could type.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT 0029 ADDS: 54 TABLES, IN SIX GROUPS
-- ═════════════════════════════════════════════════════════════════════════════
--
--   SELLER IDENTITY     seller_addresses, seller_verifications, seller_documents,
--                       payout_accounts, brands, brand_authorisations,
--                       seller_badge_grants, marketplace_policies,
--                       policy_versions, seller_policy_acceptances,
--                       seller_sla_configs, seller_applications
--
--   CATALOGUE           marketplace_categories, listing_variants, listing_flags,
--                       authenticity_cases, product_imports, product_import_rows
--
--   INVENTORY           inventory_locations, stock_items, stock_movements,
--                       stock_reservations, low_stock_rules, stock_counts
--
--   ORDERS              seller_orders, seller_order_events, shipping_zones,
--                       shipping_methods, shipments, shipment_items,
--                       return_policies, return_requests, return_items,
--                       marketplace_disputes, marketplace_dispute_messages,
--                       buyer_reports, seller_order_payments
--
--   FINANCE             commission_rules, commission_rule_versions,
--                       order_line_commissions, commission_gaps,
--                       seller_settlements, settlement_lines, seller_payouts,
--                       payout_adjustments, seller_statements
--
--   TRUST               product_reviews, seller_reviews,
--                       seller_performance_snapshots, marketplace_sla_breaches,
--                       fraud_signals, seller_promotions, featured_placements,
--                       event_merchandise
--
-- and 64 columns on three tables that already existed: `sellers` gains who and
-- what it is, `listings` gains the product detail and a quarantine axis, and
-- `order_lines` gains its seller attribution.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE FIVE RULES THIS MIGRATION PUTS IN THE DATABASE RATHER THAN IN CODE
-- ═════════════════════════════════════════════════════════════════════════════
--
--  1. STOCK CANNOT BE OVERSOLD. `stock_items` carries a CHECK that
--     reserved + committed + damaged <= on_hand. Two checkouts racing for the
--     last gi cannot both succeed: the loser's transaction violates the
--     constraint and rolls back. Application-level "check then write" cannot
--     do this and has never been able to.
--
--  2. ONE SELLER ORDER PER (ORDER, SELLER). A retried checkout that split the
--     same basket twice would pay a seller twice for one sale.
--
--  3. ONE COMMISSION ROW PER ORDER LINE. The replay guard for a gateway that
--     retries webhooks — which they all do.
--
--  4. ONE REVIEW PER PURCHASE. `product_reviews.order_line_id` and
--     `seller_reviews.seller_order_id` are UNIQUE and NOT NULL. There is no
--     code path to an unverified review because there is no row shape for one.
--
--  5. ONE PAYOUT PER IDEMPOTENCY KEY. A payout is the one operation here that
--     a status change cannot undo, so the duplicate is prevented rather than
--     detected.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION REFUSES TO INVENT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- It ships EMPTY of every number that belongs to MMAKF. Not one commission
-- rate, not one SLA window, not one return period, not one penalty, not one
-- product category, and not one line of a seller agreement.
--
-- That is not incompleteness, it is the point. A seeded 10% commission is
-- indistinguishable six months later from a rate the federation approved, and
-- it would be deducted from real people's money. An unconfigured commission
-- therefore produces a `commission_gaps` row and BLOCKS SETTLEMENT — the sale
-- completes, the seller ships, and the money waits for a decision — which is
-- the only honest behaviour available to a system nobody has told what to
-- charge.
--
-- The one exception is the taxonomy: `marketplace_categories` is created empty
-- and src/db/catalogue.ts ships a PROPOSED tree the federation adopts by
-- running it. The categories in the brief are MMAKF's own words, so proposing
-- them is quoting; writing them in without being asked would still be a
-- decision, and adoption is one command.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE TWO BACKFILLS AT THE END OF THIS FILE, AND WHY THEY ARE NOT OPTIONAL
-- ═════════════════════════════════════════════════════════════════════════════
--
--  A. EVERY APPROVED SELLER GETS AN OPEN STORE. `publicListingPredicate()` now
--     requires `sellers.store_status = 'open'`, and the column defaults to
--     'not_created'. Without the backfill this migration would empty the public
--     shop on deploy — every approved listing would vanish, with no error and
--     no failing test, and the cause would be a DEFAULT rather than anything
--     anybody wrote. A default that silently hides live data is an outage with
--     a plausible explanation.
--
--  B. EVERY EXISTING LISTING GETS A VARIANT. Order lines now point at
--     `listing_variants`, and a listing with no variant is unbuyable. The
--     backfill creates exactly one — "Standard" — carrying the listing's own
--     price and stock, so nothing changes for the seller and everything that
--     reads variants finds one. The variant's SKU is derived from the listing
--     ref, which is already unique.
--
-- Forward-only, as every migration here is. Nothing is dropped and nothing is
-- rewritten: `listings.price_minor` and `listings.stock_qty` stay where they
-- are, as the display roll-up, because a migration that deletes the column the
-- old code reads is a migration that cannot be deployed without downtime.

-- ─── Enumerated types ────────────────────────────────────────────────────

CREATE TYPE "public"."seller_business_type" AS ENUM('individual', 'sole_proprietor', 'partnership', 'private_company', 'public_company', 'llp', 'trust', 'society', 'federation', 'club', 'dojo', 'other');--> statement-breakpoint
CREATE TYPE "public"."seller_compliance_status" AS ENUM('not_assessed', 'compliant', 'action_required', 'lapsed', 'breach');--> statement-breakpoint
CREATE TYPE "public"."seller_performance_band" AS ENUM('unrated', 'good', 'watch', 'at_risk', 'critical');--> statement-breakpoint
CREATE TYPE "public"."seller_type" AS ENUM('manufacturer', 'distributor', 'brand', 'retailer', 'dojo', 'federation', 'institutional', 'individual', 'service_provider');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('not_created', 'draft', 'open', 'closed_by_seller', 'closed_by_federation');--> statement-breakpoint
CREATE TYPE "public"."brand_authorisation_status" AS ENUM('claimed', 'under_review', 'verified', 'rejected', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."brand_status" AS ENUM('active', 'restricted', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."marketplace_badge" AS ENUM('mmakf_official', 'mmakf_authorised', 'verified_seller', 'verified_brand', 'verified_product');--> statement-breakpoint
CREATE TYPE "public"."payout_account_status" AS ENUM('pending', 'verifying', 'verified', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."marketplace_policy_kind" AS ENUM('seller_agreement', 'marketplace_terms', 'return_policy', 'shipping_policy', 'privacy_policy', 'prohibited_products', 'counterfeit_policy', 'commission_schedule');--> statement-breakpoint
CREATE TYPE "public"."seller_address_kind" AS ENUM('registered', 'operating', 'warehouse', 'return', 'pickup');--> statement-breakpoint
CREATE TYPE "public"."seller_verification_check" AS ENUM('identity', 'business', 'gst', 'pan', 'bank', 'address', 'brand_authorisation', 'manufacturer_authorisation', 'product_authorisation');--> statement-breakpoint
CREATE TYPE "public"."seller_verification_status" AS ENUM('not_started', 'submitted', 'under_review', 'documents_required', 'verified', 'rejected', 'suspended', 'expired');--> statement-breakpoint
CREATE TYPE "public"."authenticity_case_status" AS ENUM('opened', 'evidence_requested', 'seller_responded', 'under_review', 'upheld', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."category_policy" AS ENUM('allowed', 'requires_review', 'restricted', 'prohibited');--> statement-breakpoint
CREATE TYPE "public"."product_import_row_status" AS ENUM('pending', 'valid', 'invalid', 'duplicate', 'created', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."product_import_status" AS ENUM('uploaded', 'validating', 'preview', 'failed', 'submitted', 'partially_published', 'published', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."listing_flag_kind" AS ENUM('duplicate', 'wrong_image', 'wrong_category', 'misleading_claim', 'incorrect_brand', 'unsupported_affiliation', 'false_certification', 'false_official_claim', 'prohibited_item', 'unsafe_item', 'price_manipulation', 'other');--> statement-breakpoint
CREATE TYPE "public"."listing_flag_status" AS ENUM('open', 'investigating', 'upheld', 'dismissed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."listing_variant_status" AS ENUM('active', 'out_of_stock', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."inventory_location_kind" AS ENUM('warehouse', 'store', 'fulfilment_centre', 'dropship', 'dojo');--> statement-breakpoint
CREATE TYPE "public"."stock_reservation_status" AS ENUM('held', 'committed', 'released', 'expired', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('receipt', 'reservation', 'release', 'commit', 'dispatch', 'return_in', 'restock', 'damage', 'write_off', 'adjustment', 'transfer_out', 'transfer_in', 'count');--> statement-breakpoint
CREATE TYPE "public"."marketplace_dispute_kind" AS ENUM('item_not_received', 'not_as_described', 'damaged_on_arrival', 'counterfeit', 'wrong_item', 'missing_parts', 'refund_not_received', 'seller_conduct', 'delivery_dispute', 'other');--> statement-breakpoint
CREATE TYPE "public"."marketplace_dispute_status" AS ENUM('open', 'seller_responding', 'under_review', 'resolved', 'withdrawn', 'escalated', 'closed');--> statement-breakpoint
CREATE TYPE "public"."return_inspection_result" AS ENUM('pending', 'sellable', 'damaged', 'counterfeit', 'not_the_item', 'not_received', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."return_item_condition" AS ENUM('unopened', 'opened_unused', 'used', 'damaged', 'incomplete', 'not_as_described', 'wrong_item');--> statement-breakpoint
CREATE TYPE "public"."return_request_status" AS ENUM('requested', 'seller_reviewing', 'approved', 'rejected', 'authorised', 'in_transit', 'received', 'inspected', 'refund_pending', 'refunded', 'exchanged', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."seller_order_status" AS ENUM('order_created', 'payment_pending', 'paid', 'seller_accepted', 'processing', 'packed', 'shipped', 'in_transit', 'delivered', 'return_requested', 'returned', 'refund_pending', 'refunded', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('created', 'label_printed', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned_to_origin', 'lost');--> statement-breakpoint
CREATE TYPE "public"."shipping_rate_kind" AS ENUM('flat', 'per_item', 'by_weight', 'free', 'free_above');--> statement-breakpoint
CREATE TYPE "public"."payout_adjustment_kind" AS ENUM('hold', 'release', 'penalty', 'correction', 'chargeback', 'goodwill', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."seller_payout_status" AS ENUM('pending', 'queued', 'processing', 'paid', 'failed', 'reversed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."settlement_line_kind" AS ENUM('sale', 'shipping', 'tax_collected', 'commission', 'commission_tax', 'refund', 'refund_commission_reversal', 'gateway_fee', 'adjustment', 'penalty', 'hold', 'release', 'carry_forward');--> statement-breakpoint
CREATE TYPE "public"."seller_settlement_status" AS ENUM('open', 'closed', 'approved', 'paying', 'paid', 'on_hold', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fraud_signal_kind" AS ENUM('duplicate_seller_account', 'shared_contact_details', 'suspicious_review_pattern', 'unusual_order_velocity', 'payment_anomaly', 'rapid_refund_pattern', 'inventory_manipulation', 'counterfeit_indicator', 'brand_impersonation', 'federation_impersonation', 'price_manipulation', 'other');--> statement-breakpoint
CREATE TYPE "public"."fraud_signal_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed', 'false_positive');--> statement-breakpoint
CREATE TYPE "public"."seller_promotion_status" AS ENUM('draft', 'awaiting_seller_consent', 'awaiting_federation_approval', 'scheduled', 'active', 'ended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."marketplace_review_status" AS ENUM('pending', 'published', 'rejected', 'hidden', 'withdrawn');--> statement-breakpoint

-- ─── Tables ──────────────────────────────────────────────────────────────

CREATE TABLE "brand_authorisations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"relationship" text NOT NULL,
	"scope" text,
	"document_id" integer,
	"issuer" text,
	"issuer_contact" text,
	"reference_number" text,
	"valid_from" date,
	"valid_to" date,
	"status" "brand_authorisation_status" DEFAULT 'claimed' NOT NULL,
	"verified_by_user_id" integer,
	"verified_at" timestamp with time zone,
	"decision_reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_owner" text,
	"website" text,
	"logo_url" text,
	"description" text,
	"status" "brand_status" DEFAULT 'active' NOT NULL,
	"requires_authorisation" boolean DEFAULT false NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketplace_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" "marketplace_policy_kind" NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"mandatory_for_sellers" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"provider_contact_id" text,
	"holder_name" text,
	"bank_name" text,
	"last4" text,
	"ifsc_prefix" text,
	"status" "payout_account_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"failure_reason" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"policy_id" integer NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"published_by_user_id" integer,
	"published_at" timestamp with time zone,
	"body_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"kind" "seller_address_kind" NOT NULL,
	"label" text,
	"line1" text,
	"line2" text,
	"locality" text,
	"city" text,
	"district" text,
	"state" text,
	"postcode" text,
	"country" text DEFAULT 'IN' NOT NULL,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"contact_name" text,
	"contact_phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"ref" text NOT NULL,
	"person_id" integer,
	"dojo_id" integer,
	"submission" jsonb NOT NULL,
	"requested_categories" jsonb,
	"requested_brands" jsonb,
	"expected_monthly_orders" integer,
	"has_warehouse" boolean,
	"ships_nationally" boolean,
	"motivation" text,
	"risk_flags" jsonb,
	"assigned_reviewer_user_id" integer,
	"sla_due_at" timestamp with time zone,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_badge_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"badge" "marketplace_badge" NOT NULL,
	"seller_id" integer,
	"listing_id" integer,
	"granted_by_user_id" integer,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authority" text,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_by_user_id" integer,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);--> statement-breakpoint
CREATE TABLE "seller_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"verification_id" integer,
	"kind" text NOT NULL,
	"label" text,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_by_user_id" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "seller_policy_acceptances" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"policy_version_id" integer NOT NULL,
	"accepted_by_user_id" integer,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"body_hash" text NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_sla_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer,
	"acceptance_hours" integer,
	"dispatch_hours" integer,
	"return_response_hours" integer,
	"support_response_hours" integer,
	"dispute_response_hours" integer,
	"set_by_user_id" integer,
	"authority" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"check" "seller_verification_check" NOT NULL,
	"status" "seller_verification_status" DEFAULT 'not_started' NOT NULL,
	"evidence" jsonb,
	"submitted_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "authenticity_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_id" integer NOT NULL,
	"listing_id" integer,
	"brand_id" integer,
	"complainant_kind" text NOT NULL,
	"complainant_name" text,
	"complainant_contact" text,
	"order_id" integer,
	"allegation" text NOT NULL,
	"evidence" jsonb,
	"status" "authenticity_case_status" DEFAULT 'opened' NOT NULL,
	"seller_response" text,
	"seller_responded_at" timestamp with time zone,
	"seller_evidence" jsonb,
	"response_due_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"decision" text,
	"enforcement" jsonb,
	"opened_by_user_id" integer,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "listing_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"kind" "listing_flag_kind" NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb,
	"raised_by_user_id" integer,
	"raised_by_system" boolean DEFAULT false NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "listing_flag_status" DEFAULT 'open' NOT NULL,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"action_taken" text
);--> statement-breakpoint
CREATE TABLE "listing_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"sku" text NOT NULL,
	"seller_sku" text,
	"barcode" text,
	"gtin" text,
	"label" text NOT NULL,
	"attributes" jsonb,
	"price_minor" integer NOT NULL,
	"compare_at_minor" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"status" "listing_variant_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"available_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketplace_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"description" text,
	"legacy_category" text,
	"policy" "category_policy" DEFAULT 'requires_review' NOT NULL,
	"policy_reason" text,
	"requires_brand_authorisation" boolean DEFAULT false NOT NULL,
	"requires_certification" boolean DEFAULT false NOT NULL,
	"requires_age_statement" boolean DEFAULT false NOT NULL,
	"requires_safety_classification" boolean DEFAULT false NOT NULL,
	"requires_federation_approval" boolean DEFAULT false NOT NULL,
	"hsn_code" text,
	"tax_category_code" text,
	"shipping_class" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "product_import_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"row_no" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"resolved" jsonb,
	"status" "product_import_row_status" DEFAULT 'pending' NOT NULL,
	"errors" jsonb,
	"listing_id" integer,
	"variant_id" integer,
	"duplicate_of_listing_id" integer
);--> statement-breakpoint
CREATE TABLE "product_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"ref" text NOT NULL,
	"filename" text,
	"storage_key" text,
	"status" "product_import_status" DEFAULT 'uploaded' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"failure_reason" text,
	"uploaded_by_user_id" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "inventory_location_kind" DEFAULT 'warehouse' NOT NULL,
	"address_line" text,
	"city" text,
	"district" text,
	"state" text,
	"postcode" text,
	"country" text DEFAULT 'IN' NOT NULL,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"contact_name" text,
	"contact_phone" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"fulfils_orders" boolean DEFAULT true NOT NULL,
	"accepts_returns" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "low_stock_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"variant_id" integer,
	"location_id" integer,
	"threshold" integer NOT NULL,
	"notify_email" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"system_qty" integer NOT NULL,
	"counted_qty" integer NOT NULL,
	"variance_qty" integer NOT NULL,
	"note" text,
	"counted_by_user_id" integer,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"adjustment_movement_id" integer
);--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"committed" integer DEFAULT 0 NOT NULL,
	"damaged" integer DEFAULT 0 NOT NULL,
	"in_transit" integer DEFAULT 0 NOT NULL,
	"last_counted_at" timestamp with time zone,
	"last_counted_qty" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"on_hand_delta" integer DEFAULT 0 NOT NULL,
	"reserved_delta" integer DEFAULT 0 NOT NULL,
	"committed_delta" integer DEFAULT 0 NOT NULL,
	"damaged_delta" integer DEFAULT 0 NOT NULL,
	"in_transit_delta" integer DEFAULT 0 NOT NULL,
	"on_hand_after" integer NOT NULL,
	"order_id" integer,
	"order_line_id" integer,
	"ref_type" text,
	"ref_id" integer,
	"reason" text,
	"by_user_id" integer,
	"by_system" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"status" "stock_reservation_status" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "buyer_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"order_id" integer,
	"seller_order_id" integer,
	"seller_id" integer,
	"listing_id" integer,
	"order_line_id" integer,
	"reported_by_person_id" integer,
	"reported_by_user_id" integer,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"escalated_to_dispute_id" integer,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketplace_dispute_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispute_id" integer NOT NULL,
	"by_user_id" integer,
	"by_actor" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb,
	"visible_to" text DEFAULT 'all' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketplace_disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"order_id" integer NOT NULL,
	"seller_order_id" integer,
	"seller_id" integer NOT NULL,
	"listing_id" integer,
	"return_request_id" integer,
	"raised_by_person_id" integer,
	"raised_by_user_id" integer,
	"kind" "marketplace_dispute_kind" NOT NULL,
	"summary" text NOT NULL,
	"buyer_evidence" jsonb,
	"status" "marketplace_dispute_status" DEFAULT 'open' NOT NULL,
	"respond_by" timestamp with time zone,
	"seller_response" text,
	"seller_evidence" jsonb,
	"seller_responded_at" timestamp with time zone,
	"assigned_to_user_id" integer,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"decision_reason" text,
	"refund_id" integer,
	"refund_minor" integer,
	"penalty_minor" integer,
	"penalty_reason" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "return_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_request_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"variant_id" integer,
	"requested_qty" integer NOT NULL,
	"received_qty" integer,
	"restocked_qty" integer,
	"damaged_qty" integer,
	"buyer_stated_condition" "return_item_condition",
	"inspection_result" "return_inspection_result" DEFAULT 'pending' NOT NULL,
	"inspection_notes" text,
	"inspected_by_user_id" integer,
	"inspected_at" timestamp with time zone,
	"refundable_minor" integer,
	"approved_refund_minor" integer
);--> statement-breakpoint
CREATE TABLE "return_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer,
	"category_id" integer,
	"window_days" integer,
	"no_reason_required" boolean,
	"return_shipping_paid_by" text,
	"condition_requirements" text,
	"exchange_offered" boolean,
	"non_returnable" boolean DEFAULT false NOT NULL,
	"non_returnable_reason" text,
	"set_by_user_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_order_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"buyer_person_id" integer,
	"requested_by_user_id" integer,
	"reason" text NOT NULL,
	"reason_detail" text,
	"evidence" jsonb,
	"remedy_sought" text DEFAULT 'refund' NOT NULL,
	"status" "return_request_status" DEFAULT 'requested' NOT NULL,
	"eligibility_at_request" jsonb,
	"return_shipping_paid_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"respond_by" timestamp with time zone,
	"seller_responded_at" timestamp with time zone,
	"decision_reason" text,
	"decided_by_user_id" integer,
	"rma_number" text,
	"return_to_location_id" integer,
	"carrier" text,
	"tracking_number" text,
	"pickup_scheduled_for" date,
	"received_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"refund_id" integer,
	"refunded_minor" integer,
	"refund_funded_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_order_id" integer NOT NULL,
	"from_status" "seller_order_status",
	"to_status" "seller_order_status" NOT NULL,
	"note" text,
	"by_user_id" integer,
	"by_actor" text DEFAULT 'system' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_order_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_order_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"allocated_minor" integer NOT NULL,
	"gateway_fee_share_minor" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_order_no" text NOT NULL,
	"order_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"status" "seller_order_status" DEFAULT 'order_created' NOT NULL,
	"subtotal_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"commission_minor" integer,
	"commission_tax_minor" integer,
	"seller_payable_minor" integer,
	"commission_resolved" boolean DEFAULT false NOT NULL,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"ship_to" jsonb,
	"buyer_name" text,
	"buyer_phone" text,
	"buyer_email" text,
	"buyer_person_id" integer,
	"fulfilment_location_id" integer,
	"shipping_method_id" integer,
	"accept_by" timestamp with time zone,
	"dispatch_by" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" integer,
	"cancel_reason" text,
	"cancelled_by" text,
	"seller_notes" text,
	"event_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"qty" integer NOT NULL
);--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_order_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"ref" text NOT NULL,
	"carrier" text,
	"service" text,
	"tracking_number" text,
	"tracking_url" text,
	"status" "shipment_status" DEFAULT 'created' NOT NULL,
	"from_location_id" integer,
	"weight_grams" integer,
	"package_count" integer DEFAULT 1 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"expected_by" date,
	"delivered_at" timestamp with time zone,
	"delivered_to" text,
	"failure_reason" text,
	"tracking_events" jsonb,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "shipping_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"zone_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" "shipping_rate_kind" NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"per_kg_minor" integer,
	"per_item_minor" integer,
	"free_above_minor" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"min_days" integer,
	"max_days" integer,
	"carrier" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "shipping_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"name" text NOT NULL,
	"countries" jsonb,
	"states" jsonb,
	"postcode_prefixes" jsonb,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "commission_gaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_order_id" integer NOT NULL,
	"order_line_id" integer,
	"seller_id" integer NOT NULL,
	"category_id" integer,
	"reason" text NOT NULL,
	"detail" text,
	"amount_at_risk_minor" integer,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_rule_version_id" integer
);--> statement-breakpoint
CREATE TABLE "commission_rule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"version" integer NOT NULL,
	"rate_bps" integer,
	"flat_minor" integer,
	"min_minor" integer,
	"max_minor" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"charged_on_shipping" boolean,
	"charged_on_tax" boolean,
	"commission_tax_rate_bps" integer,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"approved_by_user_id" integer,
	"authority" text,
	"published_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"seller_id" integer,
	"seller_tier" text,
	"seller_type" text,
	"category_id" integer,
	"category_subtree" boolean DEFAULT true NOT NULL,
	"listing_id" integer,
	"campaign_code" text,
	"contract_ref" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "order_line_commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_line_id" integer NOT NULL,
	"seller_order_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"rule_id" integer,
	"rule_version_id" integer,
	"rate_bps" integer,
	"flat_minor" integer,
	"basis_minor" integer NOT NULL,
	"basis_description" text,
	"commission_minor" integer NOT NULL,
	"commission_tax_minor" integer DEFAULT 0 NOT NULL,
	"seller_payable_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "payout_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"settlement_id" integer,
	"kind" "payout_adjustment_kind" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"reason" text NOT NULL,
	"authority" text,
	"dispute_id" integer,
	"requested_by_user_id" integer,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_line_id" integer,
	"reversed_at" timestamp with time zone,
	"reversed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"settlement_id" integer,
	"seller_id" integer NOT NULL,
	"payout_account_id" integer,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"provider" text,
	"provider_payout_id" text,
	"utr" text,
	"status" "seller_payout_status" DEFAULT 'pending' NOT NULL,
	"initiated_by_user_id" integer,
	"initiated_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failure_reason" text,
	"reversed_at" timestamp with time zone,
	"reversed_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"cadence" text,
	"status" "seller_settlement_status" DEFAULT 'open' NOT NULL,
	"gross_minor" integer DEFAULT 0 NOT NULL,
	"commission_minor" integer DEFAULT 0 NOT NULL,
	"commission_tax_minor" integer DEFAULT 0 NOT NULL,
	"refund_minor" integer DEFAULT 0 NOT NULL,
	"adjustment_minor" integer DEFAULT 0 NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"tax_collected_minor" integer DEFAULT 0 NOT NULL,
	"gateway_fee_minor" integer DEFAULT 0 NOT NULL,
	"net_payable_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"has_unresolved_commission" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" integer,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"hold_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_id" integer NOT NULL,
	"settlement_id" integer,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"cadence" text NOT NULL,
	"gross_minor" bigint DEFAULT 0 NOT NULL,
	"commission_minor" bigint DEFAULT 0 NOT NULL,
	"refund_minor" bigint DEFAULT 0 NOT NULL,
	"adjustment_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"settlement_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"kind" "settlement_line_kind" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"seller_order_id" integer,
	"order_id" integer,
	"order_line_id" integer,
	"refund_id" integer,
	"return_request_id" integer,
	"dispute_id" integer,
	"description" text NOT NULL,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "event_merchandise" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"listing_id" integer NOT NULL,
	"seller_id" integer NOT NULL,
	"collection_label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"offer_at_registration" boolean DEFAULT false NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"mandatory_policy_ref" text,
	"authorised_by_user_id" integer,
	"authorised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "featured_placements" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"slot" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text,
	"blurb" text,
	"image_url" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "fraud_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"seller_id" integer,
	"kind" "fraud_signal_kind" NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb,
	"detector" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "fraud_signal_status" DEFAULT 'open' NOT NULL,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp with time zone,
	"decision_reason" text,
	"action_taken" text
);--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"variant_id" integer,
	"seller_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"person_id" integer,
	"by_user_id" integer,
	"rating" integer NOT NULL,
	"title" text,
	"body" text,
	"media" jsonb,
	"status" "marketplace_review_status" DEFAULT 'pending' NOT NULL,
	"moderated_by_user_id" integer,
	"moderated_at" timestamp with time zone,
	"moderation_reason" text,
	"moderation_signals" jsonb,
	"seller_reply" text,
	"seller_replied_at" timestamp with time zone,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"reported_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_performance_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"cancelled_by_seller_count" integer DEFAULT 0 NOT NULL,
	"dispatched_count" integer DEFAULT 0 NOT NULL,
	"on_time_dispatch_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"return_count" integer DEFAULT 0 NOT NULL,
	"refund_count" integer DEFAULT 0 NOT NULL,
	"dispute_count" integer DEFAULT 0 NOT NULL,
	"disputes_upheld_count" integer DEFAULT 0 NOT NULL,
	"complaint_count" integer DEFAULT 0 NOT NULL,
	"counterfeit_case_count" integer DEFAULT 0 NOT NULL,
	"acceptance_rate_bps" integer,
	"on_time_dispatch_rate_bps" integer,
	"cancellation_rate_bps" integer,
	"return_rate_bps" integer,
	"refund_rate_bps" integer,
	"dispute_rate_bps" integer,
	"median_dispatch_hours" integer,
	"rating_avg_bps" integer,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"inventory_accuracy_bps" integer,
	"score_bps" integer,
	"band" text,
	"workings" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_id" integer,
	"listing_id" integer,
	"category_id" integer,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value_bps" integer,
	"value_minor" integer,
	"min_qty" integer,
	"min_basket_minor" integer,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"funded_by" text,
	"campaign_code" text,
	"event_id" integer,
	"status" "seller_promotion_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by_user_id" integer,
	"seller_consent_by_user_id" integer,
	"seller_consent_at" timestamp with time zone,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "seller_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"seller_order_id" integer NOT NULL,
	"person_id" integer,
	"by_user_id" integer,
	"rating_overall" integer NOT NULL,
	"rating_delivery" integer,
	"rating_communication" integer,
	"rating_packaging" integer,
	"rating_accuracy" integer,
	"body" text,
	"status" "marketplace_review_status" DEFAULT 'pending' NOT NULL,
	"moderated_by_user_id" integer,
	"moderated_at" timestamp with time zone,
	"moderation_reason" text,
	"seller_reply" text,
	"seller_replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "marketplace_sla_breaches" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer NOT NULL,
	"seller_order_id" integer,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"breached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"overdue_hours" integer,
	"escalation" text DEFAULT 'none' NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalated_to_user_id" integer,
	"resolved_at" timestamp with time zone,
	"note" text
);--> statement-breakpoint

-- ─── Columns on existing tables ──────────────────────────────────────────

ALTER TABLE "order_lines" ADD COLUMN "seller_order_id" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "seller_id" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "listing_id" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "listing_variant_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "brand_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "specifications" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "materials" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "length_mm" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "height_mm" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "country_of_origin" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "warranty" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "gtin" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "sport" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "discipline" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "shotokan_relevant" boolean;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "age_min_years" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "age_max_years" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "safety_classification" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "certification" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "usage_instructions" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "warning" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "hsn_code" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "tax_rate_bps" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "shipping_class" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "variant_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "quarantined_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "quarantine_lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "seller_type" "seller_type";--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "business_type" "seller_business_type";--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "social_profiles" jsonb;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "business_description" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "years_operating" integer;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "business_category" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_slug" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_status" "store_status" DEFAULT 'not_created' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_tagline" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_about" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_logo_url" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_specialisms" jsonb;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "store_closed_reason" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "compliance_status" "seller_compliance_status" DEFAULT 'not_assessed' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "rating_avg_bps" integer;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "performance_score_bps" integer;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "performance_band" "seller_performance_band" DEFAULT 'unrated' NOT NULL;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "performance_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "restricted_reason" text;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "restricted_categories" jsonb;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "terminated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "terminated_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "terminated_reason" text;--> statement-breakpoint

-- ─── Foreign keys ────────────────────────────────────────────────────────

ALTER TABLE "brand_authorisations" ADD CONSTRAINT "brand_authorisations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_authorisations" ADD CONSTRAINT "brand_authorisations_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_authorisations" ADD CONSTRAINT "brand_authorisations_document_id_seller_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seller_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_authorisations" ADD CONSTRAINT "brand_authorisations_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_marketplace_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."marketplace_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_addresses" ADD CONSTRAINT "seller_addresses_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_addresses" ADD CONSTRAINT "seller_addresses_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_addresses" ADD CONSTRAINT "seller_addresses_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_applications" ADD CONSTRAINT "seller_applications_assigned_reviewer_user_id_users_id_fk" FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_badge_grants" ADD CONSTRAINT "seller_badge_grants_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_badge_grants" ADD CONSTRAINT "seller_badge_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_badge_grants" ADD CONSTRAINT "seller_badge_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_documents" ADD CONSTRAINT "seller_documents_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_documents" ADD CONSTRAINT "seller_documents_verification_id_seller_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."seller_verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_documents" ADD CONSTRAINT "seller_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_policy_acceptances" ADD CONSTRAINT "seller_policy_acceptances_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_policy_acceptances" ADD CONSTRAINT "seller_policy_acceptances_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_policy_acceptances" ADD CONSTRAINT "seller_policy_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_sla_configs" ADD CONSTRAINT "seller_sla_configs_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_sla_configs" ADD CONSTRAINT "seller_sla_configs_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_flags" ADD CONSTRAINT "listing_flags_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_flags" ADD CONSTRAINT "listing_flags_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_flags" ADD CONSTRAINT "listing_flags_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_flags" ADD CONSTRAINT "listing_flags_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_categories" ADD CONSTRAINT "marketplace_categories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_import_id_product_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."product_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_duplicate_of_listing_id_listings_id_fk" FOREIGN KEY ("duplicate_of_listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "low_stock_rules" ADD CONSTRAINT "low_stock_rules_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "low_stock_rules" ADD CONSTRAINT "low_stock_rules_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "low_stock_rules" ADD CONSTRAINT "low_stock_rules_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_user_id_users_id_fk" FOREIGN KEY ("counted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_adjustment_movement_id_stock_movements_id_fk" FOREIGN KEY ("adjustment_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_reported_by_person_id_persons_id_fk" FOREIGN KEY ("reported_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_reports" ADD CONSTRAINT "buyer_reports_escalated_to_dispute_id_marketplace_disputes_id_fk" FOREIGN KEY ("escalated_to_dispute_id") REFERENCES "public"."marketplace_disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_dispute_messages" ADD CONSTRAINT "marketplace_dispute_messages_dispute_id_marketplace_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."marketplace_disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_dispute_messages" ADD CONSTRAINT "marketplace_dispute_messages_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_raised_by_person_id_persons_id_fk" FOREIGN KEY ("raised_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_disputes" ADD CONSTRAINT "marketplace_disputes_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_inspected_by_user_id_users_id_fk" FOREIGN KEY ("inspected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_buyer_person_id_persons_id_fk" FOREIGN KEY ("buyer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_return_to_location_id_inventory_locations_id_fk" FOREIGN KEY ("return_to_location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_order_events" ADD CONSTRAINT "seller_order_events_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_order_events" ADD CONSTRAINT "seller_order_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_order_payments" ADD CONSTRAINT "seller_order_payments_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_order_payments" ADD CONSTRAINT "seller_order_payments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_buyer_person_id_persons_id_fk" FOREIGN KEY ("buyer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_fulfilment_location_id_inventory_locations_id_fk" FOREIGN KEY ("fulfilment_location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_from_location_id_inventory_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_gaps" ADD CONSTRAINT "commission_gaps_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_gaps" ADD CONSTRAINT "commission_gaps_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_gaps" ADD CONSTRAINT "commission_gaps_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_gaps" ADD CONSTRAINT "commission_gaps_category_id_marketplace_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_gaps" ADD CONSTRAINT "commission_gaps_resolved_by_rule_version_id_commission_rule_versions_id_fk" FOREIGN KEY ("resolved_by_rule_version_id") REFERENCES "public"."commission_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_versions" ADD CONSTRAINT "commission_rule_versions_rule_id_commission_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."commission_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rule_versions" ADD CONSTRAINT "commission_rule_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_category_id_marketplace_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_commissions" ADD CONSTRAINT "order_line_commissions_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_commissions" ADD CONSTRAINT "order_line_commissions_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_commissions" ADD CONSTRAINT "order_line_commissions_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_commissions" ADD CONSTRAINT "order_line_commissions_rule_id_commission_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."commission_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_commissions" ADD CONSTRAINT "order_line_commissions_rule_version_id_commission_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."commission_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_settlement_id_seller_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."seller_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_dispute_id_marketplace_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."marketplace_disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_applied_line_id_settlement_lines_id_fk" FOREIGN KEY ("applied_line_id") REFERENCES "public"."settlement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_settlement_id_seller_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."seller_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_payout_account_id_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_statements" ADD CONSTRAINT "seller_statements_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_statements" ADD CONSTRAINT "seller_statements_settlement_id_seller_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."seller_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_seller_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."seller_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_dispute_id_marketplace_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."marketplace_disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_merchandise" ADD CONSTRAINT "event_merchandise_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_merchandise" ADD CONSTRAINT "event_merchandise_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_merchandise" ADD CONSTRAINT "event_merchandise_authorised_by_user_id_users_id_fk" FOREIGN KEY ("authorised_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_placements" ADD CONSTRAINT "featured_placements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_variant_id_listing_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_moderated_by_user_id_users_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_performance_snapshots" ADD CONSTRAINT "seller_performance_snapshots_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_category_id_marketplace_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_seller_consent_by_user_id_users_id_fk" FOREIGN KEY ("seller_consent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_moderated_by_user_id_users_id_fk" FOREIGN KEY ("moderated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_sla_breaches" ADD CONSTRAINT "marketplace_sla_breaches_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_sla_breaches" ADD CONSTRAINT "marketplace_sla_breaches_seller_order_id_seller_orders_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_sla_breaches" ADD CONSTRAINT "marketplace_sla_breaches_escalated_to_user_id_users_id_fk" FOREIGN KEY ("escalated_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_quarantined_by_user_id_users_id_fk" FOREIGN KEY ("quarantined_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_terminated_by_user_id_users_id_fk" FOREIGN KEY ("terminated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX "brand_authorisations_brand_seller_idx" ON "brand_authorisations" USING btree ("brand_id","seller_id");--> statement-breakpoint
CREATE INDEX "brand_authorisations_seller_idx" ON "brand_authorisations" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_authorisations_live_uk" ON "brand_authorisations" USING btree ("brand_id","seller_id") WHERE status in ('claimed', 'under_review', 'verified');--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_uk" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "brands_name_idx" ON "brands" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_policies_code_uk" ON "marketplace_policies" USING btree ("code");--> statement-breakpoint
CREATE INDEX "payout_accounts_seller_idx" ON "payout_accounts" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_default_uk" ON "payout_accounts" USING btree ("seller_id") WHERE is_default and disabled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_version_uk" ON "policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE INDEX "policy_versions_effective_idx" ON "policy_versions" USING btree ("policy_id","effective_from");--> statement-breakpoint
CREATE INDEX "seller_addresses_seller_idx" ON "seller_addresses" USING btree ("seller_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_addresses_primary_uk" ON "seller_addresses" USING btree ("seller_id","kind") WHERE is_primary and active;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_applications_ref_uk" ON "seller_applications" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "seller_applications_seller_idx" ON "seller_applications" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "seller_applications_reviewer_idx" ON "seller_applications" USING btree ("assigned_reviewer_user_id");--> statement-breakpoint
CREATE INDEX "seller_badge_grants_seller_idx" ON "seller_badge_grants" USING btree ("seller_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "seller_badge_grants_listing_idx" ON "seller_badge_grants" USING btree ("listing_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "seller_documents_seller_idx" ON "seller_documents" USING btree ("seller_id","kind");--> statement-breakpoint
CREATE INDEX "seller_documents_verification_idx" ON "seller_documents" USING btree ("verification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_policy_acceptances_uk" ON "seller_policy_acceptances" USING btree ("seller_id","policy_version_id");--> statement-breakpoint
CREATE INDEX "seller_policy_acceptances_seller_idx" ON "seller_policy_acceptances" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "seller_sla_configs_scope_idx" ON "seller_sla_configs" USING btree ("seller_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_verifications_seller_check_uk" ON "seller_verifications" USING btree ("seller_id","check");--> statement-breakpoint
CREATE INDEX "seller_verifications_status_idx" ON "seller_verifications" USING btree ("status","check");--> statement-breakpoint
CREATE INDEX "seller_verifications_expiry_idx" ON "seller_verifications" USING btree ("expires_at") WHERE status = 'verified' and expires_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_cases_ref_uk" ON "authenticity_cases" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "authenticity_cases_seller_idx" ON "authenticity_cases" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "authenticity_cases_status_idx" ON "authenticity_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "authenticity_cases_brand_idx" ON "authenticity_cases" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "listing_flags_listing_idx" ON "listing_flags" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_flags_seller_idx" ON "listing_flags" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "listing_flags_open_idx" ON "listing_flags" USING btree ("status","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_variants_sku_uk" ON "listing_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "listing_variants_listing_idx" ON "listing_variants" USING btree ("listing_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_variants_seller_sku_uk" ON "listing_variants" USING btree ("seller_id","seller_sku") WHERE seller_sku is not null;--> statement-breakpoint
CREATE INDEX "listing_variants_seller_idx" ON "listing_variants" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_categories_slug_uk" ON "marketplace_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "marketplace_categories_path_idx" ON "marketplace_categories" USING btree ("path");--> statement-breakpoint
CREATE INDEX "marketplace_categories_parent_idx" ON "marketplace_categories" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "marketplace_categories_policy_idx" ON "marketplace_categories" USING btree ("policy");--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_rows_row_uk" ON "product_import_rows" USING btree ("import_id","row_no");--> statement-breakpoint
CREATE INDEX "product_import_rows_status_idx" ON "product_import_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_imports_ref_uk" ON "product_imports" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "product_imports_seller_idx" ON "product_imports" USING btree ("seller_id","uploaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_code_uk" ON "inventory_locations" USING btree ("seller_id","code");--> statement-breakpoint
CREATE INDEX "inventory_locations_seller_idx" ON "inventory_locations" USING btree ("seller_id","active");--> statement-breakpoint
CREATE INDEX "low_stock_rules_seller_idx" ON "low_stock_rules" USING btree ("seller_id","active");--> statement-breakpoint
CREATE INDEX "low_stock_rules_variant_idx" ON "low_stock_rules" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_counts_seller_idx" ON "stock_counts" USING btree ("seller_id","counted_at");--> statement-breakpoint
CREATE INDEX "stock_counts_variance_idx" ON "stock_counts" USING btree ("variance_qty");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_items_place_uk" ON "stock_items" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_items_seller_idx" ON "stock_items" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "stock_items_variant_idx" ON "stock_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_idx" ON "stock_movements" USING btree ("variant_id","at");--> statement-breakpoint
CREATE INDEX "stock_movements_seller_idx" ON "stock_movements" USING btree ("seller_id","at");--> statement-breakpoint
CREATE INDEX "stock_movements_order_idx" ON "stock_movements" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reservations_live_uk" ON "stock_reservations" USING btree ("order_line_id","location_id") WHERE status in ('held', 'committed');--> statement-breakpoint
CREATE INDEX "stock_reservations_order_idx" ON "stock_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_expiry_idx" ON "stock_reservations" USING btree ("expires_at") WHERE status = 'held';--> statement-breakpoint
CREATE INDEX "stock_reservations_seller_idx" ON "stock_reservations" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_reports_ref_uk" ON "buyer_reports" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "buyer_reports_seller_idx" ON "buyer_reports" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "buyer_reports_order_idx" ON "buyer_reports" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "marketplace_dispute_messages_dispute_idx" ON "marketplace_dispute_messages" USING btree ("dispute_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_disputes_ref_uk" ON "marketplace_disputes" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "marketplace_disputes_seller_idx" ON "marketplace_disputes" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "marketplace_disputes_order_idx" ON "marketplace_disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "marketplace_disputes_status_idx" ON "marketplace_disputes" USING btree ("status","raised_at");--> statement-breakpoint
CREATE INDEX "return_items_request_idx" ON "return_items" USING btree ("return_request_id");--> statement-breakpoint
CREATE INDEX "return_items_line_idx" ON "return_items" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "return_policies_seller_idx" ON "return_policies" USING btree ("seller_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_ref_uk" ON "return_requests" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "return_requests_seller_order_idx" ON "return_requests" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "return_requests_seller_idx" ON "return_requests" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "return_requests_status_idx" ON "return_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "return_requests_due_idx" ON "return_requests" USING btree ("respond_by") WHERE seller_responded_at is null and respond_by is not null;--> statement-breakpoint
CREATE INDEX "seller_order_events_order_idx" ON "seller_order_events" USING btree ("seller_order_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_order_payments_uk" ON "seller_order_payments" USING btree ("seller_order_id","payment_id");--> statement-breakpoint
CREATE INDEX "seller_order_payments_payment_idx" ON "seller_order_payments" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_orders_no_uk" ON "seller_orders" USING btree ("seller_order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_orders_order_seller_uk" ON "seller_orders" USING btree ("order_id","seller_id");--> statement-breakpoint
CREATE INDEX "seller_orders_seller_idx" ON "seller_orders" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "seller_orders_order_idx" ON "seller_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "seller_orders_status_idx" ON "seller_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "seller_orders_dispatch_due_idx" ON "seller_orders" USING btree ("dispatch_by") WHERE dispatched_at is null and dispatch_by is not null;--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_items_line_uk" ON "shipment_items" USING btree ("shipment_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_ref_uk" ON "shipments" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "shipments_seller_order_idx" ON "shipments" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "shipments_seller_idx" ON "shipments" USING btree ("seller_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tracking_uk" ON "shipments" USING btree ("carrier","tracking_number") WHERE tracking_number is not null;--> statement-breakpoint
CREATE INDEX "shipping_methods_zone_idx" ON "shipping_methods" USING btree ("zone_id","active");--> statement-breakpoint
CREATE INDEX "shipping_methods_seller_idx" ON "shipping_methods" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "shipping_zones_seller_idx" ON "shipping_zones" USING btree ("seller_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_gaps_open_uk" ON "commission_gaps" USING btree ("seller_order_id","order_line_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "commission_gaps_seller_idx" ON "commission_gaps" USING btree ("seller_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rule_versions_version_uk" ON "commission_rule_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE INDEX "commission_rule_versions_live_idx" ON "commission_rule_versions" USING btree ("rule_id","effective_from") WHERE published_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rules_code_uk" ON "commission_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "commission_rules_seller_idx" ON "commission_rules" USING btree ("seller_id") WHERE active;--> statement-breakpoint
CREATE INDEX "commission_rules_category_idx" ON "commission_rules" USING btree ("category_id") WHERE active;--> statement-breakpoint
CREATE INDEX "commission_rules_active_idx" ON "commission_rules" USING btree ("active","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "order_line_commissions_line_uk" ON "order_line_commissions" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "order_line_commissions_seller_order_idx" ON "order_line_commissions" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "order_line_commissions_seller_idx" ON "order_line_commissions" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "payout_adjustments_seller_idx" ON "payout_adjustments" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "payout_adjustments_pending_idx" ON "payout_adjustments" USING btree ("seller_id") WHERE applied_at is null and approved_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_payouts_ref_uk" ON "seller_payouts" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_payouts_idempotency_uk" ON "seller_payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_payouts_provider_uk" ON "seller_payouts" USING btree ("provider","provider_payout_id") WHERE provider_payout_id is not null;--> statement-breakpoint
CREATE INDEX "seller_payouts_seller_idx" ON "seller_payouts" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "seller_payouts_settlement_idx" ON "seller_payouts" USING btree ("settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_settlements_ref_uk" ON "seller_settlements" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_settlements_open_uk" ON "seller_settlements" USING btree ("seller_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "seller_settlements_seller_idx" ON "seller_settlements" USING btree ("seller_id","period_start");--> statement-breakpoint
CREATE INDEX "seller_settlements_status_idx" ON "seller_settlements" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_statements_ref_uk" ON "seller_statements" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_statements_period_uk" ON "seller_statements" USING btree ("seller_id","cadence","period_start");--> statement-breakpoint
CREATE INDEX "seller_statements_seller_idx" ON "seller_statements" USING btree ("seller_id","period_start");--> statement-breakpoint
CREATE INDEX "settlement_lines_settlement_idx" ON "settlement_lines" USING btree ("settlement_id","occurred_on");--> statement-breakpoint
CREATE INDEX "settlement_lines_seller_order_idx" ON "settlement_lines" USING btree ("seller_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_lines_sale_uk" ON "settlement_lines" USING btree ("seller_order_id","kind","order_line_id") WHERE kind in ('sale', 'commission', 'commission_tax', 'shipping');--> statement-breakpoint
CREATE UNIQUE INDEX "event_merchandise_pair_uk" ON "event_merchandise" USING btree ("event_id","listing_id");--> statement-breakpoint
CREATE INDEX "event_merchandise_event_idx" ON "event_merchandise" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "event_merchandise_seller_idx" ON "event_merchandise" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "featured_placements_slot_idx" ON "featured_placements" USING btree ("slot","position") WHERE active;--> statement-breakpoint
CREATE INDEX "featured_placements_subject_idx" ON "featured_placements" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "fraud_signals_subject_idx" ON "fraud_signals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "fraud_signals_seller_idx" ON "fraud_signals" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "fraud_signals_open_idx" ON "fraud_signals" USING btree ("status","severity","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_signals_live_uk" ON "fraud_signals" USING btree ("subject_type","subject_id","kind") WHERE status in ('open', 'reviewing');--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_line_uk" ON "product_reviews" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "product_reviews_published_idx" ON "product_reviews" USING btree ("listing_id","created_at") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "product_reviews_seller_idx" ON "product_reviews" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "product_reviews_queue_idx" ON "product_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_performance_period_uk" ON "seller_performance_snapshots" USING btree ("seller_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "seller_performance_seller_idx" ON "seller_performance_snapshots" USING btree ("seller_id","period_end");--> statement-breakpoint
CREATE INDEX "seller_performance_band_idx" ON "seller_performance_snapshots" USING btree ("band","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_promotions_ref_uk" ON "seller_promotions" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "seller_promotions_seller_idx" ON "seller_promotions" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "seller_promotions_live_idx" ON "seller_promotions" USING btree ("status","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_reviews_order_uk" ON "seller_reviews" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "seller_reviews_published_idx" ON "seller_reviews" USING btree ("seller_id","created_at") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "seller_reviews_queue_idx" ON "seller_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_sla_breaches_uk" ON "marketplace_sla_breaches" USING btree ("seller_order_id","kind");--> statement-breakpoint
CREATE INDEX "marketplace_sla_breaches_seller_idx" ON "marketplace_sla_breaches" USING btree ("seller_id","breached_at");--> statement-breakpoint
CREATE INDEX "order_lines_seller_order_idx" ON "order_lines" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX "order_lines_seller_idx" ON "order_lines" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "order_lines_listing_variant_idx" ON "order_lines" USING btree ("listing_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_store_slug_uk" ON "sellers" USING btree ("store_slug") WHERE store_slug is not null;--> statement-breakpoint
CREATE INDEX "sellers_type_idx" ON "sellers" USING btree ("seller_type");--> statement-breakpoint
CREATE INDEX "sellers_store_status_idx" ON "sellers" USING btree ("store_status");--> statement-breakpoint

-- ─── Foreign keys declared here rather than in Drizzle ──────────────────────
--
-- Every one of these would close an import cycle between schema modules if it
-- were written as `.references()`. `order_lines` lives in commerce.schema.ts,
-- which marketplace-orders.schema.ts imports; declaring order_lines →
-- seller_orders in TypeScript would make the two files import each other, and
-- a Drizzle table reference that resolves to `undefined` at module-evaluation
-- time fails silently rather than loudly.
--
-- The constraint is real either way. The database is where referential
-- integrity actually lives; the TypeScript declaration is a convenience.

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_seller_order_id_fk" FOREIGN KEY ("seller_order_id") REFERENCES "public"."seller_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_seller_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_listing_variant_id_fk" FOREIGN KEY ("listing_variant_id") REFERENCES "public"."listing_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "marketplace_categories" ADD CONSTRAINT "marketplace_categories_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_badge_grants" ADD CONSTRAINT "seller_badge_grants_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_cases" ADD CONSTRAINT "authenticity_cases_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_shipping_method_id_fk" FOREIGN KEY ("shipping_method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_orders" ADD CONSTRAINT "seller_orders_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."marketplace_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_promotions" ADD CONSTRAINT "seller_promotions_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_merchandise" ADD CONSTRAINT "event_merchandise_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."competition_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── THE CHECK CONSTRAINTS ─────────────────────────────────────────────────
--
-- These are the rules that must hold no matter which code path writes the row,
-- including the one somebody adds next year in a hurry.

-- RULE 1 OF THE HEADER. The buckets are non-negative, and the three that
-- encumber stock cannot together exceed what is physically present.
--
-- This is what makes the oversell IMPOSSIBLE rather than unlikely. Two
-- checkouts racing for the last gi both read `available = 1`; both attempt
-- `reserved = reserved + 1`; the second violates this constraint and its whole
-- transaction rolls back. Without it, both succeed and one buyer is emailed an
-- apology a day later.
--
-- IF A TEST FAILS AGAINST THIS CONSTRAINT, THE TEST HAS FOUND THE BUG.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_non_negative_ck" CHECK (
  "on_hand" >= 0 AND "reserved" >= 0 AND "committed" >= 0
  AND "damaged" >= 0 AND "in_transit" >= 0
);--> statement-breakpoint

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_encumbrance_ck" CHECK (
  "reserved" + "committed" + "damaged" <= "on_hand"
);--> statement-breakpoint

-- A rating outside 1..5 landing in an average is the sort of defect noticed
-- weeks later as "the numbers look odd", with no way to tell which rows are
-- wrong. Rejected at the door instead.
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_rating_ck" CHECK ("rating" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "seller_reviews" ADD CONSTRAINT "seller_reviews_rating_ck" CHECK (
  "rating_overall" BETWEEN 1 AND 5
  AND ("rating_delivery" IS NULL OR "rating_delivery" BETWEEN 1 AND 5)
  AND ("rating_communication" IS NULL OR "rating_communication" BETWEEN 1 AND 5)
  AND ("rating_packaging" IS NULL OR "rating_packaging" BETWEEN 1 AND 5)
  AND ("rating_accuracy" IS NULL OR "rating_accuracy" BETWEEN 1 AND 5)
);--> statement-breakpoint

-- Quantities are counts. A negative order quantity is a refund somebody typed
-- into the wrong field, and it would flow through commission and settlement as
-- a credit nobody approved.
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_price_ck" CHECK ("price_minor" >= 0);--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_qty_ck" CHECK ("qty" > 0);--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_qty_ck" CHECK ("requested_qty" > 0);--> statement-breakpoint

-- A settlement that does not add up is a settlement somebody has to reconcile
-- by hand, which is the failure the whole module exists to prevent.
ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_period_ck" CHECK ("period_end" >= "period_start");--> statement-breakpoint
ALTER TABLE "seller_payouts" ADD CONSTRAINT "seller_payouts_amount_ck" CHECK ("amount_minor" > 0);--> statement-breakpoint

-- A badge grant names EITHER a seller OR a listing. Neither is a grant that
-- endorses nothing; both is a grant nobody can render.
ALTER TABLE "seller_badge_grants" ADD CONSTRAINT "seller_badge_grants_subject_ck" CHECK (
  ("seller_id" IS NOT NULL) <> ("listing_id" IS NOT NULL)
);--> statement-breakpoint

-- ─── The SLA scope index that Drizzle cannot express ───────────────────────
--
-- One live marketplace-wide default (seller_id NULL) and one live override per
-- seller. Over `coalesce(seller_id, 0)` because Postgres treats every NULL as
-- distinct, so a plain unique index would permit a hundred "defaults" while
-- looking exactly like a constraint that permitted one.
CREATE UNIQUE INDEX "seller_sla_configs_scope_uk" ON "seller_sla_configs" (coalesce("seller_id", 0)) WHERE "active";--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL A — OPEN A STORE FOR EVERY SELLER WHO ALREADY HAD ONE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- See the header. Without this the shop empties on deploy, silently.
--
-- The slug is derived from the trading name and falls back to the seller ref,
-- which is already unique — so no two sellers can collide even if two of them
-- trade as "Karate Supplies". Deliberately NOT clever: no transliteration, no
-- deduplication counter. A slug that is merely the ref is ugly and correct, and
-- src/db/seller-registry.ts lets the seller choose a better one afterwards.

UPDATE "sellers"
SET "store_slug" = COALESCE(
      NULLIF(regexp_replace(lower("trading_name"), '[^a-z0-9]+', '-', 'g'), '-'),
      lower("ref")
    ),
    "store_status" = 'open',
    "store_opened_at" = COALESCE("approved_at", "created_at")
WHERE "status" = 'approved' AND "store_slug" IS NULL;--> statement-breakpoint

-- Any collision the derivation produced falls back to the ref, which cannot
-- collide. Runs second so the readable slug wins wherever it is unambiguous.
UPDATE "sellers" s
SET "store_slug" = lower(s."ref")
WHERE s."store_slug" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "sellers" o
    WHERE o."store_slug" = s."store_slug" AND o."id" < s."id"
  );--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL B — ONE VARIANT PER EXISTING LISTING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Order lines now point at `listing_variants`. A listing with no variant is
-- unbuyable, so every listing that predates this migration gets exactly one,
-- carrying its own price and stock. Nothing about the seller's experience
-- changes; the data simply gains the shape the rest of the platform needs.

INSERT INTO "listing_variants" (
  "listing_id", "seller_id", "sku", "label", "price_minor", "currency",
  "status", "sort_order", "available_qty"
)
SELECT
  l."id",
  l."seller_id",
  l."ref" || '-STD',
  'Standard',
  l."price_minor",
  COALESCE(l."currency", 'INR'),
  'active',
  0,
  GREATEST(COALESCE(l."stock_qty", 0), 0)
FROM "listings" l
WHERE NOT EXISTS (SELECT 1 FROM "listing_variants" v WHERE v."listing_id" = l."id");--> statement-breakpoint

UPDATE "listings" l
SET "variant_count" = (SELECT count(*) FROM "listing_variants" v WHERE v."listing_id" = l."id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL C — A DEFAULT LOCATION AND STOCK ROW PER EXISTING SELLER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The variants created above carry an `available_qty` roll-up, but the
-- AUTHORITATIVE count lives in `stock_items` against a location. A seller with
-- no location has no authoritative stock at all, and the first sale would find
-- nothing to reserve.
--
-- So each existing seller gets one location — 'DEFAULT', named for what it is
-- rather than for a warehouse nobody described — and each backfilled variant
-- gets a stock row there carrying the count the listing already held.

INSERT INTO "inventory_locations" ("seller_id", "code", "name", "kind", "priority", "fulfils_orders", "accepts_returns", "active")
SELECT s."id", 'DEFAULT', 'Default location', 'warehouse', 100, true, true, true
FROM "sellers" s
WHERE NOT EXISTS (SELECT 1 FROM "inventory_locations" il WHERE il."seller_id" = s."id");--> statement-breakpoint

INSERT INTO "stock_items" ("variant_id", "location_id", "seller_id", "on_hand")
SELECT v."id", il."id", v."seller_id", GREATEST(COALESCE(v."available_qty", 0), 0)
FROM "listing_variants" v
JOIN "inventory_locations" il ON il."seller_id" = v."seller_id" AND il."code" = 'DEFAULT'
WHERE NOT EXISTS (
  SELECT 1 FROM "stock_items" si WHERE si."variant_id" = v."id" AND si."location_id" = il."id"
);
