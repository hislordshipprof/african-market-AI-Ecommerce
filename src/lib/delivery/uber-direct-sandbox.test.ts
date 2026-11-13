import { describe, expect, it } from "vitest";
import { UberDirectProvider } from "./uber-direct";

const hasKeys = Boolean(process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET && process.env.UBER_DIRECT_CUSTOMER_ID);

// Opt-in: runs only with the Uber Direct test keys, and checks the adapter's shapes against the real sandbox.
describe.skipIf(!hasKeys)("UberDirectProvider against the Uber Direct sandbox", () => {
  it("gets a token and a real test quote in cents with Uber's expiry", async () => {
    const quote = await new UberDirectProvider().quote({
      externalDeliveryId: `sandbox-probe-${Date.now().toString(36)}`,
      pickup: {
        businessName: "Sandbox Probe Market",
        address: { line1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910" },
        phone: "+13015550100",
      },
      dropoff: { address: { line1: "1100 Wayne Ave", city: "Silver Spring", state: "MD", zip: "20910" }, phone: "+13015550199" },
      orderValueCents: 6000,
      tipCents: 0,
    });
    expect(quote.quoteId).toMatch(/^dqt_/);
    expect(Number.isInteger(quote.feeCents) && quote.feeCents > 0).toBe(true);
    expect(quote.currency).toBe("USD");
    expect(quote.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(quote.dropoffEta?.getTime()).toBeGreaterThan(Date.now());
    console.log(JSON.stringify({ event: "uber_direct_sandbox_quote", feeCents: quote.feeCents, expiresAt: quote.expiresAt, pickupEta: quote.pickupEta, dropoffEta: quote.dropoffEta }));
  }, 30_000);
});
