-- Chat escalation (#432): a per-store reply SLA in open minutes, and when and why a thread escalated.
ALTER TABLE "stores" ADD COLUMN "support_sla_minutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "stores" ADD CONSTRAINT "stores_support_sla_minutes_check" CHECK ("support_sla_minutes" BETWEEN 1 AND 1440);

ALTER TABLE "support_threads" ADD COLUMN "escalated_at" TIMESTAMP(3);
ALTER TABLE "support_threads" ADD COLUMN "escalation_reason" TEXT;
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_escalation_reason_check" CHECK ("escalation_reason" IN ('topic', 'sla'));

CREATE INDEX "support_threads_escalated_at_idx" ON "support_threads"("escalated_at");
