import Link from "next/link";
import { listStores } from "@/lib/admin/actions";
import { SuspendButton } from "./suspend-button";

export default async function StoreListPage() {
  const stores = await listStores();

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
          <Link
            href="/admin/stores/new"
            className="rounded-full bg-[#1F5A43] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#123726]"
          >
            Create store
          </Link>
        </div>
      </div>

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
                <th className="px-4 py-3 font-medium text-[#55625A]">Preset</th>
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
                    {store.themePreset}
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
