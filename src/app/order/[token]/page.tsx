import Link from "next/link";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { OrderFlow } from "@/components/storefront/flow/order-flow";
import { FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { SuccessMark } from "@/components/storefront/flow/feedback";
import { getFlowContext } from "@/lib/customer-flow/server";
import { customerStatusLabel } from "@/lib/customer-account/order-history-view";
import { notFound } from "next/navigation";
import { deliveryProofTokenFor, findOrderForTracking } from "@/lib/notifications/lookup";
import { OrderMessages } from "@/components/storefront/flow/order-messages";
import { readCustomerMessages } from "@/lib/support/thread";
import { issueStateMessage, issueWindowOpen } from "@/lib/order/issue-report";

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

  // No catch: a database error goes to error.tsx, so a customer never reads it as "order not found".
  const realOrder = await findOrderForTracking(context.store.id, token);

  if (realOrder) {
    const proofToken = deliveryProofTokenFor(realOrder, token);
    // Only the tracking token opens the thread: an order id opens the page but never the messages.
    const messages = realOrder.trackingToken === token
      ? await readCustomerMessages(context.store.id, token).catch(() => null)
      : null;
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
          {realOrder.status === "SUBSTITUTION_PENDING" && realOrder.trackingToken === token && (
            <FlowCard title="An item is short">
              <p>The store couldn&rsquo;t find everything you ordered. Choose a swap or a refund.</p>
              <Link className="sf-button" href={`/order/${encodeURIComponent(token)}/substitutions`}>Choose now</Link>
            </FlowCard>
          )}
          <FlowCard title="Order details">
            <p><strong>Status:</strong> {customerStatusLabel(realOrder.status)}</p>
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
          {proofToken && (
            <FlowCard title="Delivery photo">
              {/* Private route, not the image optimizer: the photo must never be cached publicly. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/delivery-proof/${encodeURIComponent(proofToken)}`}
                alt={`Photo of order #${realOrder.number} where it was delivered`}
                style={{ width: "100%", height: "auto", borderRadius: 8 }}
              />
            </FlowCard>
          )}
          {messages && (
            <OrderMessages token={token} storeName={context.store.name} timeZone={context.store.timezone} initialMessages={messages} />
          )}
          {realOrder.issueReports[0] ? (
            <FlowCard title="Your problem report">
              <p>{issueStateMessage(realOrder.issueReports[0])}</p>
            </FlowCard>
          ) : realOrder.trackingToken === token && issueWindowOpen(realOrder) ? (
            <FlowCard title="Something wrong with your order?">
              <p>Tell us within 48 hours of your order and we&rsquo;ll make it right.</p>
              <Link className="sf-button" href={`/order/${encodeURIComponent(token)}/report`}>Report a problem</Link>
            </FlowCard>
          ) : null}
          <div style={{ marginTop: "1rem", textAlign: "center" }}>
            <Link className="sf-button" href="/">Continue shopping</Link>
          </div>
        </div>
      </StorefrontShell>
    );
  }

  // Outside demo flows an unknown token, or another store's, is a plain 404.
  if (!context.enabled) notFound();

  return (
    <StorefrontShell store={context.store}>
      <OrderFlow
        token={token}
        settings={context.settings}
        catalog={context.catalog}
        enabled={context.enabled}
        confirmation={query.placed === "1"}
      />
    </StorefrontShell>
  );
}
