-- A store owner's verified WhatsApp number (#143). Store-owned, RLS as
-- guest_browser_carts. One row per membership; removing the member removes it.
CREATE TABLE "owner_whatsapp_links" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "opt_in_alerts" BOOLEAN NOT NULL DEFAULT false,
    "opt_in_digest" BOOLEAN NOT NULL DEFAULT false,
    "verification_code_hash" TEXT,
    "verification_expires_at" TIMESTAMP(3),
    "verification_attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_whatsapp_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "owner_whatsapp_links_phone_number_check" CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE UNIQUE INDEX "owner_whatsapp_links_store_id_user_id_key"
    ON "owner_whatsapp_links"("store_id", "user_id");
-- At most one verified link per WhatsApp sender, platform-wide. Pending rows
-- are not unique, so one store cannot block or probe another store's number.
CREATE UNIQUE INDEX "owner_whatsapp_links_verified_wa_id_key"
    ON "owner_whatsapp_links"("wa_id")
    WHERE "verified";
CREATE INDEX "owner_whatsapp_links_wa_id_idx" ON "owner_whatsapp_links"("wa_id");

ALTER TABLE "owner_whatsapp_links"
    ADD CONSTRAINT "owner_whatsapp_links_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "owner_whatsapp_links"
    ADD CONSTRAINT "owner_whatsapp_links_store_id_user_id_fkey"
    FOREIGN KEY ("store_id", "user_id") REFERENCES "store_memberships"("store_id", "user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_whatsapp_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_whatsapp_links" FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_whatsapp_links_isolation ON "owner_whatsapp_links"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY owner_whatsapp_links_platform_admin ON "owner_whatsapp_links"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "owner_whatsapp_links" TO app_user;

-- Processed inbound WhatsApp message ids, so a redelivered webhook is handled once.
-- Not store-owned (no store_id, no RLS).
CREATE TABLE "whatsapp_inbound_messages" (
    "id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_inbound_messages_received_at_idx" ON "whatsapp_inbound_messages"("received_at");

GRANT SELECT, INSERT, DELETE ON "whatsapp_inbound_messages" TO app_user;
