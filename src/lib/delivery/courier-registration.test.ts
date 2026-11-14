import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform } from "@/lib/db";
import { findStoresNeedingCourierRegistration, registerStoreCouriers } from "./courier-registration";
import { fakeUberDirect } from "./uber-direct-fake";
import { fakeDoorDash } from "./doordash-fake";

const now = new Date("2026-11-13T15:00:00Z");
const customerId = "a418e2aa-0000-4000-8000-000000000001";
const uberKeys = { UBER_DIRECT_CLIENT_ID: "client-courier-reg", UBER_DIRECT_CLIENT_SECRET: "test-client-secret", UBER_DIRECT_CUSTOMER_ID: customerId };
const doordashKeys = {
  DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
  DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
  DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
};

function fakes(doordashDown = false) {
  const uber = fakeUberDirect({ clientId: uberKeys.UBER_DIRECT_CLIENT_ID, clientSecret: uberKeys.UBER_DIRECT_CLIENT_SECRET, customerId, now: () => now });
  const doordash = fakeDoorDash({ developerId: doordashKeys.DOORDASH_DEVELOPER_ID, keyId: doordashKeys.DOORDASH_KEY_ID, signingSecret: doordashKeys.DOORDASH_SIGNING_SECRET, now: () => now });
  const doordashFetch: typeof fetch = doordashDown
    ? async () => new Response(JSON.stringify({ code: "service_unavailable", message: "try later" }), { status: 503 })
    : (input, init) => doordash.fetch(input as string, init);
  return {
    uber,
    doordash,
    opts: {
      uber: { env: uberKeys, fetch: (input: RequestInfo | URL, init?: RequestInit) => uber.fetch(input as string, init), now: () => now },
      doordash: { env: doordashKeys, fetch: doordashFetch, now: () => now },
    },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("courier registration at onboarding (#526)", () => {
  let raw: PrismaClient;
  const ids: string[] = [];

  async function makeStore(address: boolean) {
    const stamp = `${Date.now().toString(36)}-${ids.length}`;
    const store = await raw.store.create({
      data: {
        slug: `courier-reg-${stamp}`,
        name: "Mama Ada Market",
        ...(address ? { addressLine1: "100 Main St", city: "Silver Spring", state: "MD", zip: "20910" } : {}),
      },
    });
    ids.push(store.id);
    return store.id;
  }

  beforeAll(() => {
    raw = testPrismaClient();
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { id: { in: ids } } });
    await raw.$disconnect();
  });

  it("a DoorDash failure is saved on the store, does not stop Uber, and a retry finishes it and clears the error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const storeId = await makeStore(true);

    const down = fakes(true);
    await registerStoreCouriers(storeId, down.opts);

    const failed = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(failed.uberLocationId).toBe(down.uber.organizations[0].organization_id);
    expect(failed.doordashStoreId).toBeNull();
    expect(failed.doordashRegistrationError).toMatch(/503/);
    expect((await findStoresNeedingCourierRegistration(500)).map((s) => s.id)).toContain(storeId);

    const up = fakes();
    await registerStoreCouriers(storeId, up.opts);

    const done = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(done.uberLocationId).toBe(failed.uberLocationId);
    expect(up.uber.organizations).toHaveLength(0);
    expect(done.doordashStoreId).toBe(storeId);
    expect(done.doordashRegistrationError).toBeNull();
    expect((await findStoresNeedingCourierRegistration(500)).map((s) => s.id)).not.toContain(storeId);
    errors.mockRestore();
  });

  it("the retry job picks up an existing store with an address and no registration, and skips one without an address", async () => {
    const unregistered = await makeStore(true);
    const noAddress = await makeStore(false);

    const found = (await findStoresNeedingCourierRegistration(500)).map((s) => s.id);

    expect(found).toContain(unregistered);
    expect(found).not.toContain(noAddress);
  });
});
