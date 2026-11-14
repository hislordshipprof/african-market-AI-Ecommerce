import { describe, expect, it } from "vitest";
import { createUberDirectClient, UberDirectProvider } from "./uber-direct";
import { liveSandbox, providerSandbox } from "../test-live-provider";

const hasKeys = Boolean(process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET && process.env.UBER_DIRECT_CUSTOMER_ID);

const sandbox = providerSandbox("Uber Direct");

// Opt-in (#562): books a sandbox delivery for a ready time, moves it 5 minutes, then cancels it.
describe.skipIf(!liveSandbox || !hasKeys)("courier ready time against the Uber Direct sandbox", () => {
  it("books with pickup_ready_dt, moves it with update delivery, and cancels", sandbox.test(async () => {
    const uber = new UberDirectProvider();
    const client = createUberDirectClient();
    const read = async (id: string) => client.request("eats.deliveries", "GET", `/v1/customers/${client.customerId()}/deliveries/${id}`);
    const ready = new Date(Math.ceil((Date.now() + 18 * 60_000) / 60_000) * 60_000);
    const request = {
      externalDeliveryId: `timing-probe-${Date.now().toString(36)}`,
      pickup: { businessName: "Sandbox Probe Market", address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550100" },
      dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199", givenName: "Sandbox" },
      orderValueCents: 6000,
      tipCents: 0,
      pickupReadyAt: ready,
    };

    const quote = await uber.quote(request);
    const created = await uber.create(quote.quoteId, request);
    try {
      const booked = await read(created.externalId);
      const pushed = new Date(ready.getTime() + 5 * 60_000);
      await uber.reschedule(created.externalId, pushed);
      const moved = await read(created.externalId);
      const at = (v: unknown) => new Date(String(v)).getTime();
      console.log(JSON.stringify({
        event: "uber_direct_sandbox_ready_time", deliveryId: created.externalId, feeCents: quote.feeCents, sent: ready, pushed,
        booked: { pickup_ready: booked.pickup_ready, pickup_deadline: booked.pickup_deadline, pickup_eta: booked.pickup_eta },
        moved: { pickup_ready: moved.pickup_ready, pickup_deadline: moved.pickup_deadline, pickup_eta: moved.pickup_eta },
      }));
      expect(at(booked.pickup_ready)).toBe(ready.getTime());
      // The sandbox keeps showing the first pickup_ready after an update; the courier's pickup ETA is what moves.
      expect(Math.round(at(moved.pickup_eta) / 60_000)).toBe(pushed.getTime() / 60_000);
    } finally {
      await uber.cancel(created.externalId);
      const cancelled = await read(created.externalId);
      console.log(JSON.stringify({ event: "uber_direct_sandbox_cancel", deliveryId: created.externalId, status: cancelled.status, fee: cancelled.fee }));
    }
  }), 60_000);
});
