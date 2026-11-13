import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";

const hasDb = !!process.env.DATABASE_URL;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

function endpointFor(name: string): string {
  return `https://fcm.googleapis.com/fcm/send/${name}-${suffix}`;
}

describe.skipIf(!hasDb)("push_subscriptions RLS", () => {
  let raw: PrismaClient;
  let storeA: string;
  let storeB: string;
  const userA = `push-user-a-${suffix}`;
  const userB = `push-user-b-${suffix}`;

  beforeAll(async () => {
    raw = testPrismaClient();
    storeA = (await raw.store.create({ data: { slug: `push-a-${suffix}`, name: "Push A", themePreset: "palm-and-shea" } })).id;
    storeB = (await raw.store.create({ data: { slug: `push-b-${suffix}`, name: "Push B", themePreset: "palm-and-shea" } })).id;
    await raw.user.createMany({
      data: [
        { id: userA, name: "A", email: `${userA}@example.com` },
        { id: userB, name: "B", email: `${userB}@example.com` },
      ],
    });
    await storeScoped(storeA).pushSubscription.create({
      data: { storeId: storeA, userId: userA, endpoint: endpointFor("a"), ...keys },
    });
    await storeScoped(storeB).pushSubscription.create({
      data: { storeId: storeB, userId: userB, endpoint: endpointFor("b"), ...keys },
    });
  });

  afterAll(async () => {
    await storeScoped(storeA).pushSubscription.deleteMany({});
    await storeScoped(storeB).pushSubscription.deleteMany({});
    await raw.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    await raw.$disconnect();
  });

  it("store A sees only its own subscriptions", async () => {
    const rows = await storeScoped(storeA).pushSubscription.findMany();
    expect(rows.map((r) => r.endpoint)).toEqual([endpointFor("a")]);
  });

  it("store A cannot create a subscription for store B", async () => {
    await expect(
      storeScoped(storeA).pushSubscription.create({
        data: { storeId: storeB, userId: userB, endpoint: endpointFor("forged"), ...keys },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });
});
