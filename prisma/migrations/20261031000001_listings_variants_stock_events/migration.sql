-- MasterProduct: minimal stub (D3). Shared across stores, no store_id.
CREATE TABLE "master_products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "master_products_pkey" PRIMARY KEY ("id")
);

-- Listing: store's offer of a product
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "master_product_id" TEXT,
    "custom_name" TEXT,
    "price" INTEGER NOT NULL,
    "stock_mode" TEXT NOT NULL,
    "qty" INTEGER,
    "status" TEXT,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "perishable" BOOLEAN NOT NULL DEFAULT false,
    "max_per_order" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "confidence_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "listings_store_id_idx" ON "listings"("store_id");
CREATE INDEX "listings_store_id_active_idx" ON "listings"("store_id", "active");
CREATE INDEX "listings_master_product_id_idx" ON "listings"("master_product_id");

ALTER TABLE "listings"
    ADD CONSTRAINT "listings_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listings"
    ADD CONSTRAINT "listings_master_product_id_fkey"
    FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ListingVariant: sizes/variants per listing
CREATE TABLE "listing_variants" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "weight_g" INTEGER NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "listing_variants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "listing_variants_listing_id_idx" ON "listing_variants"("listing_id");

ALTER TABLE "listing_variants"
    ADD CONSTRAINT "listing_variants_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- StockEvent: records every stock change with source
CREATE TABLE "stock_events" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_events_store_id_idx" ON "stock_events"("store_id");
CREATE INDEX "stock_events_listing_id_idx" ON "stock_events"("listing_id");
CREATE INDEX "stock_events_actor_id_idx" ON "stock_events"("actor_id");

ALTER TABLE "stock_events"
    ADD CONSTRAINT "stock_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_events"
    ADD CONSTRAINT "stock_events_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_events"
    ADD CONSTRAINT "stock_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: master_products — any authenticated user can read; only platform admin can write
ALTER TABLE "master_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "master_products" FORCE ROW LEVEL SECURITY;

CREATE POLICY master_products_read ON "master_products"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY master_products_platform_admin ON "master_products"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: listings — store-scoped isolation + platform admin bypass
ALTER TABLE "listings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listings" FORCE ROW LEVEL SECURITY;

CREATE POLICY listings_isolation ON "listings"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY listings_platform_admin ON "listings"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: listing_variants — inherit isolation through listing's store_id
ALTER TABLE "listing_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_variants" FORCE ROW LEVEL SECURITY;

CREATE POLICY listing_variants_isolation ON "listing_variants"
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM "listings"
    WHERE "listings"."id" = "listing_variants"."listing_id"
      AND "listings"."store_id" = current_setting('app.store_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "listings"
    WHERE "listings"."id" = "listing_variants"."listing_id"
      AND "listings"."store_id" = current_setting('app.store_id', true)
  ));

CREATE POLICY listing_variants_platform_admin ON "listing_variants"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: stock_events — store-scoped isolation + platform admin bypass
ALTER TABLE "stock_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_events_isolation ON "stock_events"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY stock_events_platform_admin ON "stock_events"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: audit_logs — add store-scoped INSERT and SELECT (D2)
-- Existing platform_admin policy stays. Store owners can insert and read their own store's entries.
CREATE POLICY audit_logs_store_insert ON "audit_logs"
  FOR INSERT TO app_user
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY audit_logs_store_read ON "audit_logs"
  FOR SELECT TO app_user
  USING (store_id = current_setting('app.store_id', true));

-- Grant app_user access to new tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "master_products" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "listings" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "listing_variants" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_events" TO app_user;
