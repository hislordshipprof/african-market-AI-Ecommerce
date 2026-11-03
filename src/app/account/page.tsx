import { getFlowContext } from "@/lib/customer-flow/server";
import { syncCustomerForRequest } from "@/lib/customer-sync";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountFlow } from "@/components/storefront/flow/account-flow";
export default async function AccountPage() {
  const [{ store, settings, catalog, enabled }, customer] = await Promise.all([
    getFlowContext(),
    syncCustomerForRequest(),
  ]);
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
