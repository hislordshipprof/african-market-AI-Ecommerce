-- Platform admin assistant chats (#831): per admin, never store-scoped. Only a platform admin session reads them.

CREATE TABLE "admin_assistant_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "in_flight_until" TIMESTAMP(3),
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_assistant_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_assistant_client_messages" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "client_message_id" TEXT NOT NULL,
    "reply" TEXT,
    "claimed_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_assistant_client_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_assistant_conversations_user_id_last_message_at_idx" ON "admin_assistant_conversations"("user_id", "last_message_at");
CREATE UNIQUE INDEX "admin_assistant_client_messages_user_id_client_message_id_key" ON "admin_assistant_client_messages"("user_id", "client_message_id");
CREATE INDEX "admin_assistant_client_messages_conversation_id_idx" ON "admin_assistant_client_messages"("conversation_id");

ALTER TABLE "admin_assistant_conversations"
    ADD CONSTRAINT "admin_assistant_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_assistant_client_messages"
    ADD CONSTRAINT "admin_assistant_client_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "admin_assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "admin_assistant_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_assistant_conversations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "admin_assistant_client_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_assistant_client_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY admin_assistant_conversations_platform_admin ON "admin_assistant_conversations"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY admin_assistant_client_messages_platform_admin ON "admin_assistant_client_messages"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_assistant_conversations" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_assistant_client_messages" TO app_user;
