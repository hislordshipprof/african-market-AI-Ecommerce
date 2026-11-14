import "server-only";
import { headers } from "next/headers";
import { auth } from "./auth";
import { findStoreForHeaders } from "./get-store";
import type { StoreCustomer } from "./customer-auth";
import { syncCustomerForStore } from "./customer-claim";

/** Resolve the signed-in account's Customer at this store and claim its guest orders. */
export async function syncCustomerForRequest(): Promise<StoreCustomer | null> {
  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });
  if (!session) return null;

  const store = await findStoreForHeaders(reqHeaders);
  if (!store) return null;

  return syncCustomerForStore(store.id, session.user);
}
