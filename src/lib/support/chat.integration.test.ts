import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
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
import { GET } from "@/app/api/order-messages/[token]/route";
import { auth } from "../auth";
import { storeScoped } from "../db";
import { PushTestSender, setPushSenderForTests } from "../push/sender";
import { sendOrderMessageAction } from "./customer-actions";
import { replyToThreadAction } from "./store-actions";
import { listStoreThreads } from "./thread";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(userId: string | null): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    (userId
      ? { user: { id: userId, twoFactorEnabled: true }, session: { twoFactorVerified: true } }
      : null) as unknown as FakeSession,
  );
}

function onStore(slug: string): void {
  headerState.set("x-store-slug", slug);
  headerState.set("x-forwarded-for", `203.0.113.${Math.floor(Math.random() * 250)}-${suffix}`);
}

async function poll(slug: string, token: string) {
  onStore(slug);
  const response = await GET(new Request(`http://localhost/api/order-messages/${token}`), {
    params: Promise.resolve({ token }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

describe.skipIf(!hasDb)("customer to store chat", () => {
  let raw: PrismaClient;
  const slugA = `chat-a-${suffix}`;
  const slugB = `chat-b-${suffix}`;
  let storeA = "";
  let storeB = "";
  const memberA = `chat-member-a-${suffix}`;
  const memberB = `chat-member-b-${suffix}`;
  let sender: PushTestSender;

  async function order(storeId: string, number: number) {
    const token = `chat-token-${number}-${suffix}`;
    const customer = await storeScoped(storeId).customer.create({
      data: { storeId, name: "Ada", email: `chat-${number}-${suffix}@example.com`, phone: "+15559990001" },
    });
    const created = await storeScoped(storeId).order.create({
      data: {
        storeId,
        number,
        customerId: customer.id,
        status: "ACCEPTED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 100,
        totalAuthorizedCents: 1100,
        totalCents: 1000,
        trackingToken: token,
      },
    });
    return { id: created.id, token };
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: slugA, name: "Chat A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: slugB, name: "Chat B", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({
      data: [memberA, memberB].map((id) => ({ id, name: id, email: `${id}@example.com`, twoFactorEnabled: true })),
    });
    await storeScoped(storeA).storeMembership.create({ data: { storeId: storeA, userId: memberA, role: "staff" } });
    await storeScoped(storeB).storeMembership.create({ data: { storeId: storeB, userId: memberB, role: "staff" } });
    await storeScoped(storeA).pushSubscription.create({
      data: { storeId: storeA, userId: memberA, endpoint: `https://fcm.googleapis.com/fcm/send/chat-${suffix}`, ...keys },
    });
  });

  beforeEach(() => {
    sender = new PushTestSender();
    setPushSenderForTests(sender);
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
  });

  afterEach(() => {
    setPushSenderForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const id of [storeA, storeB]) {
      const scoped = storeScoped(id);
      await scoped.pushSubscription.deleteMany({});
      await scoped.supportMessage.deleteMany({});
      await scoped.supportThread.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.storeMembership.deleteMany({});
    }
    await raw.user.deleteMany({ where: { id: { in: [memberA, memberB] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("a customer message opens one thread with unread 1 and pushes staff; the first reply records store_replied once per channel, the second none", async () => {
    const placed = await order(storeA, 1);
    onStore(slugA);
    expect(await sendOrderMessageAction({ token: placed.token, body: "Where is my order?" })).toEqual({ ok: true });

    const threads = await listStoreThreads(storeA);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ orderNumber: 1, unread: 1 });
    const message = await storeScoped(storeA).supportMessage.findFirstOrThrow({ where: { threadId: threads[0].id } });
    expect(message).toMatchObject({ storeId: storeA, sender: "customer", body: "Where is my order?" });
    await vi.waitFor(() => expect(sender.sent.map((s) => s.message.title)).toEqual(["New message"]));

    signInAs(memberA);
    onStore(slugA);
    expect(await replyToThreadAction({ threadId: threads[0].id, body: "Packing it now" })).toEqual({ ok: true });

    const seen = await poll(slugA, placed.token);
    expect(seen.body.messages.map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([
      ["customer", "Where is my order?"],
      ["store", "Packing it now"],
    ]);
    expect((await listStoreThreads(storeA))[0].unread).toBe(0);
    const rows = () => storeScoped(storeA).notificationLog.findMany({ where: { orderId: placed.id, event: "store_replied" } });
    expect((await rows()).map((r) => r.channel).sort()).toEqual(["email", "sms"]);

    expect(await replyToThreadAction({ threadId: threads[0].id, body: "Ready soon" })).toEqual({ ok: true });
    expect(await rows()).toHaveLength(2);
  });

  it("a token is refused on another store's host and cannot name another order's thread", async () => {
    const own = await order(storeA, 2);
    const other = await order(storeB, 3);

    onStore(slugA);
    expect(await sendOrderMessageAction({ token: other.token, body: "Hello" })).toMatchObject({ ok: false });
    expect(await sendOrderMessageAction({ token: own.token, body: "Hello", orderId: other.id })).toMatchObject({ ok: false });
    expect((await poll(slugA, other.token)).status).toBe(404);

    expect(await storeScoped(storeB).supportThread.count({ where: { orderId: other.id } })).toBe(0);
    expect(await storeScoped(storeA).supportThread.count({ where: { orderId: own.id } })).toBe(0);
  });

  it("staff of store B cannot read or reply to store A's thread", async () => {
    const placed = await order(storeA, 4);
    onStore(slugA);
    await sendOrderMessageAction({ token: placed.token, body: "Is it ready?" });
    const thread = await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { orderId: placed.id } });

    expect(await listStoreThreads(storeB)).toEqual([]);
    signInAs(memberB);
    onStore(slugB);
    expect(await replyToThreadAction({ threadId: thread.id, body: "Not yours" })).toMatchObject({ ok: false });
    expect(await storeScoped(storeA).supportMessage.count({ where: { threadId: thread.id } })).toBe(1);
    expect(await storeScoped(storeA).notificationLog.count({ where: { orderId: placed.id } })).toBe(0);
  });
});
