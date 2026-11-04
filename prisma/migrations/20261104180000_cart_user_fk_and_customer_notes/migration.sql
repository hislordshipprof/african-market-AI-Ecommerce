-- #132: Cart.user_id becomes a real account foreign key, and Customer gains notes (spec §13).
-- Orphan cart user ids are cleared first so the foreign key can be added on a database that
-- already has rows. customers.notes is nullable; existing rows stay null.
--
-- RLS assumption: carts and customers have forced row-level security. This migration updates
-- and alters them as the table owner (DIRECT_URL), which bypasses RLS. An app_user connection
-- would match zero cart rows and could not add the column.

UPDATE "carts"
SET "user_id" = NULL
WHERE "user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "users" WHERE "users"."id" = "carts"."user_id"
  );

ALTER TABLE "carts"
    ADD CONSTRAINT "carts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "carts_user_id_idx" ON "carts"("user_id");

ALTER TABLE "customers" ADD COLUMN "notes" TEXT;
