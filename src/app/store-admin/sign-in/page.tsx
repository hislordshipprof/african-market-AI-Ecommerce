import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { storeAdminReturnPath } from "@/lib/store-admin/sign-in-path";
import { StoreAdminSignInForm } from "./sign-in-form";

// On the production alias the proxy has already moved ?store= into a cookie, so the store comes from the request (#797).
export default async function StoreAdminSignIn({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const [store, { next }] = await Promise.all([findStoreForHeaders(await headers()), searchParams]);
  return <StoreAdminSignInForm returnTo={storeAdminReturnPath(typeof next === "string" ? next : null, store?.slug ?? null)} />;
}
