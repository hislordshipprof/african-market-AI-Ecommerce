import { afterAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { COURIER_BOTH_FAILED, selectAndDispatch, type CourierEvent } from "./dispatch";
import { DoorDashDriveProvider } from "./doordash";
import { UberDirectProvider } from "./uber-direct";
import { liveSandbox, providerSandbox } from "../test-live-provider";

const hasKeys = Boolean(process.env.DATABASE_URL && process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET && process.env.UBER_DIRECT_CUSTOMER_ID);

const sandbox = providerSandbox("Uber Direct");

// Opt-in: a real Uber Direct sandbox quote through the selection; create is intercepted so nothing is ever booked.
describe.skipIf(!liveSandbox || !hasKeys)("selectAndDispatch against the Uber Direct sandbox", () => {
  const raw = testPrismaClient();
  let storeId = "";

  afterAll(sandbox.hook(async () => {
    if (storeId) {
      await storeScoped(storeId).order.deleteMany({});
      await storeScoped(storeId).customer.deleteMany({});
      await raw.store.deleteMany({ where: { id: storeId } });
    }
    await raw.$disconnect();
  }));

  it("takes the live Uber quote, skips DoorDash without keys, and books nothing", sandbox.test(async () => {
    const stamp = Date.now().toString(36);
    storeId = (await raw.store.create({ data: { slug: `dispatch-sandbox-${stamp}`, name: "Sandbox Probe Market", themePreset: "palm-and-shea", pickupEnabled: true } })).id;
    const customer = await storeScoped(storeId).customer.create({ data: { storeId, name: "Sandbox Buyer", email: `sandbox-${stamp}@example.com` } });
    const order = await storeScoped(storeId).order.create({
      data: { storeId, customerId: customer.id, status: "READY", fulfillment: "courier", subtotalCents: 6000, bufferCents: 0, totalCents: 6000, totalAuthorizedCents: 6000, number: 1 },
    });

    const uber = new UberDirectProvider();
    // selectAndDispatch turns a refused quote into a failed courier, so the refusal is watched here.
    const quote = uber.quote.bind(uber);
    uber.quote = (request) => sandbox.watch(quote(request));
    const booked: string[] = [];
    uber.create = async (quoteId) => {
      booked.push(quoteId);
      throw new Error("tests never book a courier");
    };
    const events: CourierEvent[] = [];
    const result = await selectAndDispatch(
      {
        storeId,
        orderId: order.id,
        request: {
          pickup: { businessName: "Sandbox Probe Market", address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550100" },
          dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199" },
          orderValueCents: 6000,
          tipCents: 0,
        },
      },
      { providers: [new DoorDashDriveProvider({ env: {} }), uber], emit: async (e) => void events.push(e) },
    );

    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatch(/^dqt_/);
    expect(result).toEqual({ ok: false, reason: "both_failed" });
    expect(events.at(-1)?.name).toBe(COURIER_BOTH_FAILED);
  }), 30_000);
});
