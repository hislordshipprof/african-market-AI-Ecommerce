-- #65: a refund carries the sales tax paid on the goods it refunds. On a courier refund of an order whose
-- tax the platform collects, the platform returns that tax from its application fee with the service fee share.
ALTER TABLE "refund_requests"
    ADD COLUMN "tax_share_cents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "platform_tax_share_cents" INTEGER NOT NULL DEFAULT 0;
