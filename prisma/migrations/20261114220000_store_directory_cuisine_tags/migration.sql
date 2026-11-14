-- Store directory (#450): the owner picks up to 3 cuisine tags for the directory card.
ALTER TABLE "stores" ADD COLUMN "cuisine_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "stores" ADD CONSTRAINT "stores_cuisine_tags_max" CHECK (cardinality("cuisine_tags") <= 3);
