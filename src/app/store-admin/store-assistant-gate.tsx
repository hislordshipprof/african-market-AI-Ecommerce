"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { StoreAssistantDock } from "./copilot/store-assistant-dock";

const SETUP_PATHS = ["/store-admin/sign-in", "/store-admin/two-factor"];

/**
 * The layout checks the owner on the server, but sign-in moves on without reloading the layout. When a session
 * appears that the layout has not seen, one refresh lets it check again; after sign-out the button goes.
 */
export function StoreAssistantGate({
  owner,
  checked,
  storeId,
  lockedTitle,
}: {
  owner: boolean;
  /** The layout saw a signed-in, verified session, so its answer stands until the next reload. */
  checked: boolean;
  storeId: string;
  lockedTitle: string;
}) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { data, isPending } = authClient.useSession();
  const refreshedFor = useRef<string | null>(null);
  const sessionId = data?.session.id ?? null;
  const onSetup = SETUP_PATHS.some((path) => pathname.startsWith(path));

  useEffect(() => {
    if (checked || !sessionId || onSetup || refreshedFor.current === sessionId) return;
    refreshedFor.current = sessionId;
    router.refresh();
  }, [checked, sessionId, onSetup, router]);

  if (!owner || (!isPending && !data)) return null;
  return <StoreAssistantDock storeId={storeId} lockedTitle={lockedTitle} />;
}
