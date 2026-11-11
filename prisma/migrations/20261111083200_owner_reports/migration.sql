-- Store copilot owner reports (#21): a voice transcript or a photo, Claude's extracted items,
-- and one row per item, matched to a listing or kept as unmatched.
CREATE TABLE "owner_reports" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "raw_transcript" TEXT,
    "image_key" TEXT,
    "ai_extraction" JSONB NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "owner_reports_type_check" CHECK (
        (type = 'voice' AND raw_transcript IS NOT NULL AND image_key IS NULL)
        OR (type IN ('invoice_photo', 'shelf_photo') AND image_key IS NOT NULL AND raw_transcript IS NULL)
    ),
    CONSTRAINT "owner_reports_status_check" CHECK (
        (status = 'pending' AND decided_by_id IS NULL AND decided_at IS NULL)
        OR (status IN ('confirmed', 'rejected', 'partial') AND decided_by_id IS NOT NULL AND decided_at IS NOT NULL)
    )
);

CREATE TABLE "owner_report_items" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "extracted_name" TEXT NOT NULL,
    "extracted_qty" INTEGER,
    "unit" TEXT,
    "listing_id" TEXT,
    "match_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kind" TEXT,
    "proposed_delta" INTEGER,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_report_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "owner_report_items_match_check" CHECK (
        (status = 'unmatched' AND listing_id IS NULL AND kind IS NULL AND proposed_delta IS NULL)
        OR (status IN ('pending', 'confirmed', 'rejected') AND listing_id IS NOT NULL
            AND kind IN ('restock', 'set_status') AND proposed_delta BETWEEN 1 AND 100000)
    )
);

CREATE INDEX "owner_reports_store_id_idx" ON "owner_reports"("store_id");
CREATE INDEX "owner_reports_store_id_status_created_at_idx" ON "owner_reports"("store_id", "status", "created_at");
CREATE INDEX "owner_reports_actor_id_idx" ON "owner_reports"("actor_id");
CREATE INDEX "owner_reports_decided_by_id_idx" ON "owner_reports"("decided_by_id");
CREATE INDEX "owner_report_items_store_id_idx" ON "owner_report_items"("store_id");
CREATE INDEX "owner_report_items_report_id_idx" ON "owner_report_items"("report_id");
CREATE INDEX "owner_report_items_listing_id_idx" ON "owner_report_items"("listing_id");

ALTER TABLE "owner_reports"
    ADD CONSTRAINT "owner_reports_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_reports"
    ADD CONSTRAINT "owner_reports_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_reports"
    ADD CONSTRAINT "owner_reports_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_report_items"
    ADD CONSTRAINT "owner_report_items_report_id_fkey"
    FOREIGN KEY ("report_id") REFERENCES "owner_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_report_items"
    ADD CONSTRAINT "owner_report_items_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_report_items"
    ADD CONSTRAINT "owner_report_items_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "owner_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_reports" FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_reports_isolation ON "owner_reports"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY owner_reports_platform_admin ON "owner_reports"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "owner_reports" TO app_user;

ALTER TABLE "owner_report_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_report_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_report_items_isolation ON "owner_report_items"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "owner_reports"
            WHERE "owner_reports"."id" = "owner_report_items"."report_id"
                AND "owner_reports"."store_id" = current_setting('app.store_id', true)
        )
        AND (
            listing_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "listings"
                WHERE "listings"."id" = "owner_report_items"."listing_id"
                    AND "listings"."store_id" = current_setting('app.store_id', true)
            )
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "owner_reports"
            WHERE "owner_reports"."id" = "owner_report_items"."report_id"
                AND "owner_reports"."store_id" = current_setting('app.store_id', true)
        )
        AND (
            listing_id IS NULL
            OR EXISTS (
                SELECT 1 FROM "listings"
                WHERE "listings"."id" = "owner_report_items"."listing_id"
                    AND "listings"."store_id" = current_setting('app.store_id', true)
            )
        )
    );

CREATE POLICY owner_report_items_platform_admin ON "owner_report_items"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "owner_report_items" TO app_user;
