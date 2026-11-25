-- Platform admin assistant drafts (#832): a change waits for the admin's confirm. Only a platform admin session reads them.

CREATE TABLE "admin_assistant_drafts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "client_message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "store_id" TEXT,
    "payload" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_assistant_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_assistant_drafts_conversation_id_idx" ON "admin_assistant_drafts"("conversation_id");
CREATE INDEX "admin_assistant_drafts_user_id_client_message_id_idx" ON "admin_assistant_drafts"("user_id", "client_message_id");

ALTER TABLE "admin_assistant_drafts"
    ADD CONSTRAINT "admin_assistant_drafts_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "admin_assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "admin_assistant_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_assistant_drafts" FORCE ROW LEVEL SECURITY;

CREATE POLICY admin_assistant_drafts_platform_admin ON "admin_assistant_drafts"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_assistant_drafts" TO app_user;
