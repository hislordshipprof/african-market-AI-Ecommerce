import { CustomerSignIn } from "@/components/storefront/customer-sign-in";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStore } from "@/lib/get-store";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [store, params] = await Promise.all([getStore(), searchParams]);
  return (
    <StorefrontShell store={store}>
      <CustomerSignIn storeName={store.name} linkError={params.error ?? null} />
    </StorefrontShell>
  );
}
