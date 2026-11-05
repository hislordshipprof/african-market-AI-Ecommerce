-- One guest cart per browser, so concurrent strangers do not share a basket
-- and a second request can find the cart before the cart cookie is stored.
CREATE TABLE "guest_browser_carts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "browser_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_browser_carts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guest_browser_carts_store_id_browser_id_key"
    ON "guest_browser_carts"("store_id", "browser_id");
CREATE INDEX "guest_browser_carts_cart_id_idx" ON "guest_browser_carts"("cart_id");

ALTER TABLE "guest_browser_carts"
    ADD CONSTRAINT "guest_browser_carts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guest_browser_carts"
    ADD CONSTRAINT "guest_browser_carts_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guest_browser_carts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_browser_carts" FORCE ROW LEVEL SECURITY;

CREATE POLICY guest_browser_carts_isolation ON "guest_browser_carts"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY guest_browser_carts_platform_admin ON "guest_browser_carts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "guest_browser_carts" TO app_user;
