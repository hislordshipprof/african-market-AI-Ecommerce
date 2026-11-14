import { afterAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform } from "@/lib/db";
import { registerStoreCouriers } from "./courier-registration";
import { fakeDoorDash } from "./doordash-fake";

const hasKeys = Boolean(process.env.UBER_DIRECT_CLIENT_ID && process.env.UBER_DIRECT_CLIENT_SECRET && process.env.UBER_DIRECT_CUSTOMER_ID);

// Opt-in (COURIER_REGISTRATION_SANDBOX=1): each run creates a real Uber Direct sandbox organization. No DoorDash keys
// exist yet, so DoorDash runs on the fake.
describe.skipIf(!hasKeys || !process.env.DATABASE_URL || process.env.COURIER_REGISTRATION_SANDBOX !== "1")(
  "courier registration against the Uber Direct sandbox",
  () => {
    const raw = testPrismaClient();
    let storeId = "";

    afterAll(async () => {
      if (storeId) await raw.store.deleteMany({ where: { id: storeId } });
      await raw.$disconnect();
    });

    it("registers a new store as an Uber Direct organization and saves its id", async () => {
      storeId = (await raw.store.create({
        data: {
          slug: `courier-sandbox-${Date.now().toString(36)}`,
          name: "Sandbox Probe Market",
          addressLine1: "8121 Georgia Ave",
          city: "Silver Spring",
          state: "MD",
          zip: "20910",
        },
      })).id;
      const keys = {
        DOORDASH_DEVELOPER_ID: "0f3c2a9e-1111-4c1b-9a77-2f1d6c0e5a10",
        DOORDASH_KEY_ID: "7b1d4e22-2222-4f0a-8c55-91e0c3b7d4aa",
        DOORDASH_SIGNING_SECRET: Buffer.from("test-signing-secret-bytes-0123456789").toString("base64url"),
      };
      const doordash = fakeDoorDash({ developerId: keys.DOORDASH_DEVELOPER_ID, keyId: keys.DOORDASH_KEY_ID, signingSecret: keys.DOORDASH_SIGNING_SECRET, now: () => new Date() });

      await registerStoreCouriers(storeId, { doordash: { env: keys, fetch: doordash.fetch } });

      const saved = await platform.store.findUniqueOrThrow({ where: { id: storeId } });
      expect(saved.uberRegistrationError).toBeNull();
      expect(saved.uberLocationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(saved.doordashStoreId).toBe(storeId);
      console.log(JSON.stringify({ event: "uber_direct_sandbox_registration", uberLocationId: saved.uberLocationId }));
    }, 30_000);
  },
);
