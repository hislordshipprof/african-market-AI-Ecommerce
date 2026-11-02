-- Finding 6: Order.tipCents
ALTER TABLE "orders" ADD COLUMN "tip_cents" INTEGER NOT NULL DEFAULT 0;

-- Finding 8: OrderLine.substituteVariantId
ALTER TABLE "order_lines" ADD COLUMN "substitute_variant_id" TEXT;
CREATE INDEX "order_lines_substitute_variant_id_idx" ON "order_lines"("substitute_variant_id");

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_substitute_variant_id_fkey"
    FOREIGN KEY ("substitute_variant_id")
    REFERENCES "listing_variants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Finding 13: Cart.paymentIntentId for idempotency
ALTER TABLE "carts" ADD COLUMN "payment_intent_id" TEXT;
CREATE UNIQUE INDEX "carts_payment_intent_id_key" ON "carts"("payment_intent_id");

-- Finding 3: Composite unique constraints (needed for composite FKs)
CREATE UNIQUE INDEX "customers_id_store_id_key" ON "customers"("id", "store_id");
CREATE UNIQUE INDEX "orders_id_store_id_key" ON "orders"("id", "store_id");

-- Finding 3: Drop old simple FKs, add composite FKs
ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_id_fkey";
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_order_id_fkey";

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_customer_id_store_id_fkey"
    FOREIGN KEY ("customer_id", "store_id")
    REFERENCES "customers"("id", "store_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id")
    REFERENCES "orders"("id", "store_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
