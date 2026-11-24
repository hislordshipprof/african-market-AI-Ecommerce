-- What a label re-quoted after capture cost (#771); the platform absorbs its difference from shipping_postage_cents.
ALTER TABLE "orders" ADD COLUMN "shipping_label_postage_cents" INTEGER;
