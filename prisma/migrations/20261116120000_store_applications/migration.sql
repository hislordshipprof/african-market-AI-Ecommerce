-- Store applications from the public /sell page (#554). Platform data, not
-- store-owned: no RLS; only platform-admin code reads it. One pending
-- application per email and per phone. Rejected rows are deleted 12 months
-- after the decision by a daily job.
CREATE TABLE "store_applications" (
    "id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "store_type" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "website" TEXT,
    "offers_pickup" BOOLEAN NOT NULL DEFAULT false,
    "offers_delivery" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reject_reason" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_by_email" TEXT,
    "rejection_emailed_at" TIMESTAMP(3),
    "store_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_applications_store_type_check" CHECK ("store_type" IN ('african', 'caribbean', 'other_grocery', 'specialty_food')),
    CONSTRAINT "store_applications_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected')),
    CONSTRAINT "store_applications_phone_check" CHECK ("phone" ~ '^\+1[0-9]{10}$'),
    CONSTRAINT "store_applications_rejected_reason_check" CHECK ("status" <> 'rejected' OR ("reject_reason" IS NOT NULL AND "decided_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "store_applications_pending_email_key" ON "store_applications"("email") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "store_applications_pending_phone_key" ON "store_applications"("phone") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "store_applications_store_id_key" ON "store_applications"("store_id");
CREATE INDEX "store_applications_status_created_at_idx" ON "store_applications"("status", "created_at");
CREATE INDEX "store_applications_status_decided_at_idx" ON "store_applications"("status", "decided_at");

ALTER TABLE "store_applications"
    ADD CONSTRAINT "store_applications_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_applications" TO app_user;
