import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => headerState }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { auth } from "../auth";
import { storeScoped } from "../db";
import { subscribePushAction, unsubscribePushAction } from "./actions";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${suffix}`;

type FakeSession = Awaited<ReturnType<typeof auth.api.getSession>>;

function signInAs(userId: string | null): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    (userId
      ? {
          user: { id: userId, twoFactorEnabled: true },
          session: { twoFactorVerified: true },
        }
      : null) as unknown as FakeSession,
  );
}

function onStore(slug: string): void {
  headerState.set("x-store-slug", slug);
}

describe.skipIf(!hasDb)("subscribe and unsubscribe actions", () => {
  let raw: PrismaClient;
  const slugA = `push-act-a-${suffix}`;
  const slugB = `push-act-b-${suffix}`;
  let storeA: string;
  let storeB: string;
  const memberA = `push-member-a-${suffix}`;
  const memberB = `push-member-b-${suffix}`;

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: slugA, name: "Push Act A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: slugB, name: "Push Act B", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({
      data: [
        { id: memberA, name: "A", email: `${memberA}@example.com`, twoFactorEnabled: true },
        { id: memberB, name: "B", email: `${memberB}@example.com`, twoFactorEnabled: true },
      ],
    });
    await storeScoped(storeA).storeMembership.create({ data: { storeId: storeA, userId: memberA, role: "staff" } });
    await storeScoped(storeB).storeMembership.create({ data: { storeId: storeB, userId: memberB, role: "staff" } });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await storeScoped(storeA).pushSubscription.deleteMany({});
    await storeScoped(storeB).pushSubscription.deleteMany({});
  });

  afterAll(async () => {
    for (const id of [storeA, storeB]) {
      await storeScoped(id).pushSubscription.deleteMany({});
      await storeScoped(id).storeMembership.deleteMany({});
    }
    await raw.user.deleteMany({ where: { id: { in: [memberA, memberB] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("rejects an unauthenticated caller and stores nothing", async () => {
    signInAs(null);
    onStore(slugA);
    await expect(subscribePushAction({ endpoint: endpoint("anon"), keys })).rejects.toThrow(/REDIRECT/);
    expect(await storeScoped(storeA).pushSubscription.count()).toBe(0);
  });

  it("a store B member cannot subscribe on store A", async () => {
    signInAs(memberB);
    onStore(slugA);
    await expect(subscribePushAction({ endpoint: endpoint("cross"), keys })).rejects.toThrow(/REDIRECT/);
    expect(await storeScoped(storeA).pushSubscription.count()).toBe(0);
  });

  it("a store A member subscribes, and the same endpoint twice keeps one row", async () => {
    signInAs(memberA);
    onStore(slugA);
    expect(await subscribePushAction({ endpoint: endpoint("twice"), keys })).toEqual({ ok: true });
    expect(await subscribePushAction({ endpoint: endpoint("twice"), keys })).toEqual({ ok: true });
    const rows = await storeScoped(storeA).pushSubscription.findMany();
    expect(rows.map((r) => [r.endpoint, r.userId])).toEqual([[endpoint("twice"), memberA]]);
  });

  it("a member keeps at most 10 devices: the 11th replaces the oldest", async () => {
    signInAs(memberA);
    onStore(slugA);
    for (let i = 0; i < 11; i++) {
      expect(await subscribePushAction({ endpoint: endpoint(`cap${i}`), keys })).toEqual({ ok: true });
    }
    const rows = await storeScoped(storeA).pushSubscription.findMany();
    expect(rows.map((r) => r.endpoint).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => endpoint(`cap${i + 1}`)).sort(),
    );
  });

  it("a store B member cannot unsubscribe store A's endpoint", async () => {
    signInAs(memberA);
    onStore(slugA);
    await subscribePushAction({ endpoint: endpoint("kept"), keys });

    signInAs(memberB);
    onStore(slugB);
    expect(await unsubscribePushAction(endpoint("kept"))).toEqual({ ok: true });
    onStore(slugA);
    await expect(unsubscribePushAction(endpoint("kept"))).rejects.toThrow(/REDIRECT/);

    expect(await storeScoped(storeA).pushSubscription.count()).toBe(1);
  });

  it("a store A member unsubscribes its endpoint", async () => {
    signInAs(memberA);
    onStore(slugA);
    await subscribePushAction({ endpoint: endpoint("gone"), keys });
    expect(await unsubscribePushAction(endpoint("gone"))).toEqual({ ok: true });
    expect(await storeScoped(storeA).pushSubscription.count()).toBe(0);
  });

  it.each([
    ["a host that is not a push service", { endpoint: "https://evil.example.com/push", keys }],
    ["a p256dh key that is not a 65-byte P-256 point", { endpoint: endpoint("bad"), keys: { ...keys, p256dh: "AAAA" } }],
    ["an auth secret shorter than 16 bytes", { endpoint: endpoint("bad"), keys: { ...keys, auth: "AAAA" } }],
  ])("rejects %s and stores nothing", async (_label, input) => {
    signInAs(memberA);
    onStore(slugA);
    expect(await subscribePushAction(input)).toEqual({ ok: false, error: "Invalid push subscription" });
    expect(await storeScoped(storeA).pushSubscription.count()).toBe(0);
  });
});
