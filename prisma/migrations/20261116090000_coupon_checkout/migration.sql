-- Store coupons at checkout (#557).

-- The one code the shopper entered on this cart. Validated on every quote and again under the store lock at placement.
ALTER TABLE "carts" ADD COLUMN "coupon_code" TEXT;

-- Who a coupon use counts against: 'user:<id>' for an account, otherwise 'email:<lower-case email>'.
ALTER TABLE "orders" ADD COLUMN "coupon_customer_key" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_customer_key_check" CHECK ("coupon_customer_key" IS NULL OR "coupon_id" IS NOT NULL);
CREATE INDEX "orders_store_id_coupon_id_coupon_customer_key_idx" ON "orders"("store_id", "coupon_id", "coupon_customer_key");

-- Each line's share of the order discount, written at capture; an issue refund deducts it.
ALTER TABLE "order_lines" ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_discount_cents_check" CHECK ("discount_cents" >= 0);
