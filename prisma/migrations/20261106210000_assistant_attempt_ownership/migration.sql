-- One live assistant attempt per cart, and one attempt per PaymentIntent.
-- Partial indexes stay out of schema.prisma, same as the sweep indexes.

CREATE UNIQUE INDEX IF NOT EXISTS assistant_checkout_attempts_one_live_cart
  ON assistant_checkout_attempts (cart_id)
  WHERE status IN ('reserved', 'awaiting_payment');

CREATE UNIQUE INDEX IF NOT EXISTS assistant_checkout_attempts_one_payment_intent
  ON assistant_checkout_attempts (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

ALTER TABLE payment_intent_releases
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
