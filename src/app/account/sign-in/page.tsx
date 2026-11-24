import { CustomerSignIn } from "@/components/storefront/customer-sign-in";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStore } from "@/lib/get-store";
import { EMAIL_SIGN_IN_UNAVAILABLE, emailSignInAvailable } from "@/lib/email/send";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [store, params] = await Promise.all([getStore(), searchParams]);
  return (
    <StorefrontShell store={store}>
      <CustomerSignIn
        storeName={store.name}
        linkError={params.error ?? null}
        unavailable={emailSignInAvailable() ? null : EMAIL_SIGN_IN_UNAVAILABLE}
      />
    </StorefrontShell>
  );
}
