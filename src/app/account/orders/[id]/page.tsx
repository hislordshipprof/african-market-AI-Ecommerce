import { getFlowContext } from "@/lib/customer-flow/server";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountOrderDetail } from "@/components/storefront/flow/account-flow";
export default async function OrderPage({
  params,
}: {
  params: Promise<{
    id: string;
  }>;
}) {
  const { id } = await params;
  const { store, settings, catalog, enabled } = await getFlowContext();
  return (
    <StorefrontShell store={store}>
      <AccountOrderDetail
        id={id}
        settings={settings}
        catalog={catalog}
        enabled={enabled}
      />
    </StorefrontShell>
  );
}
