import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const session = vi.hoisted(() => ({ store: { id: "", slug: "", name: "Starter store" }, user: { id: "", email: "" } }));
vi.mock("@/lib/store-admin/session", () => ({ requireStoreOwner: async () => session }));

import { draftPurchaseOrdersAction, receivePurchaseOrderAction, saveSupplierAction } from "./actions";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("purchasing actions plan gate (lane DB)", () => {
  const run = `po575a-${Date.now()}`;
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    session.store.id = (await raw.store.create({ data: { slug: `${run}-starter`, name: "Starter store" } })).id;
    const user = await raw.user.create({ data: { id: run, name: "Owner", email: `${run}@example.com` } });
    session.user = { id: user.id, email: user.email };
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it("refuses a Starter store and writes nothing", async () => {
    const supplier = { name: "Lagos Foods", email: "orders@example.com", channel: "email", leadDays: 3 };
    expect(await saveSupplierAction({ id: null, supplier })).toMatchObject({ ok: false, message: expect.stringContaining("Pro") });
    expect(await draftPurchaseOrdersAction()).toMatchObject({ ok: false, message: expect.stringContaining("Pro") });
    const receipt = { orderId: "po-1", lines: [{ lineId: "line-1", quantity: 2, stockMode: "counted" }] };
    expect(await receivePurchaseOrderAction(receipt)).toMatchObject({ ok: false, message: expect.stringContaining("Pro") });
    expect(await raw.supplier.count({ where: { storeId: session.store.id } })).toBe(0);
  });
});
