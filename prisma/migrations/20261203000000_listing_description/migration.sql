-- The store's own product description (#820); the store chat drafts one for the owner to confirm.
ALTER TABLE "listings" ADD COLUMN "description" TEXT;

ALTER TABLE "copilot_drafts" DROP CONSTRAINT "copilot_drafts_kind_check";
ALTER TABLE "copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_kind_check" CHECK (kind IN ('coupon', 'price', 'store_change', 'description'));
