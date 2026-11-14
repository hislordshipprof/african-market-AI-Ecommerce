import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { lockListingRows, storeScoped, storeScopedTransaction } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { reserveOrderStock } from "../order/stock-ledger";
import { makeFakeStep } from "../inngest/fake-step";
import { PushTestSender, setPushSenderForTests } from "../push/sender";
import { copilotOrderStockAlerts } from "./alert-functions";
import { createOrderStockAlerts, pushCopilotAlerts } from "./alerts";

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const orderAlertsHandler = (copilotOrderStockAlerts as unknown as { fn: Handler }).fn;

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t430-${Date.now().toString(36)}`;
const VAPID_ENV = { NODE_ENV: "test", VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private" };
const PUSH_KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe.skipIf(!hasDb)("copilot alerts (lane database)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";
  let customerAId = "";
  let orderNumber = 1000;

  async function counted(storeId: string, name: string, qty: number) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, stockMode: "counted", qty, confidence: 1 },
    })).id;
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeAId = (await raw.store.create({
      data: { slug: `alerts-a-${RUN}`, name: "Alerts A", themePreset: "palm-and-shea" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `alerts-b-${RUN}`, name: "Alerts B", themePreset: "palm-and-shea" },
    })).id;
    customerAId = (await storeScoped(storeAId).customer.create({
      data: { storeId: storeAId, name: "Alerts Buyer", email: `alerts-${RUN}@example.com` },
    })).id;
  });

  /** A store whose owner and staff each have one push device. */
  async function storeWithDevices(label: string) {
    const storeId = (await raw.store.create({
      data: { slug: `alerts-${label}-${RUN}`, name: `Alerts ${label}`, themePreset: "palm-and-shea" },
    })).id;
    const ownerId = `alerts-${label}-owner-${RUN}`;
    const staffId = `alerts-${label}-staff-${RUN}`;
    await raw.user.createMany({ data: [ownerId, staffId].map((id) => ({ id, name: id, email: `${id}@example.com` })) });
    await storeScoped(storeId).storeMembership.createMany({
      data: [{ storeId, userId: ownerId, role: "owner" }, { storeId, userId: staffId, role: "staff" }],
    });
    for (const userId of [ownerId, staffId]) {
      await storeScoped(storeId).pushSubscription.create({
        data: { storeId, userId, endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`, ...PUSH_KEYS },
      });
    }
    return { storeId, ownerId };
  }

  /** An authorized order whose lines reserve stock the way checkout does. */
  async function placeOrder(lines: Array<{ listingId: string; qty: number }>, storeId = storeAId) {
    const customerId = storeId === storeAId ? customerAId : (await storeScoped(storeId).customer.create({
      data: { storeId, name: "Alerts Buyer", email: `alerts-${storeId}@example.com` },
    })).id;
    const variants = await Promise.all(lines.map((line) =>
      storeScoped(storeId).listingVariant.create({
        data: { listingId: line.listingId, label: "Each", price: 500, weightG: 500 },
      })));
    return storeScopedTransaction(storeId, async (tx) => {
      const locked = await lockListingRows(tx, lines.map((line) => line.listingId));
      const order = await tx.order.create({
        data: {
          storeId,
          number: ++orderNumber,
          customerId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 1000,
          bufferCents: 0,
          totalCents: 1000,
          totalAuthorizedCents: 1000,
        },
      });
      const created = await Promise.all(lines.map((line, i) =>
        tx.orderLine.create({
          data: { storeId, orderId: order.id, listingVariantId: variants[i]!.id, qtyOrdered: line.qty, unitPriceCents: 500 },
        })));
      await reserveOrderStock(tx, storeId, created.map((row, i) => ({
        id: row.id,
        listingId: lines[i]!.listingId,
        qtyOrdered: lines[i]!.qty,
      })), locked);
      return order.id;
    });
  }

  async function runOrderAlerts(orderId: string) {
    await orderAlertsHandler({ event: { data: { storeId: storeAId, orderId } }, step: makeFakeStep() });
  }

  async function alertsFor(listingId: string) {
    return storeScoped(storeAId).copilotAlert.findMany({ where: { listingId }, orderBy: { kind: "asc" } });
  }

  afterAll(async () => {
    await raw.$disconnect();
  });

  afterEach(() => {
    setPushSenderForTests(null);
    vi.unstubAllEnvs();
  });

  it("copilot_alerts: storeScoped(B) reads none of A's alerts, cannot insert one for A, and updates nothing", async () => {
    const listingAId = await counted(storeAId, "Gari", 3);
    const alert = await storeScoped(storeAId).copilotAlert.create({
      data: { storeId: storeAId, kind: "running_low", listingId: listingAId, dedupeKey: `running_low:${listingAId}:rls` },
    });

    expect(await storeScoped(storeBId).copilotAlert.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).copilotAlert.create({
        data: { storeId: storeAId, kind: "sold_out", listingId: listingAId, dedupeKey: "cross-store" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    await expect(
      storeScoped(storeBId).copilotAlert.create({
        data: { storeId: storeBId, kind: "sold_out", listingId: listingAId, dedupeKey: "foreign-listing" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).copilotAlert.updateMany({
      where: { id: alert.id },
      data: { state: "resolved" },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).copilotAlert.findUniqueOrThrow({ where: { id: alert.id } })).state).toBe("open");
  });

  it("an order that leaves a counted listing at or under 5 raises one running_low alert, and a replay adds none", async () => {
    const listingId = await counted(storeAId, "Egusi", 6);
    const orderId = await placeOrder([{ listingId, qty: 2 }]);

    await runOrderAlerts(orderId);
    await runOrderAlerts(orderId);

    const alerts = await alertsFor(listingId);
    expect(alerts.filter((a) => a.kind === "running_low")).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "order_needs_low_stock").map((a) => a.orderId)).toEqual([orderId]);
    expect(alerts.every((a) => a.state === "open")).toBe(true);
    expect(alerts).toHaveLength(2);
  });

  it("an order that takes the last unit raises one sold_out and one order_needs_low_stock alert", async () => {
    const listingId = await counted(storeAId, "Ogbono", 1);
    const plentyId = await counted(storeAId, "Rice", 40);
    const orderId = await placeOrder([{ listingId, qty: 1 }, { listingId: plentyId, qty: 1 }]);

    await runOrderAlerts(orderId);

    expect((await alertsFor(listingId)).map((a) => [a.kind, a.orderId])).toEqual([
      ["order_needs_low_stock", orderId],
      ["sold_out", null],
    ]);
    expect(await alertsFor(plentyId)).toEqual([]);
  });

  it("ten alerts in twenty minutes send at most two owner pushes in the hour; the rest wait for the next allowed push", async () => {
    const { storeId, ownerId } = await storeWithDevices("cap");
    const sender = new PushTestSender();
    setPushSenderForTests(sender);

    const start = Date.now();
    const alertIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const listingId = await counted(storeId, `Item ${i}`, 2);
      alertIds.push((await storeScoped(storeId).copilotAlert.create({
        data: { storeId, kind: "running_low", listingId, dedupeKey: `running_low:${listingId}:cap` },
      })).id);
      await pushCopilotAlerts(storeId, VAPID_ENV, start + i * 2 * 60_000);
    }

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent.every((push) => push.endpoint.endsWith(ownerId))).toBe(true);
    const after = await storeScoped(storeId).copilotAlert.findMany({ orderBy: { createdAt: "asc" } });
    expect(after.map((a) => a.pushedAt !== null)).toEqual([true, true, false, false, false, false, false, false, false, false]);
    expect(after.every((a) => a.state === "open")).toBe(true);

    await pushCopilotAlerts(storeId, VAPID_ENV, start + 61 * 60_000);
    expect(sender.sent).toHaveLength(3);
    expect(sender.sent[2]!.message.body).toMatch(/8/);
    expect((await storeScoped(storeId).copilotAlert.count({ where: { pushedAt: null } }))).toBe(0);
  });

  it("two racing pushes for one waiting alert use one of the hour's pushes, so a new alert minutes later still goes out", async () => {
    const { storeId } = await storeWithDevices("race");
    const sender = new PushTestSender();
    setPushSenderForTests(sender);
    const alert = async (name: string) => {
      const listingId = await counted(storeId, name, 2);
      await storeScoped(storeId).copilotAlert.create({
        data: { storeId, kind: "running_low", listingId, dedupeKey: `running_low:${listingId}:race` },
      });
    };

    const start = Date.now();
    await alert("Yam");
    await Promise.all([pushCopilotAlerts(storeId, VAPID_ENV, start), pushCopilotAlerts(storeId, VAPID_ENV, start)]);
    expect(sender.sent).toHaveLength(1);

    await alert("Plantain");
    await pushCopilotAlerts(storeId, VAPID_ENV, start + 5 * 60_000);
    expect(sender.sent).toHaveLength(2);
    expect(await storeScoped(storeId).copilotAlert.count({ where: { pushedAt: null } })).toBe(0);
  });

  it("a retried run whose alerts were already written still pushes them", async () => {
    const { storeId } = await storeWithDevices("retry");
    const sender = new PushTestSender();
    setPushSenderForTests(sender);
    const listingId = await counted(storeId, "Fufu", 6);
    const orderId = await placeOrder([{ listingId, qty: 2 }], storeId);
    await createOrderStockAlerts(storeId, orderId);

    const step = makeFakeStep();
    vi.stubEnv("VAPID_PUBLIC_KEY", VAPID_ENV.VAPID_PUBLIC_KEY);
    vi.stubEnv("VAPID_PRIVATE_KEY", VAPID_ENV.VAPID_PRIVATE_KEY);
    await orderAlertsHandler({ event: { data: { storeId, orderId } }, step });

    expect(step.runs).toEqual(["create-alerts", "push-alerts"]);
    expect(sender.sent).toHaveLength(1);
    expect(await storeScoped(storeId).copilotAlert.count({ where: { pushedAt: null } })).toBe(0);
  });
});
