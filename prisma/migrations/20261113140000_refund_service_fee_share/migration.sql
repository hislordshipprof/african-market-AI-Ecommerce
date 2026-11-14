-- #495: a courier issue refund returns its service fee share from the platform's application fee.
ALTER TABLE "refund_requests"
    ADD COLUMN "service_fee_share_cents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "fee_refund_id" TEXT;
