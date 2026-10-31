import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getStore, revalidateStore } from "@/lib/get-store";
import { storeScoped, platformAdmin } from "@/lib/db";
import { getStripeProvider } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.user.twoFactorEnabled || !session.session.twoFactorVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let store;
  try {
    store = await getStore();
  } catch {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const scoped = storeScoped(store.id);
  const membership = await scoped.storeMembership.findUnique({
    where: {
      storeId_userId: { storeId: store.id, userId: session.user.id },
    },
  });

  if (!membership || membership.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const stripe = getStripeProvider();
  let stripeAccountId = store.stripeAccountId;

  if (!stripeAccountId) {
    const fresh = await platformAdmin.store.findUnique({
      where: { id: store.id },
      select: { stripeAccountId: true },
    });
    stripeAccountId = fresh?.stripeAccountId ?? null;
  }

  if (!stripeAccountId) {
    const account = await stripe.createConnectAccount({
      email: session.user.email,
      businessName: store.name,
      storeId: store.id,
    });
    stripeAccountId = account.accountId;

    try {
      await platformAdmin.store.update({
        where: { id: store.id },
        data: {
          stripeAccountId: account.accountId,
          stripeOnboardingStatus: "pending",
        },
      });
    } catch (err: unknown) {
      const isUniqueViolation =
        err instanceof Error && err.message.includes("Unique constraint");
      if (!isUniqueViolation) throw err;
      const existing = await platformAdmin.store.findUnique({
        where: { id: store.id },
        select: { stripeAccountId: true },
      });
      stripeAccountId = existing?.stripeAccountId ?? stripeAccountId;
    }
    revalidateStore({ id: store.id, slug: store.slug });
  }

  const origin = req.nextUrl.origin;
  const storeParam = store.slug;
  const link = await stripe.createAccountLink({
    accountId: stripeAccountId,
    returnUrl: `${origin}/api/stripe/return?store=${storeParam}`,
    refreshUrl: `${origin}/store-admin/payouts?store=${storeParam}`,
  });

  return NextResponse.json({ url: link.url });
}
