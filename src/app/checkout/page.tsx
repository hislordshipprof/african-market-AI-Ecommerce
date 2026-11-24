import { cookies, headers } from "next/headers";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CheckoutPage } from "@/components/storefront/flow/checkout-page";
import { CheckoutUnavailable, ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { checkCheckoutReady, checkoutHarnessOn, checkoutTakesPayment } from "@/lib/stripe/checkout-gate";
import { auth } from "@/lib/auth";
import { loadCheckoutPrefill } from "@/lib/customer-account/checkout-profile";
import { LIVE_MODE_BLOCKED_MESSAGE, liveModeCheck } from "@/lib/checkout/live-mode";
import { STORE_NOT_TAKING_ORDERS } from "@/lib/customer-flow/contracts";
import { slotOptions } from "@/lib/checkout/slots";
import { platform, storeHasWhatsAppNumber, storeScoped } from "@/lib/db";
import { getCartIdFromCookie } from "@/lib/cart/cookies";

export default async function CheckoutRoute() {
  // Before the prefill (which calls Stripe for saved cards) and before any key reaches the browser.
  const liveMode = liveModeCheck();
  const headerList = await headers();
  const [{ store, settings, catalog, enabled }, session, cookieStore] = await Promise.all([
    getFlowContext(),
    auth.api.getSession({ headers: headerList, query: { disableCookieCache: true } }),
    cookies(),
  ]);
  // A store in setup or suspended shows why before the prefill reaches Stripe (#555).
  const unavailable = !liveMode.ok
    ? LIVE_MODE_BLOCKED_MESSAGE
    : store.status !== "active"
      ? checkCheckoutReady(store).message
      : !settings.takingOrders
        ? STORE_NOT_TAKING_ORDERS
        : null;
  const harness = checkoutHarnessOn(cookieStore);
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const prefill = !unavailable && session?.user?.id ? await loadCheckoutPrefill(session.user.id, store.id) : null;
  const takesPayment = !unavailable && checkoutTakesPayment(store, publishableKey, harness);
  const [slotStore, whatsappUpdates] = takesPayment
    ? await Promise.all([platform.store.findUnique({ where: { id: store.id } }), storeHasWhatsAppNumber(store.id)])
    : [null, false];
  const pickupSlots = slotStore
    ? await slotOptions(storeScoped(store.id), store.id, slotStore, "pickup", new Date(), await getCartIdFromCookie())
    : undefined;
  const stripeConfig =
    takesPayment
      ? {
          publishableKey: publishableKey || "pk_test_e2e_harness",
          onBehalfOf: store.stripeAccountId ?? undefined,
          harness,
          signedIn: Boolean(session?.user?.id),
          prefill,
          pickupSlots,
          whatsappUpdates,
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
