-- The store's own product photo (#787). It overrides the master product's photo for this listing only.
ALTER TABLE "listings" ADD COLUMN "image_url" TEXT;
