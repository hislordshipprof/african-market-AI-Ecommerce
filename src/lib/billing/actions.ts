"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { resolveAuthBaseUrl } from "../auth";
import { requireStoreOwner } from "../store-admin/session";
import { parseInput, readFormFields } from "../security/parse-input";
import { openBillingPortal, startSubscription } from "./service";

function planReturnUrl(slug: string): string {
  return `${resolveAuthBaseUrl()}/store-admin/plan?store=${encodeURIComponent(slug)}`;
}

/** Owner picks Starter or Pro: Stripe Checkout for a new subscription, the Customer Portal once subscribed. */
export async function choosePlanAction(formData: FormData): Promise<void> {
  const session = await requireStoreOwner();
  const fields = parseInput(z.strictObject({ plan: z.enum(["starter", "pro"]) }), readFormFields(formData, ["plan"]));
  if (!fields.ok) redirect(`/store-admin/plan?store=${encodeURIComponent(session.store.slug)}`);
  const { url } = await startSubscription({
    storeId: session.store.id,
    storeName: session.store.name,
    plan: fields.data.plan,
    owner: { id: session.user.id, email: session.user.email },
    returnUrl: planReturnUrl(session.store.slug),
  });
  redirect(url);
}

/** Change plan, card, or cancel in Stripe's Customer Portal. */
export async function manageBillingAction(): Promise<void> {
  const session = await requireStoreOwner();
  const portal = await openBillingPortal(session.store.id, planReturnUrl(session.store.slug));
  redirect(portal?.url ?? `/store-admin/plan?store=${encodeURIComponent(session.store.slug)}`);
}
