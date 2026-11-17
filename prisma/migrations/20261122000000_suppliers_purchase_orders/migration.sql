-- Wholesaler reorder (a) (#575): suppliers, the listings each supplies, and purchase orders drafted from the reorder list.
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "channel" TEXT NOT NULL,
    "lead_days" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_channel_check" CHECK (
        (channel = 'email' AND email IS NOT NULL) OR (channel IN ('whatsapp', 'sms') AND phone IS NOT NULL)
    ),
    CONSTRAINT "suppliers_lead_days_check" CHECK (lead_days BETWEEN 0 AND 90)
);

CREATE TABLE "supplier_listings" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,

    CONSTRAINT "supplier_listings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sent_via" TEXT,
    "sent_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_orders_number_check" CHECK (number > 0),
    CONSTRAINT "purchase_orders_status_check" CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
    CONSTRAINT "purchase_orders_sent_check" CHECK (
        (sent_via IS NULL) = (sent_at IS NULL)
        AND (sent_via IS NULL OR sent_via IN ('email', 'whatsapp', 'sms'))
        AND (status NOT IN ('sent', 'received') OR sent_at IS NOT NULL)
        AND (status <> 'received' OR received_at IS NOT NULL)
        AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    )
);

CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER,
    "position" INTEGER NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_order_lines_quantity_check" CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 100000)
);

CREATE INDEX "suppliers_store_id_idx" ON "suppliers"("store_id");
CREATE UNIQUE INDEX "supplier_listings_listing_id_key" ON "supplier_listings"("listing_id");
CREATE INDEX "supplier_listings_supplier_id_idx" ON "supplier_listings"("supplier_id");
CREATE INDEX "supplier_listings_store_id_idx" ON "supplier_listings"("store_id");
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");
CREATE INDEX "purchase_orders_created_by_id_idx" ON "purchase_orders"("created_by_id");
CREATE UNIQUE INDEX "purchase_orders_store_id_number_key" ON "purchase_orders"("store_id", "number");
CREATE INDEX "purchase_order_lines_store_id_idx" ON "purchase_order_lines"("store_id");
CREATE INDEX "purchase_order_lines_listing_id_idx" ON "purchase_order_lines"("listing_id");
CREATE UNIQUE INDEX "purchase_order_lines_order_id_listing_id_key" ON "purchase_order_lines"("order_id", "listing_id");

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_listings" ADD CONSTRAINT "supplier_listings_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_listings" ADD CONSTRAINT "supplier_listings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_listings" ADD CONSTRAINT "supplier_listings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;

CREATE POLICY suppliers_isolation ON "suppliers"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
    );

CREATE POLICY suppliers_platform_admin ON "suppliers"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "suppliers" TO app_user;

ALTER TABLE "supplier_listings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_listings" FORCE ROW LEVEL SECURITY;

CREATE POLICY supplier_listings_isolation ON "supplier_listings"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "suppliers"
            WHERE "suppliers"."id" = "supplier_listings"."supplier_id"
                AND "suppliers"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "supplier_listings"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "suppliers"
            WHERE "suppliers"."id" = "supplier_listings"."supplier_id"
                AND "suppliers"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "supplier_listings"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY supplier_listings_platform_admin ON "supplier_listings"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_listings" TO app_user;

ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_isolation ON "purchase_orders"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "suppliers"
            WHERE "suppliers"."id" = "purchase_orders"."supplier_id"
                AND "suppliers"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "suppliers"
            WHERE "suppliers"."id" = "purchase_orders"."supplier_id"
                AND "suppliers"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY purchase_orders_platform_admin ON "purchase_orders"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_orders" TO app_user;

ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_lines" FORCE ROW LEVEL SECURITY;

CREATE POLICY purchase_order_lines_isolation ON "purchase_order_lines"
    FOR ALL TO app_user
    USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "purchase_orders"
            WHERE "purchase_orders"."id" = "purchase_order_lines"."order_id"
                AND "purchase_orders"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "purchase_order_lines"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    )
    WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
            SELECT 1 FROM "purchase_orders"
            WHERE "purchase_orders"."id" = "purchase_order_lines"."order_id"
                AND "purchase_orders"."store_id" = current_setting('app.store_id', true)
        )
        AND EXISTS (
            SELECT 1 FROM "listings"
            WHERE "listings"."id" = "purchase_order_lines"."listing_id"
                AND "listings"."store_id" = current_setting('app.store_id', true)
        )
    );

CREATE POLICY purchase_order_lines_platform_admin ON "purchase_order_lines"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_order_lines" TO app_user;
