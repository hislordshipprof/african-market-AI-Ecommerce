import { describe, it, expect } from "vitest";
import { storeScoped } from "../db";

const hasDb = !!process.env.DATABASE_URL;
const hasDirectUrl =
  !!process.env.DATABASE_URL_UNPOOLED || !!process.env.DIRECT_URL;

describe.skipIf(!hasDb)("Demo catalog seed", () => {
  it("mama-ngozi has seeded listings visible through RLS", async () => {
    const store = await import("../db").then((m) =>
      m.platform.store.findUnique({ where: { slug: "mama-ngozi" } }),
    );
    expect(store).toBeTruthy();

    const scoped = storeScoped(store!.id);
    const listings = await scoped.listing.findMany({ where: { active: true } });
    expect(listings.length).toBeGreaterThanOrEqual(10);
  });

  it("tante-marie has seeded listings visible through RLS", async () => {
    const store = await import("../db").then((m) =>
      m.platform.store.findUnique({ where: { slug: "tante-marie" } }),
    );
    expect(store).toBeTruthy();

    const scoped = storeScoped(store!.id);
    const listings = await scoped.listing.findMany({ where: { active: true } });
    expect(listings.length).toBeGreaterThanOrEqual(10);
  });

  it("mama-ngozi cannot see tante-marie listings through RLS", async () => {
    const [storeA, storeB] = await Promise.all([
      import("../db").then((m) =>
        m.platform.store.findUnique({ where: { slug: "mama-ngozi" } }),
      ),
      import("../db").then((m) =>
        m.platform.store.findUnique({ where: { slug: "tante-marie" } }),
      ),
    ]);
    expect(storeA).toBeTruthy();
    expect(storeB).toBeTruthy();

    const scopedA = storeScoped(storeA!.id);
    const listingsA = await scopedA.listing.findMany();
    expect(listingsA.every((l) => l.storeId === storeA!.id)).toBe(true);
    expect(listingsA.some((l) => l.storeId === storeB!.id)).toBe(false);
  });

  it.skipIf(!hasDirectUrl)(
    "seed is idempotent — running twice produces same listing count",
    async () => {
      const store = await import("../db").then((m) =>
        m.platform.store.findUnique({ where: { slug: "mama-ngozi" } }),
      );
      expect(store).toBeTruthy();

      const scoped = storeScoped(store!.id);
      const before = await scoped.listing.findMany();
      const countBefore = before.length;

      const { seedDemoCatalog } = await import(
        "../../../prisma/seed-demo-catalog"
      );
      const { PrismaClient } = await import("@prisma/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { resolveDirectUrl } = await import("../env");
      const adapter = new PrismaPg(resolveDirectUrl());
      const prisma = new PrismaClient({ adapter });
      try {
        await seedDemoCatalog(prisma);
      } finally {
        await prisma.$disconnect();
      }

      const after = await scoped.listing.findMany();
      expect(after.length).toBe(countBefore);
    },
    120000,
  );
});
