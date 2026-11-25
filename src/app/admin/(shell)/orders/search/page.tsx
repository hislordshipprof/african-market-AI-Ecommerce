import { requirePlatformAdmin } from "@/lib/admin/session";
import { listOrderSearchStores } from "@/lib/admin/order-search-query";
import { OrderSearch } from "./order-search-form";

export const metadata = { title: "Search orders — Platform Admin" };

export default async function OrderSearchPage() {
  await requirePlatformAdmin();
  const stores = await listOrderSearchStores();

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="font-heading text-[28px] font-bold leading-tight text-foreground">Search orders</h1>
      <p className="mt-1 max-w-prose text-muted-foreground">
        Find an order at any store. Email and phone must match exactly. Leave every field blank to see the newest orders.
      </p>
      <OrderSearch stores={stores} />
    </div>
  );
}
