-- Add catalog fields to master_products for the full product data model (issue #62).
-- All new columns are nullable or have defaults, so existing rows are safe.

ALTER TABLE "master_products" ADD COLUMN "description" TEXT;
ALTER TABLE "master_products" ADD COLUMN "image_url" TEXT;
ALTER TABLE "master_products" ADD COLUMN "image_author" TEXT;
ALTER TABLE "master_products" ADD COLUMN "image_license" TEXT;
ALTER TABLE "master_products" ADD COLUMN "unit" TEXT;
ALTER TABLE "master_products" ADD COLUMN "weight_g" INTEGER;
ALTER TABLE "master_products" ADD COLUMN "frozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "master_products" ADD COLUMN "perishable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "master_products" ADD COLUMN "storage" TEXT;
ALTER TABLE "master_products" ADD COLUMN "subcategory" TEXT;
ALTER TABLE "master_products" ADD COLUMN "origin_countries" TEXT;
ALTER TABLE "master_products" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "master_products" ADD COLUMN "confidence" TEXT;

-- Index on status for the review queue query
CREATE INDEX "master_products_status_idx" ON "master_products"("status");

-- 6 new categories (beans-and-legumes, breakfast-and-dairy, canned-and-packaged,
-- fruits, household, seasonings-and-sauces) are seeded by seedCategoryMetadata()
-- in prisma/seed.ts with RLS-safe platform-admin context, not here, because
-- categories has FORCE ROW LEVEL SECURITY and the migration role lacks a policy.
