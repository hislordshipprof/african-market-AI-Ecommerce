import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { ReportFlow } from "@/components/storefront/flow/report-flow";
import { IssueReportForm } from "@/components/storefront/flow/issue-report-form";
import { ClosedFlow, FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import { findOrderForIssueReport } from "@/lib/notifications/lookup";
import { ISSUE_WINDOW_CLOSED, issueStateMessage, issueWindowOpen } from "@/lib/order/issue-report";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, context] = await Promise.all([params, getFlowContext()]);
  const order = await findOrderForIssueReport(context.store.id, token).catch(() => null);
  if (order) {
    const issue = order.issueReports[0];
    return (
      <StorefrontShell store={context.store}>
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 1rem" }}>
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
                  name: line.listingVariant?.listing?.customName ?? line.listingVariant?.label ?? "Item",
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
