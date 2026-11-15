-- Store directory D6 (#454): where the order's shopper came from. Null unless the directory sent them.
ALTER TABLE "orders" ADD COLUMN "acquisition_source" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_acquisition_source_check" CHECK ("acquisition_source" IN ('directory'));
