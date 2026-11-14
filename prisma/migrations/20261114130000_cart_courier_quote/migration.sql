-- The courier quote the shopper saw at checkout (#527): the hold covers this fee, and the order records it.
ALTER TABLE "carts" ADD COLUMN "courier_fee_cents" INTEGER;
ALTER TABLE "carts" ADD COLUMN "courier_provider" TEXT;
ALTER TABLE "carts" ADD COLUMN "courier_quote_key" TEXT;
ALTER TABLE "carts" ADD COLUMN "courier_quote_expires_at" TIMESTAMP(3);
