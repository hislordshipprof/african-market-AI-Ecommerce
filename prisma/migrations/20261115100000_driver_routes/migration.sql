-- Own-driver route link for a slot (#566): the driver's signed link keeps only its token hash.
CREATE TABLE "driver_routes" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "driver_name" TEXT NOT NULL,
    "driver_phone" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_routes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_routes_token_hash_key" ON "driver_routes"("token_hash");
CREATE INDEX "driver_routes_store_id_slot_idx" ON "driver_routes"("store_id", "slot");
CREATE UNIQUE INDEX "driver_routes_id_store_id_key" ON "driver_routes"("id", "store_id");

ALTER TABLE "driver_routes"
    ADD CONSTRAINT "driver_routes_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders" ADD COLUMN "driver_route_id" TEXT;
CREATE INDEX "orders_store_id_driver_route_id_idx" ON "orders"("store_id", "driver_route_id");
ALTER TABLE "orders"
    ADD CONSTRAINT "orders_driver_route_id_store_id_fkey"
    FOREIGN KEY ("driver_route_id", "store_id") REFERENCES "driver_routes"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "driver_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "driver_routes" FORCE ROW LEVEL SECURITY;

CREATE POLICY driver_routes_isolation ON "driver_routes"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY driver_routes_platform_admin ON "driver_routes"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "driver_routes" TO app_user;
