-- One receipt per assistant addition so a lost acknowledgement cannot subtract twice.
CREATE TABLE "assistant_undo_receipts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "line_id" TEXT NOT NULL,
    "addition_id" TEXT NOT NULL,
    "subtracted" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_undo_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assistant_undo_receipts_store_id_addition_id_key"
    ON "assistant_undo_receipts"("store_id", "addition_id");
CREATE INDEX "assistant_undo_receipts_store_id_idx" ON "assistant_undo_receipts"("store_id");
CREATE INDEX "assistant_undo_receipts_cart_id_idx" ON "assistant_undo_receipts"("cart_id");

ALTER TABLE "assistant_undo_receipts"
    ADD CONSTRAINT "assistant_undo_receipts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_undo_receipts"
    ADD CONSTRAINT "assistant_undo_receipts_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_undo_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_undo_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY assistant_undo_receipts_isolation ON "assistant_undo_receipts"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY assistant_undo_receipts_platform_admin ON "assistant_undo_receipts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_undo_receipts" TO app_user;
