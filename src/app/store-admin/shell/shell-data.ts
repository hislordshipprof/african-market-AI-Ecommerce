import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { platformAdmin, storeScoped } from "@/lib/db";
import { findStoreForHeaders } from "@/lib/get-store";
import { storeWebAddress } from "@/lib/directory/links";
import { storeUnreadCount } from "@/lib/support/thread";
import { payoutsAlert, storeAdminAddress } from "@/lib/store-admin/nav";

/** Pages that stay bare: sign-in and 2FA set-up come before the shell, and the reorder sheet is for printing. */
export const BARE_PATHS = ["/store-admin/sign-in", "/store-admin/two-factor", "/store-admin/copilot/reorder/print"];

export function isBarePath(pathname: string): boolean {
  return BARE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export interface ShellCounts {
  newOrders: number;
  unreadMessages: number;
}

export interface ShellData extends ShellCounts {
  store: { name: string; slug: string; place: string | null; logoUrl: string | null };
  /** Where shoppers reach the store; null when the slug cannot be routed. */
  storeAddress: string | null;
  user: { name: string };
  role: string;
  payoutsAlert: string | null;
  /** The member's other stores, each with its own admin address. */
  otherStores: { name: string; href: string }[];
}

export async function shellCounts(storeId: string): Promise<ShellCounts> {
  const [newOrders, unreadMessages] = await Promise.all([
    storeScoped(storeId).order.count({ where: { status: "AUTHORIZED" } }),
    storeUnreadCount(storeId),
  ]);
  return { newOrders, unreadMessages };
}

/**
 * The sidebar and top bar's facts (#860). Like the assistant host it never redirects: the layout also wraps
 * sign-in, 2FA set-up and the platform host, where it returns null and the page renders bare.
 */
export async function loadShell(): Promise<ShellData | null> {
  const headerList = await headers();
  const path = (headerList.get("x-request-path") ?? "").split("?")[0];
  if (isBarePath(path)) return null;
  const [store, session] = await Promise.all([findStoreForHeaders(headerList), auth.api.getSession({ headers: headerList })]);
  if (!store || !session) return null;
  if (session.user.twoFactorEnabled && !session.session.twoFactorVerified) return null;
  const membership = await storeScoped(store.id).storeMembership.findUnique({
    where: { storeId_userId: { storeId: store.id, userId: session.user.id } },
    select: { role: true },
  });
  if (!membership) return null;

  const host = headerList.get("host") ?? "";
  const [counts, memberships] = await Promise.all([
    shellCounts(store.id),
    platformAdmin.storeMembership.findMany({
      where: { userId: session.user.id, storeId: { not: store.id }, store: { status: { not: "suspended" } } },
      select: { store: { select: { name: true, slug: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const owner = membership.role === "owner";
  return {
    ...counts,
    store: { name: store.name, slug: store.slug, place: store.city, logoUrl: store.logoUrl },
    storeAddress: host ? storeWebAddress(store.slug, host) : null,
    user: { name: session.user.name || session.user.email },
    role: membership.role,
    payoutsAlert: owner ? payoutsAlert(store.stripeOnboardingStatus) : null,
    otherStores: memberships.flatMap(({ store: other }) => {
      const href = host ? storeAdminAddress(other.slug, host) : null;
      return href ? [{ name: other.name, href }] : [];
    }),
  };
}
