import Link from "next/link";
import { listOrdersToCheck } from "@/lib/admin/orders-to-check";
import { ROW_LIMIT } from "@/lib/admin/orders-to-check-query";

const ALERT_LABELS: Record<string, string> = {
  acceptance_alert: "Not accepted in 15 open minutes",
  reconcile_failed: "Reconcile failed",
  capture_released: "Card hold released before capture",
  refund_request_unknown: "Refund request outcome unknown",
};

const GROUP_LABELS: Record<string, string> = {
  authorized: "orders waiting for the store to accept",
  uncaptured: "accepted orders not yet charged",
  captured: "charged orders",
};

function formatAge(since: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export default async function OrdersToCheckPage() {
  const { checkedAt, stuck, cappedGroups, alerts, alertsCapped } = await listOrdersToCheck();
  const now = checkedAt.getTime();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Orders to check</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/orders" className="text-sm text-primary underline">
            Refunds
          </Link>
          <Link href="/admin/stores" className="text-sm text-primary underline">
            Stores
          </Link>
        </div>
      </div>

      <h2 className="mb-3 text-lg font-semibold text-foreground">Stuck orders</h2>
      {cappedGroups.map((group) => (
        <p key={group} className="mb-3 text-sm text-muted-foreground" data-testid={`stuck-capped-${group}`}>
          The list may be incomplete: only {ROW_LIMIT} {GROUP_LABELS[group]} were checked, those known to be stuck first, then the oldest.
        </p>
      ))}
      {stuck.length === 0 ? (
        <p className="mb-8 rounded-lg border border-input bg-card p-8 text-center text-muted-foreground" data-testid="stuck-empty">
          {cappedGroups.length > 0 ? "No stuck orders among those checked. The list may be incomplete." : "No orders are stuck."}
        </p>
      ) : (
        <div className="mb-8 overflow-x-auto rounded-lg border border-input bg-card">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-input bg-muted">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Store</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">State</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Reason</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">For</th>
              </tr>
            </thead>
            <tbody>
              {stuck.map((row) => (
                <tr key={row.orderId} className="border-b border-input last:border-0" data-testid={`stuck-row-${row.orderNumber}`}>
                  <td className="px-4 py-3 text-foreground">{row.storeName}</td>
                  <td className="px-4 py-3 text-foreground">#{row.orderNumber}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.status}</td>
                  <td className="px-4 py-3 text-foreground first-letter:uppercase">{row.reason}</td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{formatAge(row.since, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 text-lg font-semibold text-foreground">Alerts</h2>
      {alertsCapped && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="alerts-capped">
          The list may be incomplete: showing the newest {ROW_LIMIT} alerts.
        </p>
      )}
      {alerts.length === 0 ? (
        <p className="rounded-lg border border-input bg-card p-8 text-center text-muted-foreground" data-testid="alerts-empty">
          No alerts to check.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-input bg-card">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-input bg-muted">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Store</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Alert</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Order state</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Raised</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((row) => (
                <tr key={`${row.orderId}-${row.action}`} className="border-b border-input last:border-0" data-testid={`alert-row-${row.orderNumber}`}>
                  <td className="px-4 py-3 text-foreground">{row.storeName}</td>
                  <td className="px-4 py-3 text-foreground">#{row.orderNumber}</td>
                  <td className="px-4 py-3 text-foreground">{ALERT_LABELS[row.action] ?? row.action}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.orderStatus}</td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{formatAge(row.createdAt, now)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
