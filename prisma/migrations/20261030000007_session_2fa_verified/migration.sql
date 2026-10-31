-- Per-session 2FA verification flag: tracks whether THIS session completed
-- a second factor, not just whether the account has 2FA enabled.
ALTER TABLE "sessions" ADD COLUMN "two_factor_verified" BOOLEAN NOT NULL DEFAULT false;
