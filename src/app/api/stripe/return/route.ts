import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getStore, revalidateStore } from "@/lib/get-store";
import { storeScoped, platformAdmin } from "@/lib/db";
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

  const scoped = storeScoped(store.id);
  const membership = await scoped.storeMembership.findUnique({
    where: {
      storeId_userId: { storeId: store.id, userId: session.user.id },
    },
  });

  if (!membership || membership.role !== "owner") {
    return NextResponse.redirect(
      new URL(`/store-admin?store=${store.slug}`, req.nextUrl.origin),
    );
  }

  const fresh = await platformAdmin.store.findUnique({
    where: { id: store.id },
    select: { stripeAccountId: true },
  });
  const stripeAccountId = fresh?.stripeAccountId ?? null;

  if (stripeAccountId) {
    const stripe = getStripeProvider();
    const account = await stripe.getAccount(stripeAccountId);
    const status = deriveOnboardingStatus(account);

    await platformAdmin.store.update({
      where: { id: store.id },
      data: { stripeOnboardingStatus: status },
    });
    revalidateStore({ id: store.id, slug: store.slug });
  }

  return NextResponse.redirect(
    new URL(`/store-admin?store=${store.slug}`, req.nextUrl.origin),
  );
}
