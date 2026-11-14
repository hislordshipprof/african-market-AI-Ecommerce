-- Platform fee ledger (#546): when a refund first succeeded, and indexes for one month across stores.
ALTER TABLE "refund_requests" ADD COLUMN "succeeded_at" TIMESTAMP(3);

-- Existing rows: a card refund almost always succeeds when it is created.
UPDATE "refund_requests" SET "succeeded_at" = "created_at" WHERE "provider_status" = 'succeeded';

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

CREATE INDEX "refund_requests_succeeded_at_idx" ON "refund_requests"("succeeded_at");
CREATE INDEX "orders_ready_at_idx" ON "orders"("ready_at");
CREATE INDEX "orders_cancelled_at_idx" ON "orders"("cancelled_at");
