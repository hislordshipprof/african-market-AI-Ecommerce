-- Store delivery driver flow: out for delivery, delivered with a private proof photo.
ALTER TABLE "orders" ADD COLUMN "out_for_delivery_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "delivery_proof_key" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_proof_uploaded_at" TIMESTAMP(3);

CREATE TABLE "delivery_events" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delivery_events_type_check" CHECK ("type" IN ('out_for_delivery', 'delivered'))
);

CREATE INDEX "delivery_events_store_id_idx" ON "delivery_events"("store_id");
CREATE INDEX "delivery_events_store_id_order_id_idx" ON "delivery_events"("store_id", "order_id");

ALTER TABLE "delivery_events"
    ADD CONSTRAINT "delivery_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delivery_events"
    ADD CONSTRAINT "delivery_events_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_events_isolation ON "delivery_events"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY delivery_events_platform_admin ON "delivery_events"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "delivery_events" TO app_user;
