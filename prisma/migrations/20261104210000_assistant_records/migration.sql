-- Shopper assistant transcripts. One conversation per cart. No backfill:
-- the tables are new. Store copilot records stay in #142/#144.

CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "in_flight_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_actions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_conversations_store_id_cart_id_key" ON "ai_conversations"("store_id", "cart_id");
CREATE INDEX "ai_conversations_store_id_idx" ON "ai_conversations"("store_id");
CREATE INDEX "ai_conversations_created_at_idx" ON "ai_conversations"("created_at");
CREATE INDEX "ai_conversations_customer_id_idx" ON "ai_conversations"("customer_id");

CREATE INDEX "ai_actions_conversation_id_idx" ON "ai_actions"("conversation_id");
CREATE INDEX "ai_actions_store_id_idx" ON "ai_actions"("store_id");
CREATE INDEX "ai_actions_created_at_idx" ON "ai_actions"("created_at");

ALTER TABLE "ai_conversations"
    ADD CONSTRAINT "ai_conversations_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_conversations"
    ADD CONSTRAINT "ai_conversations_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_conversations"
    ADD CONSTRAINT "ai_conversations_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_actions"
    ADD CONSTRAINT "ai_actions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_actions"
    ADD CONSTRAINT "ai_actions_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_conversations" FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_conversations_isolation ON "ai_conversations"
  FOR ALL TO app_user
  USING (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "carts"
      WHERE "carts"."id" = "ai_conversations"."cart_id"
        AND "carts"."store_id" = current_setting('app.store_id', true)
    )
    AND (
      "ai_conversations"."customer_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM "customers"
        WHERE "customers"."id" = "ai_conversations"."customer_id"
          AND "customers"."store_id" = current_setting('app.store_id', true)
      )
    )
  )
  WITH CHECK (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "carts"
      WHERE "carts"."id" = "ai_conversations"."cart_id"
        AND "carts"."store_id" = current_setting('app.store_id', true)
    )
    AND (
      "ai_conversations"."customer_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM "customers"
        WHERE "customers"."id" = "ai_conversations"."customer_id"
          AND "customers"."store_id" = current_setting('app.store_id', true)
      )
    )
  );

CREATE POLICY ai_conversations_platform_admin ON "ai_conversations"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_conversations" TO app_user;

ALTER TABLE "ai_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_actions" FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_actions_isolation ON "ai_actions"
  FOR ALL TO app_user
  USING (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "ai_conversations"
      WHERE "ai_conversations"."id" = "ai_actions"."conversation_id"
        AND "ai_conversations"."store_id" = current_setting('app.store_id', true)
    )
  )
  WITH CHECK (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "ai_conversations"
      WHERE "ai_conversations"."id" = "ai_actions"."conversation_id"
        AND "ai_conversations"."store_id" = current_setting('app.store_id', true)
    )
  );

CREATE POLICY ai_actions_platform_admin ON "ai_actions"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_actions" TO app_user;
