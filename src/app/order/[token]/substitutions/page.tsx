import { notFound } from "next/navigation";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { SubstitutionFlow } from "@/components/storefront/flow/substitution-flow";
import { SubstitutionPrompts } from "@/components/storefront/flow/substitution-prompts";
import { FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { substitutionPromptsForToken } from "@/lib/order/substitution";
import "@/components/storefront/flow/order-flow.css";

export default async function SubstitutionsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, context] = await Promise.all([params, getFlowContext()]);
  // The tracking token only: an order id never opens the prompt.
  const real = await substitutionPromptsForToken(context.store.id, token).catch(() => null);

  if (real) {
    return (
      <StorefrontShell store={context.store}>
        <div className="of-wrap" style={{ maxWidth: 640 }}>
          <FlowHeading
            title="Your substitutions"
            description={`Order #${real.number} · ${context.store.name}`}
            backHref={`/order/${encodeURIComponent(token)}`}
            backLabel="Back to order"
          />
          {real.prompts.length ? (
            <SubstitutionPrompts key={real.prompts.map((prompt) => prompt.status).join()} token={token} prompts={real.prompts} />
          ) : (
            <FlowCard title="Everything is looking good">
              <p>No substitutions need your attention.</p>
            </FlowCard>
          )}
        </div>
      </StorefrontShell>
    );
  }

  // Outside demo flows an unknown token, or another store's, is a plain 404.
  if (!context.enabled) notFound();
  return (
    <StorefrontShell store={context.store}>
      <SubstitutionFlow
        token={token}
        settings={context.settings}
        catalog={context.catalog}
        enabled={context.enabled}
      />
    </StorefrontShell>
  );
}
