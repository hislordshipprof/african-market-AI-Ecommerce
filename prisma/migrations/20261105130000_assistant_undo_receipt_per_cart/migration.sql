-- A tool-call id can repeat in another cart. The receipt belongs to one cart.
DROP INDEX "assistant_undo_receipts_store_id_addition_id_key";
CREATE UNIQUE INDEX "assistant_undo_receipts_store_id_cart_id_addition_id_key"
    ON "assistant_undo_receipts"("store_id", "cart_id", "addition_id");
