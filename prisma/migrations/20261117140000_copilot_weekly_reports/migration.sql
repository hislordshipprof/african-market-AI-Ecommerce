-- Store copilot weekly report (#550): one row per store per ISO week, claimed before the email is sent.

CREATE TABLE "copilot_weekly_reports" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "iso_week" TEXT NOT NULL,
    "week_start" TEXT NOT NULL,
    "figures" JSONB NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_weekly_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "copilot_weekly_reports_store_id_iso_week_key" ON "copilot_weekly_reports"("store_id", "iso_week");
CREATE INDEX "copilot_weekly_reports_store_id_week_start_idx" ON "copilot_weekly_reports"("store_id", "week_start");

ALTER TABLE "copilot_weekly_reports"
    ADD CONSTRAINT "copilot_weekly_reports_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_weekly_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_weekly_reports" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_weekly_reports_isolation ON "copilot_weekly_reports"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY copilot_weekly_reports_platform_admin ON "copilot_weekly_reports"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_weekly_reports" TO app_user;
