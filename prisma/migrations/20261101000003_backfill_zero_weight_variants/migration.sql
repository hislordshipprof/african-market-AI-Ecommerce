-- Backfill listing variants written before #102 with weight_g = 0, then enforce weight_g > 0.
-- Prefer the linked master product's weight; otherwise fall back to 100 g and log the row for human review.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT lv.id, lv.listing_id, mp.weight_g AS master_weight
    FROM listing_variants lv
    JOIN listings l ON l.id = lv.listing_id
    LEFT JOIN master_products mp ON mp.id = l.master_product_id
    WHERE lv.weight_g = 0
  LOOP
    IF r.master_weight IS NOT NULL AND r.master_weight > 0 THEN
      UPDATE listing_variants SET weight_g = r.master_weight WHERE id = r.id;
    ELSE
      UPDATE listing_variants SET weight_g = 100 WHERE id = r.id;
      RAISE NOTICE 'listing_variant % (listing %) had weight_g = 0 and no master weight; set fallback 100 g for review', r.id, r.listing_id;
    END IF;
  END LOOP;
END $$;

-- Negative values (never valid) get the same fallback so the constraint can be added.
UPDATE listing_variants SET weight_g = 100 WHERE weight_g < 0;

ALTER TABLE listing_variants ADD CONSTRAINT listing_variants_weight_g_positive CHECK (weight_g > 0);
