-- #409. Meta's business-scoped user id (BSUID, e.g. "US.13491208655302741918")
-- for the owner's WhatsApp account. Stored when the owner answers a code, or
-- on their next message, and matched as well as wa_id, because Meta omits the
-- phone number (`from`) for a user who has adopted a username. At most one
-- verified link per BSUID, like wa_id.
ALTER TABLE "owner_whatsapp_links" ADD COLUMN "bsuid" TEXT;

CREATE UNIQUE INDEX "owner_whatsapp_links_verified_bsuid_key"
    ON "owner_whatsapp_links"("bsuid")
    WHERE "verified" AND "bsuid" IS NOT NULL;
