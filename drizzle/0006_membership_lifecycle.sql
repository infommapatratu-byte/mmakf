-- Membership lifecycle: suspension and reinstatement as first-class audit acts.
--
-- Recording a suspension as a generic 'update' loses the only thing that
-- matters about it later. "The federation suspended this membership" and "a
-- clerk edited a row" are the same audit entry under the old enum, and the
-- first is a governance decision somebody has to answer for.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12
-- and later provided the new value is not USED in the same transaction. This
-- migration only adds; nothing writes these values until application code runs.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'suspend';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'reinstate';
