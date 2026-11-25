import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EnrollTwoFactorForm } from "@/app/admin/enroll-2fa/enroll-form";
import { hasVerifiedTwoFactor, requireStoreMember } from "@/lib/store-admin/session";
import { storeAdminReturnPath } from "@/lib/store-admin/sign-in-path";

export const metadata: Metadata = {
  title: "Set up two-factor — Store Admin",
  robots: { index: false, follow: false },
};

/** Optional 2FA for store members (#840): Set up now, or Remind me later back to `next`. */
export default async function StoreTwoFactor({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const [storeSession, { next }] = await Promise.all([requireStoreMember(), searchParams]);
  const back = storeAdminReturnPath(typeof next === "string" ? next : null, storeSession.store.slug);
  if (hasVerifiedTwoFactor(storeSession)) redirect(back);
  return (
    <EnrollTwoFactorForm
      intro="Two-factor sign-in asks for a code from an app on your phone. You need it for refunds, payouts and team changes. Confirm your password to start."
      doneHref={back}
      laterHref={back}
    />
  );
}
