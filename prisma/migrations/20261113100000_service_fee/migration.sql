-- ADR-0021: the customer service fee. The column defaults fill the existing settings row
-- without an UPDATE, so no row-level-security backfill is needed.
ALTER TABLE "platform_settings"
    ADD COLUMN "service_fee_bps" INTEGER NOT NULL DEFAULT 300,
    ADD COLUMN "service_fee_min_cents" INTEGER NOT NULL DEFAULT 99,
    ADD COLUMN "service_fee_max_cents" INTEGER NOT NULL DEFAULT 299,
    ADD CONSTRAINT "platform_settings_service_fee_check"
        CHECK ("service_fee_bps" >= 0 AND "service_fee_min_cents" >= 0 AND "service_fee_max_cents" >= "service_fee_min_cents");

-- The fee charged, and the settings it was quoted with. Orders placed before the fee keep 0.
ALTER TABLE "orders"
    ADD COLUMN "service_fee_cents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "service_fee_bps" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "service_fee_min_cents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "service_fee_max_cents" INTEGER NOT NULL DEFAULT 0;
