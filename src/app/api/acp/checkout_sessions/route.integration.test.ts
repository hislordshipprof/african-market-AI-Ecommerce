vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(currentSlug ? { "x-store-slug": currentSlug } : {}) }));
// A placement that fails for a reason placeOrder does not release the hold for (a DB error in the order write).
const placement = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/lib/checkout/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/checkout/service")>();
  return {
    ...actual,
    placeOrder: (...args: Parameters<typeof actual.placeOrder>) => {
      if (!placement.failNext) return actual.placeOrder(...args);
      placement.failNext = false;
      return Promise.reject(new Error("order write failed"));
    },
  };
});
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { quoteCheckout } from "@/lib/checkout/service";
import { getCheckoutPayments, grantFakeSharedPaymentToken, resetFakeCheckoutPayments } from "@/lib/stripe/checkout-payments";
import { POST as create } from "./route";
import { GET as read, POST as update } from "./[id]/route";
import { POST as complete } from "./[id]/complete/route";
import { POST as cancel } from "./[id]/cancel/route";

let currentSlug = "";
const hasDb = !!process.env.DATABASE_URL;
const run = Date.now().toString(36);
const KEY = "acp-test-key";
// Two make $40, over the store's $35 minimum order.
const PRICE = 2000;
const BUYER = { first_name: "Ada", last_name: "Buyer", email: "ada@t574.test", phone_number: "+15551234567" };
const HOUR = 60 * 60 * 1000;

type Session = {
  id: string;
  status: string;
  line_items: { item: { id: string }; quantity: number; unit_amount: number }[];
  totals: { type: string; amount: number }[];
  messages: { code?: string; content: string }[];
  order?: { id: string };
};

function call(slug: string, method: string, path: string, body?: object, key: string | null = KEY) {
  currentSlug = slug;
  return new Request(`http://localhost:3000/api/acp/checkout_sessions${path}`, {
    method,
    headers: {
      host: `${slug}.example.test`,
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      "x-forwarded-for": `10.57.4.${run}`,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const total = (session: Session, type = "total") => session.totals.find((line) => line.type === type)!.amount;
const pay = (token: string) => ({ buyer: BUYER, payment_data: { handler_id: "card_tokenized", instrument: { type: "card", credential: { type: "spt", token } } } });

describe.skipIf(!hasDb)("ACP checkout sessions (#574)", () => {
  let raw: PrismaClient;
  const stores: Record<string, { id: string; slug: string; variantId: string; listingId: string }> = {};

  async function makeStore(label: string) {
    const slug = `t574-${label}-${run}`;
    const store = await raw.store.create({
      data: {
        slug,
        name: `ACP ${label}`,
        themePreset: "palm-and-shea",
        status: "active",
        aiCatalogReadable: true,
        stripeAccountId: `acct_t574_${label}_${run}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    const listing = await storeScoped(store.id).listing.create({
      data: { storeId: store.id, customName: "Ogbono", price: PRICE, stockMode: "unlimited", frozen: false, perishable: false, maxPerOrder: 5 },
    });
    const variant = await storeScoped(store.id).listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price: PRICE, weightG: 454 } });
    stores[label] = { id: store.id, slug, variantId: variant.id, listingId: listing.id };
  }

  async function newSession(label = "a", extra: object = { buyer: BUYER }): Promise<Session> {
    const res = await create(call(stores[label].slug, "POST", "", { line_items: [{ id: stores[label].variantId, quantity: 2 }], ...extra }));
    expect(res.status).toBe(201);
    return res.json();
  }

  async function completeWith(label: string, id: string, token: string) {
    const res = await complete(call(stores[label].slug, "POST", `/${id}/complete`, pay(token)), params(id));
    return { status: res.status, body: await res.json() };
  }

  /** A token for exactly the hold the store quotes now, as an agent grants after reading the session. */
  async function tokenForHold(label: string, sessionId: string, overrides: { maxAmount?: number; expiresAt?: Date } = {}) {
    const row = await storeScoped(stores[label].id).acpCheckoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    const quote = await quoteCheckout(stores[label].id, 0, row.cartId, { name: "Ada Buyer", email: BUYER.email, phone: BUYER.phone_number }, "pickup");
    return { token: grantFakeSharedPaymentToken({ maxAmount: overrides.maxAmount ?? quote.holdCents, expiresAt: overrides.expiresAt ?? new Date(Date.now() + HOUR) }), quote };
  }

  const ordersAt = (label: string) => storeScoped(stores[label].id).order.findMany({ select: { id: true, paymentIntentId: true, acquisitionSource: true } });

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    await makeStore("a");
    await makeStore("b");
  });

  beforeEach(() => {
    vi.stubEnv("ACP_CHECKOUT_ENABLED", "1");
    vi.stubEnv("ACP_API_KEY", KEY);
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "");
    resetFakeCheckoutPayments();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const ids = Object.values(stores).map((store) => store.id);
    if (ids.length) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.acpCheckoutSession.deleteMany({ where: { storeId: { in: ids } } }),
        raw.auditLog.deleteMany({ where: { storeId: { in: ids } } }),
        raw.notificationLog.deleteMany({ where: { storeId: { in: ids } } }),
        raw.stockEvent.deleteMany({ where: { storeId: { in: ids } } }),
        raw.paymentIntentRelease.deleteMany({ where: { storeId: { in: ids } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: ids } } }),
        raw.order.deleteMany({ where: { storeId: { in: ids } } }),
        raw.cartLine.deleteMany({ where: { storeId: { in: ids } } }),
        raw.cart.deleteMany({ where: { storeId: { in: ids } } }),
        raw.customer.deleteMany({ where: { storeId: { in: ids } } }),
        raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: ids } } } }),
        raw.listing.deleteMany({ where: { storeId: { in: ids } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: ids } } });
    }
    await raw?.$disconnect();
  }, 30_000);

  it("is not there with the flag off, or on without the Stripe fake, and wants the agent platform's key", async () => {
    vi.stubEnv("ACP_CHECKOUT_ENABLED", "");
    expect((await create(call(stores.a.slug, "POST", "", { line_items: [{ id: stores.a.variantId }] }))).status).toBe(404);
    vi.stubEnv("ACP_CHECKOUT_ENABLED", "1");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    expect((await create(call(stores.a.slug, "POST", "", { line_items: [{ id: stores.a.variantId }] }))).status).toBe(404);
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    expect((await create(call(stores.a.slug, "POST", "", { line_items: [{ id: stores.a.variantId }] }, null))).status).toBe(401);
    expect((await create(call(stores.a.slug, "POST", "", { line_items: [{ id: stores.a.variantId }] }, "wrong-key"))).status).toBe(401);
    expect(await storeScoped(stores.a.id).acpCheckoutSession.count()).toBe(0);
  });

  it("a body over 64 KB in bytes is refused before it is parsed, even when it is fewer characters", async () => {
    const before = await storeScoped(stores.a.id).acpCheckoutSession.count();
    // 40,000 two-byte characters: 80,000 bytes on the wire.
    const res = await create(call(stores.a.slug, "POST", "", { line_items: [{ id: stores.a.variantId, quantity: 2 }], buyer: BUYER, note: "é".repeat(40_000) }));
    expect(res.status).toBe(400);
    expect(await storeScoped(stores.a.id).acpCheckoutSession.count()).toBe(before);
  });

  it("prices come from the store's quote: an agent's unit_amount and totals are ignored", async () => {
    const res = await create(call(stores.a.slug, "POST", "", {
      line_items: [{ id: stores.a.variantId, quantity: 2, unit_amount: 1 }],
      totals: [{ type: "total", amount: 1 }],
      buyer: BUYER,
    }));
    const session: Session = await res.json();
    const { quote } = await tokenForHold("a", session.id);
    expect(session.line_items[0].unit_amount).toBe(PRICE);
    expect(total(session, "subtotal")).toBe(PRICE * 2);
    expect(total(session)).toBe(quote.totalCents);
    expect(session.status).toBe("ready_for_payment");
  });

  it("is not ready for payment until the buyer's contact is in, which complete may bring", async () => {
    const session = await newSession("a", {});
    expect(session.status).toBe("not_ready_for_payment");
    const { token } = await tokenForHold("a", session.id);
    expect((await completeWith("a", session.id, token)).status).toBe(200);
  });

  it("complete authorizes the hold with the token on the store's manual-capture destination charge, then places the order as the agent's", async () => {
    const session = await newSession();
    const { token, quote } = await tokenForHold("a", session.id);
    const done = await completeWith("a", session.id, token);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    const order = (await ordersAt("a")).find((row) => row.id === done.body.order.id)!;
    expect(order.acquisitionSource).toBe("agent");
    const pi = await getCheckoutPayments().retrievePaymentIntent(order.paymentIntentId!);
    expect(pi).toMatchObject({
      status: "requires_capture",
      amount: quote.holdCents,
      capture_method: "manual",
      on_behalf_of: `acct_t574_a_${run}`,
      transfer_data: { destination: `acct_t574_a_${run}` },
    });
    // A retried complete returns the same order and spends nothing.
    const again = await completeWith("a", session.id, token);
    expect(again).toMatchObject({ status: 200, body: { order: { id: order.id } } });
  });

  it("two concurrent completes authorize once and place one order", async () => {
    const session = await newSession();
    const first = await tokenForHold("a", session.id);
    const second = await tokenForHold("a", session.id);
    const before = (await ordersAt("a")).length;
    const results = await Promise.all([completeWith("a", session.id, first.token), completeWith("a", session.id, second.token)]);
    expect((await ordersAt("a")).length).toBe(before + 1);
    // The loser is told the complete is in flight, or, if it came after, gets the same order.
    const orderIds = new Set(results.filter((result) => result.status === 200).map((result) => result.body.order.id));
    expect(orderIds.size).toBe(1);
    for (const result of results.filter((r) => r.status !== 200)) expect(result.body.code).toBe("idempotency_in_flight");
    // Exactly one of the two tokens was spent: the other still pays for a new session.
    const spare = [];
    for (const token of [first.token, second.token]) spare.push((await completeWith("a", (await newSession()).id, token)).status);
    expect(spare.sort()).toEqual([200, 402]);
  });

  it("the fake Stripe refuses a reused, over-limit or expired token, and the session stays open", async () => {
    const paid = await newSession();
    const { token, quote } = await tokenForHold("a", paid.id);
    expect((await completeWith("a", paid.id, token)).status).toBe(200);

    const session = await newSession();
    const before = (await ordersAt("a")).length;
    const reused = await completeWith("a", session.id, token);
    // An agent that grants only the total, short of the hold, is refused.
    const overLimit = await completeWith("a", session.id, (await tokenForHold("a", session.id, { maxAmount: quote.totalCents })).token);
    const expired = await completeWith("a", session.id, (await tokenForHold("a", session.id, { expiresAt: new Date(Date.now() - 1000) })).token);
    for (const refused of [reused, overLimit, expired]) expect(refused).toMatchObject({ status: 402, body: { code: "payment_declined" } });
    expect((await ordersAt("a")).length).toBe(before);
    const read_ = await read(call(stores.a.slug, "GET", `/${session.id}`), params(session.id));
    expect((await read_.json()).status).toBe("ready_for_payment");
  });

  it("a price raised after the agent read the session is charged at the new price: a token for the old hold is refused", async () => {
    const session = await newSession();
    const { token } = await tokenForHold("a", session.id);
    await storeScoped(stores.a.id).listingVariant.update({ where: { id: stores.a.variantId }, data: { price: PRICE + 500 } });
    try {
      expect(await completeWith("a", session.id, token)).toMatchObject({ status: 402, body: { code: "payment_declined" } });
      const refreshed: Session = await (await read(call(stores.a.slug, "GET", `/${session.id}`), params(session.id))).json();
      expect(total(refreshed, "subtotal")).toBe((PRICE + 500) * 2);
    } finally {
      await storeScoped(stores.a.id).listingVariant.update({ where: { id: stores.a.variantId }, data: { price: PRICE } });
    }
  });

  it("another store's host cannot read, change, pay or cancel a session, and cannot sell its items", async () => {
    const session = await newSession();
    const { token } = await tokenForHold("a", session.id);
    expect((await read(call(stores.b.slug, "GET", `/${session.id}`), params(session.id))).status).toBe(404);
    expect((await update(call(stores.b.slug, "POST", `/${session.id}`, { buyer: { email: "eve@t574.test" } }), params(session.id))).status).toBe(404);
    expect((await completeWith("b", session.id, token)).status).toBe(404);
    expect((await cancel(call(stores.b.slug, "POST", `/${session.id}/cancel`, {}), params(session.id))).status).toBe(404);
    const crossItem = await create(call(stores.b.slug, "POST", "", { line_items: [{ id: stores.a.variantId }] }));
    expect(crossItem.status).toBe(400);
    // The token was never spent, so store A's own complete still goes through.
    expect((await completeWith("a", session.id, token)).status).toBe(200);
  });

  async function failedPlacement(sessionId: string) {
    const { token } = await tokenForHold("a", sessionId);
    placement.failNext = true;
    await expect(completeWith("a", sessionId, token)).rejects.toThrow("order write failed");
    const row = await storeScoped(stores.a.id).acpCheckoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.status).toBe("open");
    return { token, held: row.paymentIntentId! };
  }
  const intentStatus = async (id: string) => (await getCheckoutPayments().retrievePaymentIntent(id)).status;

  it("a retry with a new token after a failed placement releases the first hold: one order, one hold", async () => {
    const session = await newSession();
    const { held } = await failedPlacement(session.id);
    const retried = await completeWith("a", session.id, (await tokenForHold("a", session.id)).token);
    expect(retried.status).toBe(200);
    const order = (await ordersAt("a")).find((row) => row.id === retried.body.order.id)!;
    expect(order.paymentIntentId).not.toBe(held);
    expect(await intentStatus(held)).toBe("canceled");
    expect(await intentStatus(order.paymentIntentId!)).toBe("requires_capture");
  });

  it("a retry with the same token after a failed placement places the order on the same hold", async () => {
    const session = await newSession();
    const { token, held } = await failedPlacement(session.id);
    const retried = await completeWith("a", session.id, token);
    expect(retried.status).toBe(200);
    const order = (await ordersAt("a")).find((row) => row.id === retried.body.order.id)!;
    expect(order.paymentIntentId).toBe(held);
    expect(await intentStatus(held)).toBe("requires_capture");
  });

  it("canceling a session after a failed placement releases its hold", async () => {
    const session = await newSession();
    const { held } = await failedPlacement(session.id);
    expect((await cancel(call(stores.a.slug, "POST", `/${session.id}/cancel`, {}), params(session.id))).status).toBe(200);
    expect(await intentStatus(held)).toBe("canceled");
  });

  it("a canceled session cannot be paid", async () => {
    const session = await newSession();
    const canceled = await cancel(call(stores.a.slug, "POST", `/${session.id}/cancel`, {}), params(session.id));
    expect((await canceled.json()).status).toBe("canceled");
    const { token } = await tokenForHold("a", session.id);
    expect(await completeWith("a", session.id, token)).toMatchObject({ status: 409, body: { code: "session_not_open" } });
  });
});
