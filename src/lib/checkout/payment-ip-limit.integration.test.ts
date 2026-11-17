import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { headers: new Headers(), cartId: "" } }));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) => (name === "cart_id" && state.cartId ? { name, value: state.cartId } : undefined),
    getAll: () => [],
    has: () => false,
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => () => fn(), revalidateTag: () => {}, revalidatePath: () => {} }));

import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { authPrisma, storeScoped } from "../db";
import { createPaymentIntentAction } from "./actions";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t713p-${Date.now().toString(36)}`;
const CONTACT = { name: "Ada Buyer", phone: "+15551234567", email: "ada@t713.test" };
const IP = `198.51.100.${(Date.now() % 200) + 20}`;
const OTHER_IP = `203.0.113.${(Date.now() % 200) + 20}`;

describe.skipIf(!hasDb)("payment setup is limited per IP as well as per cart (#713)", () => {
  let raw: PrismaClient;
  let storeId = "";

  async function attempt(ip: string) {
    state.headers = new Headers({ "x-store-slug": RUN, "x-forwarded-for": ip });
    state.cartId = (await storeScoped(storeId).cart.create({ data: { storeId } })).id;
    return createPaymentIntentAction(CONTACT, "pickup");
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeId = (await raw.store.create({
      data: { slug: RUN, name: "IP limit market", status: "active", stripeOnboardingStatus: "complete", stripeAccountId: `acct_${RUN}`, pickupEnabled: true },
    })).id;
  });

  afterAll(async () => {
    await authPrisma.appRateLimit.deleteMany({ where: { key: { in: [`payment:ip:${IP}`, `payment:ip:${OTHER_IP}`] } } });
    await storeScoped(storeId).cart.deleteMany({});
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("the 21st attempt in an hour from one IP is refused even on a fresh cart; another IP is not", async () => {
    for (let i = 0; i < 20; i++) {
      const result = await attempt(IP);
      expect(result.ok === false && "code" in result ? result.code : undefined).not.toBe("RATE_LIMITED");
    }
    expect(await attempt(IP)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(await attempt(OTHER_IP)).not.toMatchObject({ code: "RATE_LIMITED" });
  }, 60_000);
});
