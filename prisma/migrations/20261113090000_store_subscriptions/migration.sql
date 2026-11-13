-- Store subscriptions (#494, ADR-0021): billing state per store, the Stripe events already applied, and assistant chats per month.
CREATE TABLE "store_subscriptions" (
    "store_id" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "status" TEXT NOT NULL DEFAULT 'none',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "trial_ends_at" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "pilot" BOOLEAN NOT NULL DEFAULT false,
    "payment_failed_at" TIMESTAMPTZ(6),
    "last_event_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_subscriptions_pkey" PRIMARY KEY ("store_id"),
    CONSTRAINT "store_subscriptions_plan_check" CHECK ("plan" IN ('starter', 'pro'))
);

CREATE UNIQUE INDEX "store_subscriptions_stripe_customer_id_key" ON "store_subscriptions"("stripe_customer_id");
CREATE UNIQUE INDEX "store_subscriptions_stripe_subscription_id_key" ON "store_subscriptions"("stripe_subscription_id");
CREATE INDEX "store_subscriptions_pilot_idx" ON "store_subscriptions"("pilot") WHERE "pilot";

ALTER TABLE "store_subscriptions"
    ADD CONSTRAINT "store_subscriptions_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_subscriptions" FORCE ROW LEVEL SECURITY;

-- A store reads its own billing; only the platform (webhooks, admin console) writes it.
CREATE POLICY store_subscriptions_isolation ON "store_subscriptions"
  FOR SELECT TO app_user
  USING (store_id = current_setting('app.store_id', true));

CREATE POLICY store_subscriptions_platform_admin ON "store_subscriptions"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "store_subscriptions" TO app_user;

-- One row per billing event applied; a replayed event id is a no-op.
CREATE TABLE "stripe_billing_events" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_billing_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stripe_billing_events_store_id_idx" ON "stripe_billing_events"("store_id");

ALTER TABLE "stripe_billing_events"
    ADD CONSTRAINT "stripe_billing_events_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stripe_billing_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_billing_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY stripe_billing_events_platform_admin ON "stripe_billing_events"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "stripe_billing_events" TO app_user;

-- Shopper assistant chats per store per calendar month (UTC), for the plan cap.
CREATE TABLE "assistant_chat_months" (
    "store_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "chats" INTEGER NOT NULL DEFAULT 0,
    "warned_at" TIMESTAMPTZ(6),

    CONSTRAINT "assistant_chat_months_pkey" PRIMARY KEY ("store_id", "month"),
    CONSTRAINT "assistant_chat_months_chats_check" CHECK ("chats" >= 0)
);

ALTER TABLE "assistant_chat_months"
    ADD CONSTRAINT "assistant_chat_months_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_chat_months" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_chat_months" FORCE ROW LEVEL SECURITY;

CREATE POLICY assistant_chat_months_isolation ON "assistant_chat_months"
  FOR ALL TO app_user
  USING (store_id = current_setting('app.store_id', true))
  WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY assistant_chat_months_platform_admin ON "assistant_chat_months"
  FOR ALL TO app_user
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_chat_months" TO app_user;
