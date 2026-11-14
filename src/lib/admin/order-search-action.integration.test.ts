import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const requirePlatformAdmin = vi.fn();
vi.mock("./session", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));

const { searchOrdersAction } = await import("./order-search-action");
const { INITIAL_ORDER_SEARCH } = await import("./order-search");

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t537a-${Date.now()}`;
const storeId = crypto.randomUUID();
let prisma: PrismaClient;

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  await asPlatformAdmin(async (tx) => {
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, ${`Action ${RUN}`}, ${RUN}, 'active', now())`;
    const customer = await tx.customer.create({ data: { storeId, name: "Action" } });
    await tx.order.createMany({
      data: Array.from({ length: 52 }, (_, i) => i + 1).map((number) => ({
        storeId, customerId: customer.id, number, subtotalCents: 500, bufferCents: 0, totalAuthorizedCents: 500, createdAt: new Date(Date.UTC(2026, 2, 1, 0, number)),
      })),
    });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.order.deleteMany({ where: { storeId } });
    await tx.customer.deleteMany({ where: { storeId } });
    await tx.store.deleteMany({ where: { id: storeId } });
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  requirePlatformAdmin.mockReset();
  requirePlatformAdmin.mockResolvedValue({ user: { id: "admin", email: "admin@platform.test" } });
});

describe.skipIf(!hasDb)("searchOrdersAction (lane DB)", () => {
  it("returns the matching orders and echoes the fields back for the form", async () => {
    const state = await searchOrdersAction(INITIAL_ORDER_SEARCH, form({ storeId, number: "2" }));
    expect(state.error).toBeNull();
    expect(state.rows?.map((row) => row.number)).toEqual([2]);
    expect(state.values).toMatchObject({ storeId, number: "2" });
    expect(state.page).toBe(1);
  });

  it("says what is wrong instead of searching", async () => {
    const state = await searchOrdersAction(INITIAL_ORDER_SEARCH, form({ number: "2" }));
    expect(state).toMatchObject({ error: "Choose a store to search by order number.", rows: null, values: { number: "2" } });
  });

  it("pages 50 at a time, counts pages as the cursor moves on, and starts over on a new search", async () => {
    const first = await searchOrdersAction(INITIAL_ORDER_SEARCH, form({ storeId }));
    expect(first.rows).toHaveLength(50);
    expect(first.rows?.[0]?.number).toBe(52);
    const second = await searchOrdersAction(first, form({ storeId, cursor: first.nextCursor ?? "" }));
    expect(second.rows?.map((row) => row.number)).toEqual([2, 1]);
    expect(second).toMatchObject({ page: 2, nextCursor: null });
    expect((await searchOrdersAction(second, form({ storeId }))).page).toBe(1);
  });

  it("refuses anyone who is not a platform admin before reading", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("NEXT_REDIRECT /admin/sign-in"));
    await expect(searchOrdersAction(INITIAL_ORDER_SEARCH, form({ storeId }))).rejects.toThrow("NEXT_REDIRECT");
  });
});
