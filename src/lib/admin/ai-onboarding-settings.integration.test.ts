import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testPrismaClient } from "@/lib/test-prisma";
import { platformAdmin, platformAdminTransaction } from "../db";
import { readAiOnboardingSettings, saveAiOnboardingSettings, type AiOnboardingSettings } from "./ai-onboarding-settings";
import { withAiOnboardingSettings } from "./platform-settings-test-lock";

const hasDb = !!process.env.DATABASE_URL;
const actor = { id: `aio-${crypto.randomUUID().slice(0, 8)}`, email: "aio-561@test.example" };
const auditRows = () => platformAdmin.auditLog.findMany({
  where: { actorId: actor.id, action: "platform.ai_onboarding_settings_update" },
  orderBy: { createdAt: "asc" },
});

describe.skipIf(!hasDb)("AI and onboarding settings (#561)", () => {
  let raw: PrismaClient;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { id: actor.id, email: actor.email, name: "Settings 561", emailVerified: true, role: "platform_admin" } });
  });

  afterAll(async () => {
    await platformAdminTransaction((tx) => tx.auditLog.deleteMany({ where: { actorId: actor.id } }));
    await raw.user.deleteMany({ where: { id: actor.id } });
    await raw.$disconnect();
  });

  it("starts from the defaults the tickets chose: floor 20, sample 5, 2 cents, 12 months", async () => {
    await withAiOnboardingSettings({ goLiveListingFloor: 20, aiDailySamplePerStore: 5, aiTurnCostFlagCents: 2, rejectedApplicationRetentionMonths: 12 }, async () => {
      expect(await readAiOnboardingSettings()).toEqual({
        goLiveListingFloor: 20,
        dailySamplePerStore: 5,
        turnCostFlagCents: 2,
        rejectedApplicationRetentionMonths: 12,
      });
    });
  });

  it("a save writes the new values and one audit row with before and after; an unchanged save writes nothing", async () => {
    await withAiOnboardingSettings({}, async () => {
      const before = await readAiOnboardingSettings();
      const next: AiOnboardingSettings = { ...before, goLiveListingFloor: before.goLiveListingFloor === 30 ? 31 : 30, rejectedApplicationRetentionMonths: 6 };

      expect(await platformAdminTransaction((tx) => saveAiOnboardingSettings(tx, actor, next))).toBe(true);
      expect(await readAiOnboardingSettings()).toEqual(next);
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ storeId: null, actorEmail: actor.email, entityType: "platform_settings", entityId: "platform", before, after: next });

      expect(await platformAdminTransaction((tx) => saveAiOnboardingSettings(tx, actor, next))).toBe(false);
      expect(await auditRows()).toHaveLength(1);
    });
  });

  it("the change and its audit row are one transaction: a failed audit write leaves the settings as they were", async () => {
    await withAiOnboardingSettings({}, async () => {
      const before = await readAiOnboardingSettings();
      const next = { ...before, goLiveListingFloor: before.goLiveListingFloor === 40 ? 41 : 40 };
      const failure = new Error("audit insert failed");

      const save = platformAdminTransaction((tx) => saveAiOnboardingSettings(
        { ...tx, platformSettings: tx.platformSettings, $queryRaw: tx.$queryRaw.bind(tx), auditLog: { create: async () => { throw failure; } } },
        actor,
        next,
      ));

      await expect(save).rejects.toBe(failure);
      expect(await readAiOnboardingSettings()).toEqual(before);
    });
  });

  it("the database refuses a value outside the bounds even when the form is bypassed", async () => {
    await withAiOnboardingSettings({}, async () => {
      for (const data of [{ goLiveListingFloor: 0 }, { aiDailySamplePerStore: 21 }, { aiTurnCostFlagCents: 0 }, { rejectedApplicationRetentionMonths: 25 }]) {
        await expect(platformAdminTransaction((tx) => tx.platformSettings.update({ where: { id: "platform" }, data })), JSON.stringify(data)).rejects.toThrow(/check constraint/i);
      }
    });
  });
});
