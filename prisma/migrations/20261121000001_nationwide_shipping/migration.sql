-- Nationwide shipping of dry goods (ADR-0023, #567).
ALTER TABLE "stores" ADD COLUMN "shipping_handling_days" INTEGER;
ALTER TABLE "stores" ADD CONSTRAINT "stores_shipping_handling_days_check"
  CHECK ("shipping_handling_days" IS NULL OR "shipping_handling_days" BETWEEN 1 AND 10);

ALTER TABLE "listings" ADD COLUMN "shippable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "carts"
  ADD COLUMN "shipping_fee_cents" INTEGER,
  ADD COLUMN "shipping_rate_id" TEXT,
  ADD COLUMN "shipping_carrier" TEXT,
  ADD COLUMN "shipping_service" TEXT,
  ADD COLUMN "shipping_days" INTEGER,
  ADD COLUMN "shipping_quote_key" TEXT,
  ADD COLUMN "shipping_quote_expires_at" TIMESTAMP(3);

ALTER TABLE "orders"
  ADD COLUMN "shipping_rate_id" TEXT,
  ADD COLUMN "shipping_carrier" TEXT,
  ADD COLUMN "shipping_service" TEXT,
  ADD COLUMN "shipping_days" INTEGER;

ALTER TABLE "platform_settings" ADD COLUMN "shipping_states" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
