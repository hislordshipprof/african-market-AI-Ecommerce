-- Store memberships: links users to stores with roles (owner/staff)
CREATE TABLE "store_memberships" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_memberships_store_id_user_id_key" ON "store_memberships"("store_id", "user_id");
CREATE INDEX "store_memberships_user_id_idx" ON "store_memberships"("user_id");

ALTER TABLE "store_memberships"
    ADD CONSTRAINT "store_memberships_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_memberships"
    ADD CONSTRAINT "store_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Store invites: hashed single-use tokens with 72h expiry
CREATE TABLE "store_invites" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "invited_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_invites_token_hash_key" ON "store_invites"("token_hash");
CREATE INDEX "store_invites_store_id_idx" ON "store_invites"("store_id");
CREATE INDEX "store_invites_email_idx" ON "store_invites"("email");

ALTER TABLE "store_invites"
    ADD CONSTRAINT "store_invites_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_invites"
    ADD CONSTRAINT "store_invites_invited_by_id_fkey"
    FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: store_memberships — store-scoped isolation + platform admin bypass
ALTER TABLE "store_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_memberships_isolation ON "store_memberships"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_memberships_platform_admin ON "store_memberships"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- RLS: store_invites — store-scoped isolation + platform admin bypass
ALTER TABLE "store_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_invites" FORCE ROW LEVEL SECURITY;

CREATE POLICY store_invites_isolation ON "store_invites"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY store_invites_platform_admin ON "store_invites"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Grant app_user access to new tables
GRANT SELECT, INSERT, UPDATE, DELETE ON "store_memberships" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "store_invites" TO app_user;
