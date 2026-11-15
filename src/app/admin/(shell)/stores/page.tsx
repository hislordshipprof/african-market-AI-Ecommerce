import Link from "next/link";
import { listStores } from "@/lib/admin/actions";
import { SuspendButton } from "./suspend-button";
import { billingStatusLabel, PLAN_NAMES } from "@/lib/billing/plan";

export default async function StoreListPage() {
  const stores = await listStores();
  const failed = stores.filter((store) => store.subscription?.paymentFailedAt);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Stores</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/stores/new"
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create store
          </Link>
        </div>
      </div>

      {failed.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Subscription payment failed for {failed.map((store) => store.name).join(", ")}.</p>
          <p>Their storefronts stay up. Stripe retries the card; suspend a store only by decision.</p>
        </div>
      )}

      {stores.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">
            No stores yet.{" "}
            <Link href="/admin/stores/new" className="text-primary underline">
              Create the first one
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-border bg-muted">
              <tr>
                <th className="px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Slug</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Plan</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {store.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">
                    {store.slug}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        store.status === "suspended"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-foreground"
                      }`}
                    >
                      {store.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">
                        {PLAN_NAMES[store.plan]}
                      </span>
                      <span>· {billingStatusLabel(store.subscription?.status ?? "none")}</span>
                      {store.subscription?.pilot && (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-primary">Pilot</span>
                      )}
                      {store.subscription?.paymentFailedAt && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">Payment failed</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/stores/${store.id}`}
                        className="text-primary hover:underline"
                      >
                        Edit
                      </Link>
                      <SuspendButton
                        storeId={store.id}
                        currentStatus={store.status}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
