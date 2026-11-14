-- Store copilot daily digest (#433): the owner's local send hour and one claim row per store day.

ALTER TABLE "stores" ADD COLUMN "digest_hour" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "stores" ADD CONSTRAINT "stores_digest_hour_check" CHECK (digest_hour BETWEEN 0 AND 23);

CREATE TABLE "copilot_digests" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "local_date" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_digests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "copilot_digests_store_id_local_date_key" ON "copilot_digests"("store_id", "local_date");

ALTER TABLE "copilot_digests"
    ADD CONSTRAINT "copilot_digests_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "copilot_digests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_digests" FORCE ROW LEVEL SECURITY;

CREATE POLICY copilot_digests_isolation ON "copilot_digests"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY copilot_digests_platform_admin ON "copilot_digests"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_digests" TO app_user;
