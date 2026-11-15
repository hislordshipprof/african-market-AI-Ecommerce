"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BellRing, Bot, ClipboardCheck, FileInput, Gauge, House, LogOut, Menu, MessagesSquare, Package, PackageSearch, ReceiptText, Store, Truck, Undo2, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { ADMIN_NAV, currentNavHref, type AdminNavHref } from "./admin-nav";
import { signOutAdmin } from "./sign-out";

const ICONS: Record<AdminNavHref, typeof House> = {
  "/admin": House,
  "/admin/stores": Store,
  "/admin/applications": FileInput,
  "/admin/store-requests": BellRing,
  "/admin/catalog/products": Package,
  "/admin/catalog/review": ClipboardCheck,
  "/admin/orders": Undo2,
  "/admin/orders/check": PackageSearch,
  "/admin/couriers/incidents": Truck,
  "/admin/support": MessagesSquare,
  "/admin/ai/conversations": Bot,
  "/admin/ai/eval-spend": Gauge,
  "/admin/billing/ledger": ReceiptText,
};

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function AdminNav({ email }: { email: string }) {
  const current = currentNavHref(usePathname());
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  async function signOut() {
    setSigningOut(true);
    setSignOutFailed(false);
    // A full load, so no cached admin page survives the session.
    const left = await signOutAdmin(() => authClient.signOut(), (path) => window.location.assign(path));
    if (!left) {
      setSigningOut(false);
      setSignOutFailed(true);
    }
  }

  return (
    <header
      className="sticky top-0 z-30 border-b border-border bg-card lg:static lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <div className="lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-14 items-center justify-between gap-4 px-4 lg:h-auto lg:px-5 lg:pb-5 lg:pt-7">
          <Link href="/admin" className={`rounded-md font-heading text-lg font-bold text-foreground ${FOCUS}`}>
            Platform admin
          </Link>
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls="admin-menu"
            onClick={() => setOpen((value) => !value)}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted lg:hidden ${FOCUS}`}
          >
            {open ? <X aria-hidden className="size-4" /> : <Menu aria-hidden className="size-4" />}
            Menu
          </button>
        </div>

        <div
          id="admin-menu"
          className={`${open ? "flex" : "hidden"} max-h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto border-t border-border lg:flex lg:max-h-none lg:flex-1 lg:border-t-0`}
        >
          <nav aria-label="Admin" className="px-3 py-3 lg:py-0">
            <ul className="grid gap-1">
              {ADMIN_NAV.map(({ href, label }) => {
                const Icon = ICONS[href];
                const isCurrent = href === current;
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={isCurrent ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-base ${FOCUS} ${
                        isCurrent
                          ? "bg-secondary font-semibold text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <Icon aria-hidden className={`size-[18px] shrink-0 ${isCurrent ? "text-primary" : ""}`} />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="mt-auto border-t border-border px-4 py-4 lg:px-5 lg:py-5">
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p className="mb-3 truncate text-sm font-medium text-foreground" title={email}>
              {email}
            </p>
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-input px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`}
            >
              <LogOut aria-hidden className="size-4" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            {signOutFailed && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                Sign-out didn&apos;t go through. Check your connection and try again.
              </p>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
