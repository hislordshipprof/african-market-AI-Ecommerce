-- Shipping labels, tracking and the Shipped state (ADR-0023, #568).
ALTER TABLE "orders"
  ADD COLUMN "shipping_rate_expires_at" TIMESTAMP(3),
  ADD COLUMN "shipping_postage_cents" INTEGER,
  ADD COLUMN "shipping_label_status" TEXT,
  ADD COLUMN "shipping_label_claimed_at" TIMESTAMP(3),
  ADD COLUMN "shipping_label_id" TEXT,
  ADD COLUMN "shipping_label_key" TEXT,
  ADD COLUMN "shipping_tracking_number" TEXT,
  ADD COLUMN "shipping_tracking_url" TEXT,
  ADD COLUMN "shipped_at" TIMESTAMP(3);

ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_label_status_check"
  CHECK ("shipping_label_status" IS NULL OR "shipping_label_status" IN ('buying', 'bought', 'voided'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_postage_cents_check"
  CHECK ("shipping_postage_cents" IS NULL OR "shipping_postage_cents" >= 0);

-- A label is one Shippo transaction; the tracking webhook finds its order by it.
CREATE UNIQUE INDEX "orders_shipping_label_id_key" ON "orders"("shipping_label_id");

-- Tracking events have no courier delivery: one row per Shippo tracking status, keyed on the order by
-- delivery_events_order_id_external_event_id_key, so a retried webhook is a no-op.
ALTER TABLE "delivery_events" DROP CONSTRAINT "delivery_events_type_check";
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_type_check"
    CHECK ("type" IN ('out_for_delivery', 'delivered', 'courier_assigned', 'picked_up', 'cancelled', 'returned', 'failover_triggered', 'both_failed',
      'shipping_pre_transit', 'shipping_transit', 'shipping_delivered', 'shipping_returned', 'shipping_failure', 'shipping_unknown'));
