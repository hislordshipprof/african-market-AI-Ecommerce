import { describe, expect, it } from "vitest";
import { UberDirectProvider } from "./uber-direct";
import { fakeUberDirect } from "./uber-direct-fake";
import type { DeliveryProvider, DeliveryRequest } from "./provider";

const now = new Date("2026-11-13T15:00:00Z");
let clientSeq = 0;

interface SetupOptions {
  env?: Record<string, string | undefined>;
  clock?: { at: Date };
  quoteFeeCents?: number;
  tokenTtlSeconds?: number;
  /** Replaces what api.uber.com answers; the token endpoint stays the fake's. */
  api?: () => Promise<Response>;
}

function setup(overrides: SetupOptions = {}) {
  // A fresh client id per test keeps the module's token cache from leaking between tests.
  const keys = {
    UBER_DIRECT_CLIENT_ID: `client-${++clientSeq}`,
    UBER_DIRECT_CLIENT_SECRET: "test-client-secret",
    UBER_DIRECT_CUSTOMER_ID: "a418e2aa-0000-4000-8000-000000000001",
  };
  const clock = overrides.clock ?? { at: now };
  const fake = fakeUberDirect({
    clientId: keys.UBER_DIRECT_CLIENT_ID,
    clientSecret: keys.UBER_DIRECT_CLIENT_SECRET,
    customerId: keys.UBER_DIRECT_CUSTOMER_ID,
    now: () => clock.at,
    quoteFeeCents: overrides.quoteFeeCents,
    tokenTtlSeconds: overrides.tokenTtlSeconds,
  });
  const api = overrides.api;
  const doFetch: typeof fetch = (input, init) =>
    api && String(input).startsWith("https://api.uber.com") ? api() : fake.fetch(input as string, init);
  const provider: DeliveryProvider = new UberDirectProvider({ env: overrides.env ?? keys, fetch: doFetch, now: () => clock.at });
  return { fake, provider, keys };
}

const request: DeliveryRequest = {
  externalDeliveryId: "ord_123-1",
  pickup: {
    businessName: "Mama Ada Market",
    address: { line1: "100 Main St", city: "Silver Spring", state: "MD", zip: "20910" },
    phone: "+13015550100",
    providerStoreId: "store_abc",
  },
  dropoff: {
    address: { line1: "5 Elm Ave", line2: "Apt 2", city: "Silver Spring", state: "MD", zip: "20901" },
    phone: "+13015550199",
    givenName: "Ngozi",
    familyName: "Okafor",
    instructions: "Ring twice",
  },
  orderValueCents: 6000,
  tipCents: 0,
};

describe("UberDirectProvider", () => {
  it("quotes Uber's fee in cents with no markup, Uber's expiry and ETAs", async () => {
    const { provider, fake } = setup({ quoteFeeCents: 799 });
    const quote = await provider.quote(request);
    expect(quote).toEqual({
      quoteId: expect.stringMatching(/^dqt_/),
      feeCents: 799,
      currency: "USD",
      pickupEta: new Date("2026-11-13T15:12:00Z"),
      dropoffEta: new Date("2026-11-13T15:55:00Z"),
      expiresAt: new Date("2026-11-13T15:15:00Z"),
    });
    const sent = fake.calls.find((c) => c.path.endsWith("/delivery_quotes"))!.body!;
    expect(JSON.parse(String(sent.dropoff_address))).toEqual({
      street_address: ["5 Elm Ave", "Apt 2"],
      city: "Silver Spring",
      state: "MD",
      zip_code: "20901",
      country: "US",
    });
    expect(sent).toMatchObject({ manifest_total_value: 6000, external_store_id: "store_abc" });
  });

  it("creates the quoted delivery with Uber's id and tracking link, and cancels it once", async () => {
    const { provider, fake } = setup();
    const quote = await provider.quote(request);
    const created = await provider.create(quote.quoteId, request);
    expect(created).toEqual({
      externalId: expect.stringMatching(/^del_/),
      trackingUrl: `https://www.ubereats.com/orders/${created.externalId}`,
    });
    expect(fake.calls.find((c) => c.path.endsWith("/deliveries"))!.body).toMatchObject({
      quote_id: quote.quoteId,
      pickup_name: "Mama Ada Market",
      dropoff_name: "Ngozi Okafor",
      dropoff_notes: "Ring twice",
      external_id: "ord_123-1",
      manifest_total_value: 6000,
      tip: 0,
    });
    await expect(provider.create(quote.quoteId, request)).rejects.toMatchObject({ provider: "uber", status: 409 });
    await provider.cancel(created.externalId);
    await expect(provider.cancel(created.externalId)).rejects.toMatchObject({ status: 409, code: "noncancelable_delivery" });
  });

  it("shares one token across concurrent calls and gets a new one only once it expires", async () => {
    const clock = { at: now };
    const { provider, fake } = setup({ clock, tokenTtlSeconds: 3600 });
    await Promise.all([provider.quote(request), provider.quote(request), provider.quote(request)]);
    expect(fake.tokenRequests).toBe(1);

    clock.at = new Date(now.getTime() + 30 * 60_000);
    await provider.quote(request);
    expect(fake.tokenRequests).toBe(1);

    clock.at = new Date(now.getTime() + 60 * 60_000);
    await provider.quote(request);
    expect(fake.tokenRequests).toBe(2);
  });

  it("fails clearly when keys are missing, and maps 4xx, 5xx and timeouts to provider errors", async () => {
    const missing = setup({ env: { UBER_DIRECT_CLIENT_ID: "client-x" } });
    await expect(missing.provider.quote(request)).rejects.toThrow(/UBER_DIRECT_CLIENT_SECRET, UBER_DIRECT_CUSTOMER_ID/);
    expect(missing.fake.calls).toEqual([]);

    const { keys } = setup();
    const wrongSecret = setup({ env: { ...keys, UBER_DIRECT_CLIENT_SECRET: "wrong" } });
    await expect(wrongSecret.provider.quote(request)).rejects.toMatchObject({ provider: "uber", status: 401, code: "invalid_client" });

    const rejected = setup({
      api: async () =>
        new Response(
          JSON.stringify({ code: "address_undeliverable", message: "The specified location is not in a deliverable area.", kind: "error" }),
          { status: 400 },
        ),
    });
    await expect(rejected.provider.quote(request)).rejects.toMatchObject({ provider: "uber", status: 400, code: "address_undeliverable" });

    const down = setup({
      api: async () => new Response(JSON.stringify({ code: "service_unavailable", message: "try later", kind: "error" }), { status: 503 }),
    });
    await expect(down.provider.quote(request)).rejects.toMatchObject({ provider: "uber", status: 503, code: "service_unavailable" });

    const slow = setup({
      api: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    await expect(slow.provider.quote(request)).rejects.toMatchObject({ provider: "uber", status: 504, code: "timeout" });
  });
});
