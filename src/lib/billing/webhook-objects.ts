import type { WebhookInvoice, WebhookSubscription } from "../stripe/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
function idOf(value: any): string | undefined {
  if (typeof value === "string") return value;
  return typeof value?.id === "string" ? value.id : undefined;
}

/** The billing parts of a Stripe event object, shared by the real and the fake provider. */
export function billingObjects(obj: any): { subscription?: WebhookSubscription; invoice?: WebhookInvoice } {
  if (obj?.object === "subscription" && typeof obj.id === "string") {
    const item = obj.items?.data?.[0];
    const periodEnd = item?.current_period_end ?? obj.current_period_end;
    return {
      subscription: {
        id: obj.id,
        customerId: idOf(obj.customer) ?? "",
        status: String(obj.status ?? ""),
        lookupKey: typeof item?.price?.lookup_key === "string" ? item.price.lookup_key : null,
        storeId: typeof obj.metadata?.platform_store_id === "string" ? obj.metadata.platform_store_id : null,
        trialEnd: typeof obj.trial_end === "number" ? obj.trial_end : null,
        currentPeriodEnd: typeof periodEnd === "number" ? periodEnd : null,
        cancelAtPeriodEnd: obj.cancel_at_period_end === true,
      },
    };
  }
  if (obj?.object === "invoice" && typeof obj.id === "string") {
    const subscriptionId =
      idOf(obj.parent?.subscription_details?.subscription) ?? idOf(obj.subscription) ?? null;
    return {
      invoice: {
        id: obj.id,
        customerId: idOf(obj.customer) ?? "",
        subscriptionId,
        storeId:
          typeof obj.parent?.subscription_details?.metadata?.platform_store_id === "string"
            ? obj.parent.subscription_details.metadata.platform_store_id
            : null,
      },
    };
  }
  return {};
}
/* eslint-enable @typescript-eslint/no-explicit-any */
