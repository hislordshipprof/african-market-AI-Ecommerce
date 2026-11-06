-- Platform customer profile, address book, and saved-card consent.
-- Customer-owned. No store_id. No platform-admin policy. No backfill.

CREATE TABLE "platform_customer_profiles" (
    "user_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT,
    "stripe_customer_status" TEXT,
    "stripe_customer_idempotency_key" TEXT,
    "stripe_customer_attempted_at" TIMESTAMP(3),
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_customer_profiles_pkey" PRIMARY KEY ("user_id")
);

CREATE UNIQUE INDEX "platform_customer_profiles_stripe_customer_id_key"
    ON "platform_customer_profiles"("stripe_customer_id");

ALTER TABLE "platform_customer_profiles"
    ADD CONSTRAINT "platform_customer_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_customer_profiles"
    ADD CONSTRAINT "platform_customer_profiles_status_check"
    CHECK (
        "stripe_customer_status" IS NULL
        OR "stripe_customer_status" IN ('pending', 'ready')
    );

CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "notes" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_addresses_user_id_idx" ON "customer_addresses"("user_id");

CREATE UNIQUE INDEX "customer_addresses_one_default_idx"
    ON "customer_addresses"("user_id")
    WHERE "is_default";

ALTER TABLE "customer_addresses"
    ADD CONSTRAINT "customer_addresses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "card_save_consents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "payment_intent_id" TEXT NOT NULL,
    "payment_method_id" TEXT,
    "stripe_customer_id" TEXT,
    "terms_version" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_save_consents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "card_save_consents_user_id_idx" ON "card_save_consents"("user_id");
CREATE INDEX "card_save_consents_user_id_payment_method_id_idx"
    ON "card_save_consents"("user_id", "payment_method_id");

ALTER TABLE "card_save_consents"
    ADD CONSTRAINT "card_save_consents_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "carts" ADD COLUMN "payment_attempt_token" TEXT;
ALTER TABLE "orders" ADD COLUMN "source_cart_id" TEXT;

ALTER TABLE "platform_customer_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_customer_profiles" FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_customer_profiles_owner ON "platform_customer_profiles"
    FOR ALL TO app_user
    USING ("user_id" = current_setting('app.user_id', true))
    WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_customer_profiles" TO app_user;

ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_addresses" FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_addresses_owner ON "customer_addresses"
    FOR ALL TO app_user
    USING ("user_id" = current_setting('app.user_id', true))
    WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_addresses" TO app_user;

ALTER TABLE "card_save_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_save_consents" FORCE ROW LEVEL SECURITY;

CREATE POLICY card_save_consents_owner ON "card_save_consents"
    FOR ALL TO app_user
    USING ("user_id" = current_setting('app.user_id', true))
    WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "card_save_consents" TO app_user;
