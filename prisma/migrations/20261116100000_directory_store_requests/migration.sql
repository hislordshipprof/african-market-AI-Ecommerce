-- Store directory D7 (#455): "tell me when a store opens near me". Platform-owned, not store-owned.
-- A shopper inserts a request; only the platform-admin context reads or updates it, since it holds
-- an email or phone. The one message erases the contact, so a sent row keeps only ZIP and dates.
CREATE TABLE "directory_store_requests" (
    "id" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "consent_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),
    "notified_store_id" TEXT,

    CONSTRAINT "directory_store_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_store_requests_zip_fkey" FOREIGN KEY ("zip") REFERENCES "gazetteer_zips"("zip") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "directory_store_requests_notified_store_id_fkey" FOREIGN KEY ("notified_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- Waiting: exactly one contact. Sent: none.
    CONSTRAINT "directory_store_requests_contact_check"
        CHECK (num_nonnulls("email", "phone") = CASE WHEN "notified_at" IS NULL THEN 1 ELSE 0 END),
    CONSTRAINT "directory_store_requests_email_check" CHECK ("email" IS NULL OR length("email") <= 254),
    CONSTRAINT "directory_store_requests_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+1[2-9][0-9]{9}$')
);

-- The same contact asking twice for one ZIP is one request.
CREATE UNIQUE INDEX "directory_store_requests_zip_email_key" ON "directory_store_requests"("zip", "email");
CREATE UNIQUE INDEX "directory_store_requests_zip_phone_key" ON "directory_store_requests"("zip", "phone");
CREATE INDEX "directory_store_requests_waiting_idx" ON "directory_store_requests"("id") WHERE "notified_at" IS NULL;

ALTER TABLE "directory_store_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "directory_store_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY directory_store_requests_insert ON "directory_store_requests"
  FOR INSERT TO app_user
  WITH CHECK ("notified_at" IS NULL AND "notified_store_id" IS NULL);

CREATE POLICY directory_store_requests_platform_admin ON "directory_store_requests"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "directory_store_requests" TO app_user;
