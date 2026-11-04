-- A cart or order in another store can point at this variant as its substitute.
-- The saving store's row-level policies cannot see that row, and ON DELETE SET NULL
-- cleared the selection without an error. RESTRICT makes the delete fail with a
-- foreign-key violation, which the save turns into the can't-be-removed message.
-- Changing the action does not read or rewrite existing rows.

ALTER TABLE "cart_lines" DROP CONSTRAINT "cart_lines_substitute_variant_id_fkey";

ALTER TABLE "cart_lines"
    ADD CONSTRAINT "cart_lines_substitute_variant_id_fkey"
    FOREIGN KEY ("substitute_variant_id")
    REFERENCES "listing_variants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_substitute_variant_id_fkey";

ALTER TABLE "order_lines"
    ADD CONSTRAINT "order_lines_substitute_variant_id_fkey"
    FOREIGN KEY ("substitute_variant_id")
    REFERENCES "listing_variants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
