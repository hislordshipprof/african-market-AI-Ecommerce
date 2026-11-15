-- Redo the category tax code backfill from 20261118120000_sales_tax (#65).
--
-- FORCE ROW LEVEL SECURITY applies to the table owner unless that role is a
-- superuser or has BYPASSRLS (Neon console roles such as neondb_owner). On
-- lanes and hosted CI the migrating role is app_owner, which is neither, so the
-- plain UPDATEs in that migration matched zero categories. Visibility comes from
-- the categories_platform_admin policy, and only because this role already
-- inherits app_user privileges. Setting app.is_platform_admin does not grant them.
--
-- One DO block keeps set_config(..., true) local whether or not Prisma wraps the
-- file in a transaction. Set-once: a code an admin set since is kept. 'tubers',
-- 'spices' and 'oils' are the slugs 20261031000002 created; only seed.ts renames them.
-- Codes from https://docs.stripe.com/tax/tax-codes (checked against GET /v1/tax_codes).

DO $$
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);

  UPDATE "categories" SET "tax_code" = 'txcd_40040000' WHERE "tax_code" IS NULL AND "slug" IN (
    'tubers', 'tubers-and-roots', 'grains-and-flours', 'spices', 'spices-and-seasonings', 'oils', 'oils-and-butters',
    'vegetables', 'fish-and-meat', 'frozen', 'pantry-staples', 'beans-and-legumes', 'breakfast-and-dairy',
    'canned-and-packaged', 'fruits', 'seasonings-and-sauces'
  );
  UPDATE "categories" SET "tax_code" = 'txcd_40070005' WHERE "tax_code" IS NULL AND "slug" = 'snacks';
  UPDATE "categories" SET "tax_code" = 'txcd_41040008' WHERE "tax_code" IS NULL AND "slug" = 'drinks';
  UPDATE "categories" SET "tax_code" = 'txcd_32050025' WHERE "tax_code" IS NULL AND "slug" = 'beauty';
  UPDATE "categories" SET "tax_code" = 'txcd_99999999' WHERE "tax_code" IS NULL AND "slug" = 'household';

  PERFORM set_config('app.is_platform_admin', '', true);
END $$;
