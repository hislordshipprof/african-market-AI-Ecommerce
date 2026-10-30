-- CreateTable: stores (platform-level, but RLS-protected for writes)
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "brand_color" TEXT,
    "theme_preset" TEXT NOT NULL DEFAULT 'palm-and-shea',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stores_slug_key" ON "stores"("slug");

-- CreateTable: store_content (store-owned, RLS by store_id)
CREATE TABLE "store_content" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_content_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_content_store_id_idx" ON "store_content"("store_id");
CREATE UNIQUE INDEX "store_content_store_id_key_key" ON "store_content"("store_id", "key");

ALTER TABLE "store_content"
    ADD CONSTRAINT "store_content_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS setup: create app_user role that does NOT own tables (ADR-0014).
-- Migrations run as the table owner; the app drops to app_user via SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- stores: anyone can read (store resolution), only the current store can write its own row.
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;

CREATE POLICY stores_read ON "stores"
  FOR SELECT TO app_user
  USING (true);

CREATE POLICY stores_write ON "stores"
  FOR ALL TO app_user
  USING (id = current_setting('app.store_id', true))
  WITH CHECK (id = current_setting('app.store_id', true));

-- store_content: strict isolation. Read and write only your own store's rows.
ALTER TABLE "store_content" ENABLE ROW LEVEL SECURITY;

CREATE POLICY store_content_isolation ON "store_content"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));
