-- Store coupons (#556): codes a store owner creates. The store funds every discount.
CREATE TABLE "store_coupons" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "percent_off" INTEGER,
    "amount_off_cents" INTEGER,
    "min_goods_cents" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "total_uses" INTEGER,
    "uses_per_customer" INTEGER,
    "first_order_only" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_coupons_pkey" PRIMARY KEY ("id"),
    -- Stored upper-case, so the unique index below is case-insensitive.
    CONSTRAINT "store_coupons_code_check" CHECK ("code" ~ '^[A-Z0-9-]{3,20}$'),
    CONSTRAINT "store_coupons_value_check" CHECK (
        ("kind" = 'percent' AND "percent_off" BETWEEN 1 AND 90 AND "amount_off_cents" IS NULL)
        OR ("kind" = 'fixed' AND "amount_off_cents" BETWEEN 100 AND 10000 AND "percent_off" IS NULL)
    ),
    CONSTRAINT "store_coupons_min_goods_check" CHECK ("min_goods_cents" >= 0),
    CONSTRAINT "store_coupons_window_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
    CONSTRAINT "store_coupons_total_uses_check" CHECK ("total_uses" IS NULL OR "total_uses" >= 1),
    CONSTRAINT "store_coupons_uses_per_customer_check" CHECK ("uses_per_customer" IS NULL OR "uses_per_customer" >= 1)
);

CREATE UNIQUE INDEX "store_coupons_store_id_code_key" ON "store_coupons"("store_id", "code");
CREATE UNIQUE INDEX "store_coupons_id_store_id_key" ON "store_coupons"("id", "store_id");
CREATE INDEX "store_coupons_created_by_id_idx" ON "store_coupons"("created_by_id");

ALTER TABLE "store_coupons"
    ADD CONSTRAINT "store_coupons_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_coupons"
    ADD CONSTRAINT "store_coupons_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_coupons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_coupons" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_coupons_isolation ON "store_coupons"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_coupons_platform_admin ON "store_coupons"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_coupons" TO app_user;

-- The coupon an order used and the discount it gave; #557 writes them at checkout.
ALTER TABLE "orders" ADD COLUMN "coupon_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "discount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_cents_check" CHECK ("discount_cents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_needs_coupon_check" CHECK ("discount_cents" = 0 OR "coupon_id" IS NOT NULL);

-- Composite key: an order can only point at a coupon of its own store.
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_coupon_id_store_id_fkey"
    FOREIGN KEY ("coupon_id", "store_id") REFERENCES "store_coupons"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "orders_store_id_coupon_id_idx" ON "orders"("store_id", "coupon_id") WHERE "coupon_id" IS NOT NULL;
