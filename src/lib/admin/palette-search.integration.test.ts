import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const requirePlatformAdmin = vi.fn();
vi.mock("./session", () => ({ requirePlatformAdmin: () => requirePlatformAdmin() }));

const { paletteSearchAction } = await import("./palette-search");

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t859p${Date.now()}`;
const storeA = crypto.randomUUID();
const storeB = crypto.randomUUID();
let prisma: PrismaClient;

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  prisma = testPrismaClient();
  await asPlatformAdmin(async (tx) => {
    await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, ${`Palette Market ${RUN}`}, ${`pm-${RUN}`}, 'active', now()), (${storeB}, ${`Other ${RUN}`}, ${`palette-other-${RUN}`}, 'setup', now())`;
    for (const storeId of [storeA, storeB]) {
      const customer = await tx.customer.create({ data: { storeId, name: "Palette" } });
      await tx.order.create({ data: { storeId, customerId: customer.id, number: 7, subtotalCents: 500, bufferCents: 0, totalAuthorizedCents: 500 } });
    }
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.order.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
    await tx.customer.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
    await tx.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  requirePlatformAdmin.mockReset();
  requirePlatformAdmin.mockResolvedValue({ user: { id: "admin", email: "admin@platform.test" } });
});

describe.skipIf(!hasDb)("paletteSearchAction (#859)", () => {
  it("finds stores by name or slug, ignoring case", async () => {
    expect((await paletteSearchAction(`palette market ${RUN}`)).stores.map((store) => store.id)).toEqual([storeA]);
    expect((await paletteSearchAction(`PALETTE-OTHER-${RUN}`)).stores.map((store) => store.id)).toEqual([storeB]);
  });

  it("finds an order by its number in the stores the words match, through the order search", async () => {
    const found = await paletteSearchAction(`${RUN} #7`);
    expect(found.orders.map((order) => [order.storeName, order.number]).sort()).toEqual([[`Other ${RUN}`, 7], [`Palette Market ${RUN}`, 7]]);
    expect((await paletteSearchAction(`pm-${RUN} 8`)).orders).toEqual([]);
  });

  it("reads nothing for a query with no store words", async () => {
    expect(await paletteSearchAction("#7")).toEqual({ stores: [], orders: [] });
    expect(await paletteSearchAction(42 as unknown as string)).toEqual({ stores: [], orders: [] });
  });

  it("refuses anyone who is not a platform admin before reading", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("NEXT_REDIRECT /admin/sign-in"));
    await expect(paletteSearchAction(RUN)).rejects.toThrow("NEXT_REDIRECT");
  });
});
