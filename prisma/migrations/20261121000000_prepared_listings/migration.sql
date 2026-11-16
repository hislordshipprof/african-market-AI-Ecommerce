-- #570: a grocery store may sell prepared food (ADR-0004 amendment). A prepared
-- listing is hot or cold and carries the minutes it takes to make; both are
-- set together or not at all.
ALTER TABLE "listings"
    ADD COLUMN "prepared" TEXT,
    ADD COLUMN "prep_minutes" INTEGER,
    ADD CONSTRAINT "listings_prepared_check" CHECK (
        ("prepared" IS NULL AND "prep_minutes" IS NULL)
        OR ("prepared" IN ('hot', 'cold') AND "prep_minutes" BETWEEN 0 AND 120)
    );
