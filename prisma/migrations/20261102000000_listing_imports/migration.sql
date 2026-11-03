-- D1: DB-backed listing imports (replaces in-memory token Map)
-- Additive migration; works on an empty database.

CREATE TABLE "listing_imports" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "csv_text" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "listing_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "listing_imports_store_id_idx" ON "listing_imports"("store_id");
CREATE INDEX "listing_imports_store_id_status_idx" ON "listing_imports"("store_id", "status");

ALTER TABLE "listing_imports"
    ADD CONSTRAINT "listing_imports_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listing_imports"
    ADD CONSTRAINT "listing_imports_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: listing_imports — store-scoped isolation + platform admin bypass
ALTER TABLE "listing_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "listing_imports" FORCE ROW LEVEL SECURITY;

CREATE POLICY listing_imports_isolation ON "listing_imports"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY listing_imports_platform_admin ON "listing_imports"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "listing_imports" TO app_user;

-- Expired rows are left in place (inert data). A future cleanup job can
-- DELETE FROM listing_imports WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 day'.
