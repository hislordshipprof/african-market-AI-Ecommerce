import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction } from "../db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
// The store the request's host resolves to.
const request = vi.hoisted(() => ({ slug: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-store-slug": request.slug }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));

const { getFlowContext } = await import("./server");

const hasDb = Boolean(process.env.DATABASE_URL);
// Only this file allows Kansas, so the e2e seed's states and other files' are left alone.
const ALLOWED = "KS";

describe.skipIf(!hasDb)("checkout offers store delivery and Ship only when their setup is complete (#765, lane DB)", () => {
  const raw = testPrismaClient();
  let storeId = "";

  beforeAll(async () => {
    const store = await platformAdmin.store.create({
      data: {
        slug: `t765-${crypto.randomUUID().slice(0, 8)}`, name: "Setup Market", pickupEnabled: true,
        storeDeliveryEnabled: true, storeDeliveryFeeCents: 500, deliveryRadiusMi: 8, lat: 29.7604, lng: -95.3698,
        addressLine1: "100 Main St", city: "Houston", state: "TX", zip: "77002", shippingHandlingDays: 2,
      },
    });
    storeId = store.id;
    request.slug = store.slug;
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_append(array_remove(shipping_states, ${ALLOWED}), ${ALLOWED}) WHERE id = 'platform'`));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await platformAdminTransaction((tx) => tx.$executeRaw(Prisma.sql`UPDATE platform_settings SET shipping_states = array_remove(shipping_states, ${ALLOWED}) WHERE id = 'platform'`));
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  function setup(proofBucket: string, fakeShippo: string) {
    vi.stubEnv("R2_PROOF_BUCKET", proofBucket);
    vi.stubEnv("SHIPPO_API_KEY", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("E2E_FAKE_SHIPPO", fakeShippo);
  }

  it("offers both once the proof bucket and Shippo are set", async () => {
    setup("proof-bucket", "1");
    const { settings } = await getFlowContext();
    expect(settings.storeDeliveryEnabled).toBe(true);
    expect(settings.shipsTo).toContain(ALLOWED);
  });

  it("hides both without the proof bucket: a delivery photo or a label PDF would have nowhere to go", async () => {
    setup("", "1");
    const { settings } = await getFlowContext();
    expect(settings.storeDeliveryEnabled).toBe(false);
    expect(settings.shipsTo).toEqual([]);
  });

  it("hides only Ship without Shippo: no label can be bought", async () => {
    setup("proof-bucket", "");
    const { settings } = await getFlowContext();
    expect(settings.storeDeliveryEnabled).toBe(true);
    expect(settings.shipsTo).toEqual([]);
  });
});
