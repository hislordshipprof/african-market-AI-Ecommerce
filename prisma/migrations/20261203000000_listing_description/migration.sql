-- The store's own product description (#820); the store chat drafts one for the owner to confirm.
ALTER TABLE "listings" ADD COLUMN "description" TEXT;
