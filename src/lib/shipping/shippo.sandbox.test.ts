import { describe, expect, it } from "vitest";
import { liveSandbox, providerSandbox } from "../test-live-provider";
import { ShippoProvider } from "./shippo";
import { cheapestRate } from "./provider";

const key = process.env.SHIPPO_API_KEY ?? "";
const sandbox = providerSandbox("Shippo");

// The real Shippo API with a test token (#567); test labels are never mailed. Skipped until SHIPPO_API_KEY is set.
describe.skipIf(!liveSandbox || !key.startsWith("shippo_test_"))("Shippo sandbox (#567)", () => {
  it("returns USD rates for a domestic parcel, and the cheapest has a carrier", sandbox.test(async () => {
    const rates = await new ShippoProvider({ apiKey: key }).rates({
      from: { name: "Ship Market", line1: "1600 Main St", city: "Houston", state: "TX", zip: "77002", phone: "+17135550100" },
      to: { name: "Ada Buyer", line1: "500 W Markham St", city: "Little Rock", state: "AR", zip: "72201" },
      weightG: 3629,
    });
    expect(rates.length).toBeGreaterThan(0);
    expect(cheapestRate(rates)).toMatchObject({ carrier: expect.any(String), feeCents: expect.any(Number) });
  }));
});
