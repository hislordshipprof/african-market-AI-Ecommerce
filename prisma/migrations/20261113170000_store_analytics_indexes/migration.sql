-- Store analytics (#498): date-range reads per store.
CREATE INDEX "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");
CREATE INDEX "ai_actions_store_id_tool_created_at_idx" ON "ai_actions"("store_id", "tool", "created_at");
CREATE INDEX "ai_conversations_store_id_created_at_idx" ON "ai_conversations"("store_id", "created_at");
