import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { FEATURE_LABELS } from "@/lib/billing/plan";
import { storeScoped } from "@/lib/db";
import { findStoreForHeaders } from "@/lib/get-store";
import { StoreAssistantGate } from "./store-assistant-gate";

/**
 * The store assistant's button, for a signed-in owner of this store only (#855). It never redirects:
 * the layout also wraps sign-in, 2FA set-up and the platform host.
 */
export async function StoreAssistantHost() {
  const headerList = await headers();
  const [store, session] = await Promise.all([findStoreForHeaders(headerList), auth.api.getSession({ headers: headerList })]);
  if (!store) return null;
  const verified = session && !(session.user.twoFactorEnabled && !session.session.twoFactorVerified);
  const membership = verified
    ? await storeScoped(store.id).storeMembership.findUnique({
      where: { storeId_userId: { storeId: store.id, userId: session.user.id } },
      select: { role: true },
    })
    : null;
  return (
    <Suspense fallback={null}>
      <StoreAssistantGate owner={membership?.role === "owner"} checked={Boolean(verified)} storeId={store.id} lockedTitle={FEATURE_LABELS["store-assistant"]} />
    </Suspense>
  );
}
