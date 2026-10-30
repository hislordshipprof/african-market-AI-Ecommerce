import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let storeAId: string;
let storeBId: string;

beforeAll(async () => {
  await prisma.$connect();

  const storeA = await prisma.store.upsert({
    where: { slug: "test-store-a" },
    update: {},
    create: {
      slug: "test-store-a",
      name: "Test Store A",
      themePreset: "palm-and-shea",
    },
  });
  storeAId = storeA.id;

  const storeB = await prisma.store.upsert({
    where: { slug: "test-store-b" },
    update: {},
    create: {
      slug: "test-store-b",
      name: "Test Store B",
      themePreset: "lagoon-and-coral",
    },
  });
  storeBId = storeB.id;

  await prisma.storeContent.upsert({
    where: { storeId_key: { storeId: storeAId, key: "test_key" } },
    update: { value: "Store A value" },
    create: { storeId: storeAId, key: "test_key", value: "Store A value" },
  });

  await prisma.storeContent.upsert({
    where: { storeId_key: { storeId: storeBId, key: "test_key" } },
    update: { value: "Store B value" },
    create: { storeId: storeBId, key: "test_key", value: "Store B value" },
  });
});

afterAll(async () => {
  await prisma.storeContent.deleteMany({
    where: { storeId: { in: [storeAId, storeBId] } },
  });
  await prisma.store.deleteMany({
    where: { slug: { in: ["test-store-a", "test-store-b"] } },
  });
  await prisma.$disconnect();
});

async function queryAsStore(storeId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    await tx.$executeRaw`SET ROLE app_user`;
    return tx.storeContent.findMany();
  });
}

async function insertAsStore(storeId: string, targetStoreId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    await tx.$executeRaw`SET ROLE app_user`;
    return tx.storeContent.create({
      data: {
        storeId: targetStoreId,
        key: `rls_test_${Date.now()}`,
        value: "should fail",
      },
    });
  });
}

describe("Store isolation (RLS)", () => {
  it("store A can only read its own store_content rows", async () => {
    const rows = await queryAsStore(storeAId);
    expect(rows.length).toBe(1);
    expect(rows[0].storeId).toBe(storeAId);
    expect(rows[0].value).toBe("Store A value");
  });

  it("store B can only read its own store_content rows", async () => {
    const rows = await queryAsStore(storeBId);
    expect(rows.length).toBe(1);
    expect(rows[0].storeId).toBe(storeBId);
    expect(rows[0].value).toBe("Store B value");
  });

  it("store A cannot read store B rows", async () => {
    const rows = await queryAsStore(storeAId);
    const hasBRows = rows.some((r) => r.storeId === storeBId);
    expect(hasBRows).toBe(false);
  });

  it("store A cannot insert into store B", async () => {
    await expect(insertAsStore(storeAId, storeBId)).rejects.toThrow();
  });

  it("store B cannot insert into store A", async () => {
    await expect(insertAsStore(storeBId, storeAId)).rejects.toThrow();
  });
});
