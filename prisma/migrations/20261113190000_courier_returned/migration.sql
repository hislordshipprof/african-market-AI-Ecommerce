-- A courier can bring a failed drop-off back to the store (DoorDash DELIVERY_RETURNED, Uber returned) (#136).
ALTER TABLE "delivery_events" DROP CONSTRAINT "delivery_events_type_check";
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_type_check"
    CHECK ("type" IN ('out_for_delivery', 'delivered', 'courier_assigned', 'picked_up', 'cancelled', 'returned'));

ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_status_check";
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_status_check"
    CHECK ("status" IN ('requested', 'courier_assigned', 'picked_up', 'delivered', 'cancelled', 'returned'));
