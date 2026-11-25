import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/get-store";
import { platformAdmin } from "@/lib/db";
import { hasVerifiedTwoFactor, requireStoreOwner } from "@/lib/store-admin/session";
import { storeTwoFactorPath } from "@/lib/store-admin/sign-in-path";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await getStore();
  } catch {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }

  // An owner only; anyone else is redirected (sign-in, or store admin for staff).
  const storeSession = await requireStoreOwner();
  const { store } = storeSession;
  // Stripe Connect settings need 2FA on and verified this session (#840).
  if (!hasVerifiedTwoFactor(storeSession)) {
    const payouts = `/store-admin/payouts?store=${encodeURIComponent(store.slug)}`;
    return NextResponse.redirect(new URL(storeTwoFactorPath(store.slug, payouts), req.nextUrl.origin));
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
