-- Dedupe existing rows: keep the one with the highest count per key
DELETE FROM "rate_limits" a
USING "rate_limits" b
WHERE a."id" < b."id" AND a."key" = b."key";

-- Drop the non-unique index
DROP INDEX IF EXISTS "rate_limits_key_idx";

-- Add unique constraint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_key_key" UNIQUE ("key");
