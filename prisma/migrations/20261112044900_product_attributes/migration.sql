-- #484: ingredients, allergens and dietary claims as structured product data.
-- Each attribute group (ingredients, allergens, dietary) carries a status:
-- unknown (no data, never safe), known (stated by a store owner), reviewed
-- (approved by a platform admin). Master-catalog tables follow master_products:
-- everyone reads, only the platform admin writes. Store corrections are
-- store-owned rows with store_id and RLS.

ALTER TABLE "master_products"
    ADD COLUMN "ingredients_status" TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN "allergens" TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "allergens_status" TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN "dietary_claims" TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "dietary_status" TEXT NOT NULL DEFAULT 'unknown',
    ADD CONSTRAINT "master_products_attribute_status_check" CHECK (
        "ingredients_status" IN ('unknown', 'known', 'reviewed')
        AND "allergens_status" IN ('unknown', 'known', 'reviewed')
        AND "dietary_status" IN ('unknown', 'known', 'reviewed')
    ),
    ADD CONSTRAINT "master_products_allergens_check" CHECK (
        "allergens" <@ ARRAY['milk', 'eggs', 'fish', 'crustacean_shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soybeans', 'sesame']::TEXT[]
    ),
    ADD CONSTRAINT "master_products_dietary_claims_check" CHECK (
        "dietary_claims" <@ ARRAY['halal', 'kosher', 'vegan', 'vegetarian', 'no_pork', 'gluten_free']::TEXT[]
    );

CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ingredients_name_key" ON "ingredients"("name");

CREATE TABLE "ingredient_synonyms" (
    "id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingredient_synonyms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingredient_synonyms_ingredient_id_fkey" FOREIGN KEY ("ingredient_id")
        REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ingredient_synonyms_term_key" ON "ingredient_synonyms"("term");
CREATE INDEX "ingredient_synonyms_ingredient_id_idx" ON "ingredient_synonyms"("ingredient_id");

CREATE TABLE "master_product_ingredients" (
    "product_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    CONSTRAINT "master_product_ingredients_pkey" PRIMARY KEY ("product_id", "ingredient_id"),
    CONSTRAINT "master_product_ingredients_product_id_fkey" FOREIGN KEY ("product_id")
        REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "master_product_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id")
        REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "master_product_ingredients_ingredient_id_idx" ON "master_product_ingredients"("ingredient_id");

-- A group the model could not read (*_read false) stays unknown when approved.
CREATE TABLE "attribute_proposals" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "ingredients_read" BOOLEAN NOT NULL,
    "ingredients" TEXT[] NOT NULL DEFAULT '{}',
    "allergens_read" BOOLEAN NOT NULL,
    "allergens" TEXT[] NOT NULL DEFAULT '{}',
    "dietary_read" BOOLEAN NOT NULL,
    "dietary_claims" TEXT[] NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    CONSTRAINT "attribute_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attribute_proposals_product_id_fkey" FOREIGN KEY ("product_id")
        REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attribute_proposals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'superseded'))
);
CREATE INDEX "attribute_proposals_status_created_at_idx" ON "attribute_proposals"("status", "created_at");
CREATE INDEX "attribute_proposals_product_id_idx" ON "attribute_proposals"("product_id");

-- A null status inherits that group from the master product.
CREATE TABLE "listing_attributes" (
    "listing_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "ingredients_status" TEXT,
    "allergens" TEXT[] NOT NULL DEFAULT '{}',
    "allergens_status" TEXT,
    "dietary_claims" TEXT[] NOT NULL DEFAULT '{}',
    "dietary_status" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "listing_attributes_pkey" PRIMARY KEY ("listing_id"),
    CONSTRAINT "listing_attributes_listing_id_fkey" FOREIGN KEY ("listing_id")
        REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "listing_attributes_store_id_fkey" FOREIGN KEY ("store_id")
        REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "listing_attributes_status_check" CHECK (
        ("ingredients_status" IS NULL OR "ingredients_status" IN ('unknown', 'known'))
        AND ("allergens_status" IS NULL OR "allergens_status" IN ('unknown', 'known'))
        AND ("dietary_status" IS NULL OR "dietary_status" IN ('unknown', 'known'))
    ),
    CONSTRAINT "listing_attributes_allergens_check" CHECK (
        "allergens" <@ ARRAY['milk', 'eggs', 'fish', 'crustacean_shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soybeans', 'sesame']::TEXT[]
    ),
    CONSTRAINT "listing_attributes_dietary_claims_check" CHECK (
        "dietary_claims" <@ ARRAY['halal', 'kosher', 'vegan', 'vegetarian', 'no_pork', 'gluten_free']::TEXT[]
    )
);
CREATE INDEX "listing_attributes_store_id_idx" ON "listing_attributes"("store_id");

CREATE TABLE "listing_ingredients" (
    "listing_id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    CONSTRAINT "listing_ingredients_pkey" PRIMARY KEY ("listing_id", "ingredient_id"),
    CONSTRAINT "listing_ingredients_listing_id_fkey" FOREIGN KEY ("listing_id")
        REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "listing_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id")
        REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "listing_ingredients_store_id_fkey" FOREIGN KEY ("store_id")
        REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "listing_ingredients_store_id_idx" ON "listing_ingredients"("store_id");
CREATE INDEX "listing_ingredients_ingredient_id_idx" ON "listing_ingredients"("ingredient_id");

-- RLS: master-catalog tables, same as master_products
ALTER TABLE "ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingredients" FORCE ROW LEVEL SECURITY;
CREATE POLICY ingredients_read ON "ingredients" FOR SELECT TO app_user USING (true);
CREATE POLICY ingredients_platform_admin ON "ingredients" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "ingredient_synonyms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingredient_synonyms" FORCE ROW LEVEL SECURITY;
CREATE POLICY ingredient_synonyms_read ON "ingredient_synonyms" FOR SELECT TO app_user USING (true);
CREATE POLICY ingredient_synonyms_platform_admin ON "ingredient_synonyms" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "master_product_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "master_product_ingredients" FORCE ROW LEVEL SECURITY;
CREATE POLICY master_product_ingredients_read ON "master_product_ingredients" FOR SELECT TO app_user USING (true);
CREATE POLICY master_product_ingredients_platform_admin ON "master_product_ingredients" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: proposals are unreviewed model output, platform admin only
ALTER TABLE "attribute_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attribute_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY attribute_proposals_platform_admin ON "attribute_proposals" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: store corrections, the row's store and its listing's store must both be app.store_id
ALTER TABLE "listing_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_attributes" FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_attributes_isolation ON "listing_attributes" FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_attributes"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true))
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_attributes"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true))
    );
CREATE POLICY listing_attributes_platform_admin ON "listing_attributes" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "listing_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_ingredients" FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_ingredients_isolation ON "listing_ingredients" FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_ingredients"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true))
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (SELECT 1 FROM "listings" WHERE "listings"."id" = "listing_ingredients"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true))
    );
CREATE POLICY listing_ingredients_platform_admin ON "listing_ingredients" FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ingredients" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ingredient_synonyms" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "master_product_ingredients" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "attribute_proposals" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "listing_attributes" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "listing_ingredients" TO app_user;
