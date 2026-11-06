-- Agentic checkout (#247). New tables, so there is no backfill.
-- Same-store parents need a unique (id, store_id) for the composite keys.

CREATE UNIQUE INDEX "carts_id_store_id_key" ON "carts"("id", "store_id");
CREATE UNIQUE INDEX "ai_conversations_id_store_id_key" ON "ai_conversations"("id", "store_id");

ALTER TABLE "orders" ADD COLUMN "cancellable_until" TIMESTAMP(3);
CREATE INDEX "orders_store_id_cancellable_until_idx" ON "orders"("store_id", "cancellable_until");

CREATE TABLE "assistant_checkout_drafts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "fulfillment" TEXT NOT NULL DEFAULT 'pickup',
    "slot_id" TEXT,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "contact_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_checkout_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assistant_checkout_drafts_conversation_id_key" ON "assistant_checkout_drafts"("conversation_id");
CREATE UNIQUE INDEX "assistant_checkout_drafts_conversation_id_store_id_key" ON "assistant_checkout_drafts"("conversation_id", "store_id");
CREATE INDEX "assistant_checkout_drafts_store_id_idx" ON "assistant_checkout_drafts"("store_id");

ALTER TABLE "assistant_checkout_drafts"
    ADD CONSTRAINT "assistant_checkout_drafts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_drafts"
    ADD CONSTRAINT "assistant_checkout_drafts_conversation_id_store_id_fkey"
    FOREIGN KEY ("conversation_id", "store_id") REFERENCES "ai_conversations"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "assistant_checkout_attempts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "cart_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "snapshot_hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "payment_kind" TEXT NOT NULL,
    "saved_payment_method_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "reserved_amount_cents" INTEGER NOT NULL,
    "payment_intent_id" TEXT,
    "order_id" TEXT,
    "window_minutes" INTEGER NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "contact_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_checkout_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assistant_checkout_attempts_id_store_id_key" ON "assistant_checkout_attempts"("id", "store_id");
CREATE UNIQUE INDEX "assistant_checkout_attempts_idempotency_key_key" ON "assistant_checkout_attempts"("idempotency_key");
CREATE INDEX "assistant_checkout_attempts_store_id_conversation_id_idx" ON "assistant_checkout_attempts"("store_id", "conversation_id");
CREATE INDEX "assistant_checkout_attempts_store_id_cart_id_idx" ON "assistant_checkout_attempts"("store_id", "cart_id");
CREATE INDEX "assistant_checkout_attempts_store_id_payment_intent_id_idx" ON "assistant_checkout_attempts"("store_id", "payment_intent_id");

ALTER TABLE "assistant_checkout_attempts"
    ADD CONSTRAINT "assistant_checkout_attempts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_attempts"
    ADD CONSTRAINT "assistant_checkout_attempts_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_attempts"
    ADD CONSTRAINT "assistant_checkout_attempts_conversation_store_fkey"
    FOREIGN KEY ("conversation_id", "store_id") REFERENCES "ai_conversations"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_attempts"
    ADD CONSTRAINT "assistant_checkout_attempts_cart_id_store_id_fkey"
    FOREIGN KEY ("cart_id", "store_id") REFERENCES "carts"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "assistant_checkout_tokens" (
    "token_hash" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_checkout_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX "assistant_checkout_tokens_store_id_attempt_id_idx" ON "assistant_checkout_tokens"("store_id", "attempt_id");

ALTER TABLE "assistant_checkout_tokens"
    ADD CONSTRAINT "assistant_checkout_tokens_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_tokens"
    ADD CONSTRAINT "assistant_checkout_tokens_attempt_id_store_id_fkey"
    FOREIGN KEY ("attempt_id", "store_id") REFERENCES "assistant_checkout_attempts"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_checkout_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_checkout_drafts" FORCE ROW LEVEL SECURITY;

CREATE POLICY assistant_checkout_drafts_isolation ON "assistant_checkout_drafts"
  FOR ALL TO app_user
  USING (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "ai_conversations"
      WHERE "ai_conversations"."id" = "assistant_checkout_drafts"."conversation_id"
        AND "ai_conversations"."store_id" = current_setting('app.store_id', true)
    )
  )
  WITH CHECK (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "ai_conversations"
      WHERE "ai_conversations"."id" = "assistant_checkout_drafts"."conversation_id"
        AND "ai_conversations"."store_id" = current_setting('app.store_id', true)
    )
  );

CREATE POLICY assistant_checkout_drafts_platform_admin ON "assistant_checkout_drafts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_checkout_drafts" TO app_user;

ALTER TABLE "assistant_checkout_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_checkout_attempts" FORCE ROW LEVEL SECURITY;

CREATE POLICY assistant_checkout_attempts_isolation ON "assistant_checkout_attempts"
  FOR ALL TO app_user
  USING (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "carts"
      WHERE "carts"."id" = "assistant_checkout_attempts"."cart_id"
        AND "carts"."store_id" = current_setting('app.store_id', true)
    )
  )
  WITH CHECK (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "carts"
      WHERE "carts"."id" = "assistant_checkout_attempts"."cart_id"
        AND "carts"."store_id" = current_setting('app.store_id', true)
    )
    AND (
      "conversation_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM "ai_conversations"
        WHERE "ai_conversations"."id" = "assistant_checkout_attempts"."conversation_id"
          AND "ai_conversations"."store_id" = current_setting('app.store_id', true)
      )
    )
  );

CREATE POLICY assistant_checkout_attempts_platform_admin ON "assistant_checkout_attempts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_checkout_attempts" TO app_user;

ALTER TABLE "assistant_checkout_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_checkout_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY assistant_checkout_tokens_isolation ON "assistant_checkout_tokens"
  FOR ALL TO app_user
  USING (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "assistant_checkout_attempts"
      WHERE "assistant_checkout_attempts"."id" = "assistant_checkout_tokens"."attempt_id"
        AND "assistant_checkout_attempts"."store_id" = current_setting('app.store_id', true)
    )
  )
  WITH CHECK (
    store_id = current_setting('app.store_id', true)
    AND EXISTS (
      SELECT 1 FROM "assistant_checkout_attempts"
      WHERE "assistant_checkout_attempts"."id" = "assistant_checkout_tokens"."attempt_id"
        AND "assistant_checkout_attempts"."store_id" = current_setting('app.store_id', true)
    )
  );

CREATE POLICY assistant_checkout_tokens_platform_admin ON "assistant_checkout_tokens"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_checkout_tokens" TO app_user;
