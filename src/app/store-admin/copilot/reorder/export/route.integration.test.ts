import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "@/lib/db";
import { saveReorderList } from "@/lib/copilot/reorder-list";

const session = vi.hoisted(() => ({ store: { id: "", slug: "" } }));
vi.mock("@/lib/store-admin/session", () => ({ requireStoreOwner: async () => session }));

import { GET } from "./route";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("reorder list CSV export route (lane DB)", () => {
  const run = `ro551r-${Date.now()}`;
  let raw: PrismaClient;
  let starter = "";
  let pro = "";
  let empty = "";

  const get = (storeId: string) => {
    session.store = { id: storeId, slug: `${run}-${storeId.slice(-4)}` };
    return GET();
  };

  beforeAll(async () => {
    raw = testPrismaClient();
    starter = (await raw.store.create({ data: { slug: `${run}-starter`, name: "Starter store" } })).id;
    pro = (await raw.store.create({ data: { slug: `${run}-pro`, name: "Pro store" } })).id;
    empty = (await raw.store.create({ data: { slug: `${run}-empty`, name: "Empty store" } })).id;
    const user = await raw.user.create({ data: { id: run, name: "Owner", email: `${run}@example.com` } });
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.create({ data: { storeId: pro, plan: "pro", status: "active" } });
      await tx.storeSubscription.create({ data: { storeId: empty, plan: "pro", status: "active" } });
    });
    for (const storeId of [starter, pro]) {
      const listing = await storeScoped(storeId).listing.create({
        data: { storeId, customName: "Palm oil, 1L", price: 500, confidence: 1, stockMode: "counted", qty: 1 },
      });
      expect(await saveReorderList(storeId, [{ listingId: listing.id, quantity: 12 }], { id: user.id, email: user.email })).toEqual({ ok: true });
    }
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it("refuses a Starter store, even with a saved list", async () => {
    expect((await get(starter)).status).toBe(403);
  });

  it("is 404 for a Pro store with no saved list, never another store's", async () => {
    expect((await get(empty)).status).toBe(404);
  });

  it("gives a Pro store its saved list", async () => {
    const res = await get(pro);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.text()).toBe('Item,Quantity\r\n"Palm oil, 1L",12\r\n');
  });
});
