-- Category tree (#541): one parent level. The app keeps the depth at one; the database refuses
-- a self-parent and deleting a category that still has products or subcategories.
ALTER TABLE "categories"
    ADD COLUMN "parent_id" TEXT,
    ADD CONSTRAINT "categories_parent_not_self_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"),
    ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

ALTER TABLE "master_products" DROP CONSTRAINT "master_products_category_id_fkey";
ALTER TABLE "master_products"
    ADD CONSTRAINT "master_products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
