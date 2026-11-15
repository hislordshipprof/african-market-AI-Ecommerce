-- #671: each order line keeps its tax from the final calculation, so a refund returns the exact tax of the
-- lines it refunds; each refund request keeps the Stripe Tax reversal it owes and, once made, its id.
ALTER TABLE "order_lines" ADD COLUMN "tax_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tax_cents_check" CHECK ("tax_cents" >= 0);

ALTER TABLE "refund_requests"
    ADD COLUMN "tax_reversal" JSONB,
    ADD COLUMN "tax_reversal_id" TEXT;
