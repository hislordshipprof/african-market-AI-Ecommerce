import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../inngest/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inngest/notify")>()),
  scheduleCourierPacking: vi.fn(),
}));
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { setStripeProvider } from "../stripe";
import { capturedPayments, fakeStripeProvider, setAuthorizedAmount } from "../stripe/fake";
import { scheduleCourierPacking } from "../inngest/notify";
import { dispatchPackingOrder, type CourierEvent } from "../delivery/dispatch";
import { DoorDashDriveProvider } from "../delivery/doordash";
import { fakeDoorDash } from "../delivery/doordash-fake";
import { markLinePicked, markLineShort, markReady } from "./service";
import {
  BATCH_NOT_FOUND,
  BATCH_ORDERS_NOT_BATCHABLE,
  BATCH_SIZE,
  ORDER_IN_BATCH,
  leaveBatch,
  pickBatchLine,
  readPickBatch,
  startBatch,
  startBatchPacking,
} from "./batch";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t564-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("batch picking (#564, lane DB)", () => {
  let raw: PrismaClient;
  let storeId = "";
  let storeBId = "";
  let customerId = "";
  let customerBId = "";
  let categoryId = "";
  const masterIds: string[] = [];
  const v = { egusi: "", ogbono: "", stockfish: "", ugu: "", other: "" };
  let seq = 0;

  async function variant(store: string, name: string, price: number, extra: { master?: string; perishable?: boolean; frozen?: boolean } = {}) {
    const listing = await storeScoped(store).listing.create({
      data: {
        storeId: store, customName: name, price, stockMode: "counted", qty: 50,
        masterProductId: extra.master ?? null, perishable: extra.perishable ?? false, frozen: extra.frozen ?? false,
      },
    });
    return (await storeScoped(store).listingVariant.create({ data: { listingId: listing.id, label: "1 lb", price, weightG: 450 } })).id;
  }

  type LineSpec = { variantId: string; qty: number; price: number; swapRule?: string; substituteVariantId?: string };

  /** An accepted order; `minutesAgo` sets its age, which decides its tote letter and fill order. */
  async function order(lines: LineSpec[], opts: { minutesAgo: number; fulfillment?: string; store?: string } = { minutesAgo: 0 }) {
    const store = opts.store ?? storeId;
    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const hold = Math.round(subtotal * 1.2);
    const n = ++seq;
    const paymentIntentId = `pi_${RUN}_${n}`;
    const created = await storeScopedTransaction(store, async (tx) => {
      const row = await tx.order.create({
        data: {
          storeId: store,
          number: 1000 + n,
          customerId: store === storeId ? customerId : customerBId,
          status: "ACCEPTED",
          fulfillment: opts.fulfillment ?? "pickup",
          subtotalCents: subtotal,
          bufferCents: hold - subtotal,
          totalAuthorizedCents: hold,
          totalCents: subtotal,
          paymentIntentId,
          trackingToken: `tok_${RUN}_${n}_${"x".repeat(20)}`,
          ...(opts.fulfillment === "courier"
            ? { deliveryLine1: "1100 Wayne Ave", deliveryCity: "Silver Spring", deliveryState: "MD", deliveryZip: "20910" }
            : {}),
          acceptedAt: new Date(),
          createdAt: new Date(Date.now() - opts.minutesAgo * 60_000),
        },
      });
      const lineIds: string[] = [];
      for (const line of lines) {
        lineIds.push((await tx.orderLine.create({
          data: {
            storeId: store, orderId: row.id, listingVariantId: line.variantId, qtyOrdered: line.qty,
            unitPriceCents: line.price, swapRule: line.swapRule ?? "exact_only", substituteVariantId: line.substituteVariantId ?? null,
          },
        })).id);
      }
      return { id: row.id, number: row.number, lineIds };
    });
    setAuthorizedAmount(paymentIntentId, hold);
    return { ...created, paymentIntentId };
  }

  async function lineRow(id: string) {
    return storeScoped(storeId).orderLine.findUniqueOrThrow({ where: { id } });
  }

  async function orderRow(id: string) {
    return storeScoped(storeId).order.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    setStripeProvider(fakeStripeProvider);
    storeId = (await raw.store.create({
      data: {
        slug: `b-${RUN}`, name: "Ada's Market", themePreset: "palm-and-shea",
        addressLine1: "8121 Georgia Ave", city: "Silver Spring", state: "MD", zip: "20910", phone: "+13015550100",
      },
    })).id;
    storeBId = (await raw.store.create({ data: { slug: `bb-${RUN}`, name: "Other", themePreset: "palm-and-shea" } })).id;
    await platformAdminTransaction(async (tx) => {
      await tx.storeSubscription.create({ data: { storeId, plan: "pro", status: "active" } });
      categoryId = (await tx.category.create({ data: { name: `Soup ${RUN}`, slug: `soup-${RUN}`, sortOrder: 99 } })).id;
      for (const name of ["Egusi", "Ogbono"]) {
        masterIds.push((await tx.masterProduct.create({ data: { name: `${name} ${RUN}`, categoryId } })).id);
      }
    });
    v.egusi = await variant(storeId, "Egusi", 1000, { master: masterIds[0] });
    v.ogbono = await variant(storeId, "Ogbono", 1100, { master: masterIds[1] });
    v.stockfish = await variant(storeId, "Stockfish", 2500, { frozen: true });
    v.ugu = await variant(storeId, "Ugu leaves", 400, { perishable: true });
    v.other = await variant(storeBId, "Egusi", 1000);
    customerId = (await storeScoped(storeId).customer.create({ data: { storeId, name: "Ada", phone: "+13014482210", email: "ada@example.com" } })).id;
    customerBId = (await storeScoped(storeBId).customer.create({ data: { storeId: storeBId, name: "Bisi", phone: "+13014482211", email: "bisi@example.com" } })).id;
  });

  beforeEach(() => {
    vi.mocked(scheduleCourierPacking).mockClear();
  });

  afterAll(async () => {
    setStripeProvider(null);
    for (const id of [storeId, storeBId]) {
      const scoped = storeScoped(id);
      await scoped.deliveryEvent.deleteMany({});
      await scoped.delivery.deleteMany({});
      await scoped.substitutionRequest.deleteMany({});
      await scoped.notificationLog.deleteMany({});
      await scoped.stockEvent.deleteMany({});
      await scoped.orderLine.deleteMany({});
      await scoped.order.deleteMany({});
      await scoped.pickBatch.deleteMany({});
      await scoped.customer.deleteMany({});
      await scoped.listingVariant.deleteMany({});
      await scoped.listing.deleteMany({});
    }
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: [storeId, storeBId] } } });
      await tx.storeSubscription.deleteMany({ where: { storeId } });
      await tx.masterProduct.deleteMany({ where: { id: { in: masterIds } } });
      await tx.category.deleteMany({ where: { id: categoryId } });
    });
    await raw.store.deleteMany({ where: { id: { in: [storeId, storeBId] } } });
    await raw.$disconnect();
  });

  it("AC1: starts a batch from 2-4 accepted orders only, one open batch per order", async () => {
    const a = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 30 });
    const b = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 20 });
    const c = await order([{ variantId: v.ogbono, qty: 1, price: 1100 }], { minutesAgo: 10 });
    const picking = await order([{ variantId: v.ogbono, qty: 1, price: 1100 }], { minutesAgo: 5 });
    await markLinePicked(storeId, picking.lineIds[0]);

    expect(await startBatch(storeId, [a.id])).toEqual({ ok: false, error: BATCH_SIZE });
    expect(await startBatch(storeId, [a.id, a.id])).toEqual({ ok: false, error: BATCH_SIZE });
    expect(await startBatch(storeId, [a.id, b.id, c.id, picking.id, "x"])).toEqual({ ok: false, error: BATCH_SIZE });
    expect(await startBatch(storeId, [a.id, picking.id])).toEqual({ ok: false, error: BATCH_ORDERS_NOT_BATCHABLE });

    const first = await startBatch(storeId, [a.id, b.id]);
    expect(first.ok).toBe(true);
    // An order already in an open batch cannot join a second one.
    expect(await startBatch(storeId, [b.id, c.id])).toEqual({ ok: false, error: BATCH_ORDERS_NOT_BATCHABLE });
    expect((await orderRow(c.id)).pickBatchId).toBeNull();
  });

  it("AC1 store isolation: another store's orders and batches are not found, and RLS hides the batch row", async () => {
    const a = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 9 });
    const b = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const foreign = await order([{ variantId: v.other, qty: 1, price: 1000 }], { minutesAgo: 7, store: storeBId });
    expect(await startBatch(storeId, [a.id, foreign.id])).toEqual({ ok: false, error: "Order not found" });

    const started = await startBatch(storeId, [a.id, b.id]);
    if (!started.ok) throw new Error(started.error);
    expect(await readPickBatch(storeBId, started.batchId)).toBeNull();
    expect(await pickBatchLine(storeBId, started.batchId, v.egusi, 2)).toEqual({ ok: false, error: BATCH_NOT_FOUND });
    expect(await startBatchPacking(storeBId, started.batchId)).toEqual({ ok: false, error: BATCH_NOT_FOUND });
    expect(await leaveBatch(storeBId, started.batchId)).toEqual({ ok: false, error: BATCH_NOT_FOUND });
    expect(await storeScoped(storeBId).pickBatch.findMany()).toEqual([]);
    await expect(storeScoped(storeBId).pickBatch.create({ data: { storeId } })).rejects.toSatisfy(isRlsRejection);
    expect((await orderRow(a.id)).pickBatchId).toBe(started.batchId);
  });

  it("AC1: staff cannot pick or short a batched order's line on its own; the batch and individual picking cannot both win", async () => {
    const a = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 9 });
    const b = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const started = await startBatch(storeId, [a.id, b.id]);
    if (!started.ok) throw new Error(started.error);
    expect(await markLinePicked(storeId, a.lineIds[0])).toEqual({ ok: false, error: ORDER_IN_BATCH });
    expect(await markLineShort(storeId, b.lineIds[0], 0)).toEqual({ ok: false, error: ORDER_IN_BATCH });
    expect((await lineRow(a.lineIds[0])).status).toBe("pending");

    // A race between starting a batch and a separate pick: the store lock lets exactly one through.
    const c = await order([{ variantId: v.ogbono, qty: 1, price: 1100 }], { minutesAgo: 6 });
    const d = await order([{ variantId: v.ogbono, qty: 1, price: 1100 }], { minutesAgo: 5 });
    const [batch, pick] = await Promise.all([startBatch(storeId, [c.id, d.id]), markLinePicked(storeId, c.lineIds[0])]);
    expect([batch.ok, pick.ok].filter(Boolean)).toHaveLength(1);
    const stored = await orderRow(c.id);
    expect(stored.pickBatchId !== null && (await lineRow(c.lineIds[0])).status === "picked").toBe(false);
  });

  it("AC2: the combined list totals each item with its split per tote, in zone order with chilled and frozen last", async () => {
    const newer = await order([
      { variantId: v.egusi, qty: 1, price: 1000 },
      { variantId: v.stockfish, qty: 1, price: 2500 },
    ], { minutesAgo: 4 });
    const older = await order([
      { variantId: v.egusi, qty: 2, price: 1000, swapRule: "named_substitute", substituteVariantId: v.ogbono },
      { variantId: v.ugu, qty: 3, price: 400 },
    ], { minutesAgo: 14 });
    const started = await startBatch(storeId, [newer.id, older.id]);
    if (!started.ok) throw new Error(started.error);

    const batch = (await readPickBatch(storeId, started.batchId))!;
    expect(batch.totes.map((t) => [t.number, t.letter])).toEqual([[older.number, "A"], [newer.number, "B"]]);
    expect(batch.zones.map((z) => z.name)).toEqual([`Soup ${RUN}`, "Chilled", "Frozen"]);
    const egusi = batch.zones[0].lines[0];
    expect(egusi).toMatchObject({ name: "Egusi", label: "1 lb", totalQty: 3, open: true });
    expect(egusi.splits.map((s) => [s.number, s.letter, s.qty, s.swap])).toEqual([
      [older.number, "A", 2, "Swap OK: Ogbono 1 lb"],
      [newer.number, "B", 1, null],
    ]);
    expect(batch.packingStarted).toBe(false);
  });

  it("AC6: start packing moves every order to Picking and books the courier (#562) for courier orders only, once", async () => {
    const courier = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 9, fulfillment: "courier" });
    const pickup = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const started = await startBatch(storeId, [courier.id, pickup.id]);
    if (!started.ok) throw new Error(started.error);

    expect(await startBatchPacking(storeId, started.batchId)).toEqual({ ok: true });
    for (const id of [courier.id, pickup.id]) {
      const row = await orderRow(id);
      expect(row.status).toBe("PICKING");
      expect(row.pickingStartedAt).toBeInstanceOf(Date);
    }
    expect(vi.mocked(scheduleCourierPacking).mock.calls).toEqual([[storeId, courier.id]]);
    expect((await readPickBatch(storeId, started.batchId))!.packingStarted).toBe(true);

    // A second tap books nothing new.
    expect(await startBatchPacking(storeId, started.batchId)).toEqual({ ok: true });
    expect(vi.mocked(scheduleCourierPacking)).toHaveBeenCalledTimes(1);
  });

  it("AC6 with the DoorDash fake: the packing event books the courier for the ready time counted from start packing", async () => {
    const MIN = 60_000;
    const courier = await order([{ variantId: v.egusi, qty: 4, price: 1000 }], { minutesAgo: 9, fulfillment: "courier" });
    const pickup = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const started = await startBatch(storeId, [courier.id, pickup.id]);
    if (!started.ok) throw new Error(started.error);
    await startBatchPacking(storeId, started.batchId);
    const startedAt = (await orderRow(courier.id)).pickingStartedAt!;

    const keys = { DOORDASH_DEVELOPER_ID: "dev-564", DOORDASH_KEY_ID: "key-564", DOORDASH_SIGNING_SECRET: Buffer.from("signing-secret-564-bytes-0123456789").toString("base64url") };
    const now = () => startedAt;
    const fake = fakeDoorDash({ developerId: keys.DOORDASH_DEVELOPER_ID, keyId: keys.DOORDASH_KEY_ID, signingSecret: keys.DOORDASH_SIGNING_SECRET, now });
    const events: CourierEvent[] = [];
    const booked = await dispatchPackingOrder(storeId, courier.id, {
      providers: [new DoorDashDriveProvider({ env: keys, fetch: fake.fetch, now })],
      emit: async (event) => { events.push(event); },
      now,
    });

    // 4 items at the default 90 s each is under the 10-minute floor.
    const ready = new Date(startedAt.getTime() + 10 * MIN);
    expect(booked).toMatchObject({ ok: true, provider: "doordash" });
    expect(fake.calls[0].body).toMatchObject({ pickup_time: ready.toISOString() });
    expect((await orderRow(courier.id)).readyEstimateAt).toEqual(ready);
    expect((await readPickBatch(storeId, started.batchId))!.totes.find((t) => t.orderId === courier.id)?.readyEstimateAt).toEqual(ready);
  });

  it("AC3: units found fill the oldest order first; the short lands on the newest, which gets its own #13 prompt", async () => {
    const oldest = await order([{ variantId: v.egusi, qty: 2, price: 1000 }], { minutesAgo: 30 });
    const middle = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 20 });
    const newest = await order([{ variantId: v.egusi, qty: 2, price: 1000, swapRule: "store_suggests" }], { minutesAgo: 10 });
    const started = await startBatch(storeId, [newest.id, middle.id, oldest.id]);
    if (!started.ok) throw new Error(started.error);

    expect(await pickBatchLine(storeId, started.batchId, v.egusi, 6)).toEqual({
      ok: false,
      error: "Units found must be a whole number from 0 to 5",
    });
    expect(await pickBatchLine(storeId, started.batchId, v.egusi, 4)).toEqual({ ok: true });

    expect(await lineRow(oldest.lineIds[0])).toMatchObject({ status: "picked", qtyPicked: 2 });
    expect(await lineRow(middle.lineIds[0])).toMatchObject({ status: "picked", qtyPicked: 1 });
    expect(await lineRow(newest.lineIds[0])).toMatchObject({ status: "short", qtyPicked: 1 });
    expect((await orderRow(newest.id)).status).toBe("SUBSTITUTION_PENDING");
    expect((await orderRow(oldest.id)).status).toBe("PICKING");
    const prompts = await storeScoped(storeId).substitutionRequest.findMany({ where: { orderId: { in: [oldest.id, middle.id, newest.id] } } });
    expect(prompts.map((p) => [p.orderLineId, p.qty, p.status, p.proposedVariantId])).toEqual([
      [newest.lineIds[0], 1, "pending", v.ogbono],
    ]);

    // The line is done: nothing left to pick on it.
    expect(await pickBatchLine(storeId, started.batchId, v.egusi, 0)).toEqual({ ok: false, error: "Nothing left to pick on this line" });
  });

  it("AC3: a short spread over two orders gives each affected order line its own prompt", async () => {
    const older = await order([{ variantId: v.ogbono, qty: 2, price: 1100 }], { minutesAgo: 30 });
    const newer = await order([{ variantId: v.ogbono, qty: 2, price: 1100 }], { minutesAgo: 10 });
    const started = await startBatch(storeId, [older.id, newer.id]);
    if (!started.ok) throw new Error(started.error);

    expect(await pickBatchLine(storeId, started.batchId, v.ogbono, 1)).toEqual({ ok: true });
    expect(await lineRow(older.lineIds[0])).toMatchObject({ status: "short", qtyPicked: 1 });
    expect(await lineRow(newer.lineIds[0])).toMatchObject({ status: "short", qtyPicked: 0 });
    const prompts = await storeScoped(storeId).substitutionRequest.findMany({ where: { orderId: { in: [older.id, newer.id] } } });
    expect(prompts.map((p) => p.orderLineId).sort()).toEqual([older.lineIds[0], newer.lineIds[0]].sort());
  });

  it("AC4: each batched order goes Ready and captures only its own goods; the batch moves no money", async () => {
    const a = await order([{ variantId: v.egusi, qty: 2, price: 1000 }, { variantId: v.ugu, qty: 1, price: 400 }], { minutesAgo: 9 });
    const b = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const started = await startBatch(storeId, [a.id, b.id]);
    if (!started.ok) throw new Error(started.error);
    await startBatchPacking(storeId, started.batchId);
    await pickBatchLine(storeId, started.batchId, v.egusi, 3);

    // A is still missing its ugu; B goes Ready on its own.
    expect(await markReady(storeId, a.id)).toEqual({ ok: false, error: "Cannot mark ready: unresolved order lines remain" });
    expect(await markReady(storeId, b.id)).toEqual({ ok: true, capturedAmountCents: 1000 });
    expect(capturedPayments.get(b.paymentIntentId)).toBe(1000);
    expect(capturedPayments.has(a.paymentIntentId)).toBe(false);
    const readyNotes = (orderId: string) => storeScoped(storeId).notificationLog.count({ where: { orderId, event: "ready" } });
    expect(await readyNotes(b.id)).toBeGreaterThan(0);
    expect(await readyNotes(a.id)).toBe(0);

    await pickBatchLine(storeId, started.batchId, v.ugu, 1);
    expect(await markReady(storeId, a.id)).toEqual({ ok: true, capturedAmountCents: 2400 });
    expect(capturedPayments.get(a.paymentIntentId)).toBe(2400);
    expect(await readyNotes(a.id)).toBeGreaterThan(0);
    expect((await orderRow(b.id)).status).toBe("AWAITING_PICKUP");
  });

  it("AC5: leaving a batch returns each order to normal picking with its progress kept", async () => {
    const a = await order([{ variantId: v.egusi, qty: 1, price: 1000 }, { variantId: v.ogbono, qty: 1, price: 1100 }], { minutesAgo: 9 });
    const b = await order([{ variantId: v.egusi, qty: 1, price: 1000 }], { minutesAgo: 8 });
    const started = await startBatch(storeId, [a.id, b.id]);
    if (!started.ok) throw new Error(started.error);
    await pickBatchLine(storeId, started.batchId, v.egusi, 2);

    expect(await leaveBatch(storeId, started.batchId)).toEqual({ ok: true });
    expect(await readPickBatch(storeId, started.batchId)).toBeNull();
    expect((await orderRow(a.id)).pickBatchId).toBeNull();
    expect(await lineRow(a.lineIds[0])).toMatchObject({ status: "picked", qtyPicked: 1 });
    expect(await markLinePicked(storeId, a.lineIds[1])).toEqual({ ok: true, orderStatus: "PICKING" });
    expect(await leaveBatch(storeId, started.batchId)).toEqual({ ok: false, error: BATCH_NOT_FOUND });
  });
});
