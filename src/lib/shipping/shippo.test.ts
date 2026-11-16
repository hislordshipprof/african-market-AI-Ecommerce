import { describe, expect, it } from "vitest";
import { ShippoProvider } from "./shippo";
import { fakeShippo } from "./shippo-fake";
import { cheapestRate, ShippingProviderError, type ParcelRequest } from "./provider";

const TOKEN = "shippo_test_unit";
const NOW = new Date("2026-11-15T12:00:00Z");
const REQUEST: ParcelRequest = {
  from: { name: "Ship Market", line1: "100 Main St", city: "Houston", state: "TX", zip: "77002", phone: "+17135550100" },
  to: { name: "Ada Buyer", line1: "500 W Markham St", city: "Little Rock", state: "AR", zip: "72201" },
  weightG: 3629,
};

describe("Shippo rates (#567)", () => {
  it("asks for synchronous rates with the token, reads dollar strings as cents, and keeps each rate the 7 days Shippo sells it", async () => {
    const fetch = fakeShippo({ token: TOKEN });
    const rates = await new ShippoProvider({ apiKey: TOKEN, fetch, now: () => NOW }).rates(REQUEST);

    expect(fetch.calls[0]).toMatchObject({ async: false, parcels: [{ weight: "8.00", mass_unit: "lb", distance_unit: "in" }], address_to: { country: "US", zip: "72201" } });
    expect(rates.map((rate) => [rate.carrier, rate.service, rate.feeCents, rate.days])).toEqual([
      ["USPS", "Ground Advantage", 1305, 5],
      ["USPS", "Priority Mail", 1855, 3],
      ["UPS", "Ground", 1730, 4],
    ]);
    expect(rates[0].expiresAt).toEqual(new Date("2026-11-22T12:00:00Z"));
    expect(cheapestRate(rates)).toMatchObject({ carrier: "USPS", feeCents: 1305 });
  });

  it("a wrong token, a missing ZIP or no weight is refused as Shippo refuses it", async () => {
    const fetch = fakeShippo({ token: TOKEN });
    const refused = async (provider: ShippoProvider, request: ParcelRequest) => {
      const error = await provider.rates(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ShippingProviderError);
      return (error as ShippingProviderError).status;
    };
    expect(await refused(new ShippoProvider({ apiKey: "shippo_test_other", fetch }), REQUEST)).toBe(401);
    const provider = new ShippoProvider({ apiKey: TOKEN, fetch });
    expect(await refused(provider, { ...REQUEST, to: { ...REQUEST.to, zip: "" } })).toBe(400);
    expect(await refused(provider, { ...REQUEST, weightG: 0 })).toBe(400);
    expect(await refused(new ShippoProvider({ apiKey: "", fetch }), REQUEST)).toBe(0);
  });
});
