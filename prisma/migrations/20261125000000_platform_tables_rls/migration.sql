-- Row-level security on platform tables that had none (#713, data audit L1/L2).
-- FORCE holds the owning login to the policies too; on Neon the owner has BYPASSRLS, on lanes and CI it does not,
-- so the seed and tests write these tables as the platform admin.

-- Store applications (#554): only the platform admin reads or decides them. The public /sell form may insert a new,
-- undecided application and nothing else; with no SELECT policy for it, that insert cannot return the row.
ALTER TABLE "store_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_applications" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_applications_platform_admin ON "store_applications"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY store_applications_public_insert ON "store_applications"
  FOR INSERT TO app_user
  WITH CHECK (
    "status" = 'pending'
    AND "reject_reason" IS NULL
    AND "decided_at" IS NULL
    AND "decided_by_email" IS NULL
    AND "rejection_emailed_at" IS NULL
    AND "store_id" IS NULL
  );

-- Recipe base (#25): everyone reads it. The platform admin edits it; the assistant's lookup writer may only add a
-- looked-up dish (origin 'lookup') with plain ingredient names, in a transaction that sets app.recipe_writer.
ALTER TABLE "recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipes" FORCE ROW LEVEL SECURITY;

CREATE POLICY recipes_read ON "recipes"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY recipes_platform_admin ON "recipes"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY recipes_lookup_insert ON "recipes"
  FOR INSERT TO app_user
  WITH CHECK (current_setting('app.recipe_writer', true) = 'lookup' AND "origin" = 'lookup');

ALTER TABLE "recipe_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipe_ingredients" FORCE ROW LEVEL SECURITY;

CREATE POLICY recipe_ingredients_read ON "recipe_ingredients"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY recipe_ingredients_platform_admin ON "recipe_ingredients"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY recipe_ingredients_lookup_insert ON "recipe_ingredients"
  FOR INSERT TO app_user
  WITH CHECK (
    current_setting('app.recipe_writer', true) = 'lookup'
    AND "master_product_id" IS NULL
    AND EXISTS (SELECT 1 FROM "recipes" r WHERE r."id" = "recipe_ingredients"."recipe_id" AND r."origin" = 'lookup')
  );
