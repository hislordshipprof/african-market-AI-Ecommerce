-- The order lines a refund returns (#798), so the store and the shopper see which lines were refunded.
ALTER TABLE "refund_requests" ADD COLUMN "lines" JSONB;
