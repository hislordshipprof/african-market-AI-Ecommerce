import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { viewOrderDetail, type OrderDetail } from "@/lib/admin/order-detail";
import { money } from "@/lib/format";
import { FULFILLMENT_LABELS, placedAt } from "../order-labels";

export const metadata = { title: "Order — Platform Admin" };
// Every view writes an audit row, so the page is never served from a cache.
export const dynamic = "force-dynamic";

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const SENDER: Record<string, string> = { customer: "Customer", store: "Store", platform: "Platform team" };

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 id={id} className="mb-3 font-heading text-lg font-bold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words text-right tabular-nums text-foreground sm:text-left">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Lines({ lines }: { lines: OrderDetail["lines"] }) {
  if (lines.length === 0) return <Empty>No lines.</Empty>;
  return (
    <ul className="divide-y divide-border" data-testid="order-lines">
      {lines.map((line) => (
        <li key={line.id} className="py-3 first:pt-0 last:pb-0">
          <p className="font-medium text-foreground">
            {line.name} <span className="font-normal text-muted-foreground">· {line.variantLabel}</span>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            Ordered {line.qtyOrdered} · Picked {line.qtyPicked} · {money(line.unitPriceCents)} each · <span className="font-mono text-xs">{line.status}</span> ·
            swap rule <span className="font-mono text-xs">{line.swapRule}</span>
          </p>
          {line.substitutedName && (
            <p className="mt-0.5 text-sm text-foreground">
              Substituted with {line.substitutedName} · {line.substitutedVariantLabel}
              {line.substitutedUnitPriceCents !== null && <> at {money(line.substitutedUnitPriceCents)} each</>}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function captured(pay: OrderDetail["payment"], at: (date: Date) => string): string {
  if (!pay.capturedAt) return pay.capturedCents === null ? "Not captured" : money(pay.capturedCents);
  return `${pay.capturedCents === null ? "Amount not recorded" : money(pay.capturedCents)} on ${at(pay.capturedAt)}`;
}

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!ORDER_ID.test(orderId)) notFound();
  const order = await viewOrderDetail(orderId);
  if (!order) notFound();

  const zone = order.store.timezone;
  const at = (date: Date) => placedAt(date, zone);
  const pay = order.payment;
  const thread = order.supportThread;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <Link href="/admin/orders/search" className={`inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-primary hover:underline ${FOCUS}`}>
        <ChevronLeft aria-hidden className="size-4" />
        Search orders
      </Link>
      <h1 className="mt-2 font-heading text-[28px] font-bold leading-tight text-foreground">Order #{order.number}</h1>
      <p className="mt-1 text-muted-foreground">
        {order.store.name} · <span className="font-mono text-sm text-foreground" data-testid="order-status">{order.status}</span> ·{" "}
        {FULFILLMENT_LABELS[order.fulfillment] ?? order.fulfillment} · placed {at(order.createdAt)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Times are in the store&apos;s time zone ({zone}). This view is recorded in the audit log.</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section title="Customer" id="customer-heading">
          <Rows
            rows={[
              ["Name", order.customer.name],
              ["Email", order.customer.email ?? "—"],
              ["Phone", order.customer.phone ?? "—"],
              ...(order.deliveryAddress ? ([["Deliver to", order.deliveryAddress]] as Array<[string, React.ReactNode]>) : []),
              ["Tracking link", order.trackingTokenHint ? <span data-testid="tracking-hint">ends {order.trackingTokenHint}</span> : "—"],
            ]}
          />
        </Section>

        <Section title="Payment" id="payment-heading">
          <Rows
            rows={[
              ["PaymentIntent", <span key="pi" className="font-mono text-xs" data-testid="payment-intent">{pay.paymentIntentId ?? "—"}</span>],
              ["Goods", money(pay.subtotalCents)],
              ["Tip", money(pay.tipCents)],
              ["Delivery fee", money(pay.deliveryFeeCents)],
              ["Service fee", money(pay.serviceFeeCents)],
              ["Authorized", <span key="auth" data-testid="authorized">{money(pay.authorizedCents)}</span>],
              ["Captured", <span key="cap" data-testid="captured">{captured(pay, at)}</span>],
              ["Application fee", <span key="fee" data-testid="application-fee">{pay.applicationFeeCents === null ? (pay.capturedAt ? "Not recorded" : "Set at capture") : money(pay.applicationFeeCents)}</span>],
              ["Refunded", <span key="ref" data-testid="refunded">{money(pay.refundedCents)}</span>],
            ]}
          />
        </Section>

        <div className="lg:col-span-2">
          <Section title="Lines" id="lines-heading">
            <Lines lines={order.lines} />
          </Section>
        </div>

        <Section title="Timeline" id="timeline-heading">
          <ol className="grid gap-2 text-sm" data-testid="order-timeline">
            {order.timeline.map((entry, index) => (
              <li key={`${entry.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4">
                <span className="text-foreground">
                  {entry.actorEmail ? <span className="font-mono text-xs">{entry.label}</span> : entry.label}
                  {entry.actorEmail && <span className="block text-xs text-muted-foreground">{entry.actorEmail}</span>}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">{at(entry.at)}</span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Refund requests" id="refunds-heading">
          {order.refundRequests.length === 0 ? (
            <Empty>No refund requests.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="refund-requests">
              {order.refundRequests.map((request) => (
                <li key={request.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="flex justify-between gap-4 text-foreground">
                    <span className="tabular-nums">{money(request.amountCents)}</span>
                    <span>
                      <span className="font-mono text-xs">{request.state}</span>
                      {request.providerStatus && <> · {request.providerStatus}</>}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {at(request.createdAt)}
                    {request.providerRefundId && <> · <span className="font-mono">{request.providerRefundId}</span></>}
                    {request.serviceFeeShareCents > 0 && <> · service fee share {money(request.serviceFeeShareCents)}</>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Deliveries" id="deliveries-heading">
          {order.deliveries.length === 0 ? (
            <Empty>No courier booking.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="deliveries">
              {order.deliveries.map((delivery) => (
                <li key={delivery.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="flex justify-between gap-4 text-foreground">
                    <span className="capitalize">{delivery.provider}</span>
                    <span className="font-mono text-xs">{delivery.status}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Quote {money(delivery.quoteFeeCents)}
                    {delivery.actualFeeCents !== null && <> · charged {money(delivery.actualFeeCents)}</>} · <span className="font-mono">{delivery.externalId}</span> ·{" "}
                    {at(delivery.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Issue reports" id="issues-heading">
          {order.issueReports.length === 0 ? (
            <Empty>No issue reports.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="issue-reports">
              {order.issueReports.map((issue) => (
                <li key={issue.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="flex justify-between gap-4 text-foreground">
                    <span className="capitalize">{issue.type}</span>
                    <span>
                      <span className="tabular-nums">{money(issue.amountCents)}</span> · <span className="font-mono text-xs">{issue.state}</span>
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{at(issue.createdAt)}</p>
                  {issue.note && <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{issue.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="lg:col-span-2">
          <Section title="Support thread" id="thread-heading">
            {!thread ? (
              <Empty>No messages about this order.</Empty>
            ) : (
              <div data-testid="support-thread">
                <p className="text-sm text-foreground">
                  <span className="font-mono text-xs">{thread.state}</span> · {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}
                  {thread.escalatedAt && <> · escalated {at(thread.escalatedAt)}</>}
                </p>
                {thread.inPlatformQueue && (
                  <div className="mt-3">
                    <Link
                      href={`/admin/support#thread-${thread.id}`}
                      className={`inline-flex min-h-11 items-center rounded-full border border-input px-4 text-sm font-medium text-primary hover:bg-muted ${FOCUS}`}
                    >
                      Open in Messages
                    </Link>
                  </div>
                )}
                <ol id="thread-messages" className="mt-4 grid gap-2">
                  {thread.messages.map((message) => (
                    <li key={message.id} className="rounded-md border border-border px-3 py-2">
                      <span className="block text-xs text-muted-foreground">
                        {SENDER[message.sender] ?? message.sender} · {at(message.createdAt)}
                      </span>
                      <span className="whitespace-pre-wrap break-words text-sm text-foreground">{message.body}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
