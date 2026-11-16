/**
 * Catering (#571): a prepared listing ordered ahead, like a party tray of jollof. It carries a lead
 * time in hours and a minimum quantity. A cart with catering lines must take a slot at or past its
 * longest lead time and inside the 5-day card hold, so the lead stays under 5 days.
 */

export const MAX_CATERING_LEAD_HOURS = 96;
export const MAX_CATERING_MIN_QTY = 500;

export const CATERING_NEEDS_PREPARED = "Only prepared food can be catering.";

export interface CateringFields {
  cateringLeadHours: number | null;
  cateringMinQty: number | null;
}

/** The longest catering lead in the basket, in minutes; 0 when it has none. */
export function cateringLeadMinutes(lines: ReadonlyArray<{ cateringLeadHours: number | null }>): number {
  return lines.reduce((max, line) => Math.max(max, (line.cateringLeadHours ?? 0) * 60), 0);
}

export function cateringMinMessage(min: number): string {
  return `Order at least ${min} of this catering item.`;
}

/** Both fields or neither, prepared only, whole numbers in range; throws the owner-facing reason. */
export function cateringFields(
  prepared: string | null,
  leadHours: number | null,
  minQty: number | null,
): CateringFields {
  if (leadHours == null && minQty == null) return { cateringLeadHours: null, cateringMinQty: null };
  if (prepared == null) throw new Error(CATERING_NEEDS_PREPARED);
  if (leadHours == null || !Number.isInteger(leadHours) || leadHours < 1 || leadHours > MAX_CATERING_LEAD_HOURS) {
    throw new Error(`Catering lead time must be 1 to ${MAX_CATERING_LEAD_HOURS} hours (4 days)`);
  }
  if (minQty == null || !Number.isInteger(minQty) || minQty < 1 || minQty > MAX_CATERING_MIN_QTY) {
    throw new Error(`Catering minimum must be a whole number, 1 to ${MAX_CATERING_MIN_QTY}`);
  }
  return { cateringLeadHours: leadHours, cateringMinQty: minQty };
}

/** "2 days" for whole days, else "30 hours". */
export function cateringLeadText(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "1 day" : `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
