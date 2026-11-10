import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { headerState, cookieJar } = vi.hoisted(() => ({
  headerState: new Headers(),
  cookieJar: new Map<string, string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => headerState,
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
  }),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { auth } from "../auth";
import { storeScoped, storeScopedTransaction } from "../db";
import { newTrackingToken } from "./record";
import { createPaymentIntentAction } from "../checkout/actions";
import OrderPage from "@/app/order/[token]/page";

const hasDb = !!process.env.DATABASE_URL;

/** Every `description` prop in the page's element tree, without rendering client components. */
function headingDescriptions(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(headingDescriptions);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const props = (node as { props: { description?: unknown; children?: unknown } }).props;
  const own = typeof props.description === "string" ? [props.description] : [];
  return [...own, ...headingDescriptions(props.children)];
}
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)("order tracking by token", () => {
  let raw: PrismaClient;
  const slugA = `track-a-${suffix}`;
  const slugB = `track-b-${suffix}`;
  let storeA: string;
  let storeB: string;
  let orderNumber = 500;

  async function createOrder(storeId: string, sourceCartId: string | null = null) {
    const customerId = (await storeScoped(storeId).customer.create({
      data: { storeId, name: "Track Customer", email: `track-${suffix}-${orderNumber}@example.com`, phone: "+15559990002" },
    })).id;
    return storeScopedTransaction(storeId, (tx) =>
      tx.order.create({
        data: {
          storeId,
          number: ++orderNumber,
          customerId,
          sourceCartId,
          trackingToken: newTrackingToken(),
          subtotalCents: 1000,
          bufferCents: 100,
          totalAuthorizedCents: 1100,
          totalCents: 1000,
        },
      }),
    );
  }

  function render(slug: string, token: string) {
    headerState.set("x-store-slug", slug);
    return OrderPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({
      data: { slug: slugA, name: "Track A", themePreset: "palm-and-shea", stripeOnboardingStatus: "complete" },
    })).id;
    storeB = (await raw.store.create({ data: { slug: slugB, name: "Track B", themePreset: "palm-and-shea" } })).id;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("NEXT_PUBLIC_DEMO_FLOWS", "");
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    cookieJar.clear();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const id of [storeA, storeB]) {
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).cart.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("a valid token renders the order without a session", async () => {
    const order = await createOrder(storeA);
    const page = await render(slugA, order.trackingToken!);
    expect(headingDescriptions(page)).toContain(`Order #${order.number} · Track A`);
  });

  it("an unknown token is a 404", async () => {
    await expect(render(slugA, newTrackingToken())).rejects.toThrow("NOT_FOUND");
  });

  it("another store's token is a 404", async () => {
    const order = await createOrder(storeB);
    await expect(render(slugA, order.trackingToken!)).rejects.toThrow("NOT_FOUND");
  });

  it("checkout sends the shopper to the tracking token, not the order id", async () => {
    const cart = await storeScoped(storeA).cart.create({ data: { storeId: storeA, userId: null, source: "manual" } });
    const order = await createOrder(storeA, cart.id);
    headerState.set("x-store-slug", slugA);
    cookieJar.set("cart_id", cart.id);

    const result = await createPaymentIntentAction(
      { name: "Ada Buyer", email: "ada@example.com", phone: "2025550100" },
      "pickup",
    );
    expect(result).toEqual({ ok: true, orderedToken: order.trackingToken });
  });
});
