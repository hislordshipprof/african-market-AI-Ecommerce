import { Suspense } from "react";
import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { EMAIL_SIGN_IN_UNAVAILABLE, emailSignInAvailable } from "@/lib/email/send";
import { ResetPasswordForm } from "./reset-password-form";

// Whether a reset link can be sent is read per request, never baked in at build (#765).
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  const store = await findStoreForHeaders(await headers());
  return (
    <Suspense>
      <ResetPasswordForm
        unavailable={emailSignInAvailable() ? null : EMAIL_SIGN_IN_UNAVAILABLE}
        storeSlug={store?.slug ?? null}
      />
    </Suspense>
  );
}
