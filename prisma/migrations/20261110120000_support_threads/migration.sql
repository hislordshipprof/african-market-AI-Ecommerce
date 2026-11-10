-- Customer to store chat: one support thread per order, many messages.
CREATE TABLE "support_threads" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL DEFAULT 'order',
    "state" TEXT NOT NULL DEFAULT 'open',
    "last_customer_at" TIMESTAMP(3),
    "last_reply_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_threads_topic_check" CHECK ("topic" IN ('order', 'payment', 'delivery', 'app')),
    CONSTRAINT "support_threads_state_check" CHECK ("state" IN ('open', 'escalated', 'resolved'))
);

CREATE UNIQUE INDEX "support_threads_order_id_key" ON "support_threads"("order_id");
CREATE UNIQUE INDEX "support_threads_id_store_id_key" ON "support_threads"("id", "store_id");
CREATE INDEX "support_threads_store_id_last_customer_at_idx" ON "support_threads"("store_id", "last_customer_at");

ALTER TABLE "support_threads"
    ADD CONSTRAINT "support_threads_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_threads"
    ADD CONSTRAINT "support_threads_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "sender_user_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_messages_sender_check" CHECK ("sender" IN ('customer', 'store', 'platform')),
    CONSTRAINT "support_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 1000)
);

CREATE INDEX "support_messages_store_id_idx" ON "support_messages"("store_id");
CREATE INDEX "support_messages_thread_id_created_at_idx" ON "support_messages"("thread_id", "created_at");
CREATE INDEX "support_messages_sender_user_id_idx" ON "support_messages"("sender_user_id");

ALTER TABLE "support_messages"
    ADD CONSTRAINT "support_messages_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_messages"
    ADD CONSTRAINT "support_messages_thread_id_store_id_fkey"
    FOREIGN KEY ("thread_id", "store_id") REFERENCES "support_threads"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_messages"
    ADD CONSTRAINT "support_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "support_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_threads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY support_threads_isolation ON "support_threads"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY support_threads_platform_admin ON "support_threads"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY support_messages_isolation ON "support_messages"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY support_messages_platform_admin ON "support_messages"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "support_threads" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "support_messages" TO app_user;
