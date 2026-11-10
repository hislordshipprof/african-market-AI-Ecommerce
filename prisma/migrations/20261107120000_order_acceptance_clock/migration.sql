-- When the acceptance alert and auto-cancel start counting (#167): the order time
-- when the store was open, else its next opening. Nullable, no default and no
-- backfill: code reads NULL as created_at, so older orders keep #67 timing.
-- The table-level grants and the orders RLS policies cover the new column.
-- ADD COLUMN with no default does not rewrite the table.

ALTER TABLE "orders" ADD COLUMN "acceptance_clock_starts_at" TIMESTAMPTZ(6);
