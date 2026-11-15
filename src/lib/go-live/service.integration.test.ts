import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));

import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction, storeScoped } from "../db";
import { withAiOnboardingSettings } from "../admin/platform-settings-test-lock";
import { forceGoLive, goLive } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t555s-${Date.now().toString(36)}`;
const NOW = new Date("2026-11-16T20:00:00Z");
const HOURS = { monday: "9:00 AM - 8:00 PM", tuesday: "9:00 AM - 8:00 PM" };

describe.skipIf(!hasDb)("Go live and the admin's forced go live (#555)", () => {
  let raw: PrismaClient;
  let actor = { id: "", email: `owner-${RUN}@test.example` };
  const ids: string[] = [];

  /** A store in setup with every checklist item done at a floor of 3. */
  async function readyStore(name: string, extra: { status?: string } = {}) {
    const store = await raw.store.create({
      data: {
        slug: `${RUN}-${name}`,
        name,
        status: extra.status ?? "setup",
        stripeOnboardingStatus: "complete",
        hours: HOURS,
        timezone: "America/Chicago",
        pickupEnabled: true,
      },
    });
    ids.push(store.id);
    await platformAdminTransaction((tx) => tx.storeSubscription.create({
      data: { storeId: store.id, plan: "starter", status: "active", stripeSubscriptionId: `sub_${RUN}_${name}` },
    }));
    for (let i = 0; i < 3; i++) {
      await storeScoped(store.id).listing.create({ data: { storeId: store.id, customName: `${RUN} item`, price: 299, stockMode: "status" } });
    }
    return store;
  }

  const statusOf = async (id: string) => (await platformAdmin.store.findUniqueOrThrow({ where: { id } })).status;
  const auditRows = (id: string) => platformAdmin.auditLog.findMany({ where: { storeId: id, action: { startsWith: "store.go_live" } } });

  beforeAll(async () => {
    raw = testPrismaClient();
    const user = await raw.user.create({ data: { id: crypto.randomUUID(), email: actor.email, name: "Go Live Owner", emailVerified: true } });
    actor = { id: user.id, email: user.email };
  }, 30_000);

  afterAll(async () => {
    for (const id of ids) await storeScoped(id).listing.deleteMany({ where: { storeId: id } });
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: ids } } });
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: ids } } });
      await tx.store.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.user.delete({ where: { id: actor.id } });
    await raw.$disconnect();
  });

  it("refuses while an item is open: the store stays in setup and nothing is audited", async () => {
    const store = await readyStore("open-item");
    await raw.store.update({ where: { id: store.id }, data: { pickupEnabled: false } });
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      const result = await goLive(store.id, actor, NOW);
      expect(result).toEqual({ ok: false, error: "Finish the checklist first: Pickup or a delivery option on." });
    });
    expect(await statusOf(store.id)).toBe("setup");
    expect(await auditRows(store.id)).toEqual([]);
  });

  it("sets a ready store active with one audit row; going live again changes nothing; other stores stay in setup", async () => {
    const store = await readyStore("ready");
    const neighbour = await readyStore("neighbour");
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      expect(await goLive(store.id, actor, NOW)).toEqual({ ok: true });
      expect(await goLive(store.id, actor, NOW)).toEqual({ ok: true });
    });
    expect(await statusOf(store.id)).toBe("active");
    expect(await statusOf(neighbour.id)).toBe("setup");
    const rows = await auditRows(store.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "store.go_live",
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: "store",
      entityId: store.id,
      before: { status: "setup" },
      after: { status: "active" },
    });
  });

  it("a suspended store never goes live, even with every item done", async () => {
    const store = await readyStore("suspended", { status: "suspended" });
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      expect(await goLive(store.id, actor, NOW)).toEqual({ ok: false, error: "This store is suspended. The platform team must lift the suspension first." });
      expect(await forceGoLive(store.id, "Launch day", actor, NOW)).toEqual({ ok: false, error: "This store is suspended. Lift the suspension first." });
    });
    expect(await statusOf(store.id)).toBe("suspended");
    expect(await auditRows(store.id)).toEqual([]);
  });

  it("a platform admin forces go live only with a reason, and the audit row keeps the reason and the open items", async () => {
    const store = await readyStore("forced");
    await raw.store.update({ where: { id: store.id }, data: { stripeOnboardingStatus: "pending" } });
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      expect(await forceGoLive(store.id, "   ", actor, NOW)).toEqual({ ok: false, error: "Give a reason for going live with items open." });
      expect(await statusOf(store.id)).toBe("setup");
      expect(await forceGoLive(store.id, " Owner finishing Stripe tonight ", actor, NOW)).toEqual({ ok: true });
    });
    expect(await statusOf(store.id)).toBe("active");
    const rows = await auditRows(store.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "store.go_live_forced",
      actorId: actor.id,
      before: { status: "setup" },
      after: { status: "active", reason: "Owner finishing Stripe tonight", openItems: ["payouts"] },
    });
  });
});
