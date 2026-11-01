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

-- 6 new categories (sort_order 12-17, after existing beauty at 10 and pantry at 11)
INSERT INTO "categories" ("id", "name", "slug", "sort_order", "created_at", "updated_at") VALUES
  ('cat_beans_legumes',       'Beans & Legumes',        'beans-and-legumes',       12, NOW(), NOW()),
  ('cat_breakfast_dairy',     'Breakfast & Dairy',       'breakfast-and-dairy',     13, NOW(), NOW()),
  ('cat_canned_packaged',     'Canned & Packaged',      'canned-and-packaged',     14, NOW(), NOW()),
  ('cat_fruits',              'Fruits',                  'fruits',                  15, NOW(), NOW()),
  ('cat_household',           'Household',               'household',               16, NOW(), NOW()),
  ('cat_seasonings_sauces',   'Seasonings & Sauces',     'seasonings-and-sauces',   17, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
