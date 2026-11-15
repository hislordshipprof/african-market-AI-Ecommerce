import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";

const state = vi.hoisted(() => ({ headers: new Headers(), userId: "" }));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => () => fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        state.userId
          ? { user: { id: state.userId, email: `${state.userId}@example.com`, name: "T", twoFactorEnabled: true }, session: { twoFactorVerified: true } }
          : null,
    },
  },
}));

import { goLiveAction } from "./go-live-actions";
import { withAiOnboardingSettings } from "../admin/platform-settings-test-lock";
import { createReadyStore, deleteReadyStores } from "../go-live/test-fixtures";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t555a-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("goLiveAction (owner, lane database)", () => {
  let raw: PrismaClient;
  const ids = { a: "", b: "", ownerA: `${RUN}-owner-a`, staffA: `${RUN}-staff-a`, ownerB: `${RUN}-owner-b` };

  function as(userId: string, slug: string) {
    state.userId = userId;
    state.headers = new Headers({ "x-store-slug": slug });
  }
  const statusOf = async (id: string) => (await raw.store.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    raw = testPrismaClient();
    ids.a = (await createReadyStore(raw, `${RUN}-a`)).id;
    ids.b = (await createReadyStore(raw, `${RUN}-b`)).id;
    for (const id of [ids.ownerA, ids.staffA, ids.ownerB]) {
      await raw.user.create({ data: { id, name: id, email: `${id}@example.com`, twoFactorEnabled: true } });
    }
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.ownerA, role: "owner" } });
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.staffA, role: "staff" } });
    await storeScoped(ids.b).storeMembership.create({ data: { storeId: ids.b, userId: ids.ownerB, role: "owner" } });
  }, 60_000);

  afterAll(async () => {
    for (const id of [ids.a, ids.b]) await storeScoped(id).storeMembership.deleteMany({ where: { storeId: id } });
    await deleteReadyStores([ids.a, ids.b]);
    await raw.user.deleteMany({ where: { id: { in: [ids.ownerA, ids.staffA, ids.ownerB] } } });
    await raw.$disconnect();
  });

  it("staff cannot go live: they are sent back to the dashboard and the store stays in setup", async () => {
    as(ids.staffA, `${RUN}-a`);
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      await expect(goLiveAction()).rejects.toThrow(`REDIRECT:/store-admin?store=${RUN}-a`);
    });
    expect(await statusOf(ids.a)).toBe("setup");
  });

  it("an owner of another store, on that store's host, never moves this one", async () => {
    as(ids.ownerB, `${RUN}-a`);
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      await expect(goLiveAction()).rejects.toThrow(`REDIRECT:/store-admin/sign-in?store=${RUN}-a`);
    });
    expect(await statusOf(ids.a)).toBe("setup");
  });

  it("the owner goes live for the host's store only", async () => {
    as(ids.ownerA, `${RUN}-a`);
    await withAiOnboardingSettings({ goLiveListingFloor: 3 }, async () => {
      expect(await goLiveAction()).toEqual({ ok: true });
    });
    expect(await statusOf(ids.a)).toBe("active");
    expect(await statusOf(ids.b)).toBe("setup");
  });
});
