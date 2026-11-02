import Link from "next/link";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { OrderFlow } from "@/components/storefront/flow/order-flow";
import { ClosedFlow, FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { SuccessMark } from "@/components/storefront/flow/feedback";
import { getFlowContext } from "@/lib/customer-flow/server";
import { storeScoped } from "@/lib/db";

async function getRealOrder(storeId: string, orderId: string) {
  return storeScoped(storeId).order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      lines: {
        include: {
          listingVariant: { include: { listing: true } },
        },
      },
    },
  });
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

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

  const realOrder = await getRealOrder(context.store.id, token).catch(
    () => null,
  );

  if (realOrder) {
    return (
      <StorefrontShell store={context.store}>
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 1rem" }}>
          <FlowHeading
            title={query.placed === "1" ? "You're all set." : `Order #${realOrder.number}`}
            description={`Order #${realOrder.number} · ${context.store.name}`}
            backHref="/"
            backLabel="Keep shopping"
          />
          {query.placed === "1" && (
            <FlowCard>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem", padding: "1rem 0" }}>
                <SuccessMark />
                <h2>Order placed</h2>
              </div>
              <p>
                Your card has been authorized for {money(realOrder.totalAuthorizedCents)}.
                You&rsquo;ll be charged the final amount after picking; unused buffer is
                released.
              </p>
            </FlowCard>
          )}
          <FlowCard title="Order details">
            <p><strong>Status:</strong> {realOrder.status}</p>
            <p><strong>Fulfillment:</strong> {realOrder.fulfillment}</p>
            {realOrder.customer && (
              <p><strong>Customer:</strong> {realOrder.customer.name}</p>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
              {realOrder.lines.map((line) => (
                <li key={line.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.25rem 0" }}>
                  <span>{line.qtyOrdered} × {line.listingVariant?.listing?.customName ?? line.listingVariant?.label ?? "Item"}</span>
                  <span>{money(line.unitPriceCents * line.qtyOrdered)}</span>
                </li>
              ))}
            </ul>
            <p><strong>Subtotal:</strong> {money(realOrder.subtotalCents)}</p>
            <p><strong>Authorization hold:</strong> {money(realOrder.totalAuthorizedCents)}</p>
          </FlowCard>
          <div style={{ marginTop: "1rem", textAlign: "center" }}>
            <Link className="sf-button" href="/">Continue shopping</Link>
          </div>
        </div>
      </StorefrontShell>
    );
  }

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
