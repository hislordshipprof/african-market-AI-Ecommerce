-- Plan override (#547): a platform admin gives a store a plan until a date, with a reason. Never open-ended.
ALTER TABLE "store_subscriptions"
    ADD COLUMN "override_plan" TEXT,
    ADD COLUMN "override_ends_at" TIMESTAMPTZ(6),
    ADD COLUMN "override_reason" TEXT,
    ADD CONSTRAINT "store_subscriptions_override_plan_check" CHECK ("override_plan" IN ('starter', 'pro')),
    ADD CONSTRAINT "store_subscriptions_override_complete_check" CHECK (
        ("override_plan" IS NULL) = ("override_ends_at" IS NULL)
        AND ("override_plan" IS NULL) = ("override_reason" IS NULL)
    );
