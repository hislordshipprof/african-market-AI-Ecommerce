-- FORCE ROW LEVEL SECURITY: even the table owner cannot bypass RLS (ADR-0014).
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
ALTER TABLE "store_content" FORCE ROW LEVEL SECURITY;

-- Grant app_user to the migration/owner role so SET LOCAL ROLE app_user works.
-- Required on Neon (PG16+) where the owner role is not a superuser.
GRANT app_user TO CURRENT_USER;

-- Drop redundant index: the unique (store_id, key) index already covers store_id lookups.
DROP INDEX IF EXISTS "store_content_store_id_idx";
