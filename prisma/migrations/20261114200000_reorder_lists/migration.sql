-- Store copilot reorder suggestions (#551): lead time and cover per store, and the owner's saved reorder list.
ALTER TABLE "stores" ADD COLUMN "reorder_lead_days" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "stores" ADD COLUMN "reorder_cover_days" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "stores" ADD CONSTRAINT "stores_reorder_days_check" CHECK (
    reorder_lead_days BETWEEN 0 AND 90 AND reorder_cover_days BETWEEN 1 AND 90
);

CREATE TABLE "reorder_lists" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "saved_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reorder_lists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reorder_list_items" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER,
    "position" INTEGER NOT NULL,

    CONSTRAINT "reorder_list_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reorder_list_items_quantity_check" CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 100000)
);

CREATE UNIQUE INDEX "reorder_lists_store_id_key" ON "reorder_lists"("store_id");
CREATE INDEX "reorder_lists_saved_by_id_idx" ON "reorder_lists"("saved_by_id");
CREATE UNIQUE INDEX "reorder_list_items_list_id_listing_id_key" ON "reorder_list_items"("list_id", "listing_id");
CREATE INDEX "reorder_list_items_store_id_idx" ON "reorder_list_items"("store_id");
CREATE INDEX "reorder_list_items_listing_id_idx" ON "reorder_list_items"("listing_id");

ALTER TABLE "reorder_lists"
    ADD CONSTRAINT "reorder_lists_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reorder_lists"
    ADD CONSTRAINT "reorder_lists_saved_by_id_fkey"
    FOREIGN KEY ("saved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reorder_list_items"
    ADD CONSTRAINT "reorder_list_items_list_id_fkey"
    FOREIGN KEY ("list_id") REFERENCES "reorder_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reorder_list_items"
    ADD CONSTRAINT "reorder_list_items_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reorder_list_items"
    ADD CONSTRAINT "reorder_list_items_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reorder_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reorder_lists" FORCE ROW LEVEL SECURITY;

CREATE POLICY reorder_lists_isolation ON "reorder_lists"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY reorder_lists_platform_admin ON "reorder_lists"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "reorder_lists" TO app_user;

ALTER TABLE "reorder_list_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reorder_list_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY reorder_list_items_isolation ON "reorder_list_items"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "reorder_lists"
            WHERE "reorder_lists"."id" = "reorder_list_items"."list_id"
                AND "reorder_lists"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "reorder_list_items"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "reorder_lists"
            WHERE "reorder_lists"."id" = "reorder_list_items"."list_id"
                AND "reorder_lists"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "reorder_list_items"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY reorder_list_items_platform_admin ON "reorder_list_items"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "reorder_list_items" TO app_user;
