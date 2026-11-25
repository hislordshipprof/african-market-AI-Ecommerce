"use client";

import { Suspense, use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import type { AdminHomeCounts } from "@/lib/admin/home-counts";
import { ADMIN_NAV_GROUPS, currentNavHref, type AdminNavCount } from "./admin-nav";
import { CommandPalette } from "./command-palette";
import { signOutTo } from "@/lib/sign-out";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The admin shell of design A (#859): a grouped sidebar (a drawer below 1024px) and a sticky top bar with the ⌘K
 * search. The queue counts stream in, so a slow count never holds the page.
 */
export function AdminShell({ email, counts, children }: { email: string; counts: Promise<AdminHomeCounts>; children: React.ReactNode }) {
  const current = currentNavHref(usePathname());
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  // While the drawer is open, Esc closes it from anywhere and focus returns to the menu button.
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function closeDrawer() {
    setOpen(false);
    toggle.current?.focus();
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutFailed(false);
    // A full load, so no cached admin page survives the session.
    const left = await signOutTo("/admin/sign-in", () => authClient.signOut(), (path) => window.location.assign(path));
    if (!left) {
      setSigningOut(false);
      setSignOutFailed(true);
    }
  }

  return (
    <>
      <div
        aria-hidden
        onClick={closeDrawer}
        className={`fixed inset-0 z-30 bg-black/40 lg:hidden ${open ? "" : "hidden"}`}
      />
      <aside
        id="admin-menu"
        aria-label="Admin menu"
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col overflow-y-auto overscroll-contain border-r border-border bg-card motion-safe:transition-[transform,visibility] motion-safe:duration-200 lg:visible lg:sticky lg:top-0 lg:h-dvh lg:shrink-0 lg:translate-x-0 ${
          open ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Link href="/admin" onClick={() => setOpen(false)} className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg ${FOCUS}`}>
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              AM
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-semibold text-foreground">African Markets</span>
              <span className="block truncate text-sm text-muted-foreground">Platform admin</span>
            </span>
          </Link>
          <button
            ref={close}
            type="button"
            aria-label="Close menu"
            onClick={closeDrawer}
            className={`grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden ${FOCUS}`}
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <nav aria-label="Admin" className="px-2 pb-4">
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.label ?? "home"} className={group.label ? "mt-4" : ""}>
              {group.label && <h2 className="px-2.5 pb-1 text-[13px] font-semibold text-muted-foreground">{group.label}</h2>}
              <ul>
                {group.items.map((item) => {
                  const isCurrent = item.href === current;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={isCurrent ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 lg:min-h-9 ${FOCUS} ${
                          isCurrent ? "bg-secondary font-semibold text-foreground" : "text-foreground hover:bg-muted"
                        }`}
                      >
                        <Icon aria-hidden className={`size-4 shrink-0 ${isCurrent ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="truncate">{item.label}</span>
                        {"count" in item && (
                          <Suspense fallback={null}>
                            <NavBadge counts={counts} name={item.count} />
                          </Suspense>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-border px-4 py-4">
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
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-card px-3 sm:px-5">
          <button
            ref={toggle}
            type="button"
            aria-label="Menu"
            aria-controls="admin-menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className={`grid size-11 shrink-0 place-items-center rounded-lg text-foreground hover:bg-muted lg:hidden ${FOCUS}`}
          >
            <Menu aria-hidden className="size-5" />
          </button>
          <CommandPalette />
        </header>
        <main id="admin-main" tabIndex={-1} className="min-w-0 flex-1 pb-24 focus:outline-none">
          {children}
        </main>
      </div>

    </>
  );
}

function NavBadge({ counts, name }: { counts: Promise<AdminHomeCounts>; name: AdminNavCount }) {
  const counted = use(counts)[name];
  if (!counted || counted.count === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums text-foreground">
      <span className="sr-only">, </span>
      {counted.incomplete && <span className="sr-only">at least </span>}
      {counted.count}
      {counted.incomplete && <span aria-hidden>+</span>}
      <span className="sr-only"> waiting</span>
    </span>
  );
}
