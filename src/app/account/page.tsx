import { redirect } from "next/navigation";
import { getFlowContext } from "@/lib/customer-flow/server";
import { syncCustomerForRequest } from "@/lib/customer-sync";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountFlow } from "@/components/storefront/flow/account-flow";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const [{ store, settings, catalog, enabled }, customer] = await Promise.all([
    getFlowContext(),
    syncCustomerForRequest(),
  ]);
  if (!customer && (params.error || !enabled)) {
    const query = params.error ? `?error=${encodeURIComponent(params.error)}` : "";
    redirect(`/account/sign-in${query}`);
  }
  return (
    <StorefrontShell store={store}>
      <AccountFlow
        settings={settings}
        catalog={catalog}
        enabled={enabled}
        customer={customer}
      />
    </StorefrontShell>
  );
}
