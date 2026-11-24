-- The aisle of a custom listing (#782); a listing with a master product takes the product's category.
ALTER TABLE "listings" ADD COLUMN "category_id" TEXT;
CREATE INDEX "listings_category_id_idx" ON "listings"("category_id");
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
