import { cookies, headers } from "next/headers";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CheckoutPage } from "@/components/storefront/flow/checkout-page";
import { CheckoutUnavailable, ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { checkCheckoutReady } from "@/lib/stripe/checkout-gate";
import { auth } from "@/lib/auth";
import { loadCheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import { checkoutPaymentsUseFake } from "@/lib/stripe/checkout-payments";
import { LIVE_MODE_BLOCKED_MESSAGE, liveModeCheck } from "@/lib/checkout/live-mode";
import { STORE_NOT_TAKING_ORDERS } from "@/lib/customer-flow/contracts";

export default async function CheckoutRoute() {
  // Before the prefill (which calls Stripe for saved cards) and before any key reaches the browser.
  const liveMode = liveModeCheck();
  const headerList = await headers();
  const [{ store, settings, catalog, enabled }, session, cookieStore] = await Promise.all([
    getFlowContext(),
    auth.api.getSession({ headers: headerList, query: { disableCookieCache: true } }),
    cookies(),
  ]);
  const unavailable = !liveMode.ok
    ? LIVE_MODE_BLOCKED_MESSAGE
    : !settings.takingOrders
      ? STORE_NOT_TAKING_ORDERS
      : null;
  const gate = checkCheckoutReady(store.stripeOnboardingStatus);
  const harness = cookieStore.get("e2e_stripe_harness")?.value === "1" && checkoutPaymentsUseFake();
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const prefill = !unavailable && session?.user?.id ? await loadCheckoutPrefill(session.user.id) : null;
  const stripeConfig =
    !unavailable && gate.enabled && (publishableKey || harness)
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
      {unavailable ? (
        <CheckoutUnavailable message={unavailable} />
      ) : enabled || stripeConfig ? (
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
