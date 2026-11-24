import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireStoreMember } from "@/lib/store-admin/session";
import { getStoreOrder } from "@/lib/order/service";
import { CANCELLABLE_AFTER_CAPTURE, STORE_REFUNDABLE_FROM } from "@/lib/order/constants";
import { refundableLines, refundedUnits, requestLines } from "@/lib/order/request-lines";
import { FULFILLMENT_LABELS, orderStatusLabel } from "@/lib/order/status-labels";
import { showCapturedLine, storeOrderBreakdown, storePayoutLines } from "@/lib/order/staff-copy";
import { CANCEL_REASON_LABELS } from "@/lib/analytics/queries";
import { formatListTime, money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { RefundOrder } from "../../refund-order";

const signed = (cents: number) => (cents < 0 ? `−${money(-cents)}` : money(cents));

/** A past order (#798): read-only, except that the owner can refund it. */
export default async function PastOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStoreMember();
  const { id } = await params;
  const order = await getStoreOrder(session.store.id, id);
  if (!order) notFound();
  const slug = encodeURIComponent(session.store.slug);
  const tz = session.store.timezone;
  const choices = refundableLines(order);
  const refunded = refundedUnits(order.refunds);
  const names = new Map(choices.map((line) => [line.id, line.name]));
  const breakdown = storeOrderBreakdown(order);
  const owner = session.membership.role === "owner";

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link
            href={`/store-admin/orders/past?store=${slug}`}
            aria-label="Back to past orders"
            className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">
              Order #{order.number}
              <Badge variant="outline">{orderStatusLabel(order.status, order.fulfillment)}</Badge>
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {order.customer.name} · {formatListTime(order.createdAt, tz)} · {FULFILLMENT_LABELS[order.fulfillment] ?? "Delivery"}
            </p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        {order.cancelReason && (
          <p className="text-sm text-foreground" data-testid="cancel-reason">
            Cancelled: {CANCEL_REASON_LABELS[order.cancelReason.reason] ?? "Other (store)"}
            {order.cancelReason.note ? `. ${order.cancelReason.note}` : ""}
          </p>
        )}

        {owner && (STORE_REFUNDABLE_FROM as readonly string[]).includes(order.status) && (
          <RefundOrder
            orderId={order.id}
            canMarkNoShow={false}
            wholeCancels={(CANCELLABLE_AFTER_CAPTURE as readonly string[]).includes(order.status)}
            lines={choices}
          />
        )}

        <section aria-labelledby="items-heading">
          <h2 id="items-heading" className="mb-2 text-sm font-semibold text-foreground">Items</h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="past-order-lines">
            {order.lines.map((line) => {
              const units = refunded.get(line.id) ?? 0;
              return (
                <li key={line.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{line.qtyPicked} × {names.get(line.id)}</p>
                    <p className="text-xs text-muted-foreground">{line.listingVariant.label} · {money(line.unitPriceCents)} each</p>
                  </div>
                  {units > 0 && <Badge variant="secondary">Refunded {units}</Badge>}
                </li>
              );
            })}
          </ul>
        </section>

        {order.refunds.length > 0 && (
          <section aria-labelledby="refunds-heading">
            <h2 id="refunds-heading" className="mb-2 text-sm font-semibold text-foreground">Refunds</h2>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="past-order-refunds">
              {order.refunds.map((refund) => {
                const lines = requestLines(refund.lines);
                return (
                  <li key={refund.id} className="space-y-1 px-4 py-3 text-sm">
                    <p className="flex justify-between gap-3">
                      <span className="text-foreground">
                        {lines.length > 0 ? lines.map((line) => `${line.qty} × ${names.get(line.lineId) ?? "Item"}`).join(", ") : "Order refund"}
                      </span>
                      <span className="font-medium tabular-nums">{signed(-refund.amountCents)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatListTime(refund.createdAt, tz)}
                      {refund.by ? ` · ${refund.by}` : ""}
                      {refund.reason ? ` · ${refund.reason}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section aria-label="Money" className="space-y-1.5 rounded-lg border border-border bg-card px-4 py-3">
          {breakdown.lines.map((line) => (
            <div key={line.key} className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{line.label}</span>
              <span className="tabular-nums">{signed(line.cents)}</span>
            </div>
          ))}
          <div className="flex justify-between pt-1.5 text-base font-semibold">
            <span>{breakdown.total.label}</span>
            <span className="tabular-nums">{money(breakdown.total.cents)}</span>
          </div>
          {order.capturedAmountCents != null && showCapturedLine(order.status, order.capturedAmountCents) &&
            storePayoutLines({ ...order, capturedAmountCents: order.capturedAmountCents }).map((line) => (
              <div key={line.key} className={`flex justify-between gap-3 text-sm${line.key === "payout" ? " font-medium" : ""}`}>
                <span className={line.key === "payout" ? undefined : "text-muted-foreground"}>{line.label}</span>
                <span className="tabular-nums">{signed(line.cents)}</span>
              </div>
            ))}
        </section>
      </main>
    </div>
  );
}
