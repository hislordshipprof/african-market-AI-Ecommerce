-- ADR-0014: every foreign key is indexed. copilot_conversations.user_id had no
-- index that leads with user_id, so a user delete scanned every store's chats.
-- Plain CREATE INDEX, not CONCURRENTLY, as in 20261106030000_ai_conversations_cart_id_idx.
-- Never edit 20261108193000_copilot_records.

CREATE INDEX "copilot_conversations_user_id_idx" ON "copilot_conversations"("user_id");
