-- Courier delivery (#135): DoorDash Drive bookings, their webhook events, store registration, and the courier weight limit.
ALTER TABLE "stores" ADD COLUMN "doordash_store_id" TEXT;
CREATE UNIQUE INDEX "stores_doordash_store_id_key" ON "stores"("doordash_store_id");

CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quote_fee_cents" INTEGER NOT NULL,
    "actual_fee_cents" INTEGER,
    "tracking_url" TEXT,
    "courier_json" JSONB,
    "proof_url" TEXT,
    "pin" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "deliveries_provider_check" CHECK ("provider" IN ('doordash')),
    CONSTRAINT "deliveries_status_check" CHECK ("status" IN ('requested', 'courier_assigned', 'picked_up', 'delivered', 'cancelled')),
    CONSTRAINT "deliveries_fee_check" CHECK ("quote_fee_cents" >= 0 AND ("actual_fee_cents" IS NULL OR "actual_fee_cents" >= 0))
);

CREATE UNIQUE INDEX "deliveries_id_store_id_key" ON "deliveries"("id", "store_id");
CREATE UNIQUE INDEX "deliveries_provider_external_id_key" ON "deliveries"("provider", "external_id");
CREATE INDEX "deliveries_store_id_order_id_idx" ON "deliveries"("store_id", "order_id");

ALTER TABLE "deliveries"
    ADD CONSTRAINT "deliveries_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliveries"
    ADD CONSTRAINT "deliveries_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deliveries" FORCE ROW LEVEL SECURITY;

CREATE POLICY deliveries_isolation ON "deliveries"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY deliveries_platform_admin ON "deliveries"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "deliveries" TO app_user;

-- Courier events hang off a delivery; external_event_id makes a retried webhook a no-op.
ALTER TABLE "delivery_events" ADD COLUMN "delivery_id" TEXT;
ALTER TABLE "delivery_events" ADD COLUMN "external_event_id" TEXT;
CREATE UNIQUE INDEX "delivery_events_delivery_id_external_event_id_key" ON "delivery_events"("delivery_id", "external_event_id");
ALTER TABLE "delivery_events"
    ADD CONSTRAINT "delivery_events_delivery_id_store_id_fkey"
    FOREIGN KEY ("delivery_id", "store_id") REFERENCES "deliveries"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_events" DROP CONSTRAINT "delivery_events_type_check";
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_type_check"
    CHECK ("type" IN ('out_for_delivery', 'delivered', 'courier_assigned', 'picked_up', 'cancelled'));

-- One platform row. Seeded before RLS is forced so the migrating role can insert it.
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "courier_weight_limit_lb" INTEGER NOT NULL DEFAULT 50,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_settings_singleton_check" CHECK ("id" = 'platform'),
    CONSTRAINT "platform_settings_courier_weight_limit_check" CHECK ("courier_weight_limit_lb" > 0)
);

INSERT INTO "platform_settings" ("id") VALUES ('platform');

ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_settings_read ON "platform_settings"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY platform_settings_platform_admin ON "platform_settings"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_settings" TO app_user;
