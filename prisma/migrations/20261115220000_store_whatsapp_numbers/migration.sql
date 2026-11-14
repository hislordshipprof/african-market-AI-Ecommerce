-- A store's own WhatsApp number for customers (#558, ADR-0010). Store-owned,
-- RLS as owner_whatsapp_links. One row per store; a phone_number_id belongs to
-- at most one store platform-wide, so an inbound message resolves to one store.
-- business_token is AES-256-GCM ciphertext (WHATSAPP_TOKEN_KEY), never plaintext.
CREATE TABLE "store_whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "coexistence" BOOLEAN NOT NULL DEFAULT true,
    "business_token" TEXT,
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_whatsapp_numbers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_whatsapp_numbers_status_check"
        CHECK ("status" IN ('pending', 'registered', 'failed', 'disconnected')),
    CONSTRAINT "store_whatsapp_numbers_ids_check"
        CHECK ("waba_id" ~ '^[0-9]{5,20}$' AND "phone_number_id" ~ '^[0-9]{5,20}$'),
    CONSTRAINT "store_whatsapp_numbers_registered_token_check"
        CHECK ("status" <> 'registered' OR "business_token" IS NOT NULL)
);

CREATE UNIQUE INDEX "store_whatsapp_numbers_store_id_key" ON "store_whatsapp_numbers"("store_id");
CREATE UNIQUE INDEX "store_whatsapp_numbers_phone_number_id_key" ON "store_whatsapp_numbers"("phone_number_id");

ALTER TABLE "store_whatsapp_numbers"
    ADD CONSTRAINT "store_whatsapp_numbers_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_whatsapp_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_whatsapp_numbers" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_whatsapp_numbers_isolation ON "store_whatsapp_numbers"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_whatsapp_numbers_platform_admin ON "store_whatsapp_numbers"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_whatsapp_numbers" TO app_user;
