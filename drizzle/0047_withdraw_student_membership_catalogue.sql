-- 0047 — the withdrawn student memberships leave the public fee catalogue.
--
-- A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
--
-- WHAT WAS WRONG. src/db/fee-catalogue.ts seeds the federation's chargeable
-- services, and two of the fifty-one were the withdrawn student membership:
--
--     MMAKF-FEE-MEM-ATHLETE   'Athlete membership'         annual, per person
--     MMAKF-FEE-MEM-JUNIOR    'Junior athlete membership'  annual, per person
--
-- Both were seeded with status 'published' and display policy 'public', which
-- is publicCatalogue() listing them and the public fee page advertising an
-- annual membership for children as something MMAKF sells. No amount was ever
-- attached to either — src/db/fees.ts refuses to create a rule that would price
-- them, so nobody could be charged through one — but a federation that has
-- withdrawn a charge should not still be offering it.
--
-- The seed now states status 'withdrawn' for both. seedFeeCatalogue() never
-- overwrites an existing row, deliberately, so that a display policy an
-- operator changed is not reverted by a redeploy. That correctness is why this
-- migration exists: on any database seeded before today the two rows are still
-- 'published', and only a migration reaches them.
--
-- WHY THIS IS NOT A REWRITTEN RECORD. `fee_catalogue_entries` is the list of
-- what the federation charges for. It is forward pricing policy, not
-- accounting: no order, order line, payment, invoice, ledger entry or quote is
-- touched here, and nothing is deleted. The two codes REMAIN, because
-- src/db/revenue.ts reads this table by code to attribute paid lines, and a
-- 2024 receipt naming MMAKF-FEE-MEM-ATHLETE must keep resolving to "a student
-- membership, withdrawn on 17 August 2026" rather than to nothing at all. A
-- deleted code would make an old receipt unattributable, which is the ledger
-- being quietly damaged to make a new rule look tidy.
--
-- Any row whose status an operator has already moved off 'published' is left
-- alone: the WHERE clause names the state this migration is correcting.

UPDATE "fee_catalogue_entries"
   SET "status" = 'withdrawn',
       "description" = COALESCE("description",
         'Withdrawn on 17 August 2026. A student does not pay a membership fee for being a student; what a student buys is training. The code is kept so that payments already recorded against it stay attributable.'),
       "updated_at" = now()
 WHERE "code" IN ('MMAKF-FEE-MEM-ATHLETE', 'MMAKF-FEE-MEM-JUNIOR')
   AND "status" = 'published';
