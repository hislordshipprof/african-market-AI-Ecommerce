-- #494 review: one open Checkout per store, and invoice events applied in order.
ALTER TABLE "store_subscriptions"
    ADD COLUMN "checkout_session_id" TEXT,
    ADD COLUMN "last_invoice_paid_at" TIMESTAMPTZ(6);
