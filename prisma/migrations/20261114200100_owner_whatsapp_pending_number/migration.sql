-- #143 fix round. A code is sent for a pending number, kept apart from the
-- linked one, so a verified link stays as it was until the new code is
-- answered. phone_number and wa_id now change only on verification (or while
-- the row has never been verified). Codes are matched on pending_wa_id.
-- No backfill: a row with a code but no pending_wa_id is not a candidate, so
-- a code already in flight when this applies just needs a resend.
ALTER TABLE "owner_whatsapp_links"
    ADD COLUMN "pending_phone_number" TEXT,
    ADD COLUMN "pending_wa_id" TEXT,
    ADD CONSTRAINT "owner_whatsapp_links_pending_phone_number_check"
        CHECK ("pending_phone_number" IS NULL OR "pending_phone_number" ~ '^\+[1-9][0-9]{7,14}$');

CREATE INDEX "owner_whatsapp_links_pending_wa_id_idx" ON "owner_whatsapp_links"("pending_wa_id");
