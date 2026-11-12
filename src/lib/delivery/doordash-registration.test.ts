import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform } from "@/lib/db";
import { registerStoreWithDoorDash } from "./doordash-registration";
import { fakeDoorDash } from "./doordash-fake";

const now = new Date("2026-11-12T15:00:00Z");
const keys = {
  DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
  DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
  DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
};

describe.skipIf(!process.env.DATABASE_URL)("registerStoreWithDoorDash", () => {
  let raw: PrismaClient;
  let storeId = "";

  beforeAll(async () => {
    raw = testPrismaClient();
    const stamp = Date.now().toString(36);
    storeId = (await raw.store.create({
      data: {
        slug: `doordash-reg-${stamp}`,
        name: "Mama Ada Market",
        addressLine1: "100 Main St",
        city: "Silver Spring",
        state: "MD",
        zip: "20910",
      },
    })).id;
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { id: storeId } });
    await raw.$disconnect();
  });

  it("creates the DoorDash business and store, persists doordashStoreId, and does nothing once registered", async () => {
    const fake = fakeDoorDash({
      developerId: keys.DOORDASH_DEVELOPER_ID,
      keyId: keys.DOORDASH_KEY_ID,
      signingSecret: keys.DOORDASH_SIGNING_SECRET,
      now: () => now,
    });
    const opts = { env: keys, fetch: fake.fetch, now: () => now };
    const store = await platform.store.findUniqueOrThrow({ where: { id: storeId } });

    const id = await registerStoreWithDoorDash(store, opts);

    expect((await platform.store.findUniqueOrThrow({ where: { id: storeId } })).doordashStoreId).toBe(id);
    expect(fake.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body?.address ?? null])).toEqual([
      ["/developer/v1/businesses", null],
      [`/developer/v1/businesses/${storeId}/stores`, "100 Main St, Silver Spring, MD 20910"],
    ]);

    const callsBefore = fake.calls.length;
    const registered = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
    expect(await registerStoreWithDoorDash(registered, opts)).toBe(id);
    expect(fake.calls.length).toBe(callsBefore);
  });
});
