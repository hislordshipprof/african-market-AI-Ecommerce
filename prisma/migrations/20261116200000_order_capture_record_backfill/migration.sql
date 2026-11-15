-- Redo the capture record backfill from 20261115220000_order_capture_record (#537).
--
-- FORCE ROW LEVEL SECURITY applies to the table owner unless that role is a
-- superuser or has BYPASSRLS (Neon console roles such as neondb_owner). On
-- lanes and hosted CI the migrating role is app_owner, which is neither, so the
-- plain UPDATEs in that migration matched zero orders. Visibility comes from the
-- orders_platform_admin policy, and only because this role already inherits
-- app_user privileges. Setting app.is_platform_admin does not grant them by itself.
--
-- One DO block keeps set_config(..., true) local whether or not Prisma wraps the
-- file in a transaction. Every UPDATE is set-once: a capture record written since
-- (by the app, or by the first migration on a role that bypasses RLS) is kept.
-- Only capture_cents and captured_at change.

DO $$
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);

  -- Still captured. CAPTURING holds the intended amount, not a capture.
  UPDATE "orders"
  SET "capture_cents" = "captured_amount_cents", "captured_at" = COALESCE("captured_at", "ready_at")
  WHERE "capture_cents" IS NULL AND "captured_amount_cents" IS NOT NULL AND "status" <> 'CAPTURING';

  -- Capture already cleared: the manual repayment and the covered refund recorded the amount.
  UPDATE "orders" o
  SET "capture_cents" = (a."after"->>'capturedCents')::int, "captured_at" = COALESCE(o."captured_at", o."ready_at")
  FROM "audit_logs" a
  WHERE o."capture_cents" IS NULL AND a."entity_type" = 'order' AND a."entity_id" = o."id"
    AND a."action" = 'refund_resolved_manually' AND a."after" ? 'capturedCents';

  UPDATE "orders" o
  SET "capture_cents" = (a."after"->>'amountRefunded')::int, "captured_at" = COALESCE(o."captured_at", o."ready_at")
  FROM "audit_logs" a
  WHERE o."capture_cents" IS NULL AND a."entity_type" = 'order' AND a."entity_id" = o."id"
    AND a."action" = 'anomaly_refund' AND a."after" ? 'amountRefunded';

  -- Any other order that reached capture (ready_at is set only there) keeps its time with the amount unknown.
  UPDATE "orders" SET "captured_at" = "ready_at" WHERE "captured_at" IS NULL AND "ready_at" IS NOT NULL;

  PERFORM set_config('app.is_platform_admin', '', true);
END $$;
