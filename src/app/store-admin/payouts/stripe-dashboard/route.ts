import { hasVerifiedTwoFactor, requireStoreOwner } from "@/lib/store-admin/session";
import { storeTwoFactorPath } from "@/lib/store-admin/sign-in-path";
import { requireSameOrigin } from "@/lib/security/same-origin";
import { getStripeProvider } from "@/lib/stripe";
import { logProviderError } from "@/lib/payouts/service";

/** Opens the store's Stripe Express Dashboard. The login link is made per click and never kept (#548). */
export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const storeSession = await requireStoreOwner();
  const { store } = storeSession;
  const back = `/store-admin/payouts?store=${encodeURIComponent(store.slug)}`;
  const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  // Bank and payout details are edited in this dashboard, so it needs 2FA (#840).
  if (!hasVerifiedTwoFactor(storeSession)) return redirect(storeTwoFactorPath(store.slug, back));
  if (!store.stripeAccountId) return redirect(back);
  try {
    const link = await getStripeProvider().createLoginLink(store.stripeAccountId);
    return redirect(link.url);
  } catch (err) {
    logProviderError("login_link", store.id, err);
    return redirect(`${back}&dashboard=failed`);
  }
}
