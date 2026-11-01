import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CheckoutPage } from "@/components/storefront/flow/checkout-page";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";

export default async function CheckoutRoute() {
  const { store, settings, catalog, enabled } = await getFlowContext();
  return (
    <StorefrontShell store={store}>
      {enabled ? (
        <CheckoutPage settings={settings} catalog={catalog} enabled={enabled} />
      ) : (
        <ClosedFlow />
      )}
    </StorefrontShell>
  );
}
