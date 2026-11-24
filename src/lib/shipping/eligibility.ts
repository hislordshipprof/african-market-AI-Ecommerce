/** Which goods may ship, and when an order may (ADR-0023, #567). */

import { isStateCode, STATE_NAMES } from "../directory/us-states";

const GRAMS_PER_LB = 453.59237;
/** The heaviest order that ships, one box (#567). */
export const SHIPPING_WEIGHT_LIMIT_LB = 50;

export interface ShippableVariant {
  weightG: number;
  weightPlaceholder: boolean;
}

export interface ShippableListing {
  frozen: boolean;
  perishable: boolean;
  /** Prepared food (#570) is not a shelf-stable dry good. */
  prepared: string | null;
}

/** Why a listing cannot be marked shippable, or null when it can. */
export function shippableRefusal(listing: ShippableListing, variants: readonly ShippableVariant[]): string | null {
  if (listing.frozen) return "Frozen items cannot ship.";
  if (listing.perishable) return "Perishable items cannot ship.";
  if (listing.prepared != null) return "Prepared food cannot ship.";
  if (variants.length === 0 || variants.some((v) => v.weightPlaceholder || !(v.weightG > 0))) {
    return "Add a real weight to every size before shipping this item.";
  }
  return null;
}

/** A line ships when its listing is marked shippable and still meets the rule. */
export function lineShips(listing: ShippableListing & { shippable: boolean }, variant: ShippableVariant): boolean {
  return listing.shippable && shippableRefusal(listing, [variant]) === null;
}

export interface ShipLine {
  ships: boolean;
  weightG: number;
  qty: number;
}

/** Why this basket cannot ship to this state, or null when it can. */
export function shipRefusal(input: {
  lines: readonly ShipLine[];
  handlingDays: number | null;
  state: string | null;
  allowedStates: readonly string[];
}): string | null {
  if (input.handlingDays == null) return "This store doesn't ship orders.";
  if (input.allowedStates.length === 0) return "We don't ship to any state yet.";
  if (input.lines.some((line) => !line.ships)) return "Some items in your basket can't ship. Choose pickup or delivery.";
  const weightG = input.lines.reduce((sum, line) => sum + line.weightG * line.qty, 0);
  if (weightG > SHIPPING_WEIGHT_LIMIT_LB * GRAMS_PER_LB) return `Shipped orders can weigh up to ${SHIPPING_WEIGHT_LIMIT_LB} lb.`;
  if (input.state && !input.allowedStates.includes(input.state)) return "We can't ship to that state yet.";
  return null;
}

export function orderWeightG(lines: readonly ShipLine[]): number {
  return lines.reduce((sum, line) => sum + line.weightG * line.qty, 0);
}

/** The states this store's parcels can go to: none without handling days or while the platform ships nowhere (#750). */
export function storeShipsTo(handlingDays: number | null, allowedStates: readonly string[]): string[] {
  return handlingDays == null ? [] : [...allowedStates].sort();
}

/** "Ships to Maryland and Virginia", shown before the shopper types an address (#750). */
export function shipsToLabel(states: readonly string[]): string {
  const names = states.map((code) => (isStateCode(code) ? STATE_NAMES[code] : code));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
  return `Ships to ${list}`;
}
