import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdminTransaction, storeScoped } from "../db";
import { withAiOnboardingSettings } from "../admin/platform-settings-test-lock";
import { readGoLiveChecklist, type GoLiveChecklist } from "./checklist";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t555c-${Date.now().toString(36)}`;
// A Monday afternoon in Chicago; the checklist reads hours against a fixed clock.
const NOW = new Date("2026-11-16T20:00:00Z");
const HOURS = { monday: "9:00 AM - 8:00 PM", tuesday: "9:00 AM - 8:00 PM", saturday: "8:00 AM - 6:00 PM" };

function item(checklist: GoLiveChecklist | null, key: string) {
  const found = checklist?.items.find((i) => i.key === key);
  if (!found) throw new Error(`no ${key} item`);
  return found;
}

describe.skipIf(!hasDb)("go-live checklist (#555)", () => {
  let raw: PrismaClient;
  let readyId = "";
  let otherId = "";
  let emptyId = "";

  async function addListing(storeId: string, opts: { price?: number; active?: boolean; variants?: Array<{ price: number; weightPlaceholder?: boolean }> } = {}) {
    return storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: `${RUN} listing`,
        price: opts.price ?? 499,
        stockMode: "status",
        active: opts.active ?? true,
        ...(opts.variants
          ? { variants: { create: opts.variants.map((v, i) => ({ label: `Pack ${i}`, price: v.price, weightG: 500, weightPlaceholder: v.weightPlaceholder ?? false })) } }
          : {}),
      },
    });
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    const ready = await raw.store.create({
      data: {
        slug: `${RUN}-ready`,
        name: "Ready Market",
        status: "setup",
        stripeOnboardingStatus: "complete",
        hours: HOURS,
        timezone: "America/Chicago",
        pickupEnabled: true,
      },
    });
    const other = await raw.store.create({
      data: { slug: `${RUN}-other`, name: "Other Market", status: "setup", stripeOnboardingStatus: "complete", hours: HOURS, pickupEnabled: true },
    });
    const empty = await raw.store.create({ data: { slug: `${RUN}-empty`, name: "Empty Market", status: "setup" } });
    readyId = ready.id;
    otherId = other.id;
    emptyId = empty.id;
    await platformAdminTransaction((tx) => tx.storeSubscription.create({
      data: { storeId: readyId, plan: "starter", status: "active", stripeSubscriptionId: `sub_${RUN}` },
    }));
    for (let i = 0; i < 3; i++) await addListing(readyId);
    // Neither counts toward the floor: switched off, or priced at zero.
    await addListing(readyId, { active: false });
    await addListing(readyId, { price: 0 });
    await addListing(readyId, { active: false, variants: [{ price: 300, weightPlaceholder: true }] });
    // Another store's listings never count for this one.
    for (let i = 0; i < 5; i++) await addListing(otherId);
    await addListing(otherId, { variants: [{ price: 300, weightPlaceholder: true }] });
  }, 60_000);

  afterAll(async () => {
    const ids = [readyId, otherId, emptyId].filter(Boolean);
    for (const id of ids) await storeScoped(id).listing.deleteMany({ where: { storeId: id } });
    await platformAdminTransaction(async (tx) => {
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: ids } } });
      await tx.store.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.$disconnect();
  });

  it("is ready when every item is done, with the listing floor read from platform settings (floor 3)", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      const checklist = await readGoLiveChecklist(readyId, NOW);
      expect(checklist?.floor).toBe(3);
      expect(checklist?.items.map((i) => [i.key, i.done])).toEqual([
        ["payouts", true],
        ["hours", true],
        ["fulfillment", true],
        ["listings", true],
        ["weights", true],
        ["plan", true],
        ["couriers", true],
      ]);
      expect(checklist?.ready).toBe(true);
    });
  });

  it("counts only this store's active listings with a price against the floor", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 4 }, async () => {
      const checklist = await readGoLiveChecklist(readyId, NOW);
      expect(item(checklist, "listings")).toMatchObject({ done: false, detail: "3 of 4" });
      expect(checklist?.ready).toBe(false);
    });
  });

  it("a placeholder weight on an active listing blocks Go live; a priced variant pack counts toward the floor", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      const otherList = await readGoLiveChecklist(otherId, NOW);
      expect(item(otherList, "weights")).toMatchObject({ done: false, detail: "1 listing needs a weight" });
      expect(item(otherList, "listings").done).toBe(true);
      expect(otherList?.ready).toBe(false);
    });
  });

  it("a new store starts with the missing items open; couriers are not needed on Starter", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      const checklist = await readGoLiveChecklist(emptyId, NOW);
      expect(checklist?.items.map((i) => [i.key, i.done])).toEqual([
        ["payouts", false],
        ["hours", false],
        ["fulfillment", false],
        ["listings", false],
        ["weights", true],
        ["plan", false],
        ["couriers", true],
      ]);
      expect(checklist?.ready).toBe(false);
    });
  });

  it("a pilot store counts as plan chosen; on Pro the courier registration must be done", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      await platformAdminTransaction((tx) => tx.storeSubscription.create({ data: { storeId: emptyId, pilot: true } }));
      expect(item(await readGoLiveChecklist(emptyId, NOW), "plan").done).toBe(true);

      await platformAdminTransaction((tx) => tx.storeSubscription.update({ where: { storeId: readyId }, data: { plan: "pro" } }));
      try {
        const pro = await readGoLiveChecklist(readyId, NOW);
        expect(item(pro, "couriers").done).toBe(false);
        expect(pro?.ready).toBe(false);
        await raw.store.update({ where: { id: readyId }, data: { uberLocationId: `uber_${RUN}` } });
        expect(item(await readGoLiveChecklist(readyId, NOW), "couriers").done).toBe(true);
      } finally {
        await platformAdminTransaction((tx) => tx.storeSubscription.update({ where: { storeId: readyId }, data: { plan: "starter" } }));
        await raw.store.update({ where: { id: readyId }, data: { uberLocationId: null } });
      }
    });
  });

  it("returns null for an unknown store", async () => {
    expect(await readGoLiveChecklist(`${RUN}-missing`, NOW)).toBeNull();
  });
});
