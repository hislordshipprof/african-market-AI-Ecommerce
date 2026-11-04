-- A collection link is store-owned through both parents. The previous policy
-- checked only the collection's store, so store B could attach store A's
-- listing to a collection B owns. Table owner applies this policy; no rows
-- are rewritten. WITH CHECK and USING both require the collection and the
-- listing to belong to app.store_id, so either foreign parent from another
-- store is rejected for app_user.
DROP POLICY store_collection_listings_isolation ON "store_collection_listings";

CREATE POLICY store_collection_listings_isolation ON "store_collection_listings"
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM "store_collections"
    JOIN "listings" ON "listings"."id" = "store_collection_listings"."listing_id"
    WHERE "store_collections"."id" = "store_collection_listings"."collection_id"
      AND "store_collections"."store_id" = current_setting('app.store_id', true)
      AND "listings"."store_id" = current_setting('app.store_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "store_collections"
    JOIN "listings" ON "listings"."id" = "store_collection_listings"."listing_id"
    WHERE "store_collections"."id" = "store_collection_listings"."collection_id"
      AND "store_collections"."store_id" = current_setting('app.store_id', true)
      AND "listings"."store_id" = current_setting('app.store_id', true)
  ));
