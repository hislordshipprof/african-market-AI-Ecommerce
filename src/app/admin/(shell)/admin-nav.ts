import {
  BellRing,
  CookingPot,
  Bot,
  CopyCheck,
  ClipboardCheck,
  CreditCard,
  FileInput,
  FolderTree,
  Gauge,
  House,
  MapPinned,
  MessagesSquare,
  Package,
  PackageSearch,
  ReceiptText,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Store,
  Truck,
  Undo2,
} from "lucide-react";

/** The sidebar in design A's groups (#859). One entry per line: a new page is one line here, in the group it belongs to.
    `count` names the queue whose live count the entry shows as a badge. */
export const ADMIN_NAV_GROUPS = [
  { label: null, items: [{ href: "/admin", label: "Home", icon: House }] },
  {
    label: "Stores",
    items: [
      { href: "/admin/stores", label: "Stores", icon: Store },
      { href: "/admin/applications", label: "Applications", icon: FileInput, count: "applications" },
      { href: "/admin/store-requests", label: "Store requests", icon: BellRing, count: "storeRequests" },
      { href: "/admin/billing/subscriptions", label: "Subscriptions", icon: CreditCard },
    ],
  },
  {
    label: "Catalogue",
    items: [
      { href: "/admin/catalog/products", label: "Products", icon: Package },
      { href: "/admin/catalog/categories", label: "Categories", icon: FolderTree },
      { href: "/admin/catalog/recipes", label: "Recipes", icon: CookingPot },
      { href: "/admin/catalog/review", label: "Catalog review", icon: ClipboardCheck, count: "catalogReview" },
      { href: "/admin/catalog/duplicates", label: "Duplicates", icon: CopyCheck },
    ],
  },
  {
    label: "Orders and money",
    items: [
      { href: "/admin/orders", label: "Refunds", icon: Undo2, count: "refunds" },
      { href: "/admin/orders/check", label: "Orders to check", icon: PackageSearch, count: "ordersToCheck" },
      { href: "/admin/orders/search", label: "Search orders", icon: Search },
      { href: "/admin/disputes", label: "Disputes", icon: ShieldAlert, count: "disputes" },
      { href: "/admin/billing/ledger", label: "Fee ledger", icon: ReceiptText },
    ],
  },
  {
    label: "Delivery",
    items: [
      { href: "/admin/couriers/incidents", label: "Courier incidents", icon: Truck, count: "courierIncidents" },
      { href: "/admin/settings/couriers", label: "Courier settings", icon: Truck },
      { href: "/admin/metros", label: "Metros", icon: MapPinned },
    ],
  },
  { label: "Support", items: [{ href: "/admin/support", label: "Messages", icon: MessagesSquare, count: "messages" }] },
  {
    label: "AI",
    items: [
      { href: "/admin/ai/conversations", label: "AI conversations", icon: Bot },
      { href: "/admin/ai/eval-spend", label: "AI eval and spend", icon: Gauge },
    ],
  },
  { label: "Settings", items: [{ href: "/admin/settings/ai-onboarding", label: "AI and onboarding", icon: SlidersHorizontal }] },
] as const;

type NavGroup = (typeof ADMIN_NAV_GROUPS)[number];
export type AdminNavItem = NavGroup["items"][number];
/** The queues a badge can show; their counts come from getAdminQueueCounts. */
export type AdminNavCount = Extract<AdminNavItem, { count: string }>["count"];

export const ADMIN_NAV: readonly AdminNavItem[] = ADMIN_NAV_GROUPS.flatMap((group): readonly AdminNavItem[] => group.items);

export type AdminNavHref = (typeof ADMIN_NAV)[number]["href"];

/** The menu entry for a path: the longest entry the path sits under, so /admin/orders/check is not Refunds. */
export function currentNavHref(pathname: string): AdminNavHref {
  let match: AdminNavHref = "/admin";
  for (const { href } of ADMIN_NAV) {
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > match.length) match = href;
  }
  return match;
}

/** The ⌘K palette's pages (#859): every word of the query appears in the page's label or group. */
export function matchNavPages(query: string): Array<{ href: AdminNavHref; label: string; group: string; icon: AdminNavItem["icon"] }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({ href: item.href, label: item.label, group: group.label ?? "Go to", icon: item.icon })),
  ).filter((page) => words.every((word) => `${page.label} ${page.group}`.toLowerCase().includes(word)));
}
