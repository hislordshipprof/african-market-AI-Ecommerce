import "server-only";
import { headers } from "next/headers";
import { auth } from "./auth";
import { findStore } from "./get-store";
import { findOrCreateCustomer, type CustomerProfile } from "./customer-auth";

export async function syncCustomerForRequest(): Promise<CustomerProfile | null> {
  const reqHeaders = await headers();

  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });
  if (!session) return null;

  const slug = reqHeaders.get("x-store-slug");
  if (!slug) return null;

  const store = await findStore(slug);
  if (!store) return null;

  return findOrCreateCustomer(store.id, session.user);
}
