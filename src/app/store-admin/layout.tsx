import type { Metadata } from "next";
import { headers } from "next/headers";
import { findStore } from "@/lib/get-store";
import { pwaMetadata } from "@/lib/pwa/manifest";

/** The store admin installs as its own app, scoped to /store-admin (#563). */
export async function generateMetadata(): Promise<Metadata> {
  const slug = (await headers()).get("x-store-slug");
  const store = slug ? await findStore(slug) : null;
  return store ? pwaMetadata(store, "store-admin") : {};
}

export default function StoreAdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
