-- Uber Direct (#139): the store's Uber Direct organization, a retry flag when registering it failed, and Uber bookings.
ALTER TABLE "stores" ADD COLUMN "uber_location_id" TEXT;
ALTER TABLE "stores" ADD COLUMN "uber_registration_error" TEXT;
CREATE UNIQUE INDEX "stores_uber_location_id_key" ON "stores"("uber_location_id");

ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_provider_check";
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_provider_check" CHECK ("provider" IN ('doordash', 'uber'));
