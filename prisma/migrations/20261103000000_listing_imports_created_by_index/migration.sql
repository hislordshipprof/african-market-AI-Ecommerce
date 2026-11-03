-- ADR-0014: index the created_by_id foreign key. The (store_id, status) index
-- already serves store_id-only lookups, so the single-column store_id index is redundant.
-- Plain CREATE/DROP INDEX (not CONCURRENTLY): this runs inside the migration transaction.
-- The table is small. Never edit 20261102000000_listing_imports; Prisma checksums it.

DROP INDEX "listing_imports_store_id_idx";

CREATE INDEX "listing_imports_created_by_id_idx" ON "listing_imports"("created_by_id");
