-- Store the original image URL from CSV so approve can download without accepting arbitrary URLs.
ALTER TABLE "master_products" ADD COLUMN "image_source_url" TEXT;
