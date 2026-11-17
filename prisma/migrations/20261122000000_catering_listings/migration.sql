-- #571: a prepared listing can be catering, ordered ahead. It carries a lead
-- time in hours and a minimum quantity, set together or not at all. The lead
-- stays under 5 days so a slot still fits inside the 5-day card hold.
ALTER TABLE "listings"
    ADD COLUMN "catering_lead_hours" INTEGER,
    ADD COLUMN "catering_min_qty" INTEGER,
    ADD CONSTRAINT "listings_catering_check" CHECK (
        ("catering_lead_hours" IS NULL AND "catering_min_qty" IS NULL)
        OR ("prepared" IS NOT NULL
            AND "catering_lead_hours" BETWEEN 1 AND 96
            AND "catering_min_qty" BETWEEN 1 AND 500)
    );
