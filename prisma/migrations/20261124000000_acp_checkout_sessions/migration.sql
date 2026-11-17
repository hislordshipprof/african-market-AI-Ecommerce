-- Agentic commerce (#574): ACP checkout sessions, an AI agent's cart that it pays for with a delegated token.
CREATE TABLE "acp_checkout_sessions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "buyer_name" TEXT,
    "buyer_email" TEXT,
    "buyer_phone" TEXT,
    "payment_intent_id" TEXT,
    "order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acp_checkout_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acp_checkout_sessions_status_check" CHECK ("status" IN ('open', 'complete_in_progress', 'completed', 'canceled'))
);

CREATE UNIQUE INDEX "acp_checkout_sessions_cart_id_key" ON "acp_checkout_sessions"("cart_id");
CREATE INDEX "acp_checkout_sessions_store_id_idx" ON "acp_checkout_sessions"("store_id");

ALTER TABLE "acp_checkout_sessions"
    ADD CONSTRAINT "acp_checkout_sessions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acp_checkout_sessions"
    ADD CONSTRAINT "acp_checkout_sessions_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acp_checkout_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acp_checkout_sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY acp_checkout_sessions_isolation ON "acp_checkout_sessions"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY acp_checkout_sessions_platform_admin ON "acp_checkout_sessions"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "acp_checkout_sessions" TO app_user;
