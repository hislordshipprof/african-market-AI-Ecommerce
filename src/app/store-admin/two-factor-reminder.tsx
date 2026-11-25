"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldAlert, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useHydrated } from "@/app/admin/auth-form-parts";

const HIDDEN_KEY = "store-admin-2fa-reminder-hidden";

/** Where the banner's link leads: setup, then back to this page. On the store alias the store comes from a cookie. */
function setupHref(): string {
  const params = new URLSearchParams();
  const store = new URLSearchParams(window.location.search).get("store");
  if (store) params.set("store", store);
  params.set("next", window.location.pathname + window.location.search);
  return `/store-admin/two-factor?${params}`;
}

/**
 * The 2FA reminder on every store-admin page until 2FA is on (#840). Hiding it lasts for this visit only
 * (the browser tab's session storage). A reminder, not a gate: the actions check 2FA on the server.
 */
export function TwoFactorReminder() {
  const pathname = usePathname();
  const { data } = authClient.useSession();
  // Session storage and the URL exist only in the browser, so nothing renders before hydration.
  const hydrated = useHydrated();
  const [hiddenNow, setHiddenNow] = useState(false);

  const onSetupPage = pathname.startsWith("/store-admin/sign-in") || pathname.startsWith("/store-admin/two-factor");
  if (!hydrated || !data || data.user.twoFactorEnabled || onSetupPage) return null;
  if (hiddenNow || sessionStorage.getItem(HIDDEN_KEY) === "1") return null;
  const href = setupHref();

  function hide() {
    sessionStorage.setItem(HIDDEN_KEY, "1");
    setHiddenNow(true);
  }

  return (
    <aside
      aria-label="Two-factor reminder"
      className="flex items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-1 text-sm text-foreground"
    >
      <ShieldAlert className="size-5 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1">
        Two-factor sign-in is off. You need it for refunds, payouts and team changes.{" "}
        <Link href={href} className="inline-flex min-h-11 items-center font-semibold whitespace-nowrap text-primary underline underline-offset-4">
          Set up 2FA
        </Link>
      </p>
      <button
        type="button"
        onClick={hide}
        aria-label="Hide the reminder for this visit"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <X className="size-4" aria-hidden />
      </button>
    </aside>
  );
}
