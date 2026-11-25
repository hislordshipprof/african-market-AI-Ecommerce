"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { isBarePath } from "@/lib/store-admin/nav";

/**
 * The layout is not rendered again on client navigation, so a page reached from sign-in or 2FA set-up would keep
 * the bare frame. One refresh per page, once a session exists, lets the layout load the shell.
 */
export function ShellRefresh() {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { data } = authClient.useSession();
  const refreshedFor = useRef<string | null>(null);
  const sessionId = data?.session.id ?? null;

  useEffect(() => {
    if (!sessionId || isBarePath(pathname) || refreshedFor.current === pathname) return;
    refreshedFor.current = pathname;
    router.refresh();
  }, [sessionId, pathname, router]);

  return null;
}
