import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { makeFakeStep } from "../inngest/fake-step";
import { newOrderPush } from "../inngest/functions";
import * as db from "../db";
import { PushTestSender, setPushSenderForTests, type PushSender } from "./sender";
import { sendNewOrderPush } from "./new-order";
import { pushToStoreMembers } from "./store-members";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${suffix}`;
const VAPID_ENV = { NODE_ENV: "test", VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private" };

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const handler = (newOrderPush as unknown as { fn: Handler }).fn;

describe.skipIf(!hasDb)("new-order web push", () => {
  let raw: PrismaClient;
  let storeA: string;
  let storeB: string;
  const slugA = `push-new-a-${suffix}`;
  const memberA1 = `push-new-a1-${suffix}`;
  const memberA2 = `push-new-a2-${suffix}`;
  const memberB = `push-new-b-${suffix}`;
  const formerMember = `push-new-former-${suffix}`;
  let customerA: string;
  let orderSeq = 1000;
  let sender: PushTestSender;

  async function createOrder(fulfillment = "pickup") {
    const number = ++orderSeq;
    return storeScopedTransaction(storeA, (tx) =>
      tx.order.create({
        data: {
          storeId: storeA,
          number,
          customerId: customerA,
          status: "AUTHORIZED",
          fulfillment,
          subtotalCents: 1000,
          bufferCents: 100,
          totalAuthorizedCents: 1100,
          totalCents: 1000,
        },
      }),
    );
  }

  async function subscribe(storeId: string, userId: string, name: string) {
    await storeScoped(storeId).pushSubscription.create({
      data: { storeId, userId, endpoint: endpoint(name), ...keys },
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: slugA, name: "Push New A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `push-new-b-${suffix}`, name: "Push New B", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({
      data: [memberA1, memberA2, memberB, formerMember].map((id) => ({ id, name: id, email: `${id}@example.com` })),
    });
    await storeScoped(storeA).storeMembership.createMany({
      data: [memberA1, memberA2].map((userId) => ({ storeId: storeA, userId, role: "staff" })),
    });
    await storeScoped(storeB).storeMembership.create({ data: { storeId: storeB, userId: memberB, role: "staff" } });
    customerA = (await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Push Customer", email: `push-${suffix}@example.com`, phone: "+15559990001" },
    })).id;
  });

  beforeEach(async () => {
    sender = new PushTestSender();
    setPushSenderForTests(sender);
    await storeScoped(storeA).pushSubscription.deleteMany({});
    await storeScoped(storeB).pushSubscription.deleteMany({});
    await subscribe(storeA, memberA1, "a1");
    await subscribe(storeA, memberA2, "a2");
    await subscribe(storeB, memberB, "b");
  });

  afterEach(() => {
    setPushSenderForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const id of [storeA, storeB]) {
      await storeScoped(id).pushSubscription.deleteMany({});
      await storeScoped(id).order.deleteMany({});
      await storeScoped(id).customer.deleteMany({});
      await storeScoped(id).storeMembership.deleteMany({});
    }
    await raw.user.deleteMany({ where: { id: { in: [memberA1, memberA2, memberB, formerMember] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("the order-authorized event sends one push to each of the store's subscriptions and none to another store", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
    const order = await createOrder("store-delivery");
    await handler({ event: { data: { storeId: storeA, orderId: order.id } }, step: makeFakeStep() });

    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([endpoint("a1"), endpoint("a2")].sort());
    for (const push of sender.sent) {
      expect(push.message.title).toBe("New order");
      expect(push.message.body).toContain(`#${order.number}`);
      expect(push.message.body).toMatch(/delivery/i);
      expect(push.message.url).toBe(`/store-admin/orders?store=${slugA}`);
      expect(push.message.tag).toBe("new-order");
    }
  });

  it("pushToStoreMembers sends the payload's own tag to that store's members only", async () => {
    const message = { title: "New message", body: "Order #7", url: "/store-admin/messages", tag: "support-t1" };
    await pushToStoreMembers(storeA, message, VAPID_ENV);
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([endpoint("a1"), endpoint("a2")].sort());
    expect(sender.sent.map((s) => s.message)).toEqual([message, message]);
  });

  it("skips a subscription whose user is no longer a member of the store", async () => {
    await subscribe(storeA, formerMember, "former");
    const order = await createOrder();
    await sendNewOrderPush(storeA, order.id, VAPID_ENV);
    expect(sender.sent.map((s) => s.endpoint)).not.toContain(endpoint("former"));
    expect(sender.sent).toHaveLength(2);
  });

  it("deletes a subscription the push service reports gone (410 or 404)", async () => {
    sender.failWith(endpoint("a1"), 410);
    sender.failWith(endpoint("a2"), 404);
    const order = await createOrder();
    await sendNewOrderPush(storeA, order.id, VAPID_ENV);
    expect(await storeScoped(storeA).pushSubscription.count()).toBe(0);
    expect(await storeScoped(storeB).pushSubscription.count()).toBe(1);
  });

  it("keeps a subscription on another error, does not throw, and logs no endpoint or key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sender.failWith(endpoint("a1"), 500);
    const order = await createOrder();
    await expect(sendNewOrderPush(storeA, order.id, VAPID_ENV)).resolves.toBeUndefined();

    expect(await storeScoped(storeA).pushSubscription.count()).toBe(2);
    expect(sender.sent.map((s) => s.endpoint)).toEqual([endpoint("a2")]);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("push_send_failed");
    expect(logged).not.toContain("fcm.googleapis.com");
    expect(logged).not.toContain(keys.auth);
  });

  it("a stored endpoint that is not a push service is deleted and never sent to", async () => {
    await storeScoped(storeA).pushSubscription.create({
      data: { storeId: storeA, userId: memberA1, endpoint: "https://127.0.0.1:9/x", ...keys },
    });
    const order = await createOrder();
    await sendNewOrderPush(storeA, order.id, VAPID_ENV);
    expect(sender.sent.map((s) => s.endpoint)).not.toContain("https://127.0.0.1:9/x");
    expect(sender.sent).toHaveLength(2);
    const left = await storeScoped(storeA).pushSubscription.findMany();
    expect(left.map((r) => r.endpoint)).not.toContain("https://127.0.0.1:9/x");
  });

  it("sends to all devices at once, so one slow endpoint cannot hold up the others", async () => {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const delivered: string[] = [];
    const barrier: PushSender = {
      async send(target) {
        if (++arrived === 2) release();
        await both;
        delivered.push(target.endpoint);
      },
    };
    setPushSenderForTests(barrier);
    const order = await createOrder();
    await sendNewOrderPush(storeA, order.id, VAPID_ENV);
    expect(delivered.sort()).toEqual([endpoint("a1"), endpoint("a2")].sort());
  }, 2000);

  it("a failing delete of a gone subscription does not make the step throw, and logs no endpoint", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sender.failWith(endpoint("a1"), 410);
    const realScoped = db.storeScoped;
    vi.spyOn(db, "storeScoped").mockImplementation((id: string) => {
      const real = realScoped(id);
      return new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "pushSubscription") return typeof value === "function" ? value.bind(target) : value;
          return new Proxy(value, {
            get(model, method) {
              if (method === "deleteMany") return () => Promise.reject(new Error("db down"));
              const fn = Reflect.get(model, method);
              return typeof fn === "function" ? fn.bind(model) : fn;
            },
          });
        },
      });
    });
    const order = await createOrder();
    await expect(sendNewOrderPush(storeA, order.id, VAPID_ENV)).resolves.toBeUndefined();
    expect(sender.sent.map((s) => s.endpoint)).toEqual([endpoint("a2")]);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).not.toContain("fcm.googleapis.com");
    expect(logged).not.toContain(keys.auth);
  });

  it("skips sending with one warning when the VAPID keys are missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = await createOrder();
    await sendNewOrderPush(storeA, order.id, { NODE_ENV: "test" });
    await sendNewOrderPush(storeA, order.id, { NODE_ENV: "test", VAPID_PUBLIC_KEY: "public" });
    expect(sender.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
