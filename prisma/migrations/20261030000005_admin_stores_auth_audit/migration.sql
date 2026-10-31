-- Add new settings columns to stores
ALTER TABLE "stores" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "stores" ADD COLUMN "hours" JSONB;
ALTER TABLE "stores" ADD COLUMN "prep_time_minutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "stores" ADD COLUMN "delivery_radius_mi" DECIMAL NOT NULL DEFAULT 8;
ALTER TABLE "stores" ADD COLUMN "minimum_order_cents" INTEGER NOT NULL DEFAULT 3500;
ALTER TABLE "stores" ADD COLUMN "pickup_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN "auto_refund_limit_cents" INTEGER NOT NULL DEFAULT 2500;

-- Platform admin write policy: allows platform admins to INSERT/UPDATE/DELETE stores
-- without setting app.store_id. The admin code path sets app.is_platform_admin = 'true'.
CREATE POLICY stores_platform_admin ON "stores"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Better Auth tables (no RLS — platform-wide, accessed directly by app_runtime)
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'customer',
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "two_factors" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    CONSTRAINT "two_factors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "two_factors_user_id_idx" ON "two_factors"("user_id");
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- Audit log table (RLS: platform admin only)
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_store_id_idx" ON "audit_logs"("store_id");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id");

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_platform_admin ON "audit_logs"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Grant app_user access to new tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounts" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "verifications" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factors" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_logs" TO app_user;
