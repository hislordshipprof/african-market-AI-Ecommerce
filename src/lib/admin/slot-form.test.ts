import { describe, expect, it } from "vitest";
import { readSlotForm, slotFormValues } from "./slot-form";

function reader(values: Record<string, string>) {
  return (key: string) => values[key] ?? null;
}

describe("readSlotForm", () => {
  it("is null when scheduled slots are off", () => {
    expect(readSlotForm(reader({ deliverySlotsMon: "junk" }), "deliverySlots")).toEqual({ schedule: null, errors: {} });
  });

  it("reads the settings with a 60-minute default slot and round-trips them", () => {
    const form = {
      deliverySlotsEnabled: "on",
      deliverySlotsLead: "180",
      deliverySlotsCapacity: "3",
      deliverySlotsDaysAhead: "5",
      deliverySlotsClosed: "2026-12-25, 2027-01-01",
      deliverySlotsMon: "9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM",
      deliverySlotsSat: "10am - 2pm",
    };
    const { schedule, errors } = readSlotForm(reader(form), "deliverySlots");
    expect(errors).toEqual({});
    expect(schedule).toMatchObject({ slotMinutes: 60, leadMinutes: 180, capacity: 3, daysAhead: 5, closedDates: ["2026-12-25", "2027-01-01"] });
    expect(schedule!.windows[1]).toEqual([{ start: 540, end: 720 }, { start: 840, end: 1080 }]);
    expect(schedule!.windows[6]).toEqual([{ start: 600, end: 840 }]);
    const values = slotFormValues(schedule, "deliverySlots");
    expect(values.deliverySlotsMon).toBe("9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM");
    expect(values.deliverySlotsSat).toBe("10:00 AM - 2:00 PM");
    expect(values.deliverySlotsEnabled).toBe("on");
  });

  it("refuses a lead time under 2 hours, more than 5 days ahead, bad windows and no windows", () => {
    const { schedule, errors } = readSlotForm(
      reader({ pickupSlotsEnabled: "on", pickupSlotsLead: "60", pickupSlotsDaysAhead: "7", pickupSlotsMinutes: "50", pickupSlotsTue: "6 PM - 9 AM" }),
      "pickupSlots",
    );
    expect(schedule).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["pickupSlotsDaysAhead", "pickupSlotsLead", "pickupSlotsMinutes", "pickupSlotsTue"]);
    expect(readSlotForm(reader({ pickupSlotsEnabled: "on" }), "pickupSlots").errors).toHaveProperty("pickupSlotsMon");
  });
});
