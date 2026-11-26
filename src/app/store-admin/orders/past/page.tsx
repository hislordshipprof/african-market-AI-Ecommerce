import Link from "next/link";
import { Search } from "lucide-react";
import { requireStoreMember } from "@/lib/store-admin/session";
import { pastStoreOrders } from "@/lib/order/past-orders";
import { FULFILLMENT_LABELS, orderStatusLabel } from "@/lib/order/status-labels";
import { formatListTime, money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/app/store-admin/shell/page-header";

/** Orders after hand-off (#785): completed, delivered, cancelled and refunded, newest first. */
export default async function PastOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; after?: string }>;
}) {
  const session = await requireStoreMember();
  const { q, after } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const { rows, nextCursor } = await pastStoreOrders(session.store.id, {
    q: query,
    cursor: typeof after === "string" ? after : undefined,
  });
  const slug = encodeURIComponent(session.store.slug);
  const base = `/store-admin/orders/past?store=${slug}${query ? `&q=${encodeURIComponent(query)}` : ""}`;

  return (
    <>
      <PageHeader
        title="Past orders"
        description={session.store.name}
        parent={{ href: `/store-admin/orders?store=${slug}`, label: "Orders" }}
      />
      <div>
        <form action="/store-admin/orders/past" method="get" role="search" className="mb-4 flex gap-2">
          <input type="hidden" name="store" value={session.store.slug} />
          <label htmlFor="past-orders-q" className="sr-only">Order number or customer</label>
          <Input
            id="past-orders-q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Order number or customer"
            maxLength={100}
            className="min-h-11"
          />
          <Button type="submit" variant="secondary" className="min-h-11">
            <Search className="size-4" aria-hidden />
            Search
          </Button>
        </form>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {query ? `No past orders match "${query}".` : "No past orders yet. Orders show here once they are completed, cancelled or refunded."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="past-orders">
            {rows.map((row) => (
              <li key={row.id} className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/50">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    <Link
                      href={`/store-admin/orders/past/${row.id}?store=${slug}`}
                      className="underline-offset-2 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      Order #{row.number}
                    </Link>
                    <Badge variant={row.status === "COMPLETED" || row.status === "DELIVERED" ? "secondary" : "outline"}>
                      {orderStatusLabel(row.status, row.fulfillment)}
                    </Badge>
                  </p>
                  <p className="truncate text-sm text-foreground">{row.customerName}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatListTime(row.createdAt, session.store.timezone)} · {FULFILLMENT_LABELS[row.fulfillment] ?? "Delivery"}
                  </p>
                </div>
                <dl className="grid grid-cols-[auto_auto] content-start gap-x-3 text-right text-sm">
                  <dt className="text-muted-foreground">Total</dt>
                  <dd className="tabular-nums">{money(row.totalCents)}</dd>
                  <dt className="text-muted-foreground">Your payout</dt>
                  <dd className="font-medium tabular-nums">{row.payoutCents === null ? "None" : money(row.payoutCents)}</dd>
                </dl>
              </li>
            ))}
          </ul>
        )}

        <nav aria-label="Pages" className="mt-4 flex justify-between gap-2">
          {after ? (
            <Link href={base} className={buttonVariants({ variant: "outline", className: "min-h-11" })}>Newest</Link>
          ) : <span />}
          {nextCursor && (
            <Link href={`${base}&after=${encodeURIComponent(nextCursor)}`} className={buttonVariants({ variant: "outline", className: "min-h-11" })}>
              Older orders
            </Link>
          )}
        </nav>
      </div>
    </>
  );
}
