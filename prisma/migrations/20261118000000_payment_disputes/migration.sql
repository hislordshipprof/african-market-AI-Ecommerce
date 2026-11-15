-- Card disputes (#539): one row per Stripe dispute, and the charge.dispute.* event ids already applied.
CREATE TABLE "payment_disputes" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "order_id" TEXT,
    "stripe_dispute_id" TEXT NOT NULL,
    "charge_id" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidence_due_by" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "fee_cents" INTEGER NOT NULL DEFAULT 0,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL,
    "notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id"),
    -- An order always belongs to a store; a dispute with no order may have no store.
    CONSTRAINT "payment_disputes_order_needs_store_check" CHECK ("order_id" IS NULL OR "store_id" IS NOT NULL)
);

CREATE UNIQUE INDEX "payment_disputes_stripe_dispute_id_key" ON "payment_disputes"("stripe_dispute_id");
CREATE INDEX "payment_disputes_store_id_order_id_idx" ON "payment_disputes"("store_id", "order_id");
CREATE INDEX "payment_disputes_status_evidence_due_by_idx" ON "payment_disputes"("status", "evidence_due_by");

ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- (order_id, store_id) together, so a dispute can only name an order of its own store.
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_disputes" FORCE ROW LEVEL SECURITY;

-- A store reads its own disputes; only the platform (the Stripe webhook, the admin console) writes them.
CREATE POLICY payment_disputes_isolation ON "payment_disputes"
  FOR SELECT TO app_user
  USING (store_id = current_setting('app.store_id', true));

CREATE POLICY payment_disputes_platform_admin ON "payment_disputes"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_disputes" TO app_user;

-- One row per dispute event applied; a replayed event id is a no-op.
CREATE TABLE "payment_dispute_events" (
    "id" TEXT NOT NULL,
    "stripe_dispute_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_dispute_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_dispute_events_stripe_dispute_id_idx" ON "payment_dispute_events"("stripe_dispute_id");

ALTER TABLE "payment_dispute_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_dispute_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_dispute_events_platform_admin ON "payment_dispute_events"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_dispute_events" TO app_user;
