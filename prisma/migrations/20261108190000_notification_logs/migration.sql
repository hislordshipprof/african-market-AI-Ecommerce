-- Unguessable tracking links, and one log row per order, event and channel.
ALTER TABLE "orders" ADD COLUMN "tracking_token" TEXT;

CREATE UNIQUE INDEX "orders_tracking_token_key" ON "orders"("tracking_token");

CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_logs_order_id_event_channel_key"
    ON "notification_logs"("order_id", "event", "channel");
CREATE INDEX "notification_logs_store_id_idx" ON "notification_logs"("store_id");
CREATE INDEX "notification_logs_store_id_order_id_idx" ON "notification_logs"("store_id", "order_id");
CREATE INDEX "notification_logs_status_created_at_idx" ON "notification_logs"("status", "created_at");

ALTER TABLE "notification_logs"
    ADD CONSTRAINT "notification_logs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_logs"
    ADD CONSTRAINT "notification_logs_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_logs_isolation ON "notification_logs"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY notification_logs_platform_admin ON "notification_logs"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_logs" TO app_user;
