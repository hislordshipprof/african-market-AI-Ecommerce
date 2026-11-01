import type { SwapRule } from "./contracts";
const memory = new Map<string, string>();
export function readDemo<T>(key: string, fallback: T): T {
  try {
    const raw =
      typeof window === "undefined"
        ? memory.get(key)
        : (window.localStorage.getItem(key) ?? memory.get(key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    try {
      const raw = memory.get(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }
}
export function writeDemo(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, raw);
  } catch {
    /* Browser storage may be disabled. */
  }
}
export function validatedSwapRule(value: unknown): SwapRule {
  if (!value || typeof value !== "object") return { kind: "exact" };
  const rule = value as Record<string, unknown>;
  if (rule.kind === "exact" || rule.kind === "suggest")
    return { kind: rule.kind };
  if (rule.kind !== "chosen" || !rule.item || typeof rule.item !== "object")
    return { kind: "exact" };
  const item = rule.item as Record<string, unknown>;
  return typeof item.listingId === "string" &&
    item.listingId.length > 0 &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    Number.isSafeInteger(item.price) &&
    Number(item.price) >= 0 &&
    (item.variantId === undefined || typeof item.variantId === "string")
    ? {
        kind: "chosen",
        item: rule.item as import("../storefront/cart-store").CartItem,
      }
    : { kind: "exact" };
}
export function getSwapRule(storeId: string, lineKey: string): SwapRule {
  return validatedSwapRule(
    readDemo<unknown>(`demo-swap:${storeId}:${lineKey}`, null),
  );
}
export function setSwapRule(storeId: string, lineKey: string, rule: SwapRule) {
  writeDemo(`demo-swap:${storeId}:${lineKey}`, rule);
}
export function getOrderSwapRule(
  storeId: string,
  orderId: string,
  lineKey: string,
): SwapRule {
  const rules = readDemo<unknown>(
    `demo-order-rules:${storeId}:${orderId}`,
    null,
  );
  return validatedSwapRule(
    rules && typeof rules === "object"
      ? (rules as Record<string, unknown>)[lineKey]
      : null,
  );
}
import type { FlowOrder } from "./contracts";
import type { CartLine } from "../storefront/cart-store";
import { cartItemKey } from "../storefront/cart-store";
/** Keep original line identity so issue keys remain stable after a swap. */
export function effectiveOrderLines(order: FlowOrder): CartLine[] {
  return order.lines.flatMap((line) => {
    const sub = order.substitutions.find(
      (s) => s.lineKey === cartItemKey(line),
    );
    if (sub?.decision === "refund") return [];
    if (sub?.decision === "swap")
      return [
        {
          ...line,
          name: sub.proposed.name,
          price: sub.proposed.price,
          packLabel: sub.proposed.packLabel,
          imageUrl: sub.proposed.imageUrl,
        },
      ];
    return [{ ...line }];
  });
}
export function finalOrderAmounts(order: FlowOrder) {
  const lines = effectiveOrderLines(order);
  const subtotalCents = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const discountCents =
    order.quote.discountCents > 0
      ? Math.min(1000, Math.round(subtotalCents * 0.1))
      : 0;
  const taxCents = Math.round((subtotalCents - discountCents) * 0.06);
  const totalCents =
    subtotalCents -
    discountCents +
    taxCents +
    order.quote.deliveryFeeCents +
    order.quote.courierFeeCents +
    order.quote.tipCents;
  return { subtotalCents, discountCents, taxCents, totalCents };
}
/** Allocate net goods and tax by cumulative rounding; allocations sum exactly. */
export function orderIssueRefundCents(
  order: FlowOrder,
  lineKeys: readonly string[],
): number {
  const lines = effectiveOrderLines(order),
    amounts = finalOrderAmounts(order);
  let gross = 0,
    allocated = 0,
    total = 0;
  const net = amounts.subtotalCents - amounts.discountCents + amounts.taxCents;
  for (const line of lines) {
    gross += line.price * line.quantity;
    const cumulative = amounts.subtotalCents
      ? Math.round((net * gross) / amounts.subtotalCents)
      : 0;
    if (lineKeys.includes(cartItemKey(line))) total += cumulative - allocated;
    allocated = cumulative;
  }
  return Math.min(total, order.finalCents ?? amounts.totalCents);
}
