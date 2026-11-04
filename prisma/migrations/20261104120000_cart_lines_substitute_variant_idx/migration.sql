-- ADR-0014: every foreign key is indexed. cart_lines.substitute_variant_id
-- had none, so a substitute lookup and ON DELETE SET NULL scanned the table.
-- Plain CREATE INDEX (not CONCURRENTLY): this runs inside the migration transaction.
-- Index creation does not read rows, so the owner role can create it under forced RLS.

CREATE INDEX "cart_lines_substitute_variant_id_idx" ON "cart_lines"("substitute_variant_id");
