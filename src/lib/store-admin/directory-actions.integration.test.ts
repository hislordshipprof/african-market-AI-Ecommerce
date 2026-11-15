import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";

const state = vi.hoisted(() => ({ headers: new Headers(), userId: "", revalidated: [] as string[], queued: [] as string[] }));

vi.mock("../directory/store-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../directory/store-requests")>()),
  queueStoreRequestNotices: async (storeId: string) => {
    state.queued.push(storeId);
  },
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (tag: string) => state.revalidated.push(tag),
}));
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
          ? {
              user: { id: state.userId, email: `${state.userId}@example.com`, name: "T", twoFactorEnabled: true },
              session: { twoFactorVerified: true },
            }
          : null,
    },
  },
}));

import { updateDirectoryListing } from "./directory-actions";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t450-${Date.now().toString(36)}`;

describe.skipIf(!hasDb)("updateDirectoryListing (lane database)", () => {
  let raw: PrismaClient;
  const ids = { a: "", b: "", ownerA: `${RUN}-owner-a`, ownerB: `${RUN}-owner-b`, staffA: `${RUN}-staff-a` };
  const slugA = `${RUN}-a`;
  const slugB = `${RUN}-b`;

  function as(userId: string, slug: string) {
    state.userId = userId;
    state.headers = new Headers({ "x-store-slug": slug });
  }

  const store = (id: string) =>
    raw.store.findUniqueOrThrow({ where: { id }, select: { listed: true, listingBlurb: true, cuisineTags: true } });
  const audits = (storeId: string) =>
    storeScoped(storeId).auditLog.findMany({ where: { action: "store.directory_listing" }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    raw = testPrismaClient();
    ids.a = (await raw.store.create({ data: { slug: slugA, name: "Listing A" } })).id;
    ids.b = (await raw.store.create({ data: { slug: slugB, name: "Listing B", listingBlurb: "B's own words." } })).id;
    for (const id of [ids.ownerA, ids.ownerB, ids.staffA]) {
      await raw.user.create({ data: { id, name: id, email: `${id}@example.com`, twoFactorEnabled: true } });
    }
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.ownerA, role: "owner" } });
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.staffA, role: "staff" } });
    await storeScoped(ids.b).storeMembership.create({ data: { storeId: ids.b, userId: ids.ownerB, role: "owner" } });
  });

  beforeEach(() => {
    state.revalidated = [];
    state.queued = [];
  });

  // Audit rows are append-only, so the run's stores stay; RUN keeps them apart from other files.
  afterAll(async () => {
    await raw.$disconnect();
  });

  it("is off by default", async () => {
    expect(await store(ids.a)).toEqual({ listed: false, listingBlurb: null, cuisineTags: [] });
  });

  it("saves the owner's switch, blurb and tags, writes an audit row and clears the directory cache", async () => {
    as(ids.ownerA, slugA);
    const result = await updateDirectoryListing({
      listed: true,
      blurb: "  Fresh yam,\n egusi and stockfish every Friday.  ",
      cuisineTags: ["caribbean", "west-african"],
    });
    expect(result).toEqual({ ok: true });
    expect(await store(ids.a)).toEqual({
      listed: true,
      listingBlurb: "Fresh yam, egusi and stockfish every Friday.",
      cuisineTags: ["west-african", "caribbean"],
    });
    const [row] = await audits(ids.a);
    expect(row).toMatchObject({
      actorId: ids.ownerA,
      entityId: ids.a,
      before: { listed: false, listingBlurb: null, cuisineTags: [] },
      after: { listed: true, listingBlurb: "Fresh yam, egusi and stockfish every Friday.", cuisineTags: ["west-african", "caribbean"] },
    });
    expect(state.revalidated).toContain("store-directory");
    // Going into the directory runs the "tell me when a store opens" notices (#455).
    expect(state.queued).toEqual([ids.a]);
  });

  it("writes no audit row when nothing changed", async () => {
    as(ids.ownerA, slugA);
    const before = (await audits(ids.a)).length;
    await updateDirectoryListing({ listed: true, blurb: "Fresh yam, egusi and stockfish every Friday.", cuisineTags: ["west-african", "caribbean"] });
    expect((await audits(ids.a)).length).toBe(before);
    expect(state.queued).toEqual([]);
  });

  it("turns the listing off and clears the blurb", async () => {
    as(ids.ownerA, slugA);
    expect(await updateDirectoryListing({ listed: false, blurb: "   ", cuisineTags: [] })).toEqual({ ok: true });
    expect(await store(ids.a)).toEqual({ listed: false, listingBlurb: null, cuisineTags: [] });
    expect(state.revalidated).toContain("store-directory");
    expect(state.queued).toEqual([]);
  });

  it("takes 160 characters and refuses 161, counting characters not UTF-16 units", async () => {
    as(ids.ownerA, slugA);
    expect(await updateDirectoryListing({ listed: true, blurb: "é".repeat(159) + "🌶", cuisineTags: [] })).toEqual({ ok: true });
    expect((await store(ids.a)).listingBlurb).toBe("é".repeat(159) + "🌶");
    const refused = await updateDirectoryListing({ listed: true, blurb: "x".repeat(161), cuisineTags: [] });
    expect(refused.ok).toBe(false);
    expect((await store(ids.a)).listingBlurb).toBe("é".repeat(159) + "🌶");
  });

  it("refuses unknown tags and more than three", async () => {
    as(ids.ownerA, slugA);
    expect((await updateDirectoryListing({ listed: true, blurb: "", cuisineTags: ["pizza"] })).ok).toBe(false);
    expect(
      (await updateDirectoryListing({ listed: true, blurb: "", cuisineTags: ["caribbean", "west-african", "east-african", "south-asian"] })).ok,
    ).toBe(false);
    expect((await store(ids.a)).cuisineTags).toEqual([]);
  });

  it("an owner of store A cannot change store B", async () => {
    as(ids.ownerA, slugA);
    const named = await updateDirectoryListing({ storeId: ids.b, listed: true, blurb: "Taken over", cuisineTags: [] });
    expect(named.ok).toBe(false);

    // On B's host, A's owner has no membership and is sent to sign in.
    as(ids.ownerA, slugB);
    await expect(updateDirectoryListing({ listed: true, blurb: "Taken over", cuisineTags: [] })).rejects.toThrow(
      `REDIRECT:/store-admin/sign-in?store=${slugB}`,
    );
    expect(await store(ids.b)).toEqual({ listed: false, listingBlurb: "B's own words.", cuisineTags: [] });
    expect(await audits(ids.b)).toHaveLength(0);
  });

  it("refuses staff", async () => {
    as(ids.staffA, slugA);
    const before = await store(ids.a);
    await expect(updateDirectoryListing({ listed: false, blurb: "Staff words", cuisineTags: [] })).rejects.toThrow(
      `REDIRECT:/store-admin?store=${slugA}`,
    );
    expect(await store(ids.a)).toEqual(before);
  });
});
