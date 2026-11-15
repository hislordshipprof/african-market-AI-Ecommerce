import { describe, expect, it } from "vitest";
import { incidentFiltersFromSearchParams, redactCourierPayload } from "./courier-incidents-query";

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

  it("the customer's or recipient's name under any key outside the drop-off is redacted; the courier's name stays", () => {
    const payload = {
      customer_name: "Ada Obi",
      recipient: { first_name: "Ada", last_name: "Obi" },
      data: { customer: { full_name: "Ada Obi" }, recipient_name: "Ada Obi", courier: { name: "Sam" } },
    };
    expect(redactCourierPayload(payload)).toEqual({ customer_name: R, recipient: R, data: { customer: R, recipient_name: R, courier: { name: "Sam" } } });
  });

  it("dates, ids and amounts are not mistaken for phone numbers", () => {
    const payload = { created_at: "2026-11-14 15:10:00", support_reference: 1234567, fee: 1234567890, id: "del_2026111415" };
    expect(redactCourierPayload(payload)).toEqual(payload);
  });
});

describe("incidentFiltersFromSearchParams (#536 AC2)", () => {
  it("keeps only exact allowed values: a near miss, a pattern or an impossible date is dropped", () => {
    expect(
      incidentFiltersFromSearchParams({
        store: "cmwh614qk00065o0m6m511q78",
        provider: "uber",
        kind: "assigned_late",
        from: "2026-03-01",
        to: "2026-03-31",
        after: "2026-03-10T12:30:00.000Z_cmwh614qk00065o0m6m511q78",
      }),
    ).toEqual({
      storeId: "cmwh614qk00065o0m6m511q78",
      provider: "uber",
      kind: "assigned_late",
      from: "2026-03-01",
      to: "2026-03-31",
      after: "2026-03-10T12:30:00.000Z_cmwh614qk00065o0m6m511q78",
    });
    expect(
      incidentFiltersFromSearchParams({ store: "abc%", provider: "Uber", kind: "failover%", from: "2026-02-30", to: "03/31/2026", after: "2026-03-10_x' OR '1'='1" }),
    ).toEqual({});
    expect(incidentFiltersFromSearchParams({ store: ["a", "b"], provider: "" })).toEqual({});
  });
});
