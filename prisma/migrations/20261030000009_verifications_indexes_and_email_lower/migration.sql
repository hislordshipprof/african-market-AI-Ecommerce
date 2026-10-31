-- Indexes on verifications for Better Auth lookup and cleanup queries
CREATE INDEX "verifications_identifier_idx" ON "verifications" ("identifier");
CREATE INDEX "verifications_expires_at_idx" ON "verifications" ("expires_at");

-- Normalize existing emails to lowercase and add case-insensitive unique index
UPDATE "users" SET "email" = LOWER(TRIM("email")) WHERE "email" <> LOWER(TRIM("email"));
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" (LOWER("email"));
