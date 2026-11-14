-- AI oversight (#544): platform admin review labels on shopper and copilot conversations.
-- Store-owned with RLS. The composite foreign keys tie a flag to a conversation of its own store,
-- and delete it with that conversation (the 90-day retention job deletes shopper conversations).

CREATE UNIQUE INDEX "ai_conversations_id_store_id_key" ON "ai_conversations"("id", "store_id");
CREATE UNIQUE INDEX "copilot_conversations_id_store_id_key" ON "copilot_conversations"("id", "store_id");

CREATE TABLE "ai_review_flags" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "ai_conversation_id" TEXT,
    "copilot_conversation_id" TEXT,
    "label" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_review_flags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_review_flags_label_check" CHECK ("label" IN ('wrong_item', 'wrong_price', 'unsafe', 'tone', 'other')),
    CONSTRAINT "ai_review_flags_note_check" CHECK (char_length("note") <= 1000),
    CONSTRAINT "ai_review_flags_one_conversation_check" CHECK (num_nonnulls("ai_conversation_id", "copilot_conversation_id") = 1)
);

CREATE INDEX "ai_review_flags_store_id_idx" ON "ai_review_flags"("store_id");
CREATE INDEX "ai_review_flags_ai_conversation_id_idx" ON "ai_review_flags"("ai_conversation_id");
CREATE INDEX "ai_review_flags_copilot_conversation_id_idx" ON "ai_review_flags"("copilot_conversation_id");
CREATE INDEX "ai_review_flags_created_by_id_idx" ON "ai_review_flags"("created_by_id");
CREATE INDEX "ai_review_flags_created_at_idx" ON "ai_review_flags"("created_at");

ALTER TABLE "ai_review_flags"
    ADD CONSTRAINT "ai_review_flags_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_review_flags"
    ADD CONSTRAINT "ai_review_flags_ai_conversation_id_store_id_fkey"
    FOREIGN KEY ("ai_conversation_id", "store_id") REFERENCES "ai_conversations"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_review_flags"
    ADD CONSTRAINT "ai_review_flags_copilot_conversation_id_store_id_fkey"
    FOREIGN KEY ("copilot_conversation_id", "store_id") REFERENCES "copilot_conversations"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_review_flags"
    ADD CONSTRAINT "ai_review_flags_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_review_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_review_flags" FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_review_flags_isolation ON "ai_review_flags"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY ai_review_flags_platform_admin ON "ai_review_flags"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_review_flags" TO app_user;
