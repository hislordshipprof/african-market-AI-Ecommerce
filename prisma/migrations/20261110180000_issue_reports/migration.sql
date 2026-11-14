-- Customer issue reports (#428). One per order; the refund itself is a refund_requests row.
CREATE TABLE "issue_reports" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "note" TEXT,
    "photo_key" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "refund_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_reports_type_check" CHECK ("type" IN ('missing', 'damaged', 'wrong', 'poor_freshness')),
    CONSTRAINT "issue_reports_state_check" CHECK ("state" IN ('auto_refunded', 'in_review', 'approved', 'declined', 'refund_failed')),
    CONSTRAINT "issue_reports_amount_check" CHECK ("amount_cents" >= 0)
);

CREATE UNIQUE INDEX "issue_reports_order_id_key" ON "issue_reports"("order_id");
CREATE UNIQUE INDEX "issue_reports_refund_request_id_key" ON "issue_reports"("refund_request_id");
CREATE INDEX "issue_reports_store_id_idx" ON "issue_reports"("store_id");
CREATE INDEX "issue_reports_store_id_state_idx" ON "issue_reports"("store_id", "state");

ALTER TABLE "issue_reports"
    ADD CONSTRAINT "issue_reports_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "issue_reports"
    ADD CONSTRAINT "issue_reports_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "issue_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_reports" FORCE ROW LEVEL SECURITY;

CREATE POLICY issue_reports_isolation ON "issue_reports"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY issue_reports_platform_admin ON "issue_reports"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "issue_reports" TO app_user;
