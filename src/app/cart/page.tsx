import { cookies } from "next/headers";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CartPage } from "@/components/storefront/flow/cart-page";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { checkoutTakesPayment } from "@/lib/stripe/checkout-gate";
import { checkoutPaymentsUseFake } from "@/lib/stripe/checkout-payments";

export default async function CartRoute() {
  const [{ store, settings, catalog, enabled }, cookieStore] = await Promise.all([
    getFlowContext(),
    cookies(),
  ]);
  const harness = cookieStore.get("e2e_stripe_harness")?.value === "1" && checkoutPaymentsUseFake();
  const realCheckout = checkoutTakesPayment(
    store.stripeOnboardingStatus,
    process.env.STRIPE_PUBLISHABLE_KEY,
    harness,
  );
  return (
    <StorefrontShell store={store}>
      {enabled ? (
        <CartPage
          settings={settings}
          catalog={catalog}
          enabled={enabled}
          realCheckout={realCheckout}
        />
      ) : (
        <ClosedFlow />
      )}
    </StorefrontShell>
  );
}
