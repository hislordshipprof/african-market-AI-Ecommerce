-- Drop the non-unique index and replace with a unique constraint
DROP INDEX IF EXISTS "stores_stripe_account_id_idx";
CREATE UNIQUE INDEX "stores_stripe_account_id_key" ON "stores"("stripe_account_id");
