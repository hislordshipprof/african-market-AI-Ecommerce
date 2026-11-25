import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { storeAdminReturnPath, storeTwoFactorPath } from "@/lib/store-admin/sign-in-path";
import { StoreAdminSignInForm } from "./sign-in-form";

// On the production alias the proxy has already moved ?store= into a cookie, so the store comes from the request (#797).
export default async function StoreAdminSignIn({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const [store, { next }] = await Promise.all([findStoreForHeaders(await headers()), searchParams]);
  const returnTo = storeAdminReturnPath(typeof next === "string" ? next : null, store?.slug ?? null);
  // A member without 2FA is offered it after the password (#840); with no store known there is nowhere to set it up.
  const offerTwoFactor = store ? storeTwoFactorPath(store.slug, returnTo) : returnTo;
  return <StoreAdminSignInForm returnTo={returnTo} offerTwoFactor={offerTwoFactor} />;
}
