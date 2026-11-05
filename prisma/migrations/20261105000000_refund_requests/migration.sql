-- Refund requests are the app's ledger. Stripe remains the source of truth for outcomes.
CREATE TABLE "refund_requests" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "refund_application_fee" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "provider_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refund_requests_key_key" ON "refund_requests"("key");
CREATE INDEX "refund_requests_store_id_idx" ON "refund_requests"("store_id");
CREATE INDEX "refund_requests_order_id_idx" ON "refund_requests"("order_id");
CREATE INDEX "refund_requests_store_id_state_idx" ON "refund_requests"("store_id", "state");

ALTER TABLE "refund_requests"
    ADD CONSTRAINT "refund_requests_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refund_requests"
    ADD CONSTRAINT "refund_requests_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY refund_requests_isolation ON "refund_requests"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY refund_requests_platform_admin ON "refund_requests"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "refund_requests" TO app_user;
