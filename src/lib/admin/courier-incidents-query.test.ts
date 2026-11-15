import { describe, expect, it } from "vitest";
import { redactCourierPayload } from "./courier-incidents-query";

const R = "[redacted]";

describe("redactCourierPayload (#536 AC3)", () => {
  it("a DoorDash webhook keeps its status and reason, and loses every phone and the customer's contact", () => {
    const payload = {
      event_name: "DELIVERY_CANCELLED",
      external_delivery_id: "order-1-doordash-ab12cd34",
      created_at: "2026-11-14T15:10:00.000Z",
      cancellation_reason: "no_available_dashers",
      dasher_name: "John D.",
      dasher_dropoff_phone_number: "+18555550100",
      dasher_pickup_phone_number: "+18555550101",
      pickup_phone_number: "+13015550100",
      dropoff_phone_number: "+13015550199",
      dropoff_contact_given_name: "Ada",
      dropoff_contact_family_name: "Obi",
      dropoff_address: "1100 Wayne Ave, Silver Spring, MD 20910",
      dropoff_instructions: "Call 301-555-0199 at the gate",
      fee: 975,
    };

    expect(redactCourierPayload(payload)).toEqual({
      event_name: "DELIVERY_CANCELLED",
      external_delivery_id: "order-1-doordash-ab12cd34",
      created_at: "2026-11-14T15:10:00.000Z",
      cancellation_reason: "no_available_dashers",
      dasher_name: "John D.",
      dasher_dropoff_phone_number: R,
      dasher_pickup_phone_number: R,
      pickup_phone_number: R,
      dropoff_phone_number: R,
      dropoff_contact_given_name: R,
      dropoff_contact_family_name: R,
      dropoff_address: R,
      dropoff_instructions: R,
      fee: 975,
    });
  });

  it("an Uber webhook's nested drop-off, courier phone and any phone or email under an unknown key are redacted", () => {
    const payload = {
      kind: "event.delivery_status",
      status: "canceled",
      data: {
        id: "del_abc",
        undeliverable_reason: "customer_unavailable",
        courier: { name: "Sam", phone_number: "+1 (301) 555-0142", vehicle_type: "car" },
        dropoff: { name: "Ada Obi", phone_number: "+13015550199", address: "1100 Wayne Ave", location: { lat: 38.99, lng: -77.02 }, notes: "ring" },
        related: [{ customer_email: "ada@example.com" }, { contact: "+13015550111" }, { note: "reach me at ada@example.com" }],
      },
    };

    expect(redactCourierPayload(payload)).toEqual({
      kind: "event.delivery_status",
      status: "canceled",
      data: {
        id: "del_abc",
        undeliverable_reason: "customer_unavailable",
        courier: { name: "Sam", phone_number: R, vehicle_type: "car" },
        dropoff: R,
        related: [{ customer_email: R }, { contact: R }, { note: `reach me at ${R}` }],
      },
    });
  });

  it("dates, ids and amounts are not mistaken for phone numbers", () => {
    const payload = { created_at: "2026-11-14 15:10:00", support_reference: 1234567, fee: 1234567890, id: "del_2026111415" };
    expect(redactCourierPayload(payload)).toEqual(payload);
  });
});
