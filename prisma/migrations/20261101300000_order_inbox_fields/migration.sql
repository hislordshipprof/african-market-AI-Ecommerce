-- Store: autoAcceptOrders flag
ALTER TABLE "stores" ADD COLUMN "auto_accept_orders" BOOLEAN NOT NULL DEFAULT false;

-- Order: new fields for order lifecycle
ALTER TABLE "orders" ADD COLUMN "delivery_fee_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "total_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "prep_estimate_minutes" INTEGER;
ALTER TABLE "orders" ADD COLUMN "accepted_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "ready_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "completed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "cancelled_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill total_cents from subtotal_cents for existing rows
UPDATE "orders" SET "total_cents" = "subtotal_cents" + "tip_cents" WHERE "total_cents" = 0;

-- Index on (store_id, status) for inbox queries
CREATE INDEX "orders_store_id_status_idx" ON "orders"("store_id", "status");

-- OrderLine: new fields
ALTER TABLE "order_lines" ADD COLUMN "qty_picked" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order_lines" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "order_lines" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
