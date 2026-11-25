"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { isBarePath } from "@/lib/store-admin/nav";

/**
 * The layout is not rendered again on client navigation, so a page reached from sign-in or 2FA set-up would keep
 * the bare frame, or the shell of whoever was signed in before. One refresh per page, while the session's user is
 * not the one the shell was loaded for, lets the layout load the right shell.
 */
export function ShellRefresh({ shellUserId }: { shellUserId: string | null }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { data } = authClient.useSession();
  const refreshedFor = useRef<string | null>(null);
  const sessionUserId = data?.user.id ?? null;

  useEffect(() => {
    // Once per page and member: the next member to sign in on this tab may land on the same page.
    const key = `${sessionUserId} ${pathname}`;
    if (!sessionUserId || sessionUserId === shellUserId || isBarePath(pathname) || refreshedFor.current === key) return;
    refreshedFor.current = key;
    router.refresh();
  }, [sessionUserId, shellUserId, pathname, router]);

  return null;
}
