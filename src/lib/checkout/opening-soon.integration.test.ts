import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { state, getStripeClient } = vi.hoisted(() => ({
  state: { headers: new Headers() },
  getStripeClient: vi.fn(() => {
    throw new Error("Stripe must not be called");
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => () => fn(), revalidateTag: () => {}, revalidatePath: () => {} }));
vi.mock("../stripe/provider", () => ({ getStripeClient }));

import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { createPaymentIntentAction, placeOrderAction } from "./actions";
import * as checkoutService from "./service";
import { STORE_OFFLINE, STORE_OPENING_SOON } from "../stripe/checkout-gate";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t555o-${Date.now().toString(36)}`;
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t555.test" };

describe.skipIf(!hasDb)("checkout refuses a store that is not live, before any Stripe call (#555)", () => {
  let raw: PrismaClient;
  const ids: string[] = [];

  beforeAll(async () => {
    raw = testPrismaClient();
    for (const status of ["setup", "suspended"]) {
      const store = await raw.store.create({
        data: { slug: `${RUN}-${status}`, name: `${status} market`, status, stripeOnboardingStatus: "complete", stripeAccountId: `acct_${RUN}_${status}`, pickupEnabled: true },
      });
      ids.push(store.id);
    }
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { id: { in: ids } } });
    await raw.$disconnect();
  });

  it.each([
    ["setup", STORE_OPENING_SOON],
    ["suspended", STORE_OFFLINE],
  ])("a store in %s gets no PaymentIntent and no order", async (status, message) => {
    state.headers = new Headers({ "x-store-slug": `${RUN}-${status}` });
    const intent = vi.spyOn(checkoutService, "createPaymentIntent");
    const place = vi.spyOn(checkoutService, "placeOrder");
    try {
      expect(await createPaymentIntentAction(CONTACT, "pickup")).toEqual({ ok: false, error: message });
      expect(await placeOrderAction("pi_t555", CONTACT, "pickup", "", "asap")).toEqual({ ok: false, error: message });
      expect(intent).not.toHaveBeenCalled();
      expect(place).not.toHaveBeenCalled();
      expect(getStripeClient).not.toHaveBeenCalled();
    } finally {
      intent.mockRestore();
      place.mockRestore();
    }
  });
});
