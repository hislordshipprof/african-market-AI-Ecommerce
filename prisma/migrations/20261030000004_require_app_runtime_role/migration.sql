-- Require the app_runtime login role and ensure grants.
-- The role is created outside migrations (ADR-0014); CI creates it
-- before running migrate. This migration fails loudly if it is missing
-- so a deploy never silently falls back to the owner connection.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION
      'Role app_runtime does not exist. '
      'Create it before running migrations (see ADR-0014).';
  END IF;
  GRANT app_user TO app_runtime;
  GRANT USAGE ON SCHEMA public TO app_runtime;
END $$;
