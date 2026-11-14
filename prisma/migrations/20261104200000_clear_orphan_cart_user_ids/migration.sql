-- Clear orphan carts.user_id values that 20261104180000 left behind.
--
-- FORCE ROW LEVEL SECURITY applies to the table owner unless that role is a
-- superuser or has BYPASSRLS (Neon console roles such as neondb_owner). On
-- lanes and hosted CI the migrating role is app_owner, which is neither, so a
-- plain UPDATE matches zero carts. Visibility comes from the carts_platform_admin
-- policy, and only because this role already inherits app_user privileges.
-- Setting app.is_platform_admin does not grant those privileges by itself.
--
-- One DO block keeps set_config(..., true) local whether or not Prisma wraps
-- the file in a transaction. Only carts.user_id changes. No cart is deleted.
--
-- The account check is a correlated scalar subquery, not NOT EXISTS. PostgreSQL
-- plans NOT EXISTS as a hash anti-join, and that plan does not recheck a row
-- after waiting on a concurrent update. A repair that commits a real Account
-- id while this statement waits would be cleared. The scalar subquery is
-- rechecked after the wait.

DO $$
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  UPDATE "carts"
  SET "user_id" = NULL
  WHERE "user_id" IS NOT NULL
    AND (
      SELECT "users"."id" FROM "users" WHERE "users"."id" = "carts"."user_id"
    ) IS NULL;
  PERFORM set_config('app.is_platform_admin', '', true);
END $$;
