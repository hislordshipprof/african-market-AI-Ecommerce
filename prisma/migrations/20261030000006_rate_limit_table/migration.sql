-- Rate limit table for Better Auth database-backed rate limiting (ADR-0015/0017)
CREATE TABLE "rate_limits" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,
    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rate_limits_key_idx" ON "rate_limits"("key");

-- Grant app_user access
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limits" TO app_user;
