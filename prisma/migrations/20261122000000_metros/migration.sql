-- Second metro readiness (#577). A metro is an ops grouping of stores that customers never see. A platform admin
-- sets it on a store; its courier overrides layer on the platform courier settings (#535) for its stores.
CREATE TABLE "metros" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "states" TEXT[] NOT NULL,
    "center_lat" DOUBLE PRECISION NOT NULL,
    "center_lng" DOUBLE PRECISION NOT NULL,
    "radius_mi" INTEGER NOT NULL,
    -- Null follows the platform setting.
    "courier_selection_mode" TEXT,
    "courier_assignment_timeout_s" INTEGER,
    -- Off here wins; on follows the platform switch, so the platform switch stays the kill switch.
    "doordash_enabled" BOOLEAN NOT NULL DEFAULT true,
    "uber_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metros_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "metros_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
    CONSTRAINT "metros_states_check" CHECK (
        cardinality("states") BETWEEN 1 AND 10
        AND "states" <@ ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
                              'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
                              'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']::TEXT[]
    ),
    CONSTRAINT "metros_center_check" CHECK ("center_lat" BETWEEN -90 AND 90 AND "center_lng" BETWEEN -180 AND 180),
    CONSTRAINT "metros_radius_check" CHECK ("radius_mi" BETWEEN 1 AND 250),
    CONSTRAINT "metros_courier_selection_mode_check"
        CHECK ("courier_selection_mode" IS NULL OR "courier_selection_mode" IN ('cheapest', 'doordash_first', 'uber_first')),
    CONSTRAINT "metros_courier_assignment_timeout_check"
        CHECK ("courier_assignment_timeout_s" IS NULL OR "courier_assignment_timeout_s" BETWEEN 300 AND 1200)
);

CREATE UNIQUE INDEX "metros_name_key" ON "metros"("name");

-- Dispatch and checkout read the overrides as plain app_user, like platform_settings; only platform admins write.
ALTER TABLE "metros" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metros" FORCE ROW LEVEL SECURITY;

CREATE POLICY metros_read ON "metros"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY metros_platform_admin ON "metros"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "metros" TO app_user;

-- A metro with stores cannot be deleted.
ALTER TABLE "stores" ADD COLUMN "metro_id" TEXT;
ALTER TABLE "stores"
    ADD CONSTRAINT "stores_metro_id_fkey"
    FOREIGN KEY ("metro_id") REFERENCES "metros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stores_metro_id_idx" ON "stores"("metro_id");

-- Quote outcomes per store, courier and UTC day, for the readiness report's quote success rate. Store-owned.
CREATE TABLE "courier_quote_days" (
    "store_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "courier_quote_days_pkey" PRIMARY KEY ("store_id", "provider", "day"),
    CONSTRAINT "courier_quote_days_provider_check" CHECK ("provider" IN ('doordash', 'uber')),
    CONSTRAINT "courier_quote_days_counts_check" CHECK ("attempts" >= 0 AND "successes" BETWEEN 0 AND "attempts")
);

ALTER TABLE "courier_quote_days"
    ADD CONSTRAINT "courier_quote_days_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "courier_quote_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courier_quote_days" FORCE ROW LEVEL SECURITY;

CREATE POLICY courier_quote_days_isolation ON "courier_quote_days"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY courier_quote_days_platform_admin_select ON "courier_quote_days"
    FOR SELECT TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON "courier_quote_days" TO app_user;
REVOKE DELETE ON "courier_quote_days" FROM app_user;

-- States the tax advisor has signed off (ADR-0008). Shown on the readiness report; gates nothing yet. Added as a
-- platform data change after the sign-off, like shipping_states (ADR-0023).
ALTER TABLE "platform_settings"
    ADD COLUMN "tax_signed_off_states" TEXT[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT "platform_settings_tax_signed_off_states_check" CHECK (
        "tax_signed_off_states" <@ ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
                                         'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
                                         'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']::TEXT[]
    );
