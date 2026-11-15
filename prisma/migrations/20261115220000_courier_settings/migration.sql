-- #535: courier settings a platform admin edits. The column defaults fill the existing settings row
-- without an UPDATE, so no row-level-security backfill is needed. The checks refuse out-of-range values.
ALTER TABLE "platform_settings"
    ADD COLUMN "courier_selection_mode" TEXT NOT NULL DEFAULT 'cheapest',
    ADD COLUMN "courier_assignment_timeout_s" INTEGER NOT NULL DEFAULT 600,
    ADD COLUMN "doordash_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "uber_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD CONSTRAINT "platform_settings_courier_selection_mode_check"
        CHECK ("courier_selection_mode" IN ('cheapest', 'doordash_first', 'uber_first')),
    ADD CONSTRAINT "platform_settings_courier_assignment_timeout_check"
        CHECK ("courier_assignment_timeout_s" BETWEEN 300 AND 1200);
