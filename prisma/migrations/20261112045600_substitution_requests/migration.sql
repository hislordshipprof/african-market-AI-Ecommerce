-- Substitution prompts (#13). A short line asks the customer to approve a swap or take a refund.
ALTER TABLE "order_lines" ADD COLUMN "substituted_variant_id" TEXT;
ALTER TABLE "order_lines" ADD COLUMN "substituted_unit_price_cents" INTEGER;

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_substituted_variant_id_fkey"
    FOREIGN KEY ("substituted_variant_id") REFERENCES "listing_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "order_lines_substituted_variant_id_idx" ON "order_lines"("substituted_variant_id");

CREATE TABLE "substitution_requests" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_line_id" TEXT NOT NULL,
    "proposed_variant_id" TEXT,
    "proposed_unit_price_cents" INTEGER,
    "qty" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "substitution_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "substitution_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'declined', 'timed_out')),
    CONSTRAINT "substitution_requests_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "substitution_requests_proposal_check" CHECK (("proposed_variant_id" IS NULL) = ("proposed_unit_price_cents" IS NULL))
);

CREATE UNIQUE INDEX "substitution_requests_order_line_id_key" ON "substitution_requests"("order_line_id");
CREATE INDEX "substitution_requests_store_id_idx" ON "substitution_requests"("store_id");
CREATE INDEX "substitution_requests_order_id_idx" ON "substitution_requests"("order_id");
CREATE INDEX "substitution_requests_proposed_variant_id_idx" ON "substitution_requests"("proposed_variant_id");
CREATE INDEX "substitution_requests_pending_idx" ON "substitution_requests"("expires_at") WHERE "status" = 'pending';

ALTER TABLE "substitution_requests"
    ADD CONSTRAINT "substitution_requests_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "substitution_requests"
    ADD CONSTRAINT "substitution_requests_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "substitution_requests"
    ADD CONSTRAINT "substitution_requests_order_line_id_fkey"
    FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "substitution_requests"
    ADD CONSTRAINT "substitution_requests_proposed_variant_id_fkey"
    FOREIGN KEY ("proposed_variant_id") REFERENCES "listing_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "substitution_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "substitution_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY substitution_requests_isolation ON "substitution_requests"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY substitution_requests_platform_admin ON "substitution_requests"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "substitution_requests" TO app_user;
