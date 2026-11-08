import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getFlowContext } from "@/lib/customer-flow/server";
import { syncCustomerForRequest } from "@/lib/customer-sync";
import { auth } from "@/lib/auth";
import { loadAccountBook } from "@/lib/customer-account/checkout-profile";
import { listAccountOrders } from "@/lib/customer-account/order-history";
import { accountOrderRow } from "@/lib/customer-account/order-history-view";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountFlow } from "@/components/storefront/flow/account-flow";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const headerList = await headers();
  const [{ store, settings, catalog, enabled }, customer, session] = await Promise.all([
    getFlowContext(),
    syncCustomerForRequest(),
    auth.api.getSession({ headers: headerList, query: { disableCookieCache: true } }),
  ]);
  // After the sync: the history must include orders the sync just claimed.
  const [accountBook, accountOrders] = customer
    ? await Promise.all([
        session?.user?.id ? loadAccountBook(session.user.id) : null,
        listAccountOrders(store.id, customer.id),
      ])
    : [null, null];
  if (!customer && (params.error || !enabled)) {
    const query = params.error ? `?error=${encodeURIComponent(params.error)}` : "";
    redirect(`/account/sign-in${query}`);
  }
  return (
    <StorefrontShell store={store}>
      <AccountFlow
        settings={settings}
        catalog={catalog}
        enabled={enabled}
        customer={customer}
        accountBook={accountBook}
        accountOrders={accountOrders?.map((order) => accountOrderRow(order, store.timezone)) ?? null}
      />
    </StorefrontShell>
  );
}
