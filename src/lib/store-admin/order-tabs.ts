/** The Orders page's status tabs (#860): each active order sits in one stage, named as staff see it. */
export type OrderTab = "all" | "placed" | "packing" | "swap" | "ready" | "out" | "other";

const STAGES: { tab: Exclude<OrderTab, "all" | "other">; label: string; statuses: readonly string[] }[] = [
  { tab: "placed", label: "Order placed", statuses: ["AUTHORIZED"] },
  { tab: "packing", label: "Packing", statuses: ["ACCEPTED", "PICKING", "CAPTURING"] },
  { tab: "swap", label: "Swap choice", statuses: ["SUBSTITUTION_PENDING"] },
  { tab: "ready", label: "Ready", statuses: ["READY", "AWAITING_PICKUP"] },
  { tab: "out", label: "Out", statuses: ["COURIER_REQUESTED", "COURIER_ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "SHIPPED", "IN_TRANSIT"] },
];

interface TabbedOrder {
  status: string;
  number: number;
  fulfillment: string;
  customer: { name: string };
}

export function orderTab(status: string): Exclude<OrderTab, "all"> {
  return STAGES.find((stage) => stage.statuses.includes(status))?.tab ?? "other";
}

/** Every stage with its count; "Needs a look" (refund failed, cancelling, a dispute or refund the platform made) only when it has orders. */
export function orderTabCounts(orders: readonly TabbedOrder[]): { tab: OrderTab; label: string; count: number }[] {
  const count = (tab: OrderTab) => orders.filter((order) => orderTab(order.status) === tab).length;
  const other = count("other");
  return [
    { tab: "all", label: "All active", count: orders.length },
    ...STAGES.map((stage) => ({ tab: stage.tab, label: stage.label, count: count(stage.tab) })),
    ...(other > 0 ? [{ tab: "other" as const, label: "Needs a look", count: other }] : []),
  ];
}

export function filterOrders<T extends TabbedOrder>(
  orders: readonly T[],
  { tab, fulfillment, query }: { tab: OrderTab; fulfillment: string; query: string },
): T[] {
  const q = query.trim().toLowerCase();
  const number = q.replace(/^#/, "");
  return orders.filter(
    (order) =>
      (tab === "all" || orderTab(order.status) === tab) &&
      (fulfillment === "all" || order.fulfillment === fulfillment) &&
      (!q || (/^\d+$/.test(number) ? String(order.number).includes(number) : order.customer.name.toLowerCase().includes(q))),
  );
}
