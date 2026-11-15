export const ADMIN_NAV = [
  { href: "/admin", label: "Home" },
  { href: "/admin/stores", label: "Stores" },
  { href: "/admin/applications", label: "Applications" },
  { href: "/admin/store-requests", label: "Store requests" },
  { href: "/admin/catalog/products", label: "Products" },
  { href: "/admin/catalog/review", label: "Catalog review" },
  { href: "/admin/orders", label: "Refunds" },
  { href: "/admin/orders/check", label: "Orders to check" },
  { href: "/admin/couriers/incidents", label: "Courier incidents" },
  { href: "/admin/support", label: "Messages" },
  { href: "/admin/ai/conversations", label: "AI conversations" },
  { href: "/admin/ai/eval-spend", label: "AI eval and spend" },
  { href: "/admin/settings/couriers", label: "Courier settings" },
  { href: "/admin/settings/ai-onboarding", label: "AI and onboarding" },
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
