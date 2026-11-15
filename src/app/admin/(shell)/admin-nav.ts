import {
  BellRing,
  Bot,
  CopyCheck,
  ClipboardCheck,
  CreditCard,
  FileInput,
  FolderTree,
  Gauge,
  House,
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

/** One entry per line: a new menu entry is one line here, in the place it belongs. */
export const ADMIN_NAV = [
  { href: "/admin", label: "Home", icon: House },
  { href: "/admin/stores", label: "Stores", icon: Store },
  { href: "/admin/billing/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/admin/applications", label: "Applications", icon: FileInput },
  { href: "/admin/store-requests", label: "Store requests", icon: BellRing },
  { href: "/admin/catalog/products", label: "Products", icon: Package },
  { href: "/admin/catalog/categories", label: "Categories", icon: FolderTree },
  { href: "/admin/catalog/review", label: "Catalog review", icon: ClipboardCheck },
  { href: "/admin/catalog/duplicates", label: "Duplicates", icon: CopyCheck },
  { href: "/admin/orders", label: "Refunds", icon: Undo2 },
  { href: "/admin/orders/check", label: "Orders to check", icon: PackageSearch },
  { href: "/admin/orders/search", label: "Search orders", icon: Search },
  { href: "/admin/disputes", label: "Disputes", icon: ShieldAlert },
  { href: "/admin/couriers/incidents", label: "Courier incidents", icon: Truck },
  { href: "/admin/support", label: "Messages", icon: MessagesSquare },
  { href: "/admin/ai/conversations", label: "AI conversations", icon: Bot },
  { href: "/admin/ai/eval-spend", label: "AI eval and spend", icon: Gauge },
  { href: "/admin/billing/ledger", label: "Fee ledger", icon: ReceiptText },
  { href: "/admin/settings/couriers", label: "Courier settings", icon: Truck },
  { href: "/admin/settings/ai-onboarding", label: "AI and onboarding", icon: SlidersHorizontal },
] as const;

export type AdminNavHref = (typeof ADMIN_NAV)[number]["href"];

/** The menu entry for a path: the longest entry the path sits under, so /admin/orders/check is not Refunds. */
export function currentNavHref(pathname: string): AdminNavHref {
  let match: AdminNavHref = "/admin";
  for (const { href } of ADMIN_NAV) {
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > match.length) match = href;
  }
  return match;
}
