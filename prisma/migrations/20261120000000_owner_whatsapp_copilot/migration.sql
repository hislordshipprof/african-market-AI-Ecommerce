-- Store copilot on WhatsApp (#144). The owner's last message to the platform
-- number, by Meta's send time, so alerts and the digest know whether Meta's
-- 24-hour window is open (free text) or closed (an approved template).
ALTER TABLE "owner_whatsapp_links" ADD COLUMN "last_inbound_at" TIMESTAMP(3);

-- The digest's WhatsApp summary, fixed at claim time like the email body, and
-- the owners it was handed to. An owner is added before the send, so a retry
-- never sends twice (a send has no idempotency key).
ALTER TABLE "copilot_digests" ADD COLUMN "whatsapp_summary" JSONB;
ALTER TABLE "copilot_digests" ADD COLUMN "whatsapp_sent_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
