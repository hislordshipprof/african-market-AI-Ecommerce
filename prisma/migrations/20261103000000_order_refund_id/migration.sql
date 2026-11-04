-- P3: Persist Stripe refund id on order for sweep retrieval
ALTER TABLE orders ADD COLUMN refund_id TEXT;
