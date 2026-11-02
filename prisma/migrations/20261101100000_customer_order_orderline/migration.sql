-- Customer: store-scoped, guest (no userId) or authenticated
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customers_store_id_idx" ON "customers"("store_id");
CREATE INDEX "customers_store_id_email_idx" ON "customers"("store_id", "email");

ALTER TABLE "customers"
    ADD CONSTRAINT "customers_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: customers — store-scoped isolation
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_isolation ON "customers"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY customers_platform_admin ON "customers"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "customers" TO app_user;

-- Order: store-scoped, linked to customer
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AUTHORIZED',
    "fulfillment" TEXT NOT NULL DEFAULT 'pickup',
    "pickup_slot" TEXT,
    "subtotal_cents" INTEGER NOT NULL,
    "buffer_cents" INTEGER NOT NULL,
    "total_authorized_cents" INTEGER NOT NULL,
    "payment_intent_id" TEXT,
    "captured_amount_cents" INTEGER,
    "platform_fee_cents" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_store_id_number_key" ON "orders"("store_id", "number");
CREATE UNIQUE INDEX "orders_payment_intent_id_key" ON "orders"("payment_intent_id");
CREATE INDEX "orders_store_id_idx" ON "orders"("store_id");
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: orders — store-scoped isolation
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;

CREATE POLICY orders_isolation ON "orders"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY orders_platform_admin ON "orders"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "orders" TO app_user;

-- OrderLine: store-scoped (denormalized store_id for direct RLS)
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "listing_variant_id" TEXT NOT NULL,
    "qty_ordered" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "swap_rule" TEXT NOT NULL DEFAULT 'exact_only',
    "status" TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_lines_store_id_idx" ON "order_lines"("store_id");
CREATE INDEX "order_lines_order_id_idx" ON "order_lines"("order_id");
CREATE INDEX "order_lines_listing_variant_id_idx" ON "order_lines"("listing_variant_id");

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_listing_variant_id_fkey"
    FOREIGN KEY ("listing_variant_id") REFERENCES "listing_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: order_lines — store-scoped isolation
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_lines" FORCE ROW LEVEL SECURITY;

CREATE POLICY order_lines_isolation ON "order_lines"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY order_lines_platform_admin ON "order_lines"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "order_lines" TO app_user;

-- Add customerId FK to existing carts table
ALTER TABLE "carts" ADD COLUMN "customer_id" TEXT;
CREATE INDEX "carts_customer_id_idx" ON "carts"("customer_id");

ALTER TABLE "carts"
    ADD CONSTRAINT "carts_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
