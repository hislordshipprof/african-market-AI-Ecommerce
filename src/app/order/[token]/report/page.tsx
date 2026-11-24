import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ReportFlow } from "@/components/storefront/flow/report-flow";
import { IssueReportForm } from "@/components/storefront/flow/issue-report-form";
import { ClosedFlow, FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { findOrderForIssueReport, redirectToOrderStore } from "@/lib/notifications/lookup";
import { ISSUE_WINDOW_CLOSED, issueStateMessage, issueWindowOpen } from "@/lib/order/issue-report";
import { shownPack } from "@/lib/storefront/pack-order";
import "@/components/storefront/flow/order-flow.css";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await redirectToOrderStore(token, "/report");
  const context = await getFlowContext();
  // No catch: a database error goes to error.tsx, so a customer never reads it as "checkout opens soon".
  const order = await findOrderForIssueReport(context.store.id, token);
  if (order) {
    const issue = order.issueReports[0];
    return (
      <StorefrontShell store={context.store}>
        <div className="of-wrap" style={{ maxWidth: 640 }}>
          <FlowHeading
            title="Let's make it right"
            description={`Order #${order.number} · ${context.store.name}`}
            backHref={`/order/${token}`}
            backLabel="Back to order"
          />
          {issue ? (
            <FlowCard title="Your report">
              <p role="status">{issueStateMessage(issue)}</p>
            </FlowCard>
          ) : !issueWindowOpen(order) ? (
            <FlowCard title="Reporting is closed">
              <p>{ISSUE_WINDOW_CLOSED}</p>
            </FlowCard>
          ) : (
            <IssueReportForm
              token={token}
              lines={order.lines
                .filter((line) => line.qtyPicked > 0)
                .map((line) => ({
                  id: line.id,
                  // Product, then pack: a pack size alone ("8 oz") does not say which item (#743).
                  name: [line.listingVariant?.listing?.customName ?? line.listingVariant?.listing?.masterProduct?.name, line.listingVariant && shownPack(line.listingVariant).label]
                    .filter(Boolean)
                    .join(" · ") || "Item",
                  qtyPicked: line.qtyPicked,
                  unitPriceCents: line.unitPriceCents,
                }))}
            />
          )}
        </div>
      </StorefrontShell>
    );
  }
  return (
    <StorefrontShell store={context.store}>
      {context.enabled ? (
        <ReportFlow
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
