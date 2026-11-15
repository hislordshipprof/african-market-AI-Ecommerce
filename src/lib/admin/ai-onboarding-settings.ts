import type { Prisma } from "@prisma/client";
import { lockPlatformSettingsRow, platform, platformAdmin } from "../db";

/** Bounds decided in #561; the database checks hold the same ranges. */
export const AI_ONBOARDING_LIMITS = {
  goLiveListingFloor: { min: 1, max: 200 },
  dailySamplePerStore: { min: 0, max: 20 },
  turnCostFlagCents: { min: 1, max: 100 },
  rejectedApplicationRetentionMonths: { min: 1, max: 24 },
} as const;

export const AI_ONBOARDING_AUDIT_ACTION = "platform.ai_onboarding_settings_update";

/** Platform-wide AI and onboarding settings (#561), one row edited at /admin/settings/ai-onboarding. */
export interface AiOnboardingSettings {
  /** Active listings with a price a store needs before Go live (#555). */
  goLiveListingFloor: number;
  /** Random shopper and copilot chats per store per UTC day in the AI review list (#544). */
  dailySamplePerStore: number;
  /** An AI turn costing more than this is auto-flagged (#544). */
  turnCostFlagCents: number;
  /** Months a rejected store application is kept (#554). */
  rejectedApplicationRetentionMonths: number;
}

type SettingsReader = {
  platformSettings: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<{
      goLiveListingFloor: number;
      aiDailySamplePerStore: number;
      aiTurnCostFlagCents: number;
      rejectedApplicationRetentionMonths: number;
    }>;
  };
};

/** Read each time a consumer runs, so a change applies from the next run without a deploy. */
export async function readAiOnboardingSettings(db: SettingsReader = platform): Promise<AiOnboardingSettings> {
  const row = await db.platformSettings.findUniqueOrThrow({ where: { id: "platform" } });
  return {
    goLiveListingFloor: row.goLiveListingFloor,
    dailySamplePerStore: row.aiDailySamplePerStore,
    turnCostFlagCents: row.aiTurnCostFlagCents,
    rejectedApplicationRetentionMonths: row.rejectedApplicationRetentionMonths,
  };
}

/** AI cost is counted in micro-dollars: one cent is 10,000. */
export function turnCostFlagMicros(settings: Pick<AiOnboardingSettings, "turnCostFlagCents">): number {
  return settings.turnCostFlagCents * 10_000;
}

type SettingsWriter = SettingsReader & {
  platformSettings: { update(args: { where: { id: string }; data: Prisma.PlatformSettingsUpdateInput }): Promise<unknown> };
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

/**
 * Writes validated settings in the caller's platform-admin transaction, with the audit row in the same transaction.
 * The row is locked first, so each audit row's "before" is what that save replaced. Returns false, writing nothing,
 * when nothing changed.
 */
export async function saveAiOnboardingSettings(tx: SettingsWriter, actor: { id: string; email: string }, next: AiOnboardingSettings): Promise<boolean> {
  await lockPlatformSettingsRow(tx);
  const before = await readAiOnboardingSettings(tx);
  if ((Object.keys(next) as Array<keyof AiOnboardingSettings>).every((key) => before[key] === next[key])) return false;
  await tx.platformSettings.update({
    where: { id: "platform" },
    data: {
      goLiveListingFloor: next.goLiveListingFloor,
      aiDailySamplePerStore: next.dailySamplePerStore,
      aiTurnCostFlagCents: next.turnCostFlagCents,
      rejectedApplicationRetentionMonths: next.rejectedApplicationRetentionMonths,
    },
  });
  await tx.auditLog.create({
    data: {
      storeId: null,
      actorId: actor.id,
      actorEmail: actor.email,
      action: AI_ONBOARDING_AUDIT_ACTION,
      entityType: "platform_settings",
      entityId: "platform",
      before: { ...before },
      after: { ...next },
    },
  });
  return true;
}

/** Who saved these settings last and when, from the audit log, for the "last changed" line. Null before any save. */
export async function lastAiOnboardingChange(): Promise<{ actorEmail: string; at: Date } | null> {
  const row = await platformAdmin.auditLog.findFirst({
    where: { action: AI_ONBOARDING_AUDIT_ACTION, entityType: "platform_settings", entityId: "platform" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { actorEmail: true, createdAt: true },
  });
  return row ? { actorEmail: row.actorEmail, at: row.createdAt } : null;
}
