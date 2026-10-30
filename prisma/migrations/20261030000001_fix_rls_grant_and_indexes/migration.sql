-- FORCE ROW LEVEL SECURITY on store-owned tables only (not platform tables like stores).
-- This ensures even the table owner is subject to RLS policies.
ALTER TABLE "store_content" FORCE ROW LEVEL SECURITY;

-- Owner bypass policy: allows the migration/seed role to manage store_content
-- without SET ROLE. CURRENT_USER resolves to the owner at CREATE POLICY time.
CREATE POLICY store_content_owner_bypass ON "store_content"
  FOR ALL TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- Grant app_user to the migration/owner role so SET LOCAL ROLE app_user works.
-- Required on Neon (PG16+) where the owner role is not a superuser.
GRANT app_user TO CURRENT_USER;

-- Drop redundant index: the unique (store_id, key) index already covers store_id lookups.
DROP INDEX IF EXISTS "store_content_store_id_idx";
