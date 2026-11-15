-- Sales tax (#65, ADR-0008): who collects per store, Stripe tax codes per category, and the
-- calculation pinned on the cart at checkout and copied to the order.
ALTER TABLE "stores" ADD COLUMN "tax_liable_party" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "stores" ADD CONSTRAINT "stores_tax_liable_party_check" CHECK ("tax_liable_party" IN ('platform', 'store'));

ALTER TABLE "categories" ADD COLUMN "tax_code" TEXT;

ALTER TABLE "carts" ADD COLUMN "tax_cents" INTEGER;
ALTER TABLE "carts" ADD COLUMN "tax_lines" JSONB;
ALTER TABLE "carts" ADD COLUMN "tax_liable_party" TEXT;
ALTER TABLE "carts" ADD COLUMN "tax_calculation_id" TEXT;
ALTER TABLE "carts" ADD COLUMN "tax_quote_key" TEXT;

ALTER TABLE "orders" ADD COLUMN "tax_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "tax_lines" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "orders" ADD COLUMN "tax_liable_party" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "orders" ADD COLUMN "tax_calculation_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "tax_transaction_id" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_cents_check" CHECK ("tax_cents" >= 0);

-- Codes from https://docs.stripe.com/tax/tax-codes (checked against GET /v1/tax_codes).
UPDATE "categories" SET "tax_code" = 'txcd_40040000' WHERE "slug" IN (
  'tubers-and-roots', 'grains-and-flours', 'spices-and-seasonings', 'oils-and-butters', 'vegetables',
  'fish-and-meat', 'frozen', 'pantry-staples', 'beans-and-legumes', 'breakfast-and-dairy',
  'canned-and-packaged', 'fruits', 'seasonings-and-sauces'
);
UPDATE "categories" SET "tax_code" = 'txcd_40070005' WHERE "slug" = 'snacks';
UPDATE "categories" SET "tax_code" = 'txcd_41040008' WHERE "slug" = 'drinks';
UPDATE "categories" SET "tax_code" = 'txcd_32050025' WHERE "slug" = 'beauty';
UPDATE "categories" SET "tax_code" = 'txcd_99999999' WHERE "slug" = 'household';
