import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getStore } from "@/lib/get-store";
import { storeScoped, platformAdmin } from "@/lib/db";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";

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
    await updateStoreOnboardingStatus(stripeAccountId);
  }

  return NextResponse.redirect(
    new URL(`/store-admin?store=${store.slug}`, req.nextUrl.origin),
  );
}
