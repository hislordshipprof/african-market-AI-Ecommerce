import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));

import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin } from "../db";
import { withAiOnboardingSettings } from "../admin/platform-settings-test-lock";
import { forceGoLive, goLive } from "./service";
import { createReadyStore, deleteReadyStores, GO_LIVE_TEST_NOW as NOW } from "./test-fixtures";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t555s-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("Go live and the admin's forced go live (#555)", () => {
  let raw: PrismaClient;
  let actor = { id: "", email: `owner-${RUN}@test.example` };
  const ids: string[] = [];

  async function readyStore(name: string, extra: { status?: string } = {}) {
    const store = await createReadyStore(raw, `${RUN}-${name}`, extra.status);
    ids.push(store.id);
    return store;
  }

  const statusOf = async (id: string) => (await platformAdmin.store.findUniqueOrThrow({ where: { id } })).status;
  const listedOf = async (id: string) => (await platformAdmin.store.findUniqueOrThrow({ where: { id } })).listed;
  const auditRows = (id: string) => platformAdmin.auditLog.findMany({ where: { storeId: id, action: { startsWith: "store.go_live" } } });

  beforeAll(async () => {
    raw = testPrismaClient();
    const user = await raw.user.create({ data: { id: crypto.randomUUID(), email: actor.email, name: "Go Live Owner", emailVerified: true } });
    actor = { id: user.id, email: user.email };
  }, 30_000);

  afterAll(async () => {
    await deleteReadyStores(ids);
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

  it("sets a ready store active and listed in the directory with one audit row; going live again changes nothing; other stores stay in setup (#784)", async () => {
    const store = await readyStore("ready");
    const neighbour = await readyStore("neighbour");
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      expect(await goLive(store.id, actor, NOW)).toEqual({ ok: true });
      expect(await goLive(store.id, actor, NOW)).toEqual({ ok: true });
    });
    expect(await statusOf(store.id)).toBe("active");
    expect(await listedOf(store.id)).toBe(true);
    expect(await statusOf(neighbour.id)).toBe("setup");
    expect(await listedOf(neighbour.id)).toBe(false);
    const rows = await auditRows(store.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "store.go_live",
      actorId: actor.id,
      actorEmail: actor.email,
      entityType: "store",
      entityId: store.id,
      before: { status: "setup", listed: false },
      after: { status: "active", listed: true },
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
    // A forced go-live is the platform's call; listing stays the owner's switch.
    expect(await listedOf(store.id)).toBe(false);
  });
});
