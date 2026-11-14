import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform, platformAdmin } from "@/lib/db";
import { registerStoreWithUberDirect } from "./uber-direct-registration";
import { fakeUberDirect } from "./uber-direct-fake";

const now = new Date("2026-11-13T15:00:00Z");
const customerId = "a418e2aa-0000-4000-8000-000000000001";

function setup(clientId: string, api?: () => Promise<Response>) {
  const keys = { UBER_DIRECT_CLIENT_ID: clientId, UBER_DIRECT_CLIENT_SECRET: "test-client-secret", UBER_DIRECT_CUSTOMER_ID: customerId };
  const fake = fakeUberDirect({ clientId, clientSecret: keys.UBER_DIRECT_CLIENT_SECRET, customerId, now: () => now });
  const doFetch: typeof fetch = (input, init) =>
    api && String(input).startsWith("https://api.uber.com") ? api() : fake.fetch(input as string, init);
  return { fake, opts: { env: keys, fetch: doFetch, now: () => now } };
}

describe.skipIf(!process.env.DATABASE_URL)("registerStoreWithUberDirect", () => {
  let raw: PrismaClient;
  let storeId = "";
  let slug = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    slug = `uber-reg-${Date.now().toString(36)}`;
    storeId = (await raw.store.create({
      data: {
        slug,
        name: "Mama Ada Market",
        addressLine1: "100 Main St",
        addressLine2: "Unit 4",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
      },
    })).id;
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("on an Uber error logs it, sets no uberLocationId and flags the store for retry", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { opts } = setup("client-reg-down", async () =>
      new Response(JSON.stringify({ code: "service_unavailable", message: "try later", kind: "error" }), { status: 503 }),
    );
    const store = await platform.store.findUniqueOrThrow({ where: { id: storeId } });

    const result = await registerStoreWithUberDirect(store, opts);

    expect(result).toMatchObject({ ok: false });
    const saved = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(saved.uberLocationId).toBeNull();
    expect(saved.uberRegistrationError).toMatch(/503/);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("when saving the new organization fails, logs its organization_id so it can be linked by hand", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = platformAdmin.store;
    const update = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({});
    platformAdmin.store = { update } as unknown as typeof real;
    const { fake, opts } = setup("client-reg-save-fails");
    const store = await platform.store.findUniqueOrThrow({ where: { id: storeId } });

    try {
      const result = await registerStoreWithUberDirect(store, opts);

      expect(result).toMatchObject({ ok: false, error: "db down" });
      const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(fake.organizations[0].organization_id);
    } finally {
      platformAdmin.store = real;
      errors.mockRestore();
    }
  });

  it("registers the store as an Uber Direct organization, stores uberLocationId, clears the flag, and does nothing once registered", async () => {
    const { fake, opts } = setup("client-reg-ok");
    const store = await platform.store.findUniqueOrThrow({ where: { id: storeId } });

    const result = await registerStoreWithUberDirect(store, opts);

    expect(result).toEqual({ ok: true, uberLocationId: fake.organizations[0].organization_id });
    expect(fake.organizations[0]).toMatchObject({
      info: {
        name: `Mama Ada Market (${slug})`,
        billing_type: "BILLING_TYPE_CENTRALIZED",
        address: { street1: "100 Main St", street2: "Unit 4", city: "Silver Spring", state: "MD", zipcode: "20910", country_iso2: "US" },
      },
      hierarchy_info: { parent_organization_id: customerId },
    });
    const saved = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(saved.uberLocationId).toBe(fake.organizations[0].organization_id);
    expect(saved.uberRegistrationError).toBeNull();

    const callsBefore = fake.calls.length;
    expect(await registerStoreWithUberDirect(saved, opts)).toEqual(result);
    expect(fake.calls.length).toBe(callsBefore);
  });
});
