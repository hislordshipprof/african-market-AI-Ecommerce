import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { headerState, clearedTags, cachedTags } = vi.hoisted(() => ({ headerState: new Headers(), clearedTags: [] as string[], cachedTags: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown, _keys: string[], options: { tags: string[] }) => {
    cachedTags.push(...options.tags);
    return () => fn();
  },
  revalidateTag: (tag: string) => void clearedTags.push(tag),
  revalidatePath: () => {},
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
import { listStoreThreads, orderMessagesTag, storeUnreadCount, postCustomerMessage, readCustomerMessages, replyAsStore } from "./thread";
import { makeFakeStep } from "../inngest/fake-step";
import { escalateIfUnanswered, supportSlaEscalation } from "./escalation";
import { listEscalatedThreads, replyAsPlatformAction, resolveThreadAction } from "./platform-actions";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(userId: string | null, role?: "platform_admin"): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    (userId
      ? { user: { id: userId, email: `${userId}@example.com`, role, twoFactorEnabled: true }, session: { twoFactorVerified: true } }
      : null) as unknown as FakeSession,
  );
}

/** Every day 09:00-20:00 America/New_York. */
const DAILY_HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { open: "09:00", close: "20:00" }]),
);

type SlaHandler = (ctx: { event: { data: { storeId: string; messageId: string } }; step: ReturnType<typeof makeFakeStep> }) => Promise<void>;
const slaHandler = (supportSlaEscalation as unknown as { fn: SlaHandler }).fn;

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

describe.skipIf(!hasDb)("support thread", () => {
  let raw: PrismaClient;
  const slugA = `chat-a-${suffix}`;
  const slugB = `chat-b-${suffix}`;
  let storeA = "";
  let storeB = "";
  const memberA = `chat-member-a-${suffix}`;
  const memberB = `chat-member-b-${suffix}`;
  const admin = `chat-admin-${suffix}`;
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
    storeB = (await raw.store.create({ data: { slug: slugB, name: "Chat B", themePreset: "palm-and-shea", hours: DAILY_HOURS, timezone: "America/New_York" } })).id;
    await raw.user.createMany({
      data: [memberA, memberB, admin].map((id) => ({ id, name: id, email: `${id}@example.com`, twoFactorEnabled: true })),
    });
    await storeScoped(storeA).storeMembership.create({ data: { storeId: storeA, userId: memberA, role: "staff" } });
    await storeScoped(storeB).storeMembership.create({ data: { storeId: storeB, userId: memberB, role: "staff" } });
    await storeScoped(storeA).pushSubscription.create({
      data: { storeId: storeA, userId: memberA, endpoint: `https://fcm.googleapis.com/fcm/send/chat-${suffix}`, ...keys },
    });
  });

  beforeEach(() => {
    clearedTags.length = 0;
    cachedTags.length = 0;
    sender = new PushTestSender();
    setPushSenderForTests(sender);
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await raw.auditLog.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
    await raw.user.deleteMany({ where: { id: { in: [memberA, memberB, admin] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("a customer message opens one thread with unread 1 and pushes staff; the first reply records store_replied once per channel, the second none", async () => {
    const placed = await order(storeA, 1);
    onStore(slugA);
    expect(await sendOrderMessageAction({ token: placed.token, body: "Where is my order?" })).toEqual({ ok: true });
    // The poll route caches under this tag; without the clear the customer's own message vanishes for a poll.
    expect(clearedTags).toEqual([orderMessagesTag(placed.token)]);
    await poll(slugA, placed.token);
    expect(cachedTags).toContain(clearedTags[0]);

    const threads = await listStoreThreads(storeA);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ orderNumber: 1, unread: 1 });
    const message = await storeScoped(storeA).supportMessage.findFirstOrThrow({ where: { threadId: threads[0].id } });
    expect(message).toMatchObject({ storeId: storeA, sender: "customer", body: "Where is my order?" });
    await vi.waitFor(() => expect(sender.sent.map((s) => s.message.title)).toEqual(["New message"]));

    signInAs(memberA);
    onStore(slugA);
    clearedTags.length = 0;
    expect(await replyToThreadAction({ threadId: threads[0].id, body: "Packing it now" })).toEqual({ ok: true });
    expect(clearedTags).toEqual([orderMessagesTag(placed.token)]);

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

  it("a body with a NUL byte is refused by both actions and writes nothing", async () => {
    const placed = await order(storeA, 5);
    onStore(slugA);
    expect(await sendOrderMessageAction({ token: placed.token, body: "hi\u0000there" })).toMatchObject({ ok: false });
    expect(await storeScoped(storeA).supportThread.count({ where: { orderId: placed.id } })).toBe(0);

    await sendOrderMessageAction({ token: placed.token, body: "Hello" });
    const thread = await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { orderId: placed.id } });
    signInAs(memberA);
    onStore(slugA);
    expect(await replyToThreadAction({ threadId: thread.id, body: "hi\u0000there" })).toMatchObject({ ok: false });
    expect(await storeScoped(storeA).supportMessage.count({ where: { threadId: thread.id } })).toBe(1);
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

  it("the dashboard badge counts the unread of the threads the Messages list shows, not threads past its cap", async () => {
    const storeC = (await raw.store.create({ data: { slug: `chat-c-${suffix}`, name: "Chat C", themePreset: "palm-and-shea" } })).id;
    const scoped = storeScoped(storeC);
    try {
      const customer = await scoped.customer.create({ data: { storeId: storeC, name: "Bo", email: `chat-c-${suffix}@example.com` } });
      const numbers = Array.from({ length: 101 }, (_, i) => i + 1);
      await scoped.order.createMany({
        data: numbers.map((number) => ({
          storeId: storeC, number, customerId: customer.id, status: "ACCEPTED", fulfillment: "pickup",
          subtotalCents: 1000, bufferCents: 100, totalAuthorizedCents: 1100, totalCents: 1000,
        })),
      });
      const orders = await scoped.order.findMany({ select: { id: true, number: true } });
      // Order 1's customer wrote first, so its thread is the 101st, past the list's cap of 100.
      const at = (number: number) => new Date(Date.UTC(2026, 10, 1, 0, number));
      await scoped.supportThread.createMany({
        data: orders.map((o) => ({ id: `chat-c-${o.number}-${suffix}`, storeId: storeC, orderId: o.id, lastCustomerAt: at(o.number) })),
      });
      await scoped.supportMessage.createMany({
        data: orders.map((o) => ({ storeId: storeC, threadId: `chat-c-${o.number}-${suffix}`, sender: "customer", body: "Hi", createdAt: at(o.number) })),
      });

      const listed = await listStoreThreads(storeC);
      expect(listed.some((t) => t.orderNumber === 1)).toBe(false);
      expect(await storeUnreadCount(storeC)).toBe(100);
    } finally {
      await scoped.supportMessage.deleteMany({});
      await scoped.supportThread.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.customer.deleteMany({});
      await raw.store.delete({ where: { id: storeC } });
    }
  });

  describe("escalation", () => {
    /** Store B is open 09:00-20:00 New York; SLA is the default 30 open minutes. Tue 2026-11-03 14:00 New York. */
    const OPEN_AT = new Date("2026-11-03T19:00:00.000Z");

    async function messageAt(at: Date, number: number) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      const placed = await order(storeB, number);
      const posted = (await postCustomerMessage(storeB, placed.token, "Hello?"))!;
      return { ...placed, ...posted };
    }

    const thread = (id: string) =>
      storeScoped(storeB).supportThread.findUniqueOrThrow({ where: { id }, select: { state: true, escalatedAt: true, escalationReason: true } });

    it("no reply in 30 open minutes escalates once, and a replay changes nothing", async () => {
      const sent = await messageAt(OPEN_AT, 10);
      const event = { data: { storeId: storeB, messageId: sent.messageId } };
      const step = makeFakeStep({ onSleepUntil: (until) => void vi.setSystemTime(until.getTime() + 60_000) });
      await slaHandler({ event, step });

      expect(step.sleepUntils.map((s) => s.until)).toEqual(["2026-11-03T19:30:00.000Z"]);
      const first = await thread(sent.threadId);
      expect(first).toMatchObject({ state: "escalated", escalationReason: "sla" });
      expect(first.escalatedAt).not.toBeNull();

      vi.setSystemTime(OPEN_AT.getTime() + 45 * 60_000);
      await slaHandler({ event, step: makeFakeStep() });
      expect(await thread(sent.threadId)).toEqual(first);
      expect((await listStoreThreads(storeB)).find((t) => t.id === sent.threadId)?.state).toBe("escalated");
    });

    it("an SLA event naming store A with store B's message escalates nothing", async () => {
      const sent = await messageAt(OPEN_AT, 13);
      vi.setSystemTime(OPEN_AT.getTime() + 45 * 60_000);
      await slaHandler({ event: { data: { storeId: storeA, messageId: sent.messageId } }, step: makeFakeStep() });
      expect(await escalateIfUnanswered(storeA, sent.messageId)).toBe(false);
      expect(await thread(sent.threadId)).toMatchObject({ state: "open", escalatedAt: null });
    });

    it("a staff reply at minute 10 leaves the thread open when the timer wakes", async () => {
      const sent = await messageAt(OPEN_AT, 11);
      const step = makeFakeStep({
        onSleepUntil: async (until) => {
          vi.setSystemTime(OPEN_AT.getTime() + 10 * 60_000);
          await replyAsStore(storeB, memberB, sent.threadId, "On it");
          vi.setSystemTime(until);
        },
      });
      await slaHandler({ event: { data: { storeId: storeB, messageId: sent.messageId } }, step });

      expect(step.sleepNames).toHaveLength(1);
      expect(await thread(sent.threadId)).toEqual({ state: "open", escalatedAt: null, escalationReason: null });
    });

    it("a message at 19:50 counts 10 open minutes tonight and 20 tomorrow from 09:00", async () => {
      const sent = await messageAt(new Date("2026-11-04T00:50:00.000Z"), 12);
      const step = makeFakeStep({ onSleepUntil: (until) => void vi.setSystemTime(until) });
      await slaHandler({ event: { data: { storeId: storeB, messageId: sent.messageId } }, step });

      expect(step.sleepUntils.map((s) => s.until)).toEqual(["2026-11-04T14:20:00.000Z"]);
      expect(await thread(sent.threadId)).toMatchObject({ state: "escalated", escalationReason: "sla" });
    });
  });

  describe("platform admin queue", () => {
    it("a payment thread is escalated at once and listed across stores; an open order thread is not", async () => {
      const payment = await order(storeA, 20);
      const quiet = await order(storeB, 21);
      onStore(slugA);
      expect(await sendOrderMessageAction({ token: payment.token, body: "Charged twice", topic: "payment" })).toEqual({ ok: true });
      await postCustomerMessage(storeB, quiet.token, "Hi");
      const delivery = await order(storeB, 22);
      await postCustomerMessage(storeB, delivery.token, "Courier lost", "delivery");

      signInAs(admin, "platform_admin");
      const { threads: queue } = await listEscalatedThreads();
      const ours = queue.filter((t) => ["Chat A", "Chat B"].includes(t.storeName));
      expect(ours.map((t) => [t.storeName, t.orderNumber, t.topic, t.escalationReason])).toEqual(
        expect.arrayContaining([
          ["Chat A", 20, "payment", "topic"],
          ["Chat B", 22, "delivery", "topic"],
        ]),
      );
      expect(ours.some((t) => t.orderNumber === 21)).toBe(false);
    });

    it("an admin reply reaches the customer as the platform and reopens the thread; resolve closes it", async () => {
      const placed = await order(storeA, 23);
      const posted = (await postCustomerMessage(storeA, placed.token, "App crashed", "app"))!;

      signInAs(admin, "platform_admin");
      expect(await replyAsPlatformAction({ threadId: posted.threadId, body: "We are looking into it" })).toEqual({ ok: true });
    expect(clearedTags).toContain(orderMessagesTag(placed.token));
      const seen = await poll(slugA, placed.token);
      expect(seen.body.messages.at(-1)).toMatchObject({ sender: "platform", body: "We are looking into it" });
      const reopened = await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { id: posted.threadId } });
      expect(reopened.state).toBe("open");
      expect(reopened.escalatedAt).not.toBeNull();

      const seenAt = reopened.lastCustomerAt!.toISOString();
      expect(await resolveThreadAction({ threadId: posted.threadId, seenAt })).toEqual({ ok: true });
      expect((await listEscalatedThreads()).threads.some((t) => t.id === posted.threadId)).toBe(false);
      expect((await readCustomerMessages(storeA, placed.token))?.map((m) => m.sender)).toEqual(["customer", "platform"]);
    });

    it("resolve from a page older than the customer's newest message is refused, and a racing message is never hidden", async () => {
      const placed = await order(storeA, 25);
      const posted = (await postCustomerMessage(storeA, placed.token, "Charged twice", "payment"))!;
      signInAs(admin, "platform_admin");
      const stale = (await listEscalatedThreads()).threads.find((t) => t.id === posted.threadId)!;
      await postCustomerMessage(storeA, placed.token, "Still charged twice");

      expect(await resolveThreadAction({ threadId: posted.threadId, seenAt: stale.seenAt })).toEqual({
        ok: false,
        error: "A new customer message came in. Reload the page to read it.",
      });
      const fresh = (await listEscalatedThreads()).threads.find((t) => t.id === posted.threadId)!;
      expect(fresh.messages.map((m) => m.body)).toEqual(["Charged twice", "Still charged twice"]);

      // A customer message racing the resolve must leave the thread on the queue, whichever commits first.
      for (let i = 0; i < 20; i++) {
        const { lastCustomerAt } = await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { id: posted.threadId } });
        await Promise.all([
          postCustomerMessage(storeA, placed.token, `Race ${i}`),
          resolveThreadAction({ threadId: posted.threadId, seenAt: lastCustomerAt!.toISOString() }),
        ]);
        const thread = await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { id: posted.threadId } });
        expect(thread.state, `round ${i}`).toBe("escalated");
      }
    });

    it("the cap never hides a waiting thread, says how many rows it cut, and labels a follow-up after a reply as waiting", async () => {
      const storeD = (await raw.store.create({ data: { slug: `chat-d-${suffix}`, name: "Chat D", themePreset: "palm-and-shea" } })).id;
      const scoped = storeScoped(storeD);
      try {
        const customer = await scoped.customer.create({ data: { storeId: storeD, name: "Bo", email: `chat-d-${suffix}@example.com` } });
        const numbers = Array.from({ length: 102 }, (_, i) => i + 1);
        await scoped.order.createMany({
          data: numbers.map((number) => ({
            storeId: storeD, number, customerId: customer.id, status: "ACCEPTED", fulfillment: "pickup",
            subtotalCents: 1000, bufferCents: 100, totalAuthorizedCents: 1100, totalCents: 1000,
          })),
        });
        const orders = await scoped.order.findMany({ select: { id: true, number: true } });
        const at = (minute: number) => new Date(Date.UTC(2020, 0, 1, 0, minute));
        // Orders 1-100: answered long ago. 101: answered, then a customer follow-up. 102: escalated, never answered.
        await scoped.supportThread.createMany({
          data: orders.map((o) => ({
            id: `chat-d-${o.number}-${suffix}`, storeId: storeD, orderId: o.id, topic: o.number === 102 ? "payment" : "order",
            state: o.number === 102 ? "escalated" : "open", escalatedAt: at(o.number), escalationReason: o.number === 102 ? "topic" : "sla",
            lastCustomerAt: o.number === 101 ? at(500) : at(o.number), lastReplyAt: o.number === 102 ? null : at(400),
          })),
        });

        signInAs(admin, "platform_admin");
        const { threads, hidden } = await listEscalatedThreads();
        const ours = new Map(threads.filter((t) => t.storeName === "Chat D").map((t) => [t.orderNumber, t]));
        expect(ours.get(101)?.waiting).toBe(true);
        expect(ours.get(102)?.waiting).toBe(true);
        expect(ours.get(1)?.waiting).toBe(false);
        expect(threads).toHaveLength(100);
        expect(hidden).toBeGreaterThan(0);
      } finally {
        await scoped.supportThread.deleteMany({});
        await scoped.order.deleteMany({});
        await scoped.customer.deleteMany({});
        await raw.store.delete({ where: { id: storeD } });
      }
    });

    it("a store session or no session is refused the queue, the reply and resolve", async () => {
      const placed = await order(storeA, 24);
      const posted = (await postCustomerMessage(storeA, placed.token, "Refund?", "payment"))!;
      for (const user of [memberA, null]) {
        signInAs(user);
        await expect(listEscalatedThreads()).rejects.toThrow("REDIRECT:/admin/sign-in");
        await expect(replyAsPlatformAction({ threadId: posted.threadId, body: "x" })).rejects.toThrow("REDIRECT:/admin/sign-in");
        await expect(resolveThreadAction({ threadId: posted.threadId, seenAt: posted.sentAt })).rejects.toThrow("REDIRECT:/admin/sign-in");
      }
      expect(await storeScoped(storeA).supportMessage.count({ where: { threadId: posted.threadId } })).toBe(1);
      expect((await storeScoped(storeA).supportThread.findUniqueOrThrow({ where: { id: posted.threadId } })).state).toBe("escalated");
    });
  });
});
