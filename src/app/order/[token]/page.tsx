import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { OrderFlow } from "@/components/storefront/flow/order-flow";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const [{ token }, query, context] = await Promise.all([
    params,
    searchParams,
    getFlowContext(),
  ]);
  return (
    <StorefrontShell store={context.store}>
      {context.enabled ? (
        <OrderFlow
          token={token}
          settings={context.settings}
          catalog={context.catalog}
          enabled={context.enabled}
          confirmation={query.placed === "1"}
        />
      ) : (
        <ClosedFlow />
      )}
    </StorefrontShell>
  );
}
