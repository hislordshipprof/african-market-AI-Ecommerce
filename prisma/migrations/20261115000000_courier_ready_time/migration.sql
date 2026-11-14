-- Courier timing (#562): book the courier when packing starts, for an estimated ready time.
ALTER TABLE "orders" ADD COLUMN "picking_started_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "ready_estimate_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "ready_pushed_at" TIMESTAMP(3);
ALTER TABLE "deliveries" ADD COLUMN "pickup_ready_at" TIMESTAMP(3);
