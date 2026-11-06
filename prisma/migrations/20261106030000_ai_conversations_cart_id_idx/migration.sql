-- ADR-0014: every foreign key is indexed. ai_conversations.cart_id had no
-- index that leads with cart_id, so a cart delete paid one skip scan per store.
-- Plain CREATE INDEX, not CONCURRENTLY: this ticket accepts the write lock.
-- One CREATE INDEX is atomic as a PostgreSQL statement. Prisma does not wrap
-- the file in a transaction. Never edit 20261104210000_assistant_records.

CREATE INDEX "ai_conversations_cart_id_idx" ON "ai_conversations"("cart_id");
