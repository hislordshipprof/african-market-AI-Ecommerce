-- Recipe base (#25). Platform-shared like master_products: no store_id and no RLS.
-- A looked-up dish keeps only ingredient names and a source link.

CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cuisine" TEXT,
    "servings" INTEGER,
    "source_url" TEXT,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "master_product_id" TEXT,
    "qty" DECIMAL(10,3),
    "unit" TEXT,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recipes_key_key" ON "recipes"("key");
CREATE INDEX "recipe_ingredients_master_product_id_idx" ON "recipe_ingredients"("master_product_id");
CREATE UNIQUE INDEX "recipe_ingredients_recipe_id_position_key" ON "recipe_ingredients"("recipe_id", "position");

ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "recipes" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "recipe_ingredients" TO app_user;
