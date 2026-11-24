import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createPaymentIntentAction, placeOrderAction, quoteCheckoutAction } from "../checkout/actions";
import * as checkoutService from "../checkout/service";
import * as lookup from "./lookup";
import OrderPage from "@/app/order/[token]/page";
import SubstitutionsPage from "@/app/order/[token]/substitutions/page";
import ReportPage from "@/app/order/[token]/report/page";

const hasDb = !!process.env.DATABASE_URL;

/** Every `description` prop in the page's element tree, without rendering client components. */
/** All text in the page's element tree, joined, without rendering client components. */
/** The receipt's money rows (FeeLine props) as "label cents"; the element tree is not rendered, so their text is in props. */
function feeLines(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(feeLines);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const props = (node as { props: { label?: unknown; cents?: unknown; children?: unknown } }).props;
  const own = typeof props.label === "string" && typeof props.cents === "number" ? [`${props.label} ${props.cents}`] : [];
  return [...own, ...feeLines(props.children)];
}

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

  async function createOrder(
    storeId: string,
    sourceCartId: string | null = null,
    trackingToken: string | null = newTrackingToken(),
  ) {
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
          trackingToken,
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
      await storeScoped(id).storeCoupon.deleteMany({});
      await storeScoped(id).cart.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.user.deleteMany({ where: { id: `trk-${suffix}` } });
    await raw.$disconnect();
  });

  it("a valid token renders the order without a session", async () => {
    const order = await createOrder(storeA);
    const page = await render(slugA, order.trackingToken!);
    expect(headingDescriptions(page)).toContain(`Order #${order.number} · Track A`);
  });

  it("#557: the money summary shows the promo code and the discount, and only when there is one", async () => {
    const plain = await createOrder(storeA);
    expect(feeLines(await render(slugA, plain.trackingToken!)).join("|")).not.toContain("Promo");
    const order = await createOrder(storeA);
    const owner = await raw.user.create({ data: { id: `trk-${suffix}`, name: "Owner", email: `trk-${suffix}@example.com` } });
    const coupon = await storeScoped(storeA).storeCoupon.create({
      data: { storeId: storeA, code: "SAVE10", kind: "fixed", amountOffCents: 200, startsAt: new Date("2026-01-01T00:00:00Z"), createdById: owner.id },
    });
    await storeScoped(storeA).order.update({ where: { id: order.id }, data: { couponId: coupon.id, discountCents: 200 } });
    expect(feeLines(await render(slugA, order.trackingToken!))).toContain("Promo SAVE10 -200");
  });

  it("the order id of an order that has a tracking token is a 404, with no session", async () => {
    const order = await createOrder(storeA);
    await expect(render(slugA, order.id)).rejects.toThrow("NOT_FOUND");
  });

  it("an order made before tokens still opens by its id", async () => {
    const order = await createOrder(storeA, null, null);
    const page = await render(slugA, order.id);
    expect(headingDescriptions(page)).toContain(`Order #${order.number} · Track A`);
  });

  it("a database error reaches the error page instead of a 404", async () => {
    vi.spyOn(lookup, "findOrderForTracking").mockRejectedValue(new Error("db down"));
    await expect(render(slugA, newTrackingToken())).rejects.toThrow("db down");
  });

  it("an unknown token is a 404", async () => {
    await expect(render(slugA, newTrackingToken())).rejects.toThrow("NOT_FOUND");
  });

  it("another store's token is a 404", async () => {
    const order = await createOrder(storeB);
    await expect(render(slugA, order.trackingToken!)).rejects.toThrow("NOT_FOUND");
  });

  describe("on the production alias, where stores are named by ?store= (#796)", () => {
    const alias = "african-market-ai-ecommerce.vercel.app";

    beforeEach(() => {
      vi.stubEnv("PLATFORM_ROOT_DOMAIN", "");
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", alias);
      headerState.set("host", alias);
    });

    afterEach(() => {
      headerState.delete("host");
      headerState.delete("x-store-slug");
      vi.unstubAllEnvs();
    });

    it("a bookmark with no store opens its own store's order", async () => {
      const order = await createOrder(storeB);
      headerState.delete("x-store-slug");
      await expect(OrderPage({ params: Promise.resolve({ token: order.trackingToken! }), searchParams: Promise.resolve({}) }))
        .rejects.toThrow(`REDIRECT:/order/${order.trackingToken}?store=${slugB}`);
    });

    it("a browser that last saw another store is sent to the order's store", async () => {
      const order = await createOrder(storeB);
      await expect(render(slugA, order.trackingToken!)).rejects.toThrow(`REDIRECT:/order/${order.trackingToken}?store=${slugB}`);
      await expect(SubstitutionsPage({ params: Promise.resolve({ token: order.trackingToken! }) }))
        .rejects.toThrow(`REDIRECT:/order/${order.trackingToken}/substitutions?store=${slugB}`);
      await expect(ReportPage({ params: Promise.resolve({ token: order.trackingToken! }) }))
        .rejects.toThrow(`REDIRECT:/order/${order.trackingToken}/report?store=${slugB}`);
    });

    it("the order's own store renders it, and an unknown token is still a 404", async () => {
      const order = await createOrder(storeB);
      expect(headingDescriptions(await render(slugB, order.trackingToken!))).toContain(`Order #${order.number} · Track B`);
      await expect(render(slugA, newTrackingToken())).rejects.toThrow("NOT_FOUND");
    });
  });

  it("checkout sends the shopper to the tracking token, not the order id", async () => {
    const cart = await storeScoped(storeA).cart.create({ data: { storeId: storeA, userId: null, source: "manual" } });
    const order = await createOrder(storeA, cart.id);
    headerState.set("x-store-slug", slugA);
    cookieJar.set("cart_id", cart.id);

    const contact = { name: "Ada Buyer", email: "ada@example.com", phone: "2025550100" };
    const result = await createPaymentIntentAction(contact, "pickup");
    expect(result).toEqual({ ok: true, orderedToken: order.trackingToken });
    const quoted = await quoteCheckoutAction(contact, "pickup");
    expect(quoted).toMatchObject({ ok: true, orderedToken: order.trackingToken });
  });

  it("a resumed order reports the tracking token, never the order id", async () => {
    const cart = await storeScoped(storeA).cart.create({ data: { storeId: storeA, userId: null, source: "manual" } });
    const order = await createOrder(storeA, cart.id);
    headerState.set("x-store-slug", slugA);
    cookieJar.set("cart_id", cart.id);
    vi.spyOn(checkoutService, "placeOrder").mockResolvedValue({
      token: order.id,
      trackingToken: order.trackingToken,
      quote: {} as never,
    });

    const placed = await placeOrderAction(
      "pi_1",
      { name: "Ada Buyer", email: "ada@example.com", phone: "2025550100" },
      "pickup",
      "",
      "asap",
    );
    expect(placed).toEqual({ ok: true, token: order.trackingToken });

    const resumed = await createPaymentIntentAction(
      { name: "Ada Buyer", email: "ada@example.com", phone: "2025550100" },
      "pickup",
    );
    expect(resumed).toEqual({ ok: true, orderedToken: order.trackingToken });
  });
});
