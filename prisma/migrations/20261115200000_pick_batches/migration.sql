-- Batch picking (#564): staff pick 2-4 Accepted orders together. An order is in an open
-- batch while orders.pick_batch_id points at it; leaving the batch clears it.
CREATE TABLE "pick_batches" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "pick_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pick_batches_id_store_id_key" ON "pick_batches"("id", "store_id");
CREATE INDEX "pick_batches_store_id_closed_at_idx" ON "pick_batches"("store_id", "closed_at");

ALTER TABLE "pick_batches"
    ADD CONSTRAINT "pick_batches_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "pick_batch_id" TEXT;
CREATE INDEX "orders_store_id_pick_batch_id_idx" ON "orders"("store_id", "pick_batch_id");
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_pick_batch_id_store_id_fkey"
    FOREIGN KEY ("pick_batch_id", "store_id") REFERENCES "pick_batches"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pick_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pick_batches" FORCE ROW LEVEL SECURITY;

CREATE POLICY pick_batches_isolation ON "pick_batches"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY pick_batches_platform_admin ON "pick_batches"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "pick_batches" TO app_user;
