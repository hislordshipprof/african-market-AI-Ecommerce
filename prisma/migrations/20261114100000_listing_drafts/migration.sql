-- Photo-to-listing drafts (#552): one row per item Claude read from a shelf photo, pending until the
-- owner confirms a price and publishes it as a listing.
CREATE TABLE "listing_drafts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "photo_key" TEXT NOT NULL,
    "extracted_name" TEXT NOT NULL,
    "extracted_size" TEXT,
    "price_read_cents" INTEGER,
    "match" TEXT NOT NULL,
    "master_product_id" TEXT,
    "candidate_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "existing_listing_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "price_cents" INTEGER,
    "listing_id" TEXT,
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "listing_drafts_match_check" CHECK (match IN ('one', 'several', 'none', 'already_listed')),
    CONSTRAINT "listing_drafts_price_read_check" CHECK (price_read_cents IS NULL OR price_read_cents > 0),
    CONSTRAINT "listing_drafts_status_check" CHECK (
        (status IN ('pending', 'dismissed') AND listing_id IS NULL AND published_by_id IS NULL AND published_at IS NULL)
        OR (status = 'published' AND listing_id IS NOT NULL AND published_by_id IS NOT NULL
            AND published_at IS NOT NULL AND price_cents > 0)
    )
);

CREATE INDEX "listing_drafts_store_id_status_created_at_idx" ON "listing_drafts"("store_id", "status", "created_at");
CREATE INDEX "listing_drafts_created_by_id_idx" ON "listing_drafts"("created_by_id");
CREATE INDEX "listing_drafts_published_by_id_idx" ON "listing_drafts"("published_by_id");
CREATE INDEX "listing_drafts_master_product_id_idx" ON "listing_drafts"("master_product_id");
CREATE INDEX "listing_drafts_existing_listing_id_idx" ON "listing_drafts"("existing_listing_id");
CREATE INDEX "listing_drafts_listing_id_idx" ON "listing_drafts"("listing_id");

ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_published_by_id_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_master_product_id_fkey"
    FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_existing_listing_id_fkey"
    FOREIGN KEY ("existing_listing_id") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listing_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_drafts" FORCE ROW LEVEL SECURITY;

-- A draft may point only at this store's listings.
CREATE POLICY listing_drafts_isolation ON "listing_drafts"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND (listing_id IS NULL OR EXISTS (
            SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_drafts"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)))
        AND (existing_listing_id IS NULL OR EXISTS (
            SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_drafts"."existing_listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)))
    );

CREATE POLICY listing_drafts_platform_admin ON "listing_drafts"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "listing_drafts" TO app_user;
