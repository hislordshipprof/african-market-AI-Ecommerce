-- Store directory (#449): a store appears only once listed; the blurb is at most 160 characters.
ALTER TABLE "stores" ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN "listing_blurb" VARCHAR(160);
