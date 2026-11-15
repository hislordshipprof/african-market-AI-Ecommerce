-- Courier incident log (#536). Incidents are derived on read from delivery_events; failover and both-fail are now
-- recorded there too. Only an admin's notes and resolutions are stored.
ALTER TABLE "delivery_events" DROP CONSTRAINT "delivery_events_type_check";
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_type_check"
    CHECK ("type" IN ('out_for_delivery', 'delivered', 'courier_assigned', 'picked_up', 'cancelled', 'returned', 'failover_triggered', 'both_failed'));

CREATE INDEX "delivery_events_type_created_at_idx" ON "delivery_events"("type", "created_at");

-- A failover or both-fail with no delivery row (a create error) is keyed on the order, so a replayed step writes it once.
-- The unique on (delivery_id, external_event_id) cannot do it: NULL delivery ids are distinct.
CREATE UNIQUE INDEX "delivery_events_order_id_external_event_id_key" ON "delivery_events"("order_id", "external_event_id")
    WHERE "delivery_id" IS NULL AND "external_event_id" IS NOT NULL;

CREATE TABLE "courier_incident_notes" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_email" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "resolves" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_incident_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "courier_incident_notes_body_check" CHECK (char_length("body") BETWEEN 1 AND 1000)
);

CREATE INDEX "courier_incident_notes_store_id_order_id_created_at_idx" ON "courier_incident_notes"("store_id", "order_id", "created_at");
CREATE INDEX "courier_incident_notes_author_id_idx" ON "courier_incident_notes"("author_id");

ALTER TABLE "courier_incident_notes"
    ADD CONSTRAINT "courier_incident_notes_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "courier_incident_notes"
    ADD CONSTRAINT "courier_incident_notes_order_id_store_id_fkey"
    FOREIGN KEY ("order_id", "store_id") REFERENCES "orders"("id", "store_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "courier_incident_notes"
    ADD CONSTRAINT "courier_incident_notes_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "courier_incident_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courier_incident_notes" FORCE ROW LEVEL SECURITY;

CREATE POLICY courier_incident_notes_isolation ON "courier_incident_notes"
    FOR ALL TO app_user
    USING (store_id = current_setting('app.store_id', true))
    WITH CHECK (store_id = current_setting('app.store_id', true));

CREATE POLICY courier_incident_notes_platform_admin ON "courier_incident_notes"
    FOR ALL TO app_user
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Notes are append-only: no UPDATE or DELETE. They go with their order (cascade).
GRANT SELECT, INSERT ON "courier_incident_notes" TO app_user;
