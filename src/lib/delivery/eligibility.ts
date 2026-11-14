import { platform } from "@/lib/db";

const GRAMS_PER_LB = 453.59237;

export interface CourierWeightLine {
  /** Weight of one unit, in grams. */
  weightG: number;
  quantity: number;
}

export interface CourierWeightSettings {
  courierWeightLimitLb: number;
}

export type CourierEligibility =
  | { eligible: true }
  | { eligible: false; reason: "item_over_limit" | "order_over_limit" };

/** Spec D4: courier only when no item and not the whole order is over the platform limit. */
export function checkCourierEligibility(
  items: readonly CourierWeightLine[],
  settings: CourierWeightSettings,
): CourierEligibility {
  const limitG = settings.courierWeightLimitLb * GRAMS_PER_LB;
  if (items.some((item) => item.weightG > limitG)) return { eligible: false, reason: "item_over_limit" };
  const totalG = items.reduce((sum, item) => sum + item.weightG * item.quantity, 0);
  if (totalG > limitG) return { eligible: false, reason: "order_over_limit" };
  return { eligible: true };
}

/** The limit is an adjustable platform setting (spec D4), one row seeded by migration. */
export async function readCourierWeightSettings(): Promise<CourierWeightSettings> {
  const row = await platform.platformSettings.findUniqueOrThrow({ where: { id: "platform" } });
  return { courierWeightLimitLb: row.courierWeightLimitLb };
}
