import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { isRlsRejection } from "../listing/cross-store-write";
import { storeScoped, storeScopedTransaction } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import { sendCustomerNotification } from "../inngest/functions";
import { newTrackingToken, recordOrderNotification } from "../notifications/record";
import { PushTestSender, setPushSenderForTests } from "./sender";
import { subscribeOrderPushAction, unsubscribeOrderPushAction } from "./order-actions";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${suffix}`;

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const handler = (sendCustomerNotification as unknown as { fn: Handler }).fn;

describe.skipIf(!hasDb)("customer order push (#563)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const slugA = `opush-a-${suffix}`;
  const slugB = `opush-b-${suffix}`;
  let orderSeq = 700;
  let sender: PushTestSender;

  async function createOrder(storeId: string) {
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: "Push Customer", email: `opush-${suffix}-${orderSeq}@example.com` },
    });
    return storeScopedTransaction(storeId, (tx) =>
      tx.order.create({
        data: {
          storeId,
          number: ++orderSeq,
          customerId: customer.id,
          trackingToken: newTrackingToken(),
          subtotalCents: 1000,
          bufferCents: 100,
          totalAuthorizedCents: 1100,
          totalCents: 1000,
        },
      }),
    );
  }

  async function notify(storeId: string, orderId: string) {
    await storeScopedTransaction(storeId, (tx) => recordOrderNotification(tx, storeId, orderId, "accepted"));
    await handler({ event: { data: { storeId, orderId, event: "accepted" } }, step: makeFakeStep() });
    return storeScoped(storeId).notificationLog.findFirstOrThrow({ where: { orderId, event: "accepted", channel: "push" } });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: slugA, name: "Ada's Market", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: slugB, name: "Other Market", themePreset: "palm-and-shea" } })).id;
  });

  beforeEach(() => {
    headerState.set("x-store-slug", slugA);
    vi.stubEnv("PLATFORM_ROOT_DOMAIN", "markets.example");
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
    sender = new PushTestSender();
    setPushSenderForTests(sender);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setPushSenderForTests(null);
  });

  afterAll(async () => {
    for (const id of [storeA, storeB]) {
      const scoped = storeScoped(id);
      await scoped.orderPushSubscription.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
    }
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("the tracking token subscribes a device; an order id, another store's token or a bad endpoint does not", async () => {
    const order = await createOrder(storeA);
    const other = await createOrder(storeB);
    const subscription = { endpoint: endpoint("sub"), keys };

    expect(await subscribeOrderPushAction(order.id, subscription)).toEqual({ ok: false, error: "Order not found" });
    expect(await subscribeOrderPushAction(other.trackingToken, subscription)).toEqual({ ok: false, error: "Order not found" });
    expect((await subscribeOrderPushAction(order.trackingToken, { endpoint: "https://evil.example/x", keys })).ok).toBe(false);
    expect(await subscribeOrderPushAction(order.trackingToken, subscription)).toEqual({ ok: true });
    expect(await subscribeOrderPushAction(order.trackingToken, subscription)).toEqual({ ok: true });

    const rows = await storeScoped(storeA).orderPushSubscription.findMany({ where: { orderId: order.id } });
    expect(rows.map((row) => row.endpoint)).toEqual([subscription.endpoint]);
    expect(await storeScoped(storeB).orderPushSubscription.count({ where: { orderId: other.id } })).toBe(0);

    expect(await unsubscribeOrderPushAction(order.trackingToken, subscription.endpoint)).toEqual({ ok: true });
    expect(await storeScoped(storeA).orderPushSubscription.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("an order update goes out through the push channel to the order's devices only, and 404/410 deletes the subscription", async () => {
    const order = await createOrder(storeA);
    const neighbour = await createOrder(storeA);
    await subscribeOrderPushAction(order.trackingToken, { endpoint: endpoint("live"), keys });
    await subscribeOrderPushAction(order.trackingToken, { endpoint: endpoint("gone"), keys });
    await subscribeOrderPushAction(order.trackingToken, { endpoint: endpoint("missing"), keys });
    await subscribeOrderPushAction(neighbour.trackingToken, { endpoint: endpoint("neighbour"), keys });
    sender.failWith(endpoint("gone"), 410);
    sender.failWith(endpoint("missing"), 404);

    const row = await notify(storeA, order.id);

    expect(row.status).toBe("sent");
    expect(sender.sent.map((sent) => sent.endpoint)).toEqual([endpoint("live")]);
    const message = sender.sent[0].message;
    expect(message.title).toBe("Ada's Market");
    expect(message.body).toContain(`#${order.number}`);
    expect(message.url).toBe(`https://${slugA}.markets.example/order/${order.trackingToken}`);
    // Money never travels in a push: it shows on the lock screen.
    expect(JSON.stringify(message)).not.toMatch(/\$\d/);
    const left = await storeScoped(storeA).orderPushSubscription.findMany({ where: { orderId: order.id } });
    expect(left.map((sub) => sub.endpoint)).toEqual([endpoint("live")]);
  });

  it("an order without a subscribed device skips the push row", async () => {
    const order = await createOrder(storeA);
    const row = await notify(storeA, order.id);
    expect(row).toMatchObject({ status: "skipped", reason: "no_subscription" });
    expect(sender.sent).toHaveLength(0);
  });

  it("store isolation: store A cannot read or write store B's order subscriptions", async () => {
    const other = await createOrder(storeB);
    await storeScoped(storeB).orderPushSubscription.create({
      data: { storeId: storeB, orderId: other.id, endpoint: endpoint("b"), ...keys },
    });
    expect(await storeScoped(storeA).orderPushSubscription.findMany({ where: { orderId: other.id } })).toEqual([]);
    const write = storeScoped(storeA).orderPushSubscription.create({
      data: { storeId: storeB, orderId: other.id, endpoint: endpoint("b2"), ...keys },
    });
    await expect(write).rejects.toSatisfy(isRlsRejection);
  });
});
