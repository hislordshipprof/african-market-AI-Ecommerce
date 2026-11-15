-- WhatsApp order updates (#560). The checkout opt-in is kept per order with
-- its time; NULL means the customer gets SMS as before.
ALTER TABLE "orders" ADD COLUMN "whatsapp_opt_in_at" TIMESTAMP(3);

-- A customer who sent STOP to a store's own number. Per store: STOP to one
-- store never silences another. wa_id is Meta's digits-only sender id.
CREATE TABLE "whatsapp_opt_outs" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "wa_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_opt_outs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_opt_outs_wa_id_check" CHECK ("wa_id" ~ '^[0-9]{8,15}$')
);

CREATE UNIQUE INDEX "whatsapp_opt_outs_store_id_wa_id_key" ON "whatsapp_opt_outs"("store_id", "wa_id");

ALTER TABLE "whatsapp_opt_outs"
    ADD CONSTRAINT "whatsapp_opt_outs_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "whatsapp_opt_outs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_opt_outs" FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_opt_outs_isolation ON "whatsapp_opt_outs"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY whatsapp_opt_outs_platform_admin ON "whatsapp_opt_outs"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_opt_outs" TO app_user;
