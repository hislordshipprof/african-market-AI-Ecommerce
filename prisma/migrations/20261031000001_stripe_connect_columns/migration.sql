-- Add Stripe Connect columns to stores
ALTER TABLE "stores" ADD COLUMN "stripe_account_id" TEXT;
ALTER TABLE "stores" ADD COLUMN "stripe_onboarding_status" TEXT NOT NULL DEFAULT 'not_started';

-- Index on stripe_account_id for webhook lookups (find store by connected account)
CREATE INDEX "stores_stripe_account_id_idx" ON "stores"("stripe_account_id");
