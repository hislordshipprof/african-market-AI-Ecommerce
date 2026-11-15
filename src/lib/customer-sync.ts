import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "./auth";
import { findStoreForHeaders } from "./get-store";
import type { StoreCustomer } from "./customer-auth";
import { syncCustomerForStore } from "./customer-claim";
import { isPrivilegedUser } from "./privileged-user";

/** One session read per request, shared by the page and the account sync. */
export const getRequestSession = cache(async () =>
  auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  }),
);

/**
 * Resolve the signed-in account's Customer at this store and claim its guest orders.
 * Staff and platform admins are never synced into a store's customers.
 */
export async function syncCustomerForRequest(): Promise<StoreCustomer | null> {
  const reqHeaders = await headers();
  if (!reqHeaders.get("x-store-slug") && !reqHeaders.get("x-custom-domain")) return null;

  const [session, store] = await Promise.all([
    getRequestSession(),
    findStoreForHeaders(reqHeaders),
  ]);
  if (!session || !store) return null;
  if (await isPrivilegedUser(session.user.id)) return null;

  return syncCustomerForStore(store.id, session.user);
}
