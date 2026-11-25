"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bell,
  Box,
  ChevronsUpDown,
  ClipboardList,
  ExternalLink,
  Gem,
  Home,
  Landmark,
  MapPin,
  Menu,
  MessageCircle,
  MessagesSquare,
  Search,
  Settings,
  ShoppingBag,
  TicketPercent,
  Truck,
  Users,
  X,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { activeNavPath, isBarePath, storeAdminNav, type NavGroup, type NavIcon } from "@/lib/store-admin/nav";
import { SignOutButton } from "../sign-out-button";
import { SearchDialog } from "./search-dialog";
import { shellCountsAction } from "./actions";
import type { ShellCounts, ShellData } from "./shell-data";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: Home,
  orders: ShoppingBag,
  products: Box,
  "purchase-orders": ClipboardList,
  shipping: Truck,
  messages: MessagesSquare,
  promotions: TicketPercent,
  directory: MapPin,
  whatsapp: MessageCircle,
  payouts: Landmark,
  plan: Gem,
  team: Users,
  analytics: BarChart3,
  settings: Settings,
};

const FOCUS = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : (words[0]?.[1] ?? ""))).toUpperCase();
}

function withStore(path: string, slug: string): string {
  return `${path}?store=${encodeURIComponent(slug)}`;
}

/**
 * The store admin's frame (#860): a grouped sidebar beside every page from 1024px, a drawer opened from the top
 * bar below it, and the top bar with search, order alerts and View store. Store tokens only, so every theme applies.
 */
export function AdminShell({ data, children }: { data: ShellData | null; children: React.ReactNode }) {
  const pathname = usePathname() || "/store-admin";
  const chrome = data !== null && !isBarePath(pathname);
  // Counts fetched after a page change, kept with the layout data they came after: a fresh layout's counts win.
  const [fetched, setFetched] = useState<{ after: ShellData | null; counts: ShellCounts } | null>(null);
  const counts = fetched && fetched.after === data ? fetched.counts : { newOrders: data?.newOrders ?? 0, unreadMessages: data?.unreadMessages ?? 0 };
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  const groups = data
    ? storeAdminNav({ role: data.role, newOrders: counts.newOrders, unreadMessages: counts.unreadMessages, payoutsAlert: data.payoutsAlert })
    : [];
  const current = activeNavPath(groups, pathname);

  // The layout is not rendered again on client navigation, so the counts are fetched per page.
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current || !dataRef.current) return;
    let live = true;
    shellCountsAction()
      .then((fresh) => live && setFetched({ after: dataRef.current, counts: fresh }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (!chrome) return;
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chrome]);

  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  const sidebar = chrome ? (
    <SidebarBody data={data} groups={groups} current={current} onNavigate={() => setDrawerOpen(false)} />
  ) : null;

  // One tree shape with or without the chrome: the layout gains the shell after sign-in by a refresh, and a
  // changed shape would remount the page and lose what the member had typed.
  return (
    <div className={chrome ? "min-h-dvh bg-background" : undefined}>
      {chrome && data && (
        <>
          <a
            href="#store-admin-main"
            className="sr-only z-50 rounded-md bg-card px-4 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-2 focus:outline-offset-2 focus:outline-ring"
          >
            Skip to content
          </a>

          <aside aria-label="Store admin" className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-card lg:flex">
            {sidebar}
          </aside>

          <dialog
            ref={drawer}
            aria-label="Menu"
            onClose={() => {
              setDrawerOpen(false);
              menuButton.current?.focus();
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) setDrawerOpen(false);
            }}
            className="m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none border-r border-border bg-card p-0 text-foreground backdrop:bg-black/40 lg:hidden"
          >
            <div className="flex h-full flex-col">
              <div className="absolute right-2 top-3">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className={`flex size-11 items-center justify-center rounded-full text-foreground hover:bg-muted ${FOCUS}`}
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
              {sidebar}
            </div>
          </dialog>
        </>
      )}

      <div className={chrome ? "lg:pl-64" : undefined}>
        {chrome && data && (
          <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-sm">
            <div className="flex h-16 items-center gap-2 px-3 sm:gap-3 sm:px-6 lg:px-8">
              <button
                ref={menuButton}
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
                aria-haspopup="dialog"
                className={`flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-muted lg:hidden ${FOCUS}`}
              >
                <Menu className="size-5" aria-hidden />
              </button>
              <p className="min-w-0 truncate font-heading text-base font-bold text-foreground lg:hidden">{data.store.name}</p>

              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className={`hidden h-11 w-full max-w-md items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm text-muted-foreground hover:border-foreground/30 lg:flex ${FOCUS}`}
              >
                <Search className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">Search orders, products, customers…</span>
                <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-xs text-muted-foreground">⌘ K</kbd>
              </button>

              <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
                <button
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search"
                  className={`flex size-11 items-center justify-center rounded-full text-foreground hover:bg-muted lg:hidden ${FOCUS}`}
                >
                  <Search className="size-5" aria-hidden />
                </button>
                <Link
                  href={withStore("/store-admin/orders", data.store.slug)}
                  aria-label={counts.newOrders > 0 ? `Order alerts: ${counts.newOrders} new` : "Order alerts: no new orders"}
                  data-testid="order-alerts-bell"
                  className={`relative flex size-11 items-center justify-center rounded-full text-foreground hover:bg-muted ${FOCUS}`}
                >
                  <Bell className="size-5" aria-hidden />
                  {counts.newOrders > 0 && (
                    <span className="absolute right-1.5 top-1.5 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-bold leading-5 text-background tabular-nums">
                      {counts.newOrders}
                    </span>
                  )}
                </Link>
                {data.storeAddress && (
                  <a
                    href={data.storeAddress}
                    target="_blank"
                    rel="noreferrer"
                    className={`hidden min-h-11 items-center gap-2 rounded-full border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted sm:inline-flex ${FOCUS}`}
                  >
                    View store
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                )}
              </div>
            </div>
          </header>
        )}

        <div
          id="store-admin-main"
          role={chrome ? "main" : undefined}
          tabIndex={chrome ? -1 : undefined}
          className={chrome ? "px-4 py-6 focus:outline-none sm:px-6 lg:px-8" : undefined}
        >
          {children}
        </div>
      </div>

      {chrome && data && <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} storeSlug={data.store.slug} />}
    </div>
  );
}

function SidebarBody({
  data,
  groups,
  current,
  onNavigate,
}: {
  data: ShellData;
  groups: NavGroup[];
  current: string | null;
  onNavigate: () => void;
}) {
  return (
    <>
      <div className="border-b border-border p-3 pr-14 lg:pr-3">
        <StoreSwitcher data={data} />
      </div>
      <nav aria-label="Store admin" className="flex-1 overflow-y-auto px-3 py-3">
        {groups.map((group) => (
          <div key={group.label ?? "top"} className="mb-2">
            {group.label && <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{group.label}</p>}
            <ul className="grid gap-0.5">
              {group.items.map((item) => {
                const Icon = ICONS[item.icon];
                const isCurrent = item.path === current;
                return (
                  <li key={item.path}>
                    <Link
                      href={withStore(item.path, data.store.slug)}
                      aria-current={isCurrent ? "page" : undefined}
                      onClick={onNavigate}
                      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] lg:min-h-9 ${FOCUS} ${
                        isCurrent
                          ? "bg-secondary font-semibold text-foreground shadow-[inset_3px_0_0_var(--primary)]"
                          : "text-foreground/80 hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <Icon aria-hidden className={`size-[18px] shrink-0 ${isCurrent ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.count !== undefined && (
                        <span
                          className={`min-w-6 rounded-full px-1.5 text-center text-xs font-bold leading-5 tabular-nums ${
                            item.icon === "orders" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                          }`}
                          aria-label={item.icon === "orders" ? `${item.count} new` : `${item.count} unread`}
                        >
                          {item.count}
                        </span>
                      )}
                      {item.alert && (
                        <span className="flex items-center gap-1 text-xs font-medium text-destructive">
                          <AlertCircle className="size-3.5" aria-hidden />
                          {item.alert}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-3 border-t border-border p-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-foreground">
          {initials(data.user.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{data.user.name}</p>
          <p className="text-xs capitalize text-muted-foreground">{data.role}</p>
        </div>
        <SignOutButton storeSlug={data.store.slug} compact />
      </div>
    </>
  );
}

function StoreSwitcher({ data }: { data: ShellData }) {
  const [open, setOpen] = useState(false);
  const badge = (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
      {initials(data.store.name)}
    </span>
  );
  const label = (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-sm font-semibold text-foreground">{data.store.name}</span>
      {data.store.place && <span className="block truncate text-xs text-muted-foreground">{data.store.place}</span>}
    </span>
  );
  if (data.otherStores.length === 0) {
    return <div className="flex min-h-11 items-center gap-3 px-1">{badge}{label}</div>;
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="store-switcher"
        aria-label={`${data.store.name}: switch store`}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-1 hover:bg-muted ${FOCUS}`}
      >
        {badge}
        {label}
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <ul id="store-switcher" className="absolute inset-x-0 top-full z-40 mt-1 grid gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md">
          {data.otherStores.map((store) => (
            <li key={store.href}>
              {/* A full load: each store's admin has its own host and session. */}
              <a href={store.href} className={`flex min-h-11 items-center rounded-md px-3 text-sm text-foreground hover:bg-muted ${FOCUS}`}>
                {store.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
