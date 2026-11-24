-- Each owner's new-order email (#785): on until they turn it off for themselves.
ALTER TABLE "store_memberships" ADD COLUMN "new_order_email" BOOLEAN NOT NULL DEFAULT true;
