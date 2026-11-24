-- When the owner or a platform admin saved the store's time zone (#786). Go live needs it; a zone guessed from the address does not count.
ALTER TABLE "stores" ADD COLUMN "timezone_set_at" TIMESTAMP(3);
