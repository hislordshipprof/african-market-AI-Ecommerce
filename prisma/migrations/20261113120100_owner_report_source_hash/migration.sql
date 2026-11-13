-- Owner reports (#468 item 5): a double submit of the same note or photo makes one pending report.

ALTER TABLE "owner_reports" ADD COLUMN "source_hash" TEXT;

CREATE UNIQUE INDEX "owner_reports_store_id_source_hash_pending_key"
    ON "owner_reports"("store_id", "source_hash") WHERE "status" = 'pending';
