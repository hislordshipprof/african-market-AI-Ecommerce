-- #526: why the last DoorDash Drive registration failed; set means the store needs a retry.
ALTER TABLE "stores" ADD COLUMN "doordash_registration_error" TEXT;
