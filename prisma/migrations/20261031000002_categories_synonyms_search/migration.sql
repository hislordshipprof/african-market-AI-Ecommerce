-- Enable pg_trgm extension for fuzzy/typo-tolerant search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Category: shared platform table (no store_id)
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- ProductSynonym: maps local food names to master products (shared, no store_id)
CREATE TABLE "product_synonyms" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "language" TEXT,
    "region" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_synonyms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_synonyms_product_id_idx" ON "product_synonyms"("product_id");
CREATE INDEX "product_synonyms_term_idx" ON "product_synonyms"("term");

-- GIN index for trigram similarity search on synonym terms
CREATE INDEX "product_synonyms_term_trgm_idx" ON "product_synonyms" USING gin ("term" gin_trgm_ops);

ALTER TABLE "product_synonyms"
    ADD CONSTRAINT "product_synonyms_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add category_id to master_products
ALTER TABLE "master_products" ADD COLUMN "category_id" TEXT;
CREATE INDEX "master_products_category_id_idx" ON "master_products"("category_id");

ALTER TABLE "master_products"
    ADD CONSTRAINT "master_products_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Full-text search index on master_products.name
ALTER TABLE "master_products" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce("name", ''))) STORED;
CREATE INDEX "master_products_search_idx" ON "master_products" USING gin ("search_vector");

-- Trigram index on master_products.name for fuzzy matching
CREATE INDEX "master_products_name_trgm_idx" ON "master_products" USING gin ("name" gin_trgm_ops);

-- Full-text search index on listings.custom_name
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce("custom_name", ''))) STORED;
CREATE INDEX "listings_search_idx" ON "listings" USING gin ("search_vector");

-- RLS: categories — any authenticated user can read; only platform admin can write
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;

CREATE POLICY categories_read ON "categories"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY categories_platform_admin ON "categories"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: product_synonyms — same as master_products (read for all, write for platform admin)
ALTER TABLE "product_synonyms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_synonyms" FORCE ROW LEVEL SECURITY;

CREATE POLICY product_synonyms_read ON "product_synonyms"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY product_synonyms_platform_admin ON "product_synonyms"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Grant app_user access to new tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "categories" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_synonyms" TO app_user;

-- Seed the 10 categories from spec 5.1
INSERT INTO "categories" ("id", "name", "slug", "sort_order", "created_at", "updated_at") VALUES
  ('cat_tubers',        'Tubers',           'tubers',           1,  NOW(), NOW()),
  ('cat_grains',        'Grains & Flours',  'grains-and-flours', 2, NOW(), NOW()),
  ('cat_spices',        'Spices',           'spices',           3,  NOW(), NOW()),
  ('cat_oils',          'Oils',             'oils',             4,  NOW(), NOW()),
  ('cat_vegetables',    'Vegetables',       'vegetables',       5,  NOW(), NOW()),
  ('cat_fish_meat',     'Fish & Meat',      'fish-and-meat',    6,  NOW(), NOW()),
  ('cat_frozen',        'Frozen',           'frozen',           7,  NOW(), NOW()),
  ('cat_snacks',        'Snacks',           'snacks',           8,  NOW(), NOW()),
  ('cat_drinks',        'Drinks',           'drinks',           9,  NOW(), NOW()),
  ('cat_beauty',        'Beauty',           'beauty',           10, NOW(), NOW());
