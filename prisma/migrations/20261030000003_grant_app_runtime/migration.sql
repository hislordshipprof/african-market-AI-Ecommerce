-- Grant app_user membership and schema usage to the app_runtime login role.
-- app_runtime connects at runtime; it accesses tables only through app_user
-- membership and SET LOCAL ROLE app_user. The role itself is created externally
-- (not by migrations) to avoid storing passwords in migration files.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT app_user TO app_runtime;
    GRANT USAGE ON SCHEMA public TO app_runtime;
  END IF;
END $$;
