-- The capture record (#537): what Stripe captured and when, kept after a refund or cancellation
-- clears captured_amount_cents. ready_at is written in the same transaction that finalizes a capture.
ALTER TABLE "orders" ADD COLUMN "capture_cents" INTEGER;
ALTER TABLE "orders" ADD COLUMN "captured_at" TIMESTAMP(3);

UPDATE "orders"
SET "capture_cents" = "captured_amount_cents", "captured_at" = "ready_at"
WHERE "captured_amount_cents" IS NOT NULL AND "status" <> 'CAPTURING';

-- Orders whose capture was already cleared: the manual repayment and the covered refund recorded the amount.
UPDATE "orders" o
SET "capture_cents" = (a."after"->>'capturedCents')::int, "captured_at" = o."ready_at"
FROM "audit_logs" a
WHERE o."capture_cents" IS NULL AND a."entity_type" = 'order' AND a."entity_id" = o."id"
  AND a."action" = 'refund_resolved_manually' AND a."after" ? 'capturedCents';

UPDATE "orders" o
SET "capture_cents" = (a."after"->>'amountRefunded')::int, "captured_at" = o."ready_at"
FROM "audit_logs" a
WHERE o."capture_cents" IS NULL AND a."entity_type" = 'order' AND a."entity_id" = o."id"
  AND a."action" = 'anomaly_refund' AND a."after" ? 'amountRefunded';

-- Any other order that reached capture (ready_at is set only there) keeps its time with the amount unknown.
UPDATE "orders" SET "captured_at" = "ready_at" WHERE "captured_at" IS NULL AND "ready_at" IS NOT NULL;
