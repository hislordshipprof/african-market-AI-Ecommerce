import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { invoicePrefill, listPurchaseOrders, receivePurchaseOrder } from "./purchase-orders";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t576-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("receiving a purchase order into stock (lane database)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let supplierA = "";
  let actor = { id: "", email: "" };
  let nextNumber = 1;

  async function listing(storeId: string, name: string, data: { stockMode: string; qty?: number; status?: string }) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, confidence: 0.4, ...data },
    })).id;
  }

  /** A sent order with one line per listing, as #575 leaves it after sending. */
  async function sentOrder(storeId: string, supplierId: string, lines: Array<{ listingId: string; quantity: number }>, status = "sent") {
    const order = await storeScoped(storeId).purchaseOrder.create({
      data: {
        storeId, supplierId, number: nextNumber++, status, sentVia: "email", sentAt: new Date(), createdById: actor.id,
        lines: { create: lines.map((line, position) => ({ storeId, listingId: line.listingId, name: `line ${position}`, quantity: line.quantity, position })) },
      },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    return { id: order.id, lines: order.lines.map((line) => line.id) };
  }

  const stock = (id: string, storeId = storeA) => storeScoped(storeId).listing.findUniqueOrThrow({ where: { id }, select: { qty: true, status: true, confidence: true } });
  const receiptEvents = (storeId: string) =>
    storeScoped(storeId).stockEvent.findMany({ where: { storeId, idempotencyKey: { startsWith: "po-receipt:" } }, orderBy: { idempotencyKey: "asc" } });

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `rcv-a-${RUN}`, name: "Mama Put Market" } })).id;
    storeB = (await raw.store.create({ data: { slug: `rcv-b-${RUN}`, name: "Other market" } })).id;
    const user = await raw.user.create({ data: { id: `rcv-${RUN}`, name: "Owner", email: `rcv-${RUN}@example.com` } });
    actor = { id: user.id, email: user.email };
    supplierA = (await storeScoped(storeA).supplier.create({ data: { storeId: storeA, name: "Lagos Foods", channel: "email", email: "o@lagos.example", leadDays: 3 } })).id;
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it("writes restock events for the ticked lines at the received quantities, a partial receipt included", async () => {
    const palm = await listing(storeA, "Palm oil", { stockMode: "counted", qty: 2 });
    const gari = await listing(storeA, "Gari", { stockMode: "counted", qty: 0 });
    const egusi = await listing(storeA, "Egusi", { stockMode: "status", status: "out_of_stock" });
    const order = await sentOrder(storeA, supplierA, [
      { listingId: palm, quantity: 12 },
      { listingId: gari, quantity: 6 },
      { listingId: egusi, quantity: 4 },
    ]);

    // Palm oil came short (8 of 12), Egusi came in, Gari did not come.
    const result = await receivePurchaseOrder(storeA, order.id, [
      { lineId: order.lines[0], quantity: 8, stockMode: "counted" },
      { lineId: order.lines[2], quantity: null, stockMode: "status" },
    ], actor);
    expect(result).toEqual({ ok: true, received: 2, rejected: [] });

    expect(await stock(palm)).toMatchObject({ qty: 10, confidence: 1 });
    expect(await stock(gari)).toMatchObject({ qty: 0, confidence: 0.4 });
    expect(await stock(egusi)).toMatchObject({ status: "in_stock", confidence: 1 });
    const events = await receiptEvents(storeA);
    expect(events.map((e) => [e.idempotencyKey, e.listingId, e.delta])).toEqual(
      [[`po-receipt:${order.lines[0]}`, palm, 8], [`po-receipt:${order.lines[2]}`, egusi, 0]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(events.find((e) => e.listingId === palm)!.type).toBe("restock");

    const changes = await raw.auditLog.findMany({ where: { storeId: storeA, action: "listing.stock_change", entityId: palm } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ actorId: actor.id, before: { qty: 2 }, after: { qty: 10, source: "copilot", purchaseOrderId: order.id } });
    const receipt = await raw.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "purchase_order.received" } });
    expect(receipt.after).toMatchObject({ status: "received", lines: [{ lineId: order.lines[0], quantity: 8 }, { lineId: order.lines[2], quantity: null }] });
    const shown = (await listPurchaseOrders(storeA)).find((o) => o.id === order.id)!;
    expect(shown.status).toBe("received");
    expect(shown.lines.map((l) => [l.quantity, l.received])).toEqual([[12, 8], [6, null], [4, "in_stock"]]);
  });

  it("writes nothing on a repeat tap", async () => {
    const yam = await listing(storeA, "Yam", { stockMode: "counted", qty: 1 });
    const order = await sentOrder(storeA, supplierA, [{ listingId: yam, quantity: 5 }]);
    const tap = () => receivePurchaseOrder(storeA, order.id, [{ lineId: order.lines[0], quantity: 5, stockMode: "counted" }], actor);

    const [first, second] = await Promise.all([tap(), tap()]);
    const third = await tap();
    expect([first, second].filter((r) => r.ok)).toHaveLength(1);
    expect(third).toMatchObject({ ok: false });
    expect((await stock(yam)).qty).toBe(6);
    expect((await receiptEvents(storeA)).filter((e) => e.listingId === yam)).toHaveLength(1);
    expect(await raw.auditLog.count({ where: { entityId: order.id, action: "purchase_order.received" } })).toBe(1);
  });

  it("rejects and lists a line on an archived listing or one whose stock mode changed; the other lines still go in", async () => {
    const ogbono = await listing(storeA, "Ogbono", { stockMode: "counted", qty: 0 });
    const crayfish = await listing(storeA, "Crayfish", { stockMode: "counted", qty: 3 });
    const rice = await listing(storeA, "Rice", { stockMode: "counted", qty: 4 });
    const order = await sentOrder(storeA, supplierA, [
      { listingId: ogbono, quantity: 2 },
      { listingId: crayfish, quantity: 2 },
      { listingId: rice, quantity: 2 },
    ]);
    await storeScoped(storeA).listing.update({ where: { id: ogbono }, data: { active: false } });
    await storeScoped(storeA).listing.update({ where: { id: crayfish }, data: { stockMode: "status", qty: null, status: "low" } });

    const result = await receivePurchaseOrder(storeA, order.id, order.lines.map((lineId) => ({ lineId, quantity: 2, stockMode: "counted" as const })), actor);
    expect(result).toEqual({
      ok: true,
      received: 1,
      rejected: [
        { lineId: order.lines[0], name: "line 0", reason: "archived" },
        { lineId: order.lines[1], name: "line 1", reason: "stock_mode_changed" },
      ],
    });
    expect((await stock(ogbono)).qty).toBe(0);
    expect(await stock(crayfish)).toMatchObject({ qty: null, status: "low" });
    expect((await stock(rice)).qty).toBe(6);
    const receipt = await raw.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "purchase_order.received" } });
    expect(receipt.after).toMatchObject({ rejected: [{ lineId: order.lines[0], reason: "archived" }, { lineId: order.lines[1], reason: "stock_mode_changed" }] });
  });

  it("rejects a restock past the qty column and leaves the listing as it was", async () => {
    const salt = await listing(storeA, "Salt", { stockMode: "counted", qty: 2_147_483_000 });
    const order = await sentOrder(storeA, supplierA, [{ listingId: salt, quantity: 1000 }]);
    const result = await receivePurchaseOrder(storeA, order.id, [{ lineId: order.lines[0], quantity: 1000, stockMode: "counted" }], actor);
    expect(result).toMatchObject({ ok: true, received: 0, rejected: [{ reason: "too_large" }] });
    expect((await stock(salt)).qty).toBe(2_147_483_000);
  });

  it("refuses a draft, an empty tick list, a bad quantity, a line from another order and another store's order", async () => {
    const beans = await listing(storeA, "Beans", { stockMode: "counted", qty: 0 });
    const draft = await sentOrder(storeA, supplierA, [{ listingId: beans, quantity: 1 }], "draft");
    const sent = await sentOrder(storeA, supplierA, [{ listingId: beans, quantity: 1 }]);
    const line = (lineId: string, quantity: number | null = 1) => [{ lineId, quantity, stockMode: "counted" as const }];

    expect(await receivePurchaseOrder(storeA, draft.id, line(draft.lines[0]), actor)).toMatchObject({ ok: false });
    expect(await receivePurchaseOrder(storeA, sent.id, [], actor)).toMatchObject({ ok: false });
    expect(await receivePurchaseOrder(storeA, sent.id, line(sent.lines[0], 0), actor)).toMatchObject({ ok: false });
    expect(await receivePurchaseOrder(storeA, sent.id, line(sent.lines[0], null), actor)).toMatchObject({ ok: false });
    expect(await receivePurchaseOrder(storeA, sent.id, line(draft.lines[0]), actor)).toMatchObject({ ok: false });

    const supplierB = (await storeScoped(storeB).supplier.create({ data: { storeId: storeB, name: "B", channel: "email", email: "b@example.com", leadDays: 1 } })).id;
    const foreignListing = await listing(storeB, "Beans", { stockMode: "counted", qty: 0 });
    const foreign = await sentOrder(storeB, supplierB, [{ listingId: foreignListing, quantity: 1 }]);
    expect(await receivePurchaseOrder(storeA, foreign.id, line(foreign.lines[0]), actor)).toMatchObject({ ok: false });
    expect((await stock(foreignListing, storeB)).qty).toBe(0);
    expect((await stock(beans)).qty).toBe(0);
    expect(await receiptEvents(storeB)).toEqual([]);
    expect((await listPurchaseOrders(storeA)).find((o) => o.id === sent.id)!.status).toBe("sent");
  });

  it("pre-fills quantities from invoice lines on this order and writes nothing", async () => {
    const ugwu = await listing(storeA, "Ugwu leaves", { stockMode: "counted", qty: 1 });
    const kpomo = await listing(storeA, "Kpomo", { stockMode: "status", status: "low" });
    const plantain = await listing(storeA, "Plantain chips", { stockMode: "counted", qty: 0 });
    const order = await sentOrder(storeA, supplierA, [{ listingId: ugwu, quantity: 10 }, { listingId: kpomo, quantity: 2 }]);

    const prefill = await invoicePrefill(storeA, order.id, [
      { name: "Ugwu leaves", quantity: 9, unit: "bunches" },
      { name: "Kpomo 1kg", quantity: 3, unit: null },
      { name: "Plantain chips", quantity: 4, unit: null },
      { name: "Ugwu leaves", quantity: null, unit: null },
      { name: "Something unreadable", quantity: 2, unit: null },
    ]);
    expect(prefill).toEqual({
      ok: true,
      lines: { [order.lines[0]]: 9, [order.lines[1]]: 3 },
      unmatched: ["Plantain chips", "Ugwu leaves", "Something unreadable"],
    });
    expect((await stock(ugwu)).qty).toBe(1);
    expect((await stock(plantain)).qty).toBe(0);
    expect((await receiptEvents(storeA)).filter((e) => [ugwu, kpomo].includes(e.listingId))).toEqual([]);
    expect((await listPurchaseOrders(storeA)).find((o) => o.id === order.id)!.status).toBe("sent");
    expect(await invoicePrefill(storeB, order.id, [{ name: "Ugwu leaves", quantity: 9, unit: null }])).toMatchObject({ ok: false });
  });
});
