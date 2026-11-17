import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/get-store";
import { platformAdmin } from "@/lib/db";
import { requireStoreOwner } from "@/lib/store-admin/session";
import { updateStoreOnboardingStatus } from "@/lib/stripe/update-store-status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await getStore();
  } catch {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }

  // A 2FA-verified owner only; anyone else is redirected (sign-in, or store admin for staff).
  const { store } = await requireStoreOwner();

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
