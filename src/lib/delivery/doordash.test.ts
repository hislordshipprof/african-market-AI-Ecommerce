import { describe, expect, it } from "vitest";
import { DoorDashDriveProvider, DoorDashWebhookAuthError } from "./doordash";
import { fakeDoorDash } from "./doordash-fake";
import { DeliveryProviderError, type DeliveryProvider, type DeliveryRequest } from "./provider";

const now = new Date("2026-11-12T15:00:00Z");
const keys = {
  DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
  DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
  DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
};

function setup(env: Record<string, string | undefined> = keys, quoteFeeCents = 850) {
  const fake = fakeDoorDash({
    developerId: keys.DOORDASH_DEVELOPER_ID,
    keyId: keys.DOORDASH_KEY_ID,
    signingSecret: keys.DOORDASH_SIGNING_SECRET,
    now: () => now,
    quoteFeeCents,
  });
  const provider: DeliveryProvider = new DoorDashDriveProvider({ env, fetch: fake.fetch, now: () => now });
  return { fake, provider };
}

const request: DeliveryRequest = {
  externalDeliveryId: "ord_123-1",
  pickup: {
    businessName: "Mama Ada Market",
    address: { line1: "100 Main St", city: "Silver Spring", state: "MD", zip: "20910" },
    phone: "+13015550100",
    providerBusinessId: "store_abc",
    providerStoreId: "store_abc",
  },
  dropoff: {
    address: { line1: "5 Elm Ave", line2: "Apt 2", city: "Silver Spring", state: "MD", zip: "20901" },
    phone: "+13015550199",
    givenName: "Ngozi",
    contactless: true,
  },
  orderValueCents: 6000,
  tipCents: 0,
};

describe("DoorDashDriveProvider", () => {
  it("quotes DoorDash's fee in cents with no markup, valid for DoorDash's 5 minutes", async () => {
    const { provider } = setup(keys, 850);
    const quote = await provider.quote(request);
    expect(quote).toEqual({
      quoteId: "ord_123-1",
      feeCents: 850,
      currency: "USD",
      pickupEta: new Date("2026-11-12T15:20:00Z"),
      dropoffEta: new Date("2026-11-12T15:45:00Z"),
      expiresAt: new Date("2026-11-12T15:05:00Z"),
    });
  });

  it("creates the quoted delivery with a tracking link, and cancels it once", async () => {
    const { provider } = setup();
    const quote = await provider.quote(request);
    expect(await provider.create(quote.quoteId, request)).toEqual({
      externalId: "ord_123-1",
      trackingUrl: "https://doordash.com/tracking?id=ord_123-1",
      pin: null,
    });
    await provider.cancel("ord_123-1");
    await expect(provider.cancel("ord_123-1")).rejects.toMatchObject({ status: 409, code: "cannot_be_cancelled" });
  });

  it("fails clearly at call time when keys are missing, and surfaces a rejected key as a provider error", async () => {
    const missing = setup({ DOORDASH_DEVELOPER_ID: keys.DOORDASH_DEVELOPER_ID });
    await expect(missing.provider.quote(request)).rejects.toThrow(/DOORDASH_KEY_ID, DOORDASH_SIGNING_SECRET/);
    expect(missing.fake.calls).toEqual([]);

    const wrong = setup({ ...keys, DOORDASH_SIGNING_SECRET: Buffer.from("another-secret").toString("base64url") });
    const error = await wrong.provider.quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryProviderError);
    expect(error).toMatchObject({ provider: "doordash", status: 401 });
  });

  it("asks for a photo on a standard drop-off, and for our PIN with no contactless drop-off when one is set", async () => {
    const { provider, fake } = setup();
    await provider.quote(request);
    const pinned = { ...request, externalDeliveryId: "ord_123-2", dropoffPin: "4821" };
    await provider.quote(pinned);
    expect(await provider.create("ord_123-2", pinned)).toMatchObject({ pin: "4821" });
    const [standard, pin] = fake.calls.filter((c) => c.path === "/drive/v2/quotes").map((c) => c.body);
    expect(standard).toMatchObject({ contactless_dropoff: true, dropoff_options: { proof_of_delivery: "photo_required" } });
    expect(standard).not.toHaveProperty("dropoff_pin_code_verification_metadata");
    expect(pin).toMatchObject({
      contactless_dropoff: false,
      dropoff_options: { proof_of_delivery: "pin_code" },
      dropoff_pin_code_verification_metadata: { pin_code_value: "4821" },
    });
  });

  it("maps DoorDash webhook events to platform delivery events", () => {
    const authorization = "Basic d2ViaG9vazpzZWNyZXQ=";
    const provider = new DoorDashDriveProvider({ env: { ...keys, DOORDASH_WEBHOOK_AUTHORIZATION: authorization } });
    const raw = (body: Record<string, unknown>) =>
      JSON.stringify({ external_delivery_id: "ord_123-1", created_at: "2026-11-12T15:10:00Z", ...body });
    const event = (body: Record<string, unknown>) => provider.handleWebhook(raw(body), new Headers({ authorization }));

    const confirmed = event({
      event_name: "DASHER_CONFIRMED",
      dasher_name: "John D.",
      dasher_vehicle_make: "Toyota",
      dasher_vehicle_model: "Corolla",
      dropoff_time_estimated: "2026-11-12T15:40:00Z",
      tracking_url: "https://doordash.com/tracking?id=ord_123-1",
    });
    expect(confirmed).toMatchObject({
      provider: "doordash",
      externalDeliveryId: "ord_123-1",
      type: "courier_assigned",
      occurredAt: new Date("2026-11-12T15:10:00Z"),
      trackingUrl: "https://doordash.com/tracking?id=ord_123-1",
      courier: { name: "John D.", vehicle: "Toyota Corolla", dropoffEta: new Date("2026-11-12T15:40:00Z") },
    });
    expect(event({ event_name: "DASHER_PICKED_UP" }).type).toBe("picked_up");
    expect(event({ event_name: "DASHER_DROPPED_OFF", fee: 850, dropoff_verification_image_url: "https://img.doordash.com/p.jpg" })).toMatchObject({
      type: "delivered",
      actualFeeCents: 850,
      proof: { photoUrl: "https://img.doordash.com/p.jpg", pinEntered: null },
    });
    expect(event({ event_name: "DELIVERY_CANCELLED" }).type).toBe("cancelled");
    expect(event({ event_name: "DELIVERY_RETURNED" }).type).toBe("returned");
    expect(event({ event_name: "DASHER_CONFIRMED_PICKUP_ARRIVAL" }).type).toBeNull();

    expect(event({ event_name: "DASHER_PICKED_UP" }).externalEventId).toBe(event({ event_name: "DASHER_PICKED_UP" }).externalEventId);
    expect(event({ event_name: "DASHER_PICKED_UP" }).externalEventId).not.toBe(event({ event_name: "DASHER_DROPPED_OFF" }).externalEventId);
    expect(() => provider.handleWebhook(JSON.stringify({ event_name: "DASHER_PICKED_UP" }), new Headers({ authorization }))).toThrow();

    const body = raw({ event_name: "DASHER_PICKED_UP" });
    expect(() => provider.handleWebhook(body, new Headers())).toThrow(DoorDashWebhookAuthError);
    expect(() => provider.handleWebhook(body, new Headers({ authorization: "Basic d3Jvbmc=" }))).toThrow(DoorDashWebhookAuthError);
    expect(() => new DoorDashDriveProvider({ env: keys }).handleWebhook(body, new Headers({ authorization }))).toThrow(/DOORDASH_WEBHOOK_AUTHORIZATION/);
  });
});
