-- Copilot digest retries (#467): the claim keeps the rendered email so every retry sends the same body,
-- and sent_at marks the day as sent. Rows from before this were claimed and sent, so they get a sent_at.

ALTER TABLE "copilot_digests" ADD COLUMN "html" TEXT NOT NULL DEFAULT '';
ALTER TABLE "copilot_digests" ALTER COLUMN "html" DROP DEFAULT;
ALTER TABLE "copilot_digests" ADD COLUMN "sent_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "copilot_digests" ALTER COLUMN "sent_at" DROP DEFAULT;
