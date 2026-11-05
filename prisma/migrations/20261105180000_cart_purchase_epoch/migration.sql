-- One basket purchase increments this counter in the same transaction that
-- clears the lines. PaymentIntents stamp the value they were authorized for.
ALTER TABLE "carts" ADD COLUMN "purchase_epoch" INTEGER NOT NULL DEFAULT 0;
