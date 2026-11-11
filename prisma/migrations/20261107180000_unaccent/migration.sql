-- Accent folding for catalog search. Same guarded install as pg_trgm:
-- the migrating role on Neon or CI may not be allowed to create extensions,
-- and the extension may already be installed by the platform.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION
  WHEN insufficient_privilege THEN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
      RAISE EXCEPTION 'unaccent extension is required but the current role cannot create it and it is not pre-installed';
    END IF;
END
$$;
