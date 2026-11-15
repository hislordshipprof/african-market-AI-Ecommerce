-- Master catalog duplicates (#542): a merged product points at the one that took its place,
-- and proposed pairs wait for a platform admin's merge or "not a duplicate".
ALTER TABLE "master_products" ADD COLUMN "merged_into_id" TEXT;
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_merged_into_id_fkey"
    FOREIGN KEY ("merged_into_id") REFERENCES "master_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_merged_check"
    CHECK (("status" = 'merged') = ("merged_into_id" IS NOT NULL) AND "merged_into_id" IS DISTINCT FROM "id");
CREATE INDEX "master_products_merged_into_id_idx" ON "master_products"("merged_into_id");

CREATE TABLE "catalog_duplicate_pairs" (
    "id" TEXT NOT NULL,
    "product_a_id" TEXT NOT NULL,
    "product_b_id" TEXT NOT NULL,
    "name_similarity" REAL NOT NULL,
    "shared_terms" INTEGER NOT NULL,
    "score" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "verdict" TEXT,
    "verdict_reason" TEXT,
    "judged_at" TIMESTAMPTZ(6),
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_duplicate_pairs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_duplicate_pairs_order_check" CHECK ("product_a_id" < "product_b_id"),
    CONSTRAINT "catalog_duplicate_pairs_status_check" CHECK ("status" IN ('open', 'dismissed', 'merged')),
    CONSTRAINT "catalog_duplicate_pairs_verdict_check" CHECK ("verdict" IN ('same', 'different', 'unsure'))
);

CREATE UNIQUE INDEX "catalog_duplicate_pairs_product_a_id_product_b_id_key" ON "catalog_duplicate_pairs"("product_a_id", "product_b_id");
CREATE INDEX "catalog_duplicate_pairs_product_b_id_idx" ON "catalog_duplicate_pairs"("product_b_id");
CREATE INDEX "catalog_duplicate_pairs_status_score_idx" ON "catalog_duplicate_pairs"("status", "score");

ALTER TABLE "catalog_duplicate_pairs" ADD CONSTRAINT "catalog_duplicate_pairs_product_a_id_fkey"
    FOREIGN KEY ("product_a_id") REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_duplicate_pairs" ADD CONSTRAINT "catalog_duplicate_pairs_product_b_id_fkey"
    FOREIGN KEY ("product_b_id") REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform admins only: no store reads or writes pairs.
ALTER TABLE "catalog_duplicate_pairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_duplicate_pairs" FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_duplicate_pairs_platform_admin ON "catalog_duplicate_pairs"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog_duplicate_pairs" TO app_user;
