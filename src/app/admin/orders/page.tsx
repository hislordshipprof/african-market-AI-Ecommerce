import Link from "next/link";
import { listRefundFailedOrders } from "@/lib/admin/refund-resolution";

function formatRefundCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
import { ResolveForm } from "./resolve-form";

export default async function RefundFailedOrdersPage() {
  const rows = await listRefundFailedOrders();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Refunds to resolve</h1>
        <Link href="/admin/stores" className="text-sm text-primary underline">
          Stores
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-input bg-card p-8 text-center text-muted-foreground" data-testid="refunds-empty">
          No refunds need resolving.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-input bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-input bg-muted">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Store</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Captured</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Refunded</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Still owed</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Failed refund</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Failed at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.orderId} className="border-b border-input last:border-0" data-testid={`refund-row-${row.orderNumber}`}>
                  <td className="px-4 py-3 text-foreground">{row.storeName}</td>
                  <td className="px-4 py-3 text-foreground">#{row.orderNumber}</td>
                  <td className="px-4 py-3 tabular-nums">{formatRefundCents(row.capturedCents)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatRefundCents(row.refundedCents)}</td>
                  <td className="px-4 py-3 tabular-nums" data-testid="amount-owed">{formatRefundCents(row.owedCents)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.failedRefundId}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.failedAtLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-6 border-t border-input p-4">
            {rows.map((row) => (
              <div key={row.orderId}>
                <p className="mb-2 text-sm text-foreground">Resolve #{row.orderNumber}</p>
                <ResolveForm orderId={row.orderId} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
