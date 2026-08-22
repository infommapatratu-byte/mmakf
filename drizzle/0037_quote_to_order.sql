-- The second hop: an accepted quotation becomes something payable.
--
-- Two tables. Neither holds a price MMAKF has published, because MMAKF has
-- published none — every amount here is COPIED from a quote version that was
-- computed by src/db/fees.ts, and a quote version cannot carry a figure until a
-- fee framework exists. Applied against today's database these tables are
-- correct and permanently empty, and that is the honest state.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE CONSTRAINTS ARE WHERE THEY ARE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `quote_payment_links_quote_version_uk` is the whole of the "accepting twice
-- produces ONE invoice and ONE gateway order" guarantee. It is a UNIQUE INDEX
-- and not a SELECT-then-INSERT in the application, because two concurrent
-- callers both pass a SELECT and both then insert. Postgres refuses the second
-- one; src/db/quote-to-order.ts catches that refusal, reads the winner's row
-- and returns the existing link rather than opening a second charge.
--
-- `quote_payment_links_idempotency_uk` guards the same property one layer out.
-- The key on this row is the key sent to the gateway and the key written onto
-- `payments.idempotency_key`, where `payments_idempotency_uk` already refuses a
-- duplicate. Three separate mechanisms agree on one string, and none of them
-- depends on the application remembering to check.
--
-- `quote_acceptances_quote_version_uk` does the same for the agreement itself:
-- clicking Accept twice records one acceptance.
--
-- THE CHECKS ON AMOUNTS ARE NOT DECORATION. `amount_minor > 0` refuses a zero.
-- Zero reads as FREE, and a free training programme for four hundred children
-- is the most expensive misunderstanding this codebase can produce — the fee
-- engine refuses to emit one, and this table refuses to store one, so the
-- mistake has to get past two independent guards to reach an institution.

CREATE TABLE "quote_acceptances" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_version_id" integer NOT NULL,
  "quote_id" integer NOT NULL,
  "accepted_by_name" text NOT NULL,
  "accepted_by_role" text,
  "method" text NOT NULL,
  "evidence_ref" text,
  "note" text,
  "total_minor" integer NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "recorded_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- An acceptance of nothing is not an acceptance. See the note above on zero.
  CONSTRAINT "quote_acceptances_total_positive" CHECK ("total_minor" > 0),
  -- The evidence vocabulary is closed. 'we think they said yes' is not a method.
  CONSTRAINT "quote_acceptances_method" CHECK (
    "method" IN ('email', 'signed_document', 'portal', 'meeting_minuted')
  )
);
--> statement-breakpoint
CREATE TABLE "quote_payment_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_version_id" integer NOT NULL,
  "quote_id" integer NOT NULL,
  "token" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "order_id" integer,
  "invoice_id" integer,
  "payment_id" integer,
  "provider" text,
  "provider_order_id" text,
  "checkout" jsonb,
  "blocked_reason" text,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quote_payment_links_amount_positive" CHECK ("amount_minor" > 0),
  -- A token short enough to guess is not a token. 24 random bytes render to 32
  -- base64url characters; the floor is set below that so a shorter encoding is
  -- still refused rather than silently accepted.
  CONSTRAINT "quote_payment_links_token_length" CHECK (length("token") >= 24)
);
--> statement-breakpoint
ALTER TABLE "quote_acceptances" ADD CONSTRAINT "quote_acceptances_quote_version_id_quote_versions_id_fk"
  FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_acceptances" ADD CONSTRAINT "quote_acceptances_quote_id_quotes_id_fk"
  FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_acceptances" ADD CONSTRAINT "quote_acceptances_recorded_by_user_id_users_id_fk"
  FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_quote_version_id_quote_versions_id_fk"
  FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_quote_id_quotes_id_fk"
  FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_invoice_id_invoices_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_payment_links" ADD CONSTRAINT "quote_payment_links_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_acceptances_quote_version_uk" ON "quote_acceptances" ("quote_version_id");
--> statement-breakpoint
CREATE INDEX "quote_acceptances_quote_idx" ON "quote_acceptances" ("quote_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_payment_links_quote_version_uk" ON "quote_payment_links" ("quote_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_payment_links_token_uk" ON "quote_payment_links" ("token");
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_payment_links_idempotency_uk" ON "quote_payment_links" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "quote_payment_links_quote_idx" ON "quote_payment_links" ("quote_id");
--> statement-breakpoint
CREATE INDEX "quote_payment_links_order_idx" ON "quote_payment_links" ("order_id");
