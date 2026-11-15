-- Product proposals (#553): an unmatched shelf-photo item the owner published as a custom listing and
-- suggested for the master catalog. A platform admin approves it (the listing is re-pointed to the
-- master product) or rejects it (the listing stays as it is).
CREATE TABLE "product_proposals" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "draft_id" TEXT,
    "proposed_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "local_name" TEXT,
    "size" TEXT,
    "category_id" TEXT,
    "photo_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "master_product_id" TEXT,
    "reject_reason" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_proposals_name_check" CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT "product_proposals_status_check" CHECK (
        (status = 'pending' AND master_product_id IS NULL AND reviewed_by_id IS NULL AND reviewed_at IS NULL AND reject_reason IS NULL)
        OR (status = 'approved' AND master_product_id IS NOT NULL AND reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL AND reject_reason IS NULL)
        OR (status = 'rejected' AND master_product_id IS NULL AND reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "product_proposals_listing_id_key" ON "product_proposals"("listing_id");
CREATE UNIQUE INDEX "product_proposals_draft_id_key" ON "product_proposals"("draft_id");
CREATE INDEX "product_proposals_store_id_created_at_idx" ON "product_proposals"("store_id", "created_at");
CREATE INDEX "product_proposals_status_created_at_idx" ON "product_proposals"("status", "created_at");
CREATE INDEX "product_proposals_proposed_by_id_idx" ON "product_proposals"("proposed_by_id");
CREATE INDEX "product_proposals_reviewed_by_id_idx" ON "product_proposals"("reviewed_by_id");
CREATE INDEX "product_proposals_category_id_idx" ON "product_proposals"("category_id");
CREATE INDEX "product_proposals_master_product_id_idx" ON "product_proposals"("master_product_id");

ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "listing_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_proposed_by_id_fkey"
    FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_proposals" ADD CONSTRAINT "product_proposals_master_product_id_fkey"
    FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_proposals" FORCE ROW LEVEL SECURITY;

-- Store members read their own store's proposals and create them only as pending, for their own
-- listing and draft. Only the platform reviews them.
CREATE POLICY product_proposals_isolation ON "product_proposals"
    FOR SELECT TO app_user
    USING (store_id = current_setting('app.store_id', true));

CREATE POLICY product_proposals_store_insert ON "product_proposals"
    FOR INSERT TO app_user
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND status = 'pending'
        AND EXISTS (
            SELECT 1 FROM "listings" WHERE "listings"."id" = "product_proposals"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true))
        AND (draft_id IS NULL OR EXISTS (
            SELECT 1 FROM "listing_drafts" WHERE "listing_drafts"."id" = "product_proposals"."draft_id"
                AND "listing_drafts"."store_id" = current_setting('app.store_id', true)))
    );

CREATE POLICY product_proposals_platform_admin ON "product_proposals"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "product_proposals" TO app_user;
