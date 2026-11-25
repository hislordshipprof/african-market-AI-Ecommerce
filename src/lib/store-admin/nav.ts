import { storeWebAddress } from "../directory/links";

type Env = Record<string, string | undefined>;

/** The store admin sidebar (#860): grouped by job, filtered by role the way each page's own check is. */
export type NavIcon =
  | "home" | "orders" | "products" | "purchase-orders" | "shipping" | "messages"
  | "promotions" | "directory" | "whatsapp" | "payouts" | "plan" | "team" | "analytics" | "settings";

export interface NavItem {
  label: string;
  path: string;
  icon: NavIcon;
  count?: number;
  alert?: string;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export interface NavInput {
  role: string;
  newOrders: number;
  unreadMessages: number;
  /** Set while Stripe set-up is unfinished: what the Payouts item says. */
  payoutsAlert: string | null;
}

type Entry = NavItem & { ownerOnly?: boolean };

/** What the Payouts item says until Stripe set-up is complete (the dashboard's old Payouts badge). */
export function payoutsAlert(stripeOnboardingStatus: string): string | null {
  if (stripeOnboardingStatus === "complete") return null;
  return { not_started: "Not set up", pending: "Pending", restricted: "Needs info" }[stripeOnboardingStatus] ?? "Not set up";
}

export function storeAdminNav({ role, newOrders, unreadMessages, payoutsAlert }: NavInput): NavGroup[] {
  const owner = role === "owner";
  const count = (n: number) => (n > 0 ? n : undefined);
  const groups: { label: string | null; items: Entry[] }[] = [
    { label: null, items: [{ label: "Home", path: "/store-admin", icon: "home" }] },
    {
      label: "Sell",
      items: [
        { label: "Orders", path: "/store-admin/orders", icon: "orders", count: count(newOrders) },
        { label: "Products", path: "/store-admin/listings", icon: "products" },
        { label: "Purchase orders", path: "/store-admin/purchase-orders", icon: "purchase-orders", ownerOnly: true },
        { label: "Shipping", path: "/store-admin/shipping", icon: "shipping", ownerOnly: true },
      ],
    },
    { label: "Customers", items: [{ label: "Messages", path: "/store-admin/messages", icon: "messages", count: count(unreadMessages) }] },
    {
      label: "Marketing",
      items: [
        { label: "Promotions", path: "/store-admin/promotions", icon: "promotions", ownerOnly: true },
        { label: "Directory listing", path: "/store-admin/directory", icon: "directory", ownerOnly: true },
        { label: "WhatsApp", path: "/store-admin/whatsapp", icon: "whatsapp", ownerOnly: true },
      ],
    },
    {
      label: "Money",
      items: [
        { label: "Payouts", path: "/store-admin/payouts", icon: "payouts", ownerOnly: true, alert: payoutsAlert ?? undefined },
        { label: "Plan", path: "/store-admin/plan", icon: "plan", ownerOnly: true },
      ],
    },
    {
      label: "Store",
      items: [
        { label: "Team", path: "/store-admin/team", icon: "team", ownerOnly: true },
        { label: "Analytics", path: "/store-admin/analytics", icon: "analytics", ownerOnly: true },
        { label: "Settings", path: "/store-admin/settings", icon: "settings", ownerOnly: true },
      ],
    },
  ];
  return groups
    .map((group) => ({
      label: group.label,
      items: group.items
        .filter((item) => owner || !item.ownerOnly)
        .map(({ ownerOnly: _ownerOnly, count: n, alert, ...item }) => ({
          ...item,
          ...(n !== undefined ? { count: n } : {}),
          ...(alert !== undefined ? { alert } : {}),
        })),
    }))
    .filter((group) => group.items.length > 0);
}

/** The item a path belongs to: the longest matching prefix, so /store-admin/orders/past is Orders. */
export function activeNavPath(groups: NavGroup[], pathname: string): string | null {
  let best: string | null = null;
  for (const item of groups.flatMap((group) => group.items)) {
    const match = item.path === "/store-admin" ? pathname === "/store-admin" : pathname === item.path || pathname.startsWith(`${item.path}/`);
    if (match && (!best || item.path.length > best.length)) best = item.path;
  }
  return best;
}

/** Another store's admin, for the switcher: the store's own address with the admin path; null when unroutable. */
export function storeAdminAddress(slug: string, requestHost: string, env: Env = process.env): string | null {
  const address = storeWebAddress(slug, requestHost, env);
  if (!address) return null;
  const url = new URL(address);
  url.pathname = "/store-admin";
  return url.toString();
}
