-- Store copilot records. Shopper assistant tables are not changed.
-- stock_proposals has no foreign key to listings or stock_events: those checks
-- bypass row security and would reveal whether another store's id exists.

CREATE TABLE "copilot_conversations" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "in_flight_until" TIMESTAMP(3),
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "copilot_client_messages" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "client_message_id" TEXT NOT NULL,
    "reply" TEXT,
    "claimed_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_client_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_proposals" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER,
    "status_value" TEXT,
    "before" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "copilot_conversations_store_id_idx" ON "copilot_conversations"("store_id");
CREATE INDEX "copilot_conversations_store_id_user_id_last_message_at_idx" ON "copilot_conversations"("store_id", "user_id", "last_message_at");

CREATE UNIQUE INDEX "copilot_client_messages_store_id_user_id_client_message_id_key" ON "copilot_client_messages"("store_id", "user_id", "client_message_id");
CREATE INDEX "copilot_client_messages_store_id_idx" ON "copilot_client_messages"("store_id");
CREATE INDEX "copilot_client_messages_conversation_id_idx" ON "copilot_client_messages"("conversation_id");

CREATE INDEX "stock_proposals_store_id_idx" ON "stock_proposals"("store_id");
CREATE INDEX "stock_proposals_store_id_listing_id_state_idx" ON "stock_proposals"("store_id", "listing_id", "state");
CREATE INDEX "stock_proposals_store_id_client_message_id_idx" ON "stock_proposals"("store_id", "client_message_id");
CREATE INDEX "stock_proposals_conversation_id_idx" ON "stock_proposals"("conversation_id");
CREATE INDEX "stock_proposals_listing_id_idx" ON "stock_proposals"("listing_id");
CREATE INDEX "stock_proposals_decided_by_id_idx" ON "stock_proposals"("decided_by_id");

ALTER TABLE "copilot_conversations"
    ADD CONSTRAINT "copilot_conversations_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_conversations"
    ADD CONSTRAINT "copilot_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_client_messages"
    ADD CONSTRAINT "copilot_client_messages_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_client_messages"
    ADD CONSTRAINT "copilot_client_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_proposals"
    ADD CONSTRAINT "stock_proposals_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_proposals"
    ADD CONSTRAINT "stock_proposals_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_proposals"
    ADD CONSTRAINT "stock_proposals_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_proposals"
    ADD CONSTRAINT "stock_proposals_kind_check" CHECK (
        (kind IN ('restock', 'counter_sale') AND quantity BETWEEN 1 AND 100000 AND status_value IS NULL)
        OR (kind = 'recount' AND quantity BETWEEN 0 AND 100000 AND status_value IS NULL)
        OR (kind = 'set_status' AND quantity IS NULL AND status_value IN ('in_stock', 'low', 'out_of_stock'))
    );

ALTER TABLE "stock_proposals"
    ADD CONSTRAINT "stock_proposals_state_check" CHECK (
        (state = 'pending' AND decided_by_id IS NULL AND decided_at IS NULL)
        OR (state = 'confirmed' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL)
        OR (state = 'rejected' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL)
        OR state = 'expired'
    );

ALTER TABLE "copilot_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_conversations" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_conversations_isolation ON "copilot_conversations"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY copilot_conversations_platform_admin ON "copilot_conversations"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_conversations" TO app_user;

ALTER TABLE "copilot_client_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_client_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_client_messages_isolation ON "copilot_client_messages"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND (
            conversation_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "copilot_conversations"
                WHERE "copilot_conversations"."id" = "copilot_client_messages"."conversation_id"
                    AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
            )
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND (
            conversation_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "copilot_conversations"
                WHERE "copilot_conversations"."id" = "copilot_client_messages"."conversation_id"
                    AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
            )
        )
    );

CREATE POLICY copilot_client_messages_platform_admin ON "copilot_client_messages"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_client_messages" TO app_user;

ALTER TABLE "stock_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_proposals" FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_proposals_isolation ON "stock_proposals"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "copilot_conversations"
            WHERE "copilot_conversations"."id" = "stock_proposals"."conversation_id"
                AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "stock_proposals"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "copilot_conversations"
            WHERE "copilot_conversations"."id" = "stock_proposals"."conversation_id"
                AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "stock_proposals"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY stock_proposals_platform_admin ON "stock_proposals"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_proposals" TO app_user;
