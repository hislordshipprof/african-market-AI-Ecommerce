-- AI review inbox (#856): platform admin assistant chats take review labels too. Those chats belong to no store,
-- so their flags have no store id; the store isolation policy never matches them and only a platform admin sees them.

ALTER TABLE "ai_review_flags" ADD COLUMN "admin_assistant_conversation_id" TEXT;
ALTER TABLE "ai_review_flags" ALTER COLUMN "store_id" DROP NOT NULL;

ALTER TABLE "ai_review_flags" DROP CONSTRAINT "ai_review_flags_one_conversation_check";
ALTER TABLE "ai_review_flags" ADD CONSTRAINT "ai_review_flags_one_conversation_check"
    CHECK (num_nonnulls("ai_conversation_id", "copilot_conversation_id", "admin_assistant_conversation_id") = 1);
ALTER TABLE "ai_review_flags" ADD CONSTRAINT "ai_review_flags_store_check"
    CHECK (("admin_assistant_conversation_id" IS NULL) = ("store_id" IS NOT NULL));

CREATE INDEX "ai_review_flags_admin_assistant_conversation_id_idx" ON "ai_review_flags"("admin_assistant_conversation_id");

ALTER TABLE "ai_review_flags"
    ADD CONSTRAINT "ai_review_flags_admin_assistant_conversation_id_fkey"
    FOREIGN KEY ("admin_assistant_conversation_id") REFERENCES "admin_assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
