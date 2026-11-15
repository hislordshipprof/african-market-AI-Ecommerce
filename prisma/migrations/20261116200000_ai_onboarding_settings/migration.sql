-- #561: AI and onboarding settings a platform admin edits. The column defaults fill the existing settings row
-- without an UPDATE, so no row-level-security backfill is needed. The checks refuse out-of-range values.
ALTER TABLE "platform_settings"
    ADD COLUMN "go_live_listing_floor" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "ai_daily_sample_per_store" INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN "ai_turn_cost_flag_cents" INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN "rejected_application_retention_months" INTEGER NOT NULL DEFAULT 12,
    ADD CONSTRAINT "platform_settings_go_live_listing_floor_check"
        CHECK ("go_live_listing_floor" BETWEEN 1 AND 200),
    ADD CONSTRAINT "platform_settings_ai_daily_sample_per_store_check"
        CHECK ("ai_daily_sample_per_store" BETWEEN 0 AND 20),
    ADD CONSTRAINT "platform_settings_ai_turn_cost_flag_cents_check"
        CHECK ("ai_turn_cost_flag_cents" BETWEEN 1 AND 100),
    ADD CONSTRAINT "platform_settings_rejected_application_retention_months_check"
        CHECK ("rejected_application_retention_months" BETWEEN 1 AND 24);
