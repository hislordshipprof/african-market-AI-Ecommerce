-- Add optional unique custom_domain column to stores
ALTER TABLE "stores" ADD COLUMN "custom_domain" TEXT;
CREATE UNIQUE INDEX "stores_custom_domain_key" ON "stores"("custom_domain");
