import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t430-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("copilot alerts (lane database)", () => {
  let raw: PrismaClient;
  let storeAId = "";
  let storeBId = "";

  async function counted(storeId: string, name: string, qty: number) {
    return (await storeScoped(storeId).listing.create({
      data: { storeId, customName: name, price: 500, stockMode: "counted", qty, confidence: 1 },
    })).id;
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    storeAId = (await raw.store.create({
      data: { slug: `alerts-a-${RUN}`, name: "Alerts A", themePreset: "palm-and-shea" },
    })).id;
    storeBId = (await raw.store.create({
      data: { slug: `alerts-b-${RUN}`, name: "Alerts B", themePreset: "palm-and-shea" },
    })).id;
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  it("copilot_alerts: storeScoped(B) reads none of A's alerts, cannot insert one for A, and updates nothing", async () => {
    const listingAId = await counted(storeAId, "Gari", 3);
    const alert = await storeScoped(storeAId).copilotAlert.create({
      data: { storeId: storeAId, kind: "running_low", listingId: listingAId, dedupeKey: `running_low:${listingAId}:rls` },
    });

    expect(await storeScoped(storeBId).copilotAlert.findMany()).toEqual([]);
    await expect(
      storeScoped(storeBId).copilotAlert.create({
        data: { storeId: storeAId, kind: "sold_out", listingId: listingAId, dedupeKey: "cross-store" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    await expect(
      storeScoped(storeBId).copilotAlert.create({
        data: { storeId: storeBId, kind: "sold_out", listingId: listingAId, dedupeKey: "foreign-listing" },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect((await storeScoped(storeBId).copilotAlert.updateMany({
      where: { id: alert.id },
      data: { state: "resolved" },
    })).count).toBe(0);
    expect((await storeScoped(storeAId).copilotAlert.findUniqueOrThrow({ where: { id: alert.id } })).state).toBe("open");
  });
});
