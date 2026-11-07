-- First commit's result, so a repeat of the same preview can replay it.
-- No default and no backfill: rows committed before this column stay NULL
-- and keep the legacy "already been committed" rejection.
-- ADD COLUMN with no default does not rewrite the table.

ALTER TABLE "listing_imports" ADD COLUMN "commit_result" JSONB;
