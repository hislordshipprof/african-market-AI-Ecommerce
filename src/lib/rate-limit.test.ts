import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Rate limit storage (database)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "test_rl_" } } });
    await prisma.$disconnect();
  });

  it("rate_limits table exists and can store entries", async () => {
    const entry = await prisma.rateLimit.create({
      data: {
        key: "test_rl_sign_in",
        count: 1,
        lastRequest: BigInt(Date.now()),
      },
    });
    expect(entry.key).toBe("test_rl_sign_in");
    expect(entry.count).toBe(1);
  });

  it("can increment count on existing entry", async () => {
    const entry = await prisma.rateLimit.create({
      data: {
        key: "test_rl_increment",
        count: 1,
        lastRequest: BigInt(Date.now()),
      },
    });

    const updated = await prisma.rateLimit.update({
      where: { id: entry.id },
      data: { count: 2, lastRequest: BigInt(Date.now()) },
    });
    expect(updated.count).toBe(2);
  });

  it("unique constraint rejects duplicate key", async () => {
    await prisma.rateLimit.create({
      data: {
        key: "test_rl_unique",
        count: 1,
        lastRequest: BigInt(Date.now()),
      },
    });

    await expect(
      prisma.rateLimit.create({
        data: {
          key: "test_rl_unique",
          count: 1,
          lastRequest: BigInt(Date.now()),
        },
      }),
    ).rejects.toThrow(/unique constraint/i);
  });

  it("concurrent sign-in attempts produce exactly one row per key", async () => {
    const key = `test_rl_concurrent_${Date.now()}`;
    const attempts = Array.from({ length: 6 }, () =>
      prisma.rateLimit.upsert({
        where: { key },
        create: { key, count: 1, lastRequest: BigInt(Date.now()) },
        update: { count: { increment: 1 }, lastRequest: BigInt(Date.now()) },
      }),
    );
    await Promise.allSettled(attempts);

    const rows = await prisma.rateLimit.findMany({ where: { key } });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
  });
});
