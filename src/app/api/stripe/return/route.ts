import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getStore } from "@/lib/get-store";
import { platformAdmin } from "@/lib/db";
import { getStripeProvider, deriveOnboardingStatus } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  if (!session) {
    const storeSlug = req.nextUrl.searchParams.get("store") ?? "";
    return NextResponse.redirect(
      new URL(`/store-admin/sign-in?store=${storeSlug}`, req.nextUrl.origin),
    );
  }

  let store;
  try {
    store = await getStore();
  } catch {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }

  if (store.stripeAccountId) {
    const stripe = getStripeProvider();
    const account = await stripe.getAccount(store.stripeAccountId);
    const status = deriveOnboardingStatus(account);

    await platformAdmin.store.update({
      where: { id: store.id },
      data: { stripeOnboardingStatus: status },
    });
  }

  const storeParam = store.slug;
  return NextResponse.redirect(
    new URL(`/store-admin?store=${storeParam}`, req.nextUrl.origin),
  );
}
