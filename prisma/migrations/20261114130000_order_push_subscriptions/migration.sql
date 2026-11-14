-- Customer web push (#563): one row per browser that asked for one order's updates.
CREATE TABLE "order_push_subscriptions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_push_subscriptions_order_id_endpoint_key" ON "order_push_subscriptions"("order_id", "endpoint");
CREATE INDEX "order_push_subscriptions_store_id_order_id_idx" ON "order_push_subscriptions"("store_id", "order_id");

ALTER TABLE "order_push_subscriptions"
    ADD CONSTRAINT "order_push_subscriptions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_push_subscriptions"
    ADD CONSTRAINT "order_push_subscriptions_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_push_subscriptions" FORCE ROW LEVEL SECURITY;

CREATE POLICY order_push_subscriptions_isolation ON "order_push_subscriptions"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY order_push_subscriptions_platform_admin ON "order_push_subscriptions"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "order_push_subscriptions" TO app_user;
