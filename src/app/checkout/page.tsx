import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CheckoutPage } from "@/components/storefront/flow/checkout-page";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { checkCheckoutReady } from "@/lib/stripe/checkout-gate";

export default async function CheckoutRoute() {
  const { store, settings, catalog, enabled } = await getFlowContext();
  const gate = checkCheckoutReady(store.stripeOnboardingStatus);
  const stripeConfig = gate.enabled
    ? {
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
        accountId: store.stripeAccountId ?? "",
      }
    : undefined;

  return (
    <StorefrontShell store={store}>
      {enabled || stripeConfig ? (
        <CheckoutPage
          settings={settings}
          catalog={catalog}
          enabled={enabled}
          stripeConfig={stripeConfig}
        />
      ) : (
        <ClosedFlow />
      )}
    </StorefrontShell>
  );
}
