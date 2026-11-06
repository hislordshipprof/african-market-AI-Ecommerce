-- Platform rate-limit counters. Not store-owned (no store_id, no RLS).
-- Grants match rate_limits. Better Auth never reads or deletes this table.
CREATE TABLE "app_rate_limits" (
    "key" TEXT NOT NULL,
    "window_start" BIGINT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "app_rate_limits_pkey" PRIMARY KEY ("key")
);

GRANT SELECT, INSERT, UPDATE, DELETE ON "app_rate_limits" TO app_user;
