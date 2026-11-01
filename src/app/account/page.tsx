import { getFlowContext } from "@/lib/customer-flow/server";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountFlow } from "@/components/storefront/flow/account-flow";
export default async function AccountPage() {
  const { store, settings, catalog, enabled } = await getFlowContext();
  return (
    <StorefrontShell store={store}>
      <AccountFlow settings={settings} catalog={catalog} enabled={enabled} />
    </StorefrontShell>
  );
}
