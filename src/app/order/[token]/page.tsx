import Link from "next/link";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { OrderFlow } from "@/components/storefront/flow/order-flow";
import { FeeLine, FlowCard, FlowHeading } from "@/components/storefront/flow/common";
import { orderReceipt } from "@/lib/order/receipt";
import { SuccessMark } from "@/components/storefront/flow/feedback";
import { getFlowContext } from "@/lib/customer-flow/server";
import { orderOutcomeMessage } from "@/lib/customer-account/order-history-view";
import { orderStatusLabel } from "@/lib/order/status-labels";
import { notFound } from "next/navigation";
import { deliveryProofTokenFor, findOrderForTracking } from "@/lib/notifications/lookup";
import { OrderMessages } from "@/components/storefront/flow/order-messages";
import { readCustomerMessages } from "@/lib/support/thread";
import { issueStateMessage, issueWindowOpen } from "@/lib/order/issue-report";
import { courierBrand } from "@/lib/delivery/dispatch";
import type { DeliveryProviderName } from "@/lib/delivery/provider";
import { FULFILLMENT_LABELS } from "@/lib/analytics/csv";
import { OrderUpdates } from "@/components/pwa/order-updates";
import { vapidPublicKey } from "@/lib/push/sender";
import { scheduledTimeLabel } from "@/lib/order/pickup-slots";
import { deliveryDestination } from "@/lib/order/delivery-address";
import { formatClockInZone, money } from "@/lib/format";
import { shownPack } from "@/lib/storefront/pack-order";
import styles from "./tracking.module.css";

type CourierJson = { name?: string | null; vehicle?: string | null; dropoffEta?: string | null } | null;

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
    const courier = realOrder.fulfillment === "courier" ? realOrder.deliveries[0] : undefined;
    const courierInfo = courier?.courierJson as CourierJson | undefined;
    const eta = courierInfo?.dropoffEta
      ? formatClockInZone(courierInfo.dropoffEta, context.store.timezone)
      : null;
    const scheduled = scheduledTimeLabel(realOrder.pickupSlot, context.store.timezone);
    // Only the tracking token opens the thread: an order id opens the page but never the messages.
    const messages = realOrder.trackingToken === token
      ? await readCustomerMessages(context.store.id, token).catch(() => null)
      : null;
    const owner = realOrder.trackingToken === token;
    const statusLabel = orderStatusLabel(realOrder.status, realOrder.fulfillment);
    const refundedCents = realOrder.refundRequests
      .filter((request) => request.providerStatus === "succeeded")
      .reduce((sum, request) => sum + request.amountCents, 0);
    const outcome = orderOutcomeMessage(realOrder, refundedCents);
    const fulfillment = FULFILLMENT_LABELS[realOrder.fulfillment] ?? realOrder.fulfillment;
    const issue = realOrder.issueReports[0];
    const shipped = realOrder.fulfillment === "ship";
    // An address is the customer's own: shown only with the tracking token, like the PIN and the photo.
    const destination = owner ? deliveryDestination(realOrder) : null;
    const receipt = orderReceipt({ ...realOrder, couponCode: realOrder.coupon?.code ?? null, refundedCents });
    return (
      <StorefrontShell store={context.store}>
        <div className={styles.page}>
          <FlowHeading
            title={query.placed === "1" ? "You're all set." : `Order #${realOrder.number}`}
            description={`Order #${realOrder.number} · ${context.store.name}`}
            backHref="/"
            backLabel="Keep shopping"
          />
          <section className={`flow-card ${styles.status}`} aria-labelledby="order-status">
            {query.placed === "1" && <SuccessMark />}
            <p className={styles.eyebrow}>Status</p>
            <h2 id="order-status">{statusLabel}</h2>
            {outcome && <p>{outcome}</p>}
            {query.placed === "1" && (
              <p>
                Your card has been authorized for {money(realOrder.totalAuthorizedCents)}.
                You&rsquo;ll be charged the final amount after picking; unused buffer is
                released.
              </p>
            )}
            <dl className={styles.facts}>
              <div>
                <dt>Fulfillment</dt>
                <dd>{fulfillment}</dd>
              </div>
              {destination && (
                <div>
                  <dt>{destination.label}</dt>
                  <dd>{destination.address}</dd>
                </div>
              )}
              {scheduled && !outcome && (
                <div>
                  <dt>{realOrder.fulfillment === "pickup" ? "Pickup time" : "Delivery time"}</dt>
                  <dd>{scheduled}</dd>
                </div>
              )}
              {shipped && realOrder.shippingCarrier && (
                <div>
                  <dt>Carrier</dt>
                  <dd>{[realOrder.shippingCarrier, realOrder.shippingService].filter(Boolean).join(" ")}</dd>
                </div>
              )}
              {shipped && realOrder.shippingTrackingNumber && owner && (
                <div>
                  <dt>Tracking</dt>
                  <dd>
                    {realOrder.shippingTrackingUrl?.startsWith("https://") ? (
                      <a href={realOrder.shippingTrackingUrl} target="_blank" rel="noopener noreferrer">{realOrder.shippingTrackingNumber}</a>
                    ) : realOrder.shippingTrackingNumber}
                  </dd>
                </div>
              )}
            </dl>
            {realOrder.status === "SUBSTITUTION_PENDING" && owner && (
              <div className={styles.block}>
                <h3>An item is short</h3>
                <p>The store couldn&rsquo;t find everything you ordered. Choose a swap or a refund.</p>
                <Link className="sf-button" href={`/order/${encodeURIComponent(token)}/substitutions`}>Choose now</Link>
              </div>
            )}
            {issue ? (
              <div className={styles.block}>
                <h3>Your problem report</h3>
                <p>{issueStateMessage(issue)}</p>
              </div>
            ) : owner && issueWindowOpen(realOrder) ? (
              <div className={styles.block}>
                <h3>Something wrong with your order?</h3>
                <p>Tell us within 48 hours of your order and we&rsquo;ll make it right.</p>
                <Link className="sf-button" href={`/order/${encodeURIComponent(token)}/report`}>Report a problem</Link>
              </div>
            ) : null}
            {courier && (
              <div className={styles.block}>
                <h3>Your courier</h3>
                <p><strong>{courierBrand(courier.provider as DeliveryProviderName)}</strong></p>
                {courier.status === "returned" ? (
                  <p>The courier couldn&rsquo;t complete the drop-off and is taking your order back to the store. The store will contact you.</p>
                ) : courierInfo?.name ? (
                  <p>
                    {courierInfo.name}
                    {courierInfo.vehicle && ` · ${courierInfo.vehicle}`}
                    {eta && courier.status !== "delivered" && (
                      <> · arriving about <span style={{ whiteSpace: "nowrap" }}>{eta}</span></>
                    )}
                  </p>
                ) : (
                  <p>We&rsquo;re matching your order with a courier.</p>
                )}
                {courier.pin && owner && courier.status !== "delivered" && courier.status !== "returned" && (
                  <p>Give your courier this PIN at the door: <strong className={styles.pin}>{courier.pin}</strong></p>
                )}
                {courier.trackingUrl && courier.status !== "delivered" && (
                  <a className="sf-text-link" href={courier.trackingUrl} target="_blank" rel="noopener noreferrer">Track your courier</a>
                )}
              </div>
            )}
          </section>
          <FlowCard title="Receipt">
            {realOrder.customer && (
              <p><strong>Customer:</strong> {realOrder.customer.name}</p>
            )}
            <ul className={styles.lines}>
              {realOrder.lines.map((line, index) => (
                <li key={line.id}>
                  <span>
                    {line.qtyOrdered} × {[line.listingVariant?.listing?.customName ?? line.listingVariant?.listing?.masterProduct?.name, line.listingVariant && shownPack(line.listingVariant).label].filter(Boolean).join(" · ") || "Item"}
                    {receipt.items[index].note && <small className={styles.note}>{receipt.items[index].note}</small>}
                  </span>
                  <span>{money(receipt.items[index].cents)}</span>
                </li>
              ))}
            </ul>
            {receipt.lines.map((line) => (
              <FeeLine key={line.key} label={line.label} cents={line.cents} />
            ))}
            <FeeLine label={receipt.total.label} cents={receipt.total.cents} strong />
            {receipt.refund && receipt.net && (
              <>
                <FeeLine label={receipt.refund.label} cents={receipt.refund.cents} />
                <FeeLine label={receipt.net.label} cents={receipt.net.cents} strong />
              </>
            )}
            {receipt.holdCents != null && (
              <FeeLine
                label="Authorization hold"
                detail="You're charged the final amount after picking; the rest is released."
                cents={receipt.holdCents}
              />
            )}
          </FlowCard>
          {proofToken && (
            <FlowCard title="Delivery photo">
              {/* Private route, not the image optimizer: the photo must never be cached publicly. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/delivery-proof/${encodeURIComponent(proofToken)}`}
                alt={`Photo of order #${realOrder.number} where it was delivered`}
                className={styles.photo}
              />
            </FlowCard>
          )}
          {owner && (
            <OrderUpdates token={token} publicKey={vapidPublicKey()} storeName={context.store.name} />
          )}
          {messages && (
            <OrderMessages token={token} storeName={context.store.name} timeZone={context.store.timezone} initialMessages={messages} />
          )}
          <div className={styles.end}>
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
