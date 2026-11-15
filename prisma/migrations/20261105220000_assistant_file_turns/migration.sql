-- Hourly shopper-assistant file turns. Not store-owned (same pattern as rate_limits).
CREATE TABLE "assistant_file_turns" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at_ms" BIGINT NOT NULL,
    CONSTRAINT "assistant_file_turns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_file_turns_key_at_ms_idx" ON "assistant_file_turns"("key", "at_ms");

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_file_turns" TO app_user;
