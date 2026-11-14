-- #558 fix: only a live claim (pending or registered) holds a phone_number_id,
-- so a failed or disconnected row no longer locks another store out of the number.
DROP INDEX "store_whatsapp_numbers_phone_number_id_key";
CREATE UNIQUE INDEX "store_whatsapp_numbers_phone_number_id_key" ON "store_whatsapp_numbers"("phone_number_id")
  WHERE "status" IN ('pending', 'registered');
