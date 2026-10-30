-- Drop the owner bypass policy that cancels FORCE ROW LEVEL SECURITY.
-- The seed and app must write store-owned rows through storeScoped() (SET LOCAL ROLE app_user).
DROP POLICY IF EXISTS store_content_owner_bypass ON "store_content";
