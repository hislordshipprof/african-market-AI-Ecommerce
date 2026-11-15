-- Admin order search (#537): newest-first keyset pages on (created_at, id) per store and across stores,
-- and exact email or phone lookup across stores. The (store_id, created_at, id) index serves every
-- query the (store_id, created_at) index did, so it replaces it.
DROP INDEX "orders_store_id_created_at_idx";
CREATE INDEX "orders_store_id_created_at_id_idx" ON "orders"("store_id", "created_at", "id");
CREATE INDEX "orders_created_at_id_idx" ON "orders"("created_at", "id");
CREATE INDEX "customers_email_idx" ON "customers"("email");
CREATE INDEX "customers_phone_idx" ON "customers"("phone");
