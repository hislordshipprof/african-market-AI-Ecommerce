import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { storeScoped } from "@/lib/db";
import { findStoreForHeaders } from "@/lib/get-store";
import { StoreAssistantDock } from "./copilot/store-assistant-dock";

/**
 * The store assistant's button, for a signed-in owner of this store only (#855). It never redirects:
 * the layout also wraps sign-in, 2FA set-up and the platform host.
 */
export async function StoreAssistantHost() {
  const headerList = await headers();
  const [store, session] = await Promise.all([findStoreForHeaders(headerList), auth.api.getSession({ headers: headerList })]);
  if (!store || !session) return null;
  if (session.user.twoFactorEnabled && !session.session.twoFactorVerified) return null;
  const membership = await storeScoped(store.id).storeMembership.findUnique({
    where: { storeId_userId: { storeId: store.id, userId: session.user.id } },
    select: { role: true },
  });
  if (membership?.role !== "owner") return null;
  return (
    <Suspense fallback={null}>
      <StoreAssistantDock storeId={store.id} />
    </Suspense>
  );
}
