-- Store delivery settings, the order address snapshot, the cart's confirmed
-- snapshot, and the shared geocode cache. New columns are nullable or defaulted.
-- No backfill. Existing row policies already cover the new store and order columns.

ALTER TABLE "stores" ADD COLUMN "store_delivery_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN "store_delivery_fee_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "stores" ADD COLUMN "address_line1" TEXT;
ALTER TABLE "stores" ADD COLUMN "address_line2" TEXT;
ALTER TABLE "stores" ADD COLUMN "city" TEXT;
ALTER TABLE "stores" ADD COLUMN "state" TEXT;
ALTER TABLE "stores" ADD COLUMN "zip" TEXT;
ALTER TABLE "stores" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "stores" ADD COLUMN "lng" DOUBLE PRECISION;

ALTER TABLE "carts" ADD COLUMN "delivery_line1" TEXT;
ALTER TABLE "carts" ADD COLUMN "delivery_line2" TEXT;
ALTER TABLE "carts" ADD COLUMN "delivery_city" TEXT;
ALTER TABLE "carts" ADD COLUMN "delivery_state" TEXT;
ALTER TABLE "carts" ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "carts" ADD COLUMN "delivery_lat" DOUBLE PRECISION;
ALTER TABLE "carts" ADD COLUMN "delivery_lng" DOUBLE PRECISION;
ALTER TABLE "carts" ADD COLUMN "leave_at_door" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "orders" ADD COLUMN "delivery_line1" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_line2" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_city" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_state" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_zip" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_lat" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN "delivery_lng" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN "delivery_distance_mi" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN "leave_at_door" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "address_geocodes" (
    "key" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "formatted_address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "cached_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_geocodes_pkey" PRIMARY KEY ("key")
);

GRANT SELECT, INSERT, UPDATE ON "address_geocodes" TO app_user;
