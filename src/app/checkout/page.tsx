import { cookies, headers } from "next/headers";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CheckoutPage } from "@/components/storefront/flow/checkout-page";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { checkCheckoutReady } from "@/lib/stripe/checkout-gate";
import { auth } from "@/lib/auth";
import { loadCheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import { checkoutPaymentsUseFake } from "@/lib/stripe/checkout-payments";

export default async function CheckoutRoute() {
  const headerList = await headers();
  const [{ store, settings, catalog, enabled }, session, cookieStore] = await Promise.all([
    getFlowContext(),
    auth.api.getSession({ headers: headerList, query: { disableCookieCache: true } }),
    cookies(),
  ]);
  const gate = checkCheckoutReady(store.stripeOnboardingStatus);
  const harness = cookieStore.get("e2e_stripe_harness")?.value === "1" && checkoutPaymentsUseFake();
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const prefill = session?.user?.id ? await loadCheckoutPrefill(session.user.id) : null;
  const stripeConfig =
    gate.enabled && (publishableKey || harness)
      ? {
          publishableKey: publishableKey || "pk_test_e2e_harness",
          onBehalfOf: store.stripeAccountId ?? undefined,
          harness,
          signedIn: Boolean(session?.user?.id),
          prefill,
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
