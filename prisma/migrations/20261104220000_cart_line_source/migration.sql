-- Assistant-created lines are marked ai. Existing rows take the default;
-- no backfill, because a plain UPDATE matches nothing under FORCE RLS.

ALTER TABLE "cart_lines" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
