-- Store chat drafts the owner confirms (#819): coupons, prices and one-off store changes.
-- No foreign key to listings: the confirm re-reads each listing under row security.

ALTER TABLE "stores" ADD COLUMN "delivery_paused_until" TIMESTAMPTZ(6);

CREATE TABLE "copilot_drafts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "copilot_drafts_store_id_idx" ON "copilot_drafts"("store_id");
CREATE INDEX "copilot_drafts_store_id_client_message_id_idx" ON "copilot_drafts"("store_id", "client_message_id");
CREATE INDEX "copilot_drafts_conversation_id_idx" ON "copilot_drafts"("conversation_id");
CREATE INDEX "copilot_drafts_decided_by_id_idx" ON "copilot_drafts"("decided_by_id");

ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_kind_check" CHECK (kind IN ('coupon', 'price', 'store_change'));

ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_state_check" CHECK (
        (state = 'pending' AND decided_by_id IS NULL AND decided_at IS NULL)
        OR (state = 'confirmed' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL)
        OR (state = 'rejected' AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL)
        OR state = 'expired'
    );

ALTER TABLE "copilot_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_drafts" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_drafts_isolation ON "copilot_drafts"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "copilot_conversations"
            WHERE "copilot_conversations"."id" = "copilot_drafts"."conversation_id"
                AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "copilot_conversations"
            WHERE "copilot_conversations"."id" = "copilot_drafts"."conversation_id"
                AND "copilot_conversations"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY copilot_drafts_platform_admin ON "copilot_drafts"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_drafts" TO app_user;
