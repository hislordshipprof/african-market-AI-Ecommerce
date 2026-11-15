import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { chatMonth } from "@/lib/billing/assistant-chats";

const session = vi.hoisted(() => ({ store: { id: "", slug: "", timezone: "America/Chicago" } }));
vi.mock("@/lib/store-admin/session", () => ({ requireStoreOwner: async () => session }));

import { GET } from "./route";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("analytics CSV export route (lane DB)", () => {
  const run = `an498r-${Date.now()}`;
  let raw: PrismaClient;
  let starter = "";
  let pro = "";

  const get = (storeId: string, view: string) => {
    session.store = { id: storeId, slug: storeId === pro ? `${run}-pro` : `${run}-starter`, timezone: "America/Chicago" };
    return GET(new Request(`http://localhost:3000/store-admin/analytics/export?view=${view}&range=30d`));
  };

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    starter = (await raw.store.create({ data: { slug: `${run}-starter`, name: "Starter store", timezone: "America/Chicago" } })).id;
    pro = (await raw.store.create({ data: { slug: `${run}-pro`, name: "Pro store", timezone: "America/Chicago" } })).id;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.storeSubscription.create({ data: { storeId: pro, plan: "pro", status: "active" } });
      await tx.assistantChatMonth.create({ data: { storeId: pro, month: new Date(`${chatMonth(new Date())}T00:00:00Z`), chats: 42 } });
    });
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it("refuses a Starter store", async () => {
    const res = await get(starter, "sales");
    expect(res.status).toBe(403);
  });

  it("gives a Pro store the assistant CSV with this month's chats against the plan cap, as on the page", async () => {
    const res = await get(pro, "assistant");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Chats this month,42\r\n");
    expect(body).toContain("Plan cap,5000\r\n");
  });
});
