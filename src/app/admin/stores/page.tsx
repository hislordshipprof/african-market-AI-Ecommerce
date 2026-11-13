import Link from "next/link";
import { listStores } from "@/lib/admin/actions";
import { SuspendButton } from "./suspend-button";
import { effectivePlan } from "@/lib/billing/plan";

const BILLING_STATUS: Record<string, string> = {
  none: "not subscribed",
  trialing: "trial",
  active: "active",
  past_due: "past due",
  unpaid: "unpaid",
  canceled: "cancelled",
  incomplete: "waiting for card",
};

function billingStatusLabel(status: string): string {
  return BILLING_STATUS[status] ?? status;
}

export default async function StoreListPage() {
  const stores = await listStores();
  const failed = stores.filter((store) => store.subscription?.paymentFailedAt);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#15201A]">Stores</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/orders" className="text-sm text-primary underline">
            Refunds
          </Link>
          <Link href="/admin/orders/check" className="text-sm text-primary underline">
            Orders to check
          </Link>
          <Link href="/admin/support" className="text-sm text-primary underline">
            Messages
          </Link>
          <Link
            href="/admin/stores/new"
            className="rounded-full bg-[#1F5A43] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#123726]"
          >
            Create store
          </Link>
        </div>
      </div>

      {failed.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Subscription payment failed for {failed.map((store) => store.name).join(", ")}.</p>
          <p>Their storefronts stay up. Stripe retries the card; suspend a store only by decision.</p>
        </div>
      )}

      {stores.length === 0 ? (
        <div className="rounded-lg border border-[#e2e4e9] bg-white p-8 text-center">
          <p className="text-[#55625A]">
            No stores yet.{" "}
            <Link href="/admin/stores/new" className="text-[#1F5A43] underline">
              Create the first one
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[#e2e4e9] bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[#e2e4e9] bg-[#f8f9fa]">
              <tr>
                <th className="px-4 py-3 font-medium text-[#55625A]">Name</th>
                <th className="px-4 py-3 font-medium text-[#55625A]">Slug</th>
                <th className="px-4 py-3 font-medium text-[#55625A]">Status</th>
                <th className="px-4 py-3 font-medium text-[#55625A]">Plan</th>
                <th className="px-4 py-3 font-medium text-[#55625A]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} className="border-b border-[#e2e4e9] last:border-0">
                  <td className="px-4 py-3 font-medium text-[#15201A]">
                    {store.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-[#55625A]">
                    {store.slug}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        store.status === "active"
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-700"
                      }`}
                    >
                      {store.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#55625A]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-[#15201A]">
                        {effectivePlan(store.subscription) === "pro" ? "Pro" : "Starter"}
                      </span>
                      <span>· {billingStatusLabel(store.subscription?.status ?? "none")}</span>
                      {store.subscription?.pilot && (
                        <span className="rounded-full bg-[#EBF3EC] px-2 py-0.5 text-xs font-medium text-[#1F5A43]">Pilot</span>
                      )}
                      {store.subscription?.paymentFailedAt && (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Payment failed</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/admin/stores/${store.id}`}
                        className="text-[#1F5A43] hover:underline"
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
