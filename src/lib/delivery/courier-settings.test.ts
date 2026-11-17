import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { readCourierSettings, saveCourierSettings, withMetroOverrides, type CourierSettings } from "./courier-settings";

/**
 * Every field changes here, so the save runs in a transaction that is rolled back: the shared platform row that other
 * test files read never changes.
 */
describe.skipIf(!process.env.DATABASE_URL)("saveCourierSettings (#535)", () => {
  let raw: PrismaClient;
  beforeAll(() => {
    raw = testPrismaClient();
  });
  afterAll(async () => {
    await raw.$disconnect();
  });

  it("AC1/AC4: writes every setting, and one audit row with the values before and after; an unchanged save writes none", async () => {
    const rollback = new Error("rollback");
    const run = raw.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { id: crypto.randomUUID(), email: `cs535-save-${Date.now()}@test.example`, name: "Save 535", emailVerified: true } });
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      const before = await readCourierSettings(tx);
      const next: CourierSettings = {
        selectionMode: before.selectionMode === "uber_first" ? "doordash_first" : "uber_first",
        assignmentTimeoutSeconds: before.assignmentTimeoutSeconds === 300 ? 1200 : 300,
        doordashEnabled: !before.doordashEnabled,
        uberEnabled: !before.uberEnabled,
        weightLimitLb: before.weightLimitLb === 100 ? 1 : 100,
      };
      const actor = { id: user.id, email: user.email };

      expect(await saveCourierSettings(tx, actor, next)).toBe(true);
      expect(await readCourierSettings(tx)).toEqual(next);
      const rows = await tx.auditLog.findMany({ where: { actorId: user.id } });
      expect(rows).toMatchObject([{ storeId: null, action: "platform.courier_settings_update", entityType: "platform_settings", entityId: "platform", before: { ...before }, after: { ...next } }]);

      expect(await saveCourierSettings(tx, actor, next)).toBe(false);
      expect(await tx.auditLog.count({ where: { actorId: user.id } })).toBe(1);
      throw rollback;
    });
    await expect(run).rejects.toBe(rollback);
  });
});

describe("metro courier overrides (#577)", () => {
  const platformWide: CourierSettings = { selectionMode: "cheapest", assignmentTimeoutSeconds: 600, doordashEnabled: true, uberEnabled: true, weightLimitLb: 50 };

  it("AC2: a metro's mode and timeout replace the platform's; unset follows the platform; the weight limit stays platform-wide", () => {
    expect(withMetroOverrides(platformWide, { selectionMode: "uber_first", assignmentTimeoutSeconds: 900, doordashEnabled: true, uberEnabled: true }))
      .toEqual({ ...platformWide, selectionMode: "uber_first", assignmentTimeoutSeconds: 900 });
    expect(withMetroOverrides(platformWide, { selectionMode: null, assignmentTimeoutSeconds: null, doordashEnabled: true, uberEnabled: true })).toEqual(platformWide);
    expect(withMetroOverrides(platformWide, null)).toEqual(platformWide);
  });

  it("AC2: a courier off in the metro is off there, but a metro never turns on a courier the platform switched off", () => {
    expect(withMetroOverrides(platformWide, { selectionMode: null, assignmentTimeoutSeconds: null, doordashEnabled: false, uberEnabled: true }))
      .toMatchObject({ doordashEnabled: false, uberEnabled: true });
    expect(withMetroOverrides({ ...platformWide, uberEnabled: false }, { selectionMode: null, assignmentTimeoutSeconds: null, doordashEnabled: true, uberEnabled: true }))
      .toMatchObject({ doordashEnabled: true, uberEnabled: false });
  });
});
