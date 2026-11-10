-- #422: the orphan-hold sweep works through carts least recently checked first
ALTER TABLE "carts" ADD COLUMN "orphan_checked_at" TIMESTAMP(3);

-- Index for findOrphanHoldCarts: carts holding a PaymentIntent, in sweep order
CREATE INDEX IF NOT EXISTS idx_carts_orphan_hold_sweep
  ON carts (orphan_checked_at ASC NULLS FIRST, updated_at)
  WHERE payment_intent_id IS NOT NULL;

-- Index for findPickTimeoutCandidates: accepted orders not yet ready
CREATE INDEX IF NOT EXISTS idx_orders_pick_timeout
  ON orders (created_at)
  WHERE status IN ('ACCEPTED', 'PICKING');
