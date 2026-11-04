-- Idempotency for one provider call, and the committed count of one retention batch.
-- Neither table has a store id, RLS, or a DELETE grant.

CREATE TABLE "assistant_spend_calls" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "cost_micros" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_spend_calls_pkey" PRIMARY KEY ("id")
);

GRANT SELECT, INSERT ON TABLE "assistant_spend_calls" TO app_user;

CREATE TABLE "assistant_retention_batches" (
    "id" TEXT NOT NULL,
    "deleted" INTEGER NOT NULL,

    CONSTRAINT "assistant_retention_batches_pkey" PRIMARY KEY ("id")
);

GRANT SELECT, INSERT ON TABLE "assistant_retention_batches" TO app_user;
