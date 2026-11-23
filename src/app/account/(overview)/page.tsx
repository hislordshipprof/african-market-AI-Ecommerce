import { redirect } from "next/navigation";
import { getFlowContext } from "@/lib/customer-flow/server";
import { getRequestSession, syncCustomerForRequest } from "@/lib/customer-sync";
import { loadAccountBook } from "@/lib/customer-account/checkout-profile";
import { lastOrderContact, listAccountOrders } from "@/lib/customer-account/order-history";
import { USPS_STATE_CODES } from "@/lib/customer-account/address-validation";
import { accountOrderRow } from "@/lib/customer-account/order-history-view";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountFlow } from "@/components/storefront/flow/account-flow";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const [{ store, settings, catalog, enabled }, customer, session] = await Promise.all([
    getFlowContext(),
    syncCustomerForRequest(),
    getRequestSession(),
  ]);
  if (!customer && (params.error || !enabled)) {
    const query = params.error ? `?error=${encodeURIComponent(params.error)}` : "";
    redirect(`/account/sign-in${query}`);
  }
  // After the sync: the history must include orders the sync just claimed.
  const [accountBook, accountOrders, lastContact] = customer
    ? await Promise.all([
        session?.user?.id ? loadAccountBook(session.user.id) : null,
        listAccountOrders(store.id, customer.id).then((orders) =>
          orders.map((order) => accountOrderRow(order, store.timezone)),
        ),
        lastOrderContact(store.id, customer.id),
      ])
    : [null, null, null];
  const storeState = USPS_STATE_CODES.find((code) => code === store.state?.trim().toUpperCase()) ?? "MD";
  return (
    <StorefrontShell store={store}>
      <AccountFlow
        settings={settings}
        catalog={catalog}
        enabled={enabled}
        customer={customer}
        accountBook={accountBook}
        accountOrders={accountOrders}
        lastContact={lastContact}
        storeState={storeState}
      />
    </StorefrontShell>
  );
}
