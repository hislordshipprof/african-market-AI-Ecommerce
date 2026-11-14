-- Store profile fields for storefront trust/story strip
ALTER TABLE "stores" ADD COLUMN "owner_name" TEXT;
ALTER TABLE "stores" ADD COLUMN "owner_story" TEXT;
ALTER TABLE "stores" ADD COLUMN "owner_photo_url" TEXT;
ALTER TABLE "stores" ADD COLUMN "neighborhood" TEXT;
ALTER TABLE "stores" ADD COLUMN "delivery_info" TEXT;

-- Category image + local name for photo mosaic
ALTER TABLE "categories" ADD COLUMN "local_name" TEXT;
ALTER TABLE "categories" ADD COLUMN "image_url" TEXT;

-- StoreBanner: hero carousel banners, store-scoped
CREATE TABLE "store_banners" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "cta_text" TEXT,
    "cta_href" TEXT,
    "image_url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_banners_store_id_idx" ON "store_banners"("store_id");
CREATE INDEX "store_banners_store_id_active_sort_idx" ON "store_banners"("store_id", "active", "sort_order");

ALTER TABLE "store_banners"
    ADD CONSTRAINT "store_banners_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: store_banners — store-scoped isolation
ALTER TABLE "store_banners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_banners" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_banners_isolation ON "store_banners"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_banners_platform_admin ON "store_banners"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_banners" TO app_user;

-- StoreCollection: curated collections, store-scoped
CREATE TABLE "store_collections" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "image_url" TEXT,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_collections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_collections_store_id_slug_key" ON "store_collections"("store_id", "slug");
CREATE INDEX "store_collections_store_id_idx" ON "store_collections"("store_id");
CREATE INDEX "store_collections_store_id_active_sort_idx" ON "store_collections"("store_id", "active", "sort_order");

ALTER TABLE "store_collections"
    ADD CONSTRAINT "store_collections_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: store_collections — store-scoped isolation
ALTER TABLE "store_collections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_collections" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_collections_isolation ON "store_collections"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_collections_platform_admin ON "store_collections"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_collections" TO app_user;

-- StoreCollectionListing: many-to-many between collections and listings
CREATE TABLE "store_collection_listings" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_collection_listings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_collection_listings_collection_id_listing_id_key" ON "store_collection_listings"("collection_id", "listing_id");
CREATE INDEX "store_collection_listings_collection_id_idx" ON "store_collection_listings"("collection_id");
CREATE INDEX "store_collection_listings_listing_id_idx" ON "store_collection_listings"("listing_id");

ALTER TABLE "store_collection_listings"
    ADD CONSTRAINT "store_collection_listings_collection_id_fkey"
    FOREIGN KEY ("collection_id") REFERENCES "store_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "store_collection_listings"
    ADD CONSTRAINT "store_collection_listings_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: store_collection_listings — inherit isolation through collection's store_id
ALTER TABLE "store_collection_listings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_collection_listings" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_collection_listings_isolation ON "store_collection_listings"
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM "store_collections"
    WHERE "store_collections"."id" = "store_collection_listings"."collection_id"
      AND "store_collections"."store_id" = current_setting('app.store_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "store_collections"
    WHERE "store_collections"."id" = "store_collection_listings"."collection_id"
      AND "store_collections"."store_id" = current_setting('app.store_id', true)
  ));

CREATE POLICY store_collection_listings_platform_admin ON "store_collection_listings"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_collection_listings" TO app_user;
