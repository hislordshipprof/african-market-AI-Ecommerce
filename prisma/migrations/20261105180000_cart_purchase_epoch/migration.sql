-- One basket purchase increments this counter in the same transaction that
-- clears the lines. PaymentIntents stamp the value they were authorized for.
ALTER TABLE "carts" ADD COLUMN "purchase_epoch" INTEGER NOT NULL DEFAULT 0;

-- The pay path looks up the latest order for a cart on every place.
CREATE INDEX "orders_store_id_source_cart_id_created_at_idx"
  ON "orders"("store_id", "source_cart_id", "created_at");

-- One row reserves a PaymentIntent for release. Placement and release take the
-- same locks, and this row is written before Stripe is told to cancel.
CREATE TABLE "payment_intent_releases" (
    "payment_intent_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_intent_releases_pkey" PRIMARY KEY ("payment_intent_id")
);

CREATE INDEX "payment_intent_releases_store_id_idx" ON "payment_intent_releases"("store_id");

ALTER TABLE "payment_intent_releases"
    ADD CONSTRAINT "payment_intent_releases_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_intent_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_intent_releases" FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_intent_releases_isolation ON "payment_intent_releases"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY payment_intent_releases_platform_admin ON "payment_intent_releases"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_intent_releases" TO app_user;
