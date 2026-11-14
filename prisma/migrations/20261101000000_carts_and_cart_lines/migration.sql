-- Cart: store-scoped, guest or authenticated
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "carts_store_id_idx" ON "carts"("store_id");
CREATE INDEX "carts_store_id_user_id_idx" ON "carts"("store_id", "user_id");

ALTER TABLE "carts"
    ADD CONSTRAINT "carts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: carts — store-scoped isolation
ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carts" FORCE ROW LEVEL SECURITY;

CREATE POLICY carts_isolation ON "carts"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY carts_platform_admin ON "carts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "carts" TO app_user;

-- CartLine: store-scoped (denormalized store_id for direct RLS)
CREATE TABLE "cart_lines" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "swap_rule" TEXT NOT NULL DEFAULT 'exact_only',
    "substitute_variant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cart_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cart_lines_cart_id_variant_id_key" ON "cart_lines"("cart_id", "variant_id");
CREATE INDEX "cart_lines_store_id_idx" ON "cart_lines"("store_id");
CREATE INDEX "cart_lines_cart_id_idx" ON "cart_lines"("cart_id");
CREATE INDEX "cart_lines_variant_id_idx" ON "cart_lines"("variant_id");

ALTER TABLE "cart_lines"
    ADD CONSTRAINT "cart_lines_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cart_lines"
    ADD CONSTRAINT "cart_lines_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "listing_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cart_lines"
    ADD CONSTRAINT "cart_lines_substitute_variant_id_fkey"
    FOREIGN KEY ("substitute_variant_id") REFERENCES "listing_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: cart_lines — store-scoped isolation
ALTER TABLE "cart_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cart_lines" FORCE ROW LEVEL SECURITY;

CREATE POLICY cart_lines_isolation ON "cart_lines"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY cart_lines_platform_admin ON "cart_lines"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "cart_lines" TO app_user;
