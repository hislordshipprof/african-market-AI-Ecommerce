-- Placeholder weight (#216). A non-volatile DEFAULT false is stored in table
-- metadata, so existing rows read false without a table rewrite. The migrating
-- role (DIRECT_URL, table owner) applies this; app_user under forced RLS cannot
-- backfill listing_variants. No applied migration is edited.

ALTER TABLE "listing_variants" ADD COLUMN "weight_placeholder" BOOLEAN NOT NULL DEFAULT false;
