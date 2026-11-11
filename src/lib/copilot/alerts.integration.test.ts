import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { lockListingRows, storeScoped, storeScopedTransaction } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { reserveOrderStock } from "../order/stock-ledger";
import { makeFakeStep } from "../inngest/fake-step";
import { copilotOrderStockAlerts } from "./alert-functions";

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof makeFakeStep> }) => Promise<unknown>;
const orderAlertsHandler = (copilotOrderStockAlerts as unknown as { fn: Handler }).fn;

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t430-${Date.now().toString(36)}`;

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

  /** An authorized order whose lines reserve stock the way checkout does. */
  async function placeOrder(lines: Array<{ listingId: string; qty: number }>) {
    const variants = await Promise.all(lines.map((line) =>
      storeScoped(storeAId).listingVariant.create({
        data: { listingId: line.listingId, label: "Each", price: 500, weightG: 500 },
      })));
    return storeScopedTransaction(storeAId, async (tx) => {
      const locked = await lockListingRows(tx, lines.map((line) => line.listingId));
      const order = await tx.order.create({
        data: {
          storeId: storeAId,
          number: ++orderNumber,
          customerId: customerAId,
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
          data: { storeId: storeAId, orderId: order.id, listingVariantId: variants[i]!.id, qtyOrdered: line.qty, unitPriceCents: 500 },
        })));
      await reserveOrderStock(tx, storeAId, created.map((row, i) => ({
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
});
