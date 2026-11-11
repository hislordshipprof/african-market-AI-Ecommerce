-- Store copilot alerts and confirm-requests (#430).
-- No foreign key to listings or orders: those checks bypass row security and
-- would reveal whether another store's id exists. The policy checks them instead.

CREATE TABLE "copilot_alerts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "order_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "dedupe_key" TEXT NOT NULL,
    "pushed_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "copilot_alerts_store_id_dedupe_key_key" ON "copilot_alerts"("store_id", "dedupe_key");
CREATE INDEX "copilot_alerts_store_id_state_pushed_at_idx" ON "copilot_alerts"("store_id", "state", "pushed_at");
CREATE INDEX "copilot_alerts_store_id_listing_id_state_idx" ON "copilot_alerts"("store_id", "listing_id", "state");
CREATE INDEX "copilot_alerts_resolved_by_id_idx" ON "copilot_alerts"("resolved_by_id");

ALTER TABLE "copilot_alerts"
    ADD CONSTRAINT "copilot_alerts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_alerts"
    ADD CONSTRAINT "copilot_alerts_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_alerts"
    ADD CONSTRAINT "copilot_alerts_kind_check" CHECK (
        kind IN ('sold_out', 'running_low', 'order_needs_low_stock', 'confirm_request')
        AND (kind <> 'order_needs_low_stock' OR order_id IS NOT NULL)
    );

ALTER TABLE "copilot_alerts"
    ADD CONSTRAINT "copilot_alerts_state_check" CHECK (
        (state = 'open' AND resolved_by_id IS NULL AND resolved_at IS NULL)
        OR (state IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL)
    );

ALTER TABLE "copilot_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_alerts" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_alerts_isolation ON "copilot_alerts"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "copilot_alerts"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
        AND (
            order_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "orders"
                WHERE "orders"."id" = "copilot_alerts"."order_id"
                    AND "orders"."store_id" = current_setting('app.store_id', true)
            )
        )
    );

CREATE POLICY copilot_alerts_platform_admin ON "copilot_alerts"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_alerts" TO app_user;
