-- The quiz pass mark carried NOT NULL DEFAULT 60.
--
-- 60% is not a number MMAKF approved. While that default stood, "the federation
-- has not set a pass mark" was UNREPRESENTABLE: every quiz ever created
-- silently acquired a marking threshold nobody wrote, and a candidate could be
-- failed against it.
--
-- The column becomes nullable with no default. An unset pass mark now records
-- the attempt as UNGRADED for a human to decide, which is the honest outcome
-- and the same treatment every other unconfigured rule in this system receives.
--
-- Existing rows holding exactly 60 are set to NULL: they were never a federation
-- decision, they were the default asserting itself, and leaving them would
-- preserve the invented rule under a corrected schema.
ALTER TABLE "quizzes" ALTER COLUMN "pass_mark_percent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quizzes" ALTER COLUMN "pass_mark_percent" DROP DEFAULT;--> statement-breakpoint
UPDATE "quizzes" SET "pass_mark_percent" = NULL WHERE "pass_mark_percent" = 60;
