-- D2: Partial unique index on listings(store_id, master_product_id)
-- Prevents two listings for the same master product in the same store.

-- Step 1: check for existing duplicates — fail loudly, never silently delete data.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT store_id, master_product_id
    FROM listings
    WHERE master_product_id IS NOT NULL
    GROUP BY store_id, master_product_id
    HAVING COUNT(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Found % duplicate (store_id, master_product_id) pairs in listings. '
      'Fix them before applying this migration. Run: '
      'SELECT store_id, master_product_id, array_agg(id) '
      'FROM listings WHERE master_product_id IS NOT NULL '
      'GROUP BY store_id, master_product_id HAVING COUNT(*) > 1',
      dup_count;
  END IF;
END $$;

-- Step 2: add the partial unique index.
CREATE UNIQUE INDEX "listings_store_id_master_product_id_unique"
  ON "listings" ("store_id", "master_product_id")
  WHERE "master_product_id" IS NOT NULL;
