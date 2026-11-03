-- #69: Customer sign-in schema changes
-- Users: phone columns for phone-number auth
-- Customers: nullable email/phone, FK to users, partial unique on (store_id, user_id)

-- 1. Users: add phone + phone_verified
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- 2. Customers: make email and phone nullable
-- Guest checkout still requires both, but authenticated sign-in may only have one
ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;

-- 3. Customers: FK user_id → users.id
ALTER TABLE "customers"
    ADD CONSTRAINT "customers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Pre-check: fail if duplicate (store_id, user_id) rows exist
DO $$
BEGIN
  IF EXISTS (
    SELECT store_id, user_id
    FROM customers
    WHERE user_id IS NOT NULL
    GROUP BY store_id, user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate (store_id, user_id) rows in customers — deduplicate before migrating';
  END IF;
END $$;

-- 5. Partial unique: one Customer row per user per store
CREATE UNIQUE INDEX "customers_store_id_user_id_key"
  ON "customers"("store_id", "user_id")
  WHERE "user_id" IS NOT NULL;

-- 6. Index on user_id for FK lookups
CREATE INDEX "customers_user_id_idx" ON "customers"("user_id");
