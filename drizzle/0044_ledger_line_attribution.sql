-- 0044 — a ledger entry can name the order LINE it was posted for.
--
-- WHAT WAS WRONG. postLedger() in src/db/orders.ts writes one income credit per
-- order line, to `income.<order_line_kind>`, and recorded the ORDER on it and
-- not the line. That is enough to reconcile a payment and not enough to say
-- what was sold: an order carrying a gi, a grading fee and a competition entry
-- posts three credits, and nothing on any of them says which line it came from.
--
-- The account suffix carries the line KIND, which recovers the answer only when
-- the order has one line of that kind. Two 'other' lines — an institutional
-- training quotation and a facility hire, which is an ordinary basket — and the
-- attribution is a coin toss. src/db/revenue.ts refuses to toss it: without
-- this column such an entry is reported as not attributable, with the reason.
--
-- So the join the revenue report needs is made REAL rather than inferred:
--
--     ledger_entries.order_line_id ──▶ order_lines.id
--
-- WHY THIS IS SAFE ON A LIVE LEDGER. The column is NULLABLE and nothing is
-- backfilled. Rule 3 of this project — historical records are never rewritten —
-- applies to the ledger before anything else, and a backfill would be this
-- migration deciding, years later, which line each historical credit belonged
-- to. Where it cannot be known it stays NULL and the report says so. Today the
-- table is empty in production (no payment has ever been captured), so no row
-- takes the NULL path at all; the code handles it because a table being empty
-- today is not a guarantee about the file's whole life.
--
-- NO TABLE IS CREATED HERE, so no new *_data_api_lockdown.sql is required —
-- tests/data-api-lockdown.test.ts asserts that invariant by name, and the loop
-- in 0043 has already secured `ledger_entries`. Adding a column to an
-- already-secured table does not unsecure it.

ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "order_line_id" integer;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_order_line_id_order_lines_id_fk'
  ) THEN
    ALTER TABLE "ledger_entries"
      ADD CONSTRAINT "ledger_entries_order_line_id_order_lines_id_fk"
      FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- The revenue report groups by line, so this is the index it reads through.
CREATE INDEX IF NOT EXISTS "ledger_order_line_idx" ON "ledger_entries" USING btree ("order_line_id");
