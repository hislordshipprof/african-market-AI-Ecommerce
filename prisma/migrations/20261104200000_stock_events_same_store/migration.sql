-- stock_events_isolation used to check only the event's own store_id, so a
-- store could write a stock event whose listing belongs to another store.
-- Foreign-key checks bypass row-level security, which also told a caller
-- whether a listing id existed anywhere. USING and WITH CHECK now require
-- the listing to belong to app.store_id as well.
--
-- The table owner runs this. app_owner (CI and lanes) is subject to forced
-- row-level security and is not BYPASSRLS, so a mismatch count is invisible
-- unless this block sets app.is_platform_admin itself. A BYPASSRLS owner
-- (the Neon console role) sees every row either way.
--
-- One DO block is the whole migration. Prisma may commit each top-level
-- statement on its own, and a lock taken in an earlier statement would not
-- still be held while the policy changed. SHARE ROW EXCLUSIVE conflicts with
-- INSERT, UPDATE and DELETE. listings is locked first, then stock_events, and
-- both locks are held until this block's transaction ends. The count runs
-- after those locks, so it sees writers that committed while this block waited.
--
-- Failed deploy. This statement rolls back, so the previous policy and the
-- rows stay as they were, and the transaction-local admin flag does not
-- remain set. Do not delete stock events from this migration, and do not mark
-- it applied while the new policy is missing. Recovery:
-- 1. Read the error. Confirm stock_events_isolation is still the store-only policy.
-- 2. Repair the mismatched rows with an authorized change.
-- 3. Confirm this migration's changes are rolled back.
-- 4. prisma migrate resolve --rolled-back 20261104200000_stock_events_same_store
-- 5. prisma migrate deploy

DO $$
DECLARE
  mismatched integer;
BEGIN
  LOCK TABLE "listings" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "stock_events" IN SHARE ROW EXCLUSIVE MODE;

  PERFORM set_config('app.is_platform_admin', 'true', true);

  SELECT count(*)::integer INTO mismatched
  FROM "stock_events" AS s
  JOIN "listings" AS l ON l.id = s.listing_id
  WHERE s.store_id <> l.store_id;

  PERFORM set_config('app.is_platform_admin', 'false', true);

  IF mismatched > 0 THEN
    RAISE EXCEPTION 'stock_events rows reference a listing in another store: %', mismatched;
  END IF;

  EXECUTE $policy$
    ALTER POLICY stock_events_isolation ON "stock_events"
      USING (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
          SELECT 1 FROM "listings"
          WHERE "listings"."id" = "stock_events"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true)
        )
      )
      WITH CHECK (
        store_id = current_setting('app.store_id', true)
        AND EXISTS (
          SELECT 1 FROM "listings"
          WHERE "listings"."id" = "stock_events"."listing_id"
            AND "listings"."store_id" = current_setting('app.store_id', true)
        )
      )
  $policy$;
END
$$;
