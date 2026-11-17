import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";
import { clearTestSentEmails, getTestSentEmails, setEmailSenderForTests } from "../email/send";
import { saveReorderList } from "../copilot/reorder-list";
import { archiveSupplier, listSuppliers, saveSupplier, setSupplierListings } from "./suppliers";
import {
  draftPurchaseOrders,
  editPurchaseOrderLines,
  listPurchaseOrders,
  movePurchaseOrder,
  receivePurchaseOrder,
  sendPurchaseOrder,
} from "./purchase-orders";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t575-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("suppliers and purchase orders (lane database)", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let actor = { id: "", email: "" };
  const ids: Record<string, string> = {};
  const store = { id: "", name: "Mama Put Market, Dallas" };

  async function listing(storeId: string, name: string, data: { stockMode: string; qty?: number; status?: string }) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, confidence: 1, ...data },
    })).id;
  }

  const audits = (entityId: string) =>
    raw.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" }, select: { action: true, before: true, after: true } });

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `po-a-${RUN}`, name: store.name } })).id;
    storeB = (await raw.store.create({ data: { slug: `po-b-${RUN}`, name: "Other market" } })).id;
    store.id = storeA;
    const user = await raw.user.create({ data: { id: `po-${RUN}`, name: "Owner", email: `po-${RUN}@example.com` } });
    actor = { id: user.id, email: user.email };
    ids.palm = await listing(storeA, "Palm oil 1L", { stockMode: "counted", qty: 1 });
    ids.gari = await listing(storeA, "Gari", { stockMode: "counted", qty: 0 });
    ids.egusi = await listing(storeA, "Egusi", { stockMode: "status", status: "low" });
    ids.yam = await listing(storeA, "Yam", { stockMode: "counted", qty: 0 });
    ids.foreign = await listing(storeB, "Palm oil 1L", { stockMode: "counted", qty: 0 });
  });

  afterEach(() => {
    clearTestSentEmails();
    setEmailSenderForTests(null);
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  async function supplier(storeId: string, input: Record<string, unknown>) {
    const result = await saveSupplier(storeId, null, { leadDays: 3, ...input }, actor);
    if (!result.ok) throw new Error(result.message);
    return result.id;
  }

  it("keeps a supplier's name, contact, channel, lead time and listings, with an audit row", async () => {
    ids.lagos = await supplier(storeA, { name: "Lagos Foods", contactName: "Ade", email: "orders@lagosfoods.example", channel: "email", leadDays: 5 });
    ids.accra = await supplier(storeA, { name: "Accra Imports", phone: "(214) 555-2368", channel: "whatsapp" });
    expect(await setSupplierListings(storeA, ids.lagos, [ids.palm, ids.gari], actor)).toEqual({ ok: true });
    expect(await setSupplierListings(storeA, ids.accra, [ids.egusi], actor)).toEqual({ ok: true });

    const suppliers = await listSuppliers(storeA);
    const lagos = suppliers.find((s) => s.id === ids.lagos)!;
    expect(lagos).toMatchObject({ name: "Lagos Foods", contactName: "Ade", email: "orders@lagosfoods.example", channel: "email", leadDays: 5 });
    expect(lagos.listingIds.sort()).toEqual([ids.palm, ids.gari].sort());
    expect(suppliers.find((s) => s.id === ids.accra)).toMatchObject({ phone: "+12145552368", listingIds: [ids.egusi] });
    expect((await audits(ids.lagos)).map((a) => a.action)).toEqual(["supplier.create", "supplier.listings"]);
  });

  it("refuses a channel without its contact, a bad phone and a lead time out of range", async () => {
    expect(await saveSupplier(storeA, null, { name: "X", channel: "email", leadDays: 3 }, actor)).toMatchObject({ ok: false });
    expect(await saveSupplier(storeA, null, { name: "X", channel: "sms", phone: "12", leadDays: 3 }, actor)).toMatchObject({ ok: false });
    expect(await saveSupplier(storeA, null, { name: "X", channel: "sms", phone: "2145552368", leadDays: 91 }, actor)).toMatchObject({ ok: false });
    // WhatsApp wholesalers can be abroad: an explicit + number is kept.
    const abroad = await saveSupplier(storeA, null, { name: "Kano Grains", channel: "whatsapp", phone: "+234 803 123 4567", leadDays: 30 }, actor);
    expect(abroad).toMatchObject({ ok: true });
    ids.kano = abroad.ok ? abroad.id : "";
  });

  it("moves a listing to its new supplier: one supplier per listing", async () => {
    expect(await setSupplierListings(storeA, ids.kano, [ids.gari], actor)).toEqual({ ok: true });
    const suppliers = await listSuppliers(storeA);
    expect(suppliers.find((s) => s.id === ids.lagos)!.listingIds).toEqual([ids.palm]);
    expect(suppliers.find((s) => s.id === ids.kano)!.listingIds).toEqual([ids.gari]);
    await setSupplierListings(storeA, ids.lagos, [ids.palm, ids.gari], actor);
  });

  it("keeps a hidden item already linked when the owner saves the supplier's items, but never adds a hidden one", async () => {
    const shown = await listing(storeA, "Ogbono", { stockMode: "counted", qty: 0 });
    const hidden = await listing(storeA, "Crayfish", { stockMode: "counted", qty: 0 });
    const added = await listing(storeA, "Stockfish", { stockMode: "counted", qty: 0 });
    const lekki = await supplier(storeA, { name: "Lekki Wholesale", email: "orders@lekki.example", channel: "email" });
    expect(await setSupplierListings(storeA, lekki, [shown, hidden], actor)).toEqual({ ok: true });
    await storeScoped(storeA).listing.update({ where: { id: hidden }, data: { active: false } });

    const linked = (await listSuppliers(storeA)).find((s) => s.id === lekki)!.listingIds;
    expect(await setSupplierListings(storeA, lekki, [...linked, added], actor)).toEqual({ ok: true });
    expect((await listSuppliers(storeA)).find((s) => s.id === lekki)!.listingIds.sort()).toEqual([shown, hidden, added].sort());

    const other = await supplier(storeA, { name: "Ikeja Foods", email: "orders@ikeja.example", channel: "email" });
    expect(await setSupplierListings(storeA, other, [hidden], actor)).toMatchObject({ ok: false });
    expect((await listSuppliers(storeA)).find((s) => s.id === lekki)!.listingIds).toContain(hidden);
  });

  it("never links another store's listing or supplier", async () => {
    expect(await setSupplierListings(storeA, ids.lagos, [ids.palm, ids.foreign], actor)).toMatchObject({ ok: false });
    const other = await supplier(storeB, { name: "B wholesaler", email: "b@example.com", channel: "email" });
    expect(await setSupplierListings(storeA, other, [ids.palm], actor)).toMatchObject({ ok: false });
    expect(await saveSupplier(storeA, other, { name: "Taken", email: "t@example.com", channel: "email", leadDays: 1 }, actor)).toMatchObject({ ok: false });
    expect((await listSuppliers(storeB)).map((s) => s.name)).toEqual(["B wholesaler"]);
    // The database refuses it even when the app does not check.
    await expect(storeScopedTransaction(storeA, (tx) =>
      tx.supplierListing.create({ data: { storeId: storeA, supplierId: ids.lagos, listingId: ids.foreign } }),
    )).rejects.toSatisfy(isRlsRejection);
    await expect(storeScopedTransaction(storeA, (tx) =>
      tx.purchaseOrder.create({ data: { storeId: storeA, supplierId: other, number: 99, createdById: actor.id } }),
    )).rejects.toSatisfy(isRlsRejection);
  });

  it("splits the saved reorder list into one draft per supplier and leaves unassigned items out", async () => {
    expect(await saveReorderList(storeA, [
      { listingId: ids.palm, quantity: 12 },
      { listingId: ids.gari, quantity: 4 },
      { listingId: ids.egusi, quantity: null },
      { listingId: ids.yam, quantity: 6 },
    ], actor)).toEqual({ ok: true });

    const result = await draftPurchaseOrders(storeA, actor);
    expect(result).toEqual({ ok: true, drafted: 2, unassigned: ["Yam"] });
    const orders = await listPurchaseOrders(storeA);
    expect(orders.map((o) => [o.supplier.name, o.status, o.lines.map((l) => [l.name, l.quantity])])).toEqual([
      ["Accra Imports", "draft", [["Egusi", null]]],
      ["Lagos Foods", "draft", [["Palm oil 1L", 12], ["Gari", 4]]],
    ]);
    expect(new Set(orders.map((o) => o.number))).toEqual(new Set([1, 2]));
    expect((await audits(orders[0].id)).map((a) => a.action)).toEqual(["purchase_order.draft"]);
    expect(await listPurchaseOrders(storeB)).toEqual([]);
  });

  it("drafting again replaces a supplier's draft, keeping its number", async () => {
    const before = await listPurchaseOrders(storeA);
    await saveReorderList(storeA, [{ listingId: ids.palm, quantity: 20 }], actor);
    expect(await draftPurchaseOrders(storeA, actor)).toEqual({ ok: true, drafted: 1, unassigned: [] });
    const after = await listPurchaseOrders(storeA);
    const lagosBefore = before.find((o) => o.supplier.name === "Lagos Foods")!;
    const lagosAfter = after.find((o) => o.supplier.name === "Lagos Foods")!;
    expect(lagosAfter).toMatchObject({ id: lagosBefore.id, number: lagosBefore.number });
    expect(lagosAfter.lines.map((l) => [l.name, l.quantity])).toEqual([["Palm oil 1L", 20]]);
    // Accra had nothing on the new list, so its draft is untouched.
    expect(after.find((o) => o.supplier.name === "Accra Imports")!.lines).toHaveLength(1);
  });

  it("edits lines of a draft only, and a 0 removes a line but not the last one", async () => {
    const accra = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Accra Imports")!;
    const line = accra.lines[0];
    expect(await editPurchaseOrderLines(storeA, accra.id, [{ lineId: line.id, quantity: 0 }], actor)).toMatchObject({ ok: false });
    expect(await editPurchaseOrderLines(storeA, accra.id, [{ lineId: line.id, quantity: 100_001 }], actor)).toMatchObject({ ok: false });
    expect(await editPurchaseOrderLines(storeA, accra.id, [{ lineId: line.id, quantity: 8 }], actor)).toEqual({ ok: true });
    const edit = (await audits(accra.id)).at(-1)!;
    expect(edit).toMatchObject({ action: "purchase_order.edit", before: { lines: [{ lineId: line.id, quantity: null }] }, after: { lines: [{ lineId: line.id, quantity: 8 }] } });
    const foreignLine = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Lagos Foods")!.lines[0];
    expect(await editPurchaseOrderLines(storeA, accra.id, [{ lineId: foreignLine.id, quantity: 3 }], actor)).toMatchObject({ ok: false });
    expect(await editPurchaseOrderLines(storeB, accra.id, [{ lineId: line.id, quantity: 3 }], actor)).toMatchObject({ ok: false });
  });

  it("will not send a line with no quantity", async () => {
    await saveReorderList(storeA, [{ listingId: ids.egusi, quantity: null }], actor);
    const accraDraft = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Accra Imports")!;
    await draftPurchaseOrders(storeA, actor);
    expect(await sendPurchaseOrder(storeA, accraDraft.id, { ...actor, storeName: store.name })).toMatchObject({ ok: false });
    expect((await listPurchaseOrders(storeA)).find((o) => o.id === accraDraft.id)!.status).toBe("draft");
    await editPurchaseOrderLines(storeA, accraDraft.id, [{ lineId: (await listPurchaseOrders(storeA)).find((o) => o.id === accraDraft.id)!.lines[0].id, quantity: 8 }], actor);
  });

  it("emails a supplier from the platform sender with the store's name, and sends once", async () => {
    const lagos = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Lagos Foods")!;
    const sent = await sendPurchaseOrder(storeA, lagos.id, { ...actor, storeName: store.name });
    expect(sent).toEqual({ ok: true, via: "email" });
    const emails = getTestSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("orders@lagosfoods.example");
    expect(emails[0].from).toMatch(/^"Mama Put Market, Dallas" <[^>]+>$/);
    expect(emails[0].replyTo).toBe(actor.email);
    expect(emails[0].html).toContain("Palm oil 1L");
    expect(emails[0].html).toContain("20");

    expect(await sendPurchaseOrder(storeA, lagos.id, { ...actor, storeName: store.name })).toMatchObject({ ok: false });
    expect(getTestSentEmails()).toHaveLength(1);
    const after = (await listPurchaseOrders(storeA)).find((o) => o.id === lagos.id)!;
    expect(after).toMatchObject({ status: "sent", sentVia: "email" });
    expect(await editPurchaseOrderLines(storeA, lagos.id, [{ lineId: after.lines[0].id, quantity: 1 }], actor)).toMatchObject({ ok: false });
    expect((await audits(lagos.id)).at(-1)).toMatchObject({ action: "purchase_order.send", after: { status: "sent", via: "email" } });
  });

  it("keeps the draft when the email fails", async () => {
    await saveReorderList(storeA, [{ listingId: ids.gari, quantity: 2 }], actor);
    await draftPurchaseOrders(storeA, actor);
    const draft = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Lagos Foods" && o.status === "draft")!;
    setEmailSenderForTests({ send: async () => { throw new Error("down"); } });
    expect(await sendPurchaseOrder(storeA, draft.id, { ...actor, storeName: store.name })).toMatchObject({ ok: false });
    expect((await listPurchaseOrders(storeA)).find((o) => o.id === draft.id)!.status).toBe("draft");
    await movePurchaseOrder(storeA, draft.id, "cancelled", actor);
  });

  it("gives a pre-filled WhatsApp link and marks the order sent; the platform messages no one", async () => {
    const accra = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Accra Imports")!;
    const result = await sendPurchaseOrder(storeA, accra.id, { ...actor, storeName: store.name });
    expect(result.ok && result.via).toBe("whatsapp");
    const link = result.ok ? new URL(result.link!) : null;
    expect(link?.origin + link!.pathname).toBe("https://wa.me/12145552368");
    expect(link!.searchParams.get("text")).toMatch(/^Purchase order \d+ from Mama Put Market, Dallas\nEgusi: 8\n/);
    expect(getTestSentEmails()).toHaveLength(0);
    expect((await listPurchaseOrders(storeA)).find((o) => o.id === accra.id)).toMatchObject({ status: "sent", sentVia: "whatsapp" });
  });

  it("moves draft to sent to received or cancelled only, each move audited", async () => {
    const orders = await listPurchaseOrders(storeA);
    const accra = orders.find((o) => o.supplier.name === "Accra Imports")!;
    const egusi = { lineId: accra.lines[0].id, quantity: null, stockMode: "status" as const };
    expect(await receivePurchaseOrder(storeA, accra.id, [egusi], actor)).toMatchObject({ ok: true });
    expect(await movePurchaseOrder(storeA, accra.id, "cancelled", actor)).toMatchObject({ ok: false });
    expect(await movePurchaseOrder(storeB, accra.id, "cancelled", actor)).toMatchObject({ ok: false });
    expect((await audits(accra.id)).map((a) => a.action).slice(-2)).toEqual(["purchase_order.send", "purchase_order.received"]);
    const cancelled = orders.find((o) => o.status === "cancelled")!;
    expect(await receivePurchaseOrder(storeA, cancelled.id, [{ ...egusi, lineId: cancelled.lines[0].id }], actor)).toMatchObject({ ok: false });
  });

  it("will not archive a supplier with an open order, and drops an archived supplier's listings", async () => {
    await saveReorderList(storeA, [{ listingId: ids.gari, quantity: 2 }], actor);
    await draftPurchaseOrders(storeA, actor);
    expect(await archiveSupplier(storeA, ids.lagos, actor)).toMatchObject({ ok: false });
    const draft = (await listPurchaseOrders(storeA)).find((o) => o.status === "draft")!;
    await movePurchaseOrder(storeA, draft.id, "cancelled", actor);
    const sentLagos = (await listPurchaseOrders(storeA)).find((o) => o.supplier.name === "Lagos Foods" && o.status === "sent")!;
    await receivePurchaseOrder(storeA, sentLagos.id, [{ lineId: sentLagos.lines[0].id, quantity: 20, stockMode: "counted" }], actor);
    expect(await archiveSupplier(storeA, ids.lagos, actor)).toEqual({ ok: true });
    expect((await listSuppliers(storeA)).map((s) => s.name)).not.toContain("Lagos Foods");
    expect(await draftPurchaseOrders(storeA, actor)).toMatchObject({ ok: false });
    expect(await storeScoped(storeA).supplierListing.count({ where: { supplierId: ids.lagos } })).toBe(0);
  });
});
