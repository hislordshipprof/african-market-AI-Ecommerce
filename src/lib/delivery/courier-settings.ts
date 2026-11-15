import type { Prisma } from "@prisma/client";
import { lockPlatformSettingsRow, platform } from "../db";
import type { DeliveryProvider, DeliveryProviderName } from "./provider";

/** How dispatch picks among live quotes (#535): the cheapest, or one provider first while it can quote. */
export const COURIER_SELECTION_MODES = ["cheapest", "doordash_first", "uber_first"] as const;
export type CourierSelectionMode = (typeof COURIER_SELECTION_MODES)[number];

/** Decision taken in #535: 5 to 20 minutes. */
export const ASSIGNMENT_TIMEOUT_SECONDS = { min: 300, max: 1200 } as const;
/** Decision taken in #535: whole pounds, 1 to 100. */
export const COURIER_WEIGHT_LIMIT_LB = { min: 1, max: 100 } as const;

/** Platform-wide courier settings (#535), one row edited at /admin/settings/couriers. Per-metro overrides wait for #577. */
export interface CourierSettings {
  selectionMode: CourierSelectionMode;
  assignmentTimeoutSeconds: number;
  doordashEnabled: boolean;
  uberEnabled: boolean;
  weightLimitLb: number;
}

type SettingsReader = {
  platformSettings: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<{
      courierSelectionMode: string;
      courierAssignmentTimeoutS: number;
      doordashEnabled: boolean;
      uberEnabled: boolean;
      courierWeightLimitLb: number;
    }>;
  };
};

/** Read when checkout quotes and when dispatch and failover run, so a change applies to the next order. */
export async function readCourierSettings(db: SettingsReader = platform): Promise<CourierSettings> {
  const row = await db.platformSettings.findUniqueOrThrow({ where: { id: "platform" } });
  return {
    selectionMode: row.courierSelectionMode as CourierSelectionMode,
    assignmentTimeoutSeconds: row.courierAssignmentTimeoutS,
    doordashEnabled: row.doordashEnabled,
    uberEnabled: row.uberEnabled,
    weightLimitLb: row.courierWeightLimitLb,
  };
}

export function providerEnabled(settings: CourierSettings, name: DeliveryProviderName): boolean {
  return name === "doordash" ? settings.doordashEnabled : settings.uberEnabled;
}

/** The providers switched on. A switched-off provider is never quoted or booked. */
export function enabledProviders<P extends Pick<DeliveryProvider, "name">>(providers: readonly P[], settings: CourierSettings): P[] {
  return providers.filter((p) => providerEnabled(settings, p.name));
}

/** True when any provider is on. With both off, checkout offers no courier option and logs why. */
export function anyCourierEnabled(settings: CourierSettings, referenceId: string): boolean {
  if (settings.doordashEnabled || settings.uberEnabled) return true;
  console.warn(JSON.stringify({ event: "courier_providers_off", referenceId }));
  return false;
}

/** The provider a priority mode tries first, or null for cheapest. */
export function preferredProvider(mode: CourierSelectionMode): DeliveryProviderName | null {
  if (mode === "doordash_first") return "doordash";
  if (mode === "uber_first") return "uber";
  return null;
}

type SettingsWriter = SettingsReader & {
  platformSettings: { update(args: { where: { id: string }; data: Prisma.PlatformSettingsUpdateInput }): Promise<unknown> };
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

/**
 * Writes validated settings in the caller's platform-admin transaction. The row is locked first, so a concurrent save
 * waits and each audit row's "before" is what that save replaced. Returns false, writing nothing, when nothing changed.
 */
export async function saveCourierSettings(tx: SettingsWriter, actor: { id: string; email: string }, next: CourierSettings): Promise<boolean> {
  await lockPlatformSettingsRow(tx);
  const before = await readCourierSettings(tx);
  if ((Object.keys(next) as Array<keyof CourierSettings>).every((key) => before[key] === next[key])) return false;
  await tx.platformSettings.update({
    where: { id: "platform" },
    data: {
      courierSelectionMode: next.selectionMode,
      courierAssignmentTimeoutS: next.assignmentTimeoutSeconds,
      doordashEnabled: next.doordashEnabled,
      uberEnabled: next.uberEnabled,
      courierWeightLimitLb: next.weightLimitLb,
    },
  });
  await tx.auditLog.create({
    data: {
      storeId: null,
      actorId: actor.id,
      actorEmail: actor.email,
      action: "platform.courier_settings_update",
      entityType: "platform_settings",
      entityId: "platform",
      before: { ...before },
      after: { ...next },
    },
  });
  return true;
}
