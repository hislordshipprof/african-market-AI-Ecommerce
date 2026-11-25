/** The Home page's pure parts (#860), safe for the client component. */
/** One row of the Home page's "Needs you now" list (#860); each links to the page that fixes it. */
export interface NeedsItem {
  key: string;
  kind: "orders" | "swap" | "payouts" | "stock" | "messages" | "go-live";
  title: string;
  detail: string;
  href: string;
}

export interface NeedsInput {
  storeSlug: string;
  isOwner: boolean;
  now: Date;
  newOrders: { count: number; oldestAt: Date | null };
  swaps: { id: string; number: number; customerName: string }[];
  /** Set while Stripe set-up is unfinished; owners only. */
  payoutsAlert: string | null;
  lowStock: { count: number; names: string[] };
  unreadMessages: number;
  goLive: { key: string; label: string; detail: string; done: boolean; href?: string }[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function minutesAgo(at: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 60) return plural(minutes, "minute", "minutes");
  const hours = Math.round(minutes / 60);
  return plural(hours, "hour", "hours");
}

export function needsYouNow(input: NeedsInput): NeedsItem[] {
  const store = `?store=${encodeURIComponent(input.storeSlug)}`;
  const items: NeedsItem[] = [];
  const { count, oldestAt } = input.newOrders;
  if (count > 0) {
    items.push({
      key: "orders",
      kind: "orders",
      title: `Accept ${plural(count, "new order", "new orders")}`,
      detail: oldestAt ? `${count === 1 ? "Placed" : "Oldest placed"} ${minutesAgo(oldestAt, input.now)} ago` : "",
      href: `/store-admin/orders${store}`,
    });
  }
  for (const swap of input.swaps) {
    items.push({
      key: `swap-${swap.id}`,
      kind: "swap",
      title: `${swap.customerName} is choosing a swap on #${swap.number}`,
      detail: "Their choice comes back to the pick list",
      href: `/store-admin/orders/${swap.id}${store}`,
    });
  }
  if (input.isOwner && input.payoutsAlert) {
    items.push({
      key: "payouts",
      kind: "payouts",
      title: `Payouts: ${input.payoutsAlert}`,
      detail: "Finish Stripe set-up so your sales reach your bank",
      href: `/store-admin/payouts${store}`,
    });
  }
  if (input.lowStock.count > 0) {
    items.push({
      key: "stock",
      kind: "stock",
      title: `${plural(input.lowStock.count, "product is", "products are")} running low`,
      detail: input.lowStock.names.length > 0 ? `${input.lowStock.names.join(" and ")} first` : "",
      href: `/store-admin/listings${store}`,
    });
  }
  if (input.unreadMessages > 0) {
    items.push({
      key: "messages",
      kind: "messages",
      title: plural(input.unreadMessages, "unread message", "unread messages"),
      detail: "Customers asking about their orders",
      href: `/store-admin/messages${store}`,
    });
  }
  for (const item of input.goLive) {
    if (item.done || !item.href) continue;
    items.push({ key: `go-live-${item.key}`, kind: "go-live", title: item.label, detail: item.detail, href: item.href });
  }
  return items;
}

/** Today's sales against the same weekday last week, in whole percent; null when last week sold nothing. */
export function compareToLastWeek(todayCents: number, lastWeekCents: number): number | null {
  if (lastWeekCents <= 0) return null;
  return Math.round(((todayCents - lastWeekCents) / lastWeekCents) * 100);
}
