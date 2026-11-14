import type { Metadata } from "next";
import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { pwaMetadata } from "@/lib/pwa/manifest";

/** The store admin installs as its own app, scoped to /store-admin (#563). */
export async function generateMetadata(): Promise<Metadata> {
  const store = await findStoreForHeaders(await headers());
  return store ? pwaMetadata(store, "store-admin") : {};
}

export default function StoreAdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
