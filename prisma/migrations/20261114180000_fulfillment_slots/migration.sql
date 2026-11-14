-- Scheduled pickup and store delivery slots (#565). Null means the fulfillment has no
-- schedule: pickup keeps today's slots from store hours, store delivery stays on demand.
ALTER TABLE "stores" ADD COLUMN "pickup_slot_settings" JSONB;
ALTER TABLE "stores" ADD COLUMN "store_delivery_slot_settings" JSONB;

-- Slot capacity counts the store's live orders for one fulfillment and slot start.
CREATE INDEX "orders_store_id_fulfillment_pickup_slot_idx" ON "orders"("store_id", "fulfillment", "pickup_slot");
