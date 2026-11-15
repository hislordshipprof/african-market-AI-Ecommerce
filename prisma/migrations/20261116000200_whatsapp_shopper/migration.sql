-- Shopper assistant on a store's WhatsApp number (#559).

-- The cart a customer's WhatsApp chat with a store fills. Keyed by an HMAC of
-- the sender's wa_id, so the number itself is never stored here.
CREATE TABLE "whatsapp_shopper_carts" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "sender_key" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_shopper_carts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_shopper_carts_sender_key_check" CHECK ("sender_key" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "whatsapp_shopper_carts_store_id_sender_key_key"
    ON "whatsapp_shopper_carts"("store_id", "sender_key");
CREATE INDEX "whatsapp_shopper_carts_cart_id_idx" ON "whatsapp_shopper_carts"("cart_id");

ALTER TABLE "whatsapp_shopper_carts"
    ADD CONSTRAINT "whatsapp_shopper_carts_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_shopper_carts"
    ADD CONSTRAINT "whatsapp_shopper_carts_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_shopper_carts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_shopper_carts" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_shopper_carts_isolation ON "whatsapp_shopper_carts"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY whatsapp_shopper_carts_platform_admin ON "whatsapp_shopper_carts"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_shopper_carts" TO app_user;

-- A checkout link sent on WhatsApp: opens the store's checkout with this cart
-- once, within 60 minutes. Only the token's SHA-256 is kept.
CREATE TABLE "whatsapp_checkout_links" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cart_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_checkout_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_checkout_links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "whatsapp_checkout_links_token_hash_key" ON "whatsapp_checkout_links"("token_hash");
CREATE INDEX "whatsapp_checkout_links_store_id_idx" ON "whatsapp_checkout_links"("store_id");
CREATE INDEX "whatsapp_checkout_links_cart_id_idx" ON "whatsapp_checkout_links"("cart_id");

ALTER TABLE "whatsapp_checkout_links"
    ADD CONSTRAINT "whatsapp_checkout_links_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_checkout_links"
    ADD CONSTRAINT "whatsapp_checkout_links_cart_id_fkey"
    FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_checkout_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_checkout_links" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_checkout_links_isolation ON "whatsapp_checkout_links"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY whatsapp_checkout_links_platform_admin ON "whatsapp_checkout_links"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_checkout_links" TO app_user;
