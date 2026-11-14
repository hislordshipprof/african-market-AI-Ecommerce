-- Platform spend ledger. No store_id and no DELETE grant: retention must not
-- lower the measured cap by deleting rows.

CREATE TABLE "assistant_spend_days" (
    "day" DATE NOT NULL,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "cap_alerted_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_spend_days_pkey" PRIMARY KEY ("day")
);

GRANT SELECT, INSERT, UPDATE ON TABLE "assistant_spend_days" TO app_user;
