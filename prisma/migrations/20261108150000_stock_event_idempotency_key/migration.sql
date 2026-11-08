-- One stock event per order line and moment (#141). NULLs stay distinct, so
-- existing rows and owner events, which carry no key, never collide. store_id is
-- part of the key so one store's keys cannot collide with or reveal another's.
ALTER TABLE "stock_events" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "stock_events_store_id_idempotency_key_key"
  ON "stock_events"("store_id", "idempotency_key");

CREATE INDEX "stock_events_store_id_listing_id_created_at_idx"
  ON "stock_events"("store_id", "listing_id", "created_at");
