import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { SubstitutionFlow } from "@/components/storefront/flow/substitution-flow";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
export default async function SubstitutionsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, context] = await Promise.all([params, getFlowContext()]);
  return (
    <StorefrontShell store={context.store}>
      {context.enabled ? (
        <SubstitutionFlow
          token={token}
          settings={context.settings}
          catalog={context.catalog}
          enabled={context.enabled}
        />
      ) : (
        <ClosedFlow />
      )}
    </StorefrontShell>
  );
}
