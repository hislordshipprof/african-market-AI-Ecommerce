-- Claimed order (#70): a guest Customer row is linked to the account Customer at the same store
-- whose verified email matches. DDL only, no backfill. The existing FOR ALL RLS policies on
-- customers cover the new columns.
ALTER TABLE "customers" ADD COLUMN "claimed_by_customer_id" TEXT;
ALTER TABLE "customers" ADD COLUMN "claimed_at" TIMESTAMP(3);

-- Composite so a link can never cross stores: referential checks bypass row security.
ALTER TABLE "customers"
    ADD CONSTRAINT "customers_claimed_by_customer_id_store_id_fkey"
    FOREIGN KEY ("claimed_by_customer_id", "store_id")
    REFERENCES "customers"("id", "store_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "customers_store_id_claimed_by_customer_id_idx"
    ON "customers"("store_id", "claimed_by_customer_id");
