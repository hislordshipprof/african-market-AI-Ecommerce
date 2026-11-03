-- K7: Partial indexes for sweep queries

-- Index for sweepOrphanedAuthorized: AUTHORIZED orders missing Inngest event
CREATE INDEX IF NOT EXISTS idx_orders_orphaned_authorized
  ON orders (created_at)
  WHERE status = 'AUTHORIZED' AND inngest_event_sent_at IS NULL;

-- Index for reconcileStuckOrders: orders stuck in CAPTURING or CANCELLING
CREATE INDEX IF NOT EXISTS idx_orders_stuck_transitional
  ON orders (updated_at)
  WHERE status IN ('CAPTURING', 'CANCELLING');
