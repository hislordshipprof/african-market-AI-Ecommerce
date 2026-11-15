-- Platform fee ledger (#546): when a refund first succeeded, an append-only record of each order's capture,
-- and indexes for one month across stores.
ALTER TABLE "refund_requests" ADD COLUMN "succeeded_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "capture_confirmed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "confirmed_capture_cents" INTEGER;

-- Backfill. FORCE ROW LEVEL SECURITY applies to the migrating role (app_owner on lanes and CI), so a plain
-- UPDATE matches no rows. The platform-admin policies give visibility; one DO block keeps the setting local.
DO $$
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);

  -- A card refund almost always succeeds when it is created.
  UPDATE "refund_requests" SET "succeeded_at" = "created_at"
  WHERE "provider_status" = 'succeeded' AND "succeeded_at" IS NULL;

  -- Captures the order still stores, dated Ready, else when its refund first failed, else cancelled.
  UPDATE "orders" o
  SET "confirmed_capture_cents" = o."captured_amount_cents",
      "capture_confirmed_at" = COALESCE(o."ready_at", (
        SELECT MIN(a."created_at") FROM "audit_logs" a
        WHERE a."entity_type" = 'order' AND a."entity_id" = o."id" AND a."store_id" = o."store_id" AND a."action" = 'refund_failed'
      ), o."cancelled_at", o."updated_at")
  WHERE o."captured_amount_cents" IS NOT NULL
    AND o."status" NOT IN ('AUTHORIZED', 'ACCEPTED', 'PICKING', 'SUBSTITUTION_PENDING', 'CAPTURING', 'CANCELLING', 'CANCELLED');

  -- Captures a manual repayment cleared: its record keeps the capture. Resolution moved cancelled_at.
  UPDATE "orders" o
  SET "confirmed_capture_cents" = (m."after"->>'capturedCents')::int,
      "capture_confirmed_at" = COALESCE(o."ready_at", (
        SELECT MIN(a."created_at") FROM "audit_logs" a
        WHERE a."entity_type" = 'order' AND a."entity_id" = o."id" AND a."store_id" = o."store_id" AND a."action" = 'refund_failed'
      ), o."cancelled_at")
  FROM (
    SELECT DISTINCT ON ("entity_id", "store_id") "entity_id", "store_id", "after" FROM "audit_logs"
    WHERE "action" = 'refund_resolved_manually' AND "entity_type" = 'order'
    ORDER BY "entity_id", "store_id", "created_at"
  ) m
  WHERE m."entity_id" = o."id" AND m."store_id" = o."store_id" AND o."confirmed_capture_cents" IS NULL
    AND (m."after"->>'capturedCents')::int > 0;

  -- Captures a full cancel refund cleared: the succeeded refunds are the capture.
  UPDATE "orders" o
  SET "confirmed_capture_cents" = r."cents", "capture_confirmed_at" = COALESCE(o."ready_at", o."cancelled_at", o."updated_at")
  FROM (
    SELECT "order_id", "store_id", SUM("amount_cents")::int AS "cents" FROM "refund_requests"
    WHERE "provider_status" = 'succeeded' GROUP BY "order_id", "store_id"
  ) r
  WHERE r."order_id" = o."id" AND r."store_id" = o."store_id" AND o."confirmed_capture_cents" IS NULL
    AND o."status" = 'CANCELLED' AND r."cents" > 0;

  PERFORM set_config('app.is_platform_admin', '', true);
END $$;

-- Every path that records a refund's status writes provider_status; the first 'succeeded' stamps the time once.
CREATE FUNCTION refund_requests_stamp_succeeded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_status = 'succeeded' AND NEW.succeeded_at IS NULL THEN
    NEW.succeeded_at := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER refund_requests_stamp_succeeded
    BEFORE INSERT OR UPDATE ON "refund_requests"
    FOR EACH ROW EXECUTE FUNCTION refund_requests_stamp_succeeded();

-- The capture record is written once and never changed: cancelling, a full refund or a manual repayment
-- clears captured_amount_cents, never this. A capture is confirmed when the order holds a captured amount
-- outside the pre-capture and cancel states (Ready, or Refund failed when a capture was found at cancel),
-- or when a cancelled order that never stored its capture has succeeded refunds (refunded in full at cancel).
CREATE FUNCTION orders_record_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  refunded integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.confirmed_capture_cents IS NOT NULL THEN
    NEW.confirmed_capture_cents := OLD.confirmed_capture_cents;
    NEW.capture_confirmed_at := OLD.capture_confirmed_at;
  ELSIF NEW.confirmed_capture_cents IS NULL THEN
    IF NEW.captured_amount_cents IS NOT NULL
      AND NEW.status NOT IN ('AUTHORIZED', 'ACCEPTED', 'PICKING', 'SUBSTITUTION_PENDING', 'CAPTURING', 'CANCELLING', 'CANCELLED') THEN
      NEW.confirmed_capture_cents := NEW.captured_amount_cents;
      NEW.capture_confirmed_at := COALESCE(NEW.ready_at, now() AT TIME ZONE 'UTC');
    ELSIF NEW.status = 'CANCELLED' THEN
      SELECT SUM(amount_cents) INTO refunded FROM refund_requests
      WHERE order_id = NEW.id AND store_id = NEW.store_id AND provider_status = 'succeeded';
      IF refunded > 0 THEN
        NEW.confirmed_capture_cents := refunded;
        NEW.capture_confirmed_at := COALESCE(NEW.ready_at, NEW.cancelled_at, now() AT TIME ZONE 'UTC');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER orders_record_capture
    BEFORE INSERT OR UPDATE ON "orders"
    FOR EACH ROW EXECUTE FUNCTION orders_record_capture();

CREATE INDEX "refund_requests_succeeded_at_idx" ON "refund_requests"("succeeded_at");
CREATE INDEX "orders_capture_confirmed_at_idx" ON "orders"("capture_confirmed_at");
