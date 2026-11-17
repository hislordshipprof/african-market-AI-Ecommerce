import { describe, expect, it } from "vitest";
import { parseTrackUpdated, ShippoProvider, signShippoWebhook, verifyShippoSignature } from "./shippo";
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

describe("Shippo labels and tracking (#568)", () => {
  it("buys the quoted rate as a PDF label with its tracking number, and voids it until the carrier scans it", async () => {
    let now = NOW;
    const fetch = fakeShippo({ token: TOKEN, now: () => now });
    const provider = new ShippoProvider({ apiKey: TOKEN, fetch, now: () => now });
    const [rate] = await provider.rates(REQUEST);

    const label = await provider.buyLabel(rate.rateId, "order1");
    expect(fetch.calls.at(-1)).toEqual({ rate: rate.rateId, label_file_type: "PDF_4x6", async: false, metadata: "order1" });
    expect(label).toMatchObject({ labelId: expect.stringMatching(/^txn_/), trackingNumber: expect.any(String), trackingUrl: expect.stringMatching(/^https:/) });
    expect(new TextDecoder().decode((await provider.downloadLabel(label.labelUrl)).subarray(0, 5))).toBe("%PDF-");
    expect(await provider.voidLabel(label.labelId)).toBe("voided");

    const [other] = await provider.rates(REQUEST);
    const scanned = await provider.buyLabel(other.rateId, "order2");
    fetch.scan(scanned.labelId);
    expect(await provider.voidLabel(scanned.labelId)).toBe("refused");

    // A rate past Shippo's 7-day window is not sold.
    const [old] = await provider.rates(REQUEST);
    now = new Date(NOW.getTime() + 7 * 24 * 60 * 60_000);
    await expect(provider.buyLabel(old.rateId, "order3")).rejects.toBeInstanceOf(ShippingProviderError);
  });

  it("accepts only a fresh HMAC signature over the exact body, and reads the transaction and status id from track_updated", () => {
    const body = JSON.stringify({ event: "track_updated", test: false, data: { transaction: "txn_1", tracking_status: { object_id: "ts_1", status: "TRANSIT" } } });
    const header = signShippoWebhook(body, "secret", NOW);
    expect(verifyShippoSignature(body, header, "secret", NOW)).toBe(true);
    expect(verifyShippoSignature(`${body} `, header, "secret", NOW)).toBe(false);
    expect(verifyShippoSignature(body, header, "other", NOW)).toBe(false);
    expect(verifyShippoSignature(body, header, "secret", new Date(NOW.getTime() + 301_000))).toBe(false);
    expect(verifyShippoSignature(body, null, "secret", NOW)).toBe(false);
    expect(verifyShippoSignature(body, "t=1,v1=zz", "secret", NOW)).toBe(false);

    expect(parseTrackUpdated(body)).toMatchObject({ eventId: "ts_1", labelId: "txn_1", status: "TRANSIT", test: false });
    expect(parseTrackUpdated(JSON.stringify({ event: "transaction_created", data: {} }))).toBeNull();
    expect(parseTrackUpdated(JSON.stringify({ event: "track_updated", data: { transaction: "txn_1", tracking_status: { object_id: "ts_1", status: "LOST" } } }))).toBeNull();
    expect(parseTrackUpdated("not json")).toBeNull();
  });
});
