import type { Metadata } from "next";
import { headers } from "next/headers";
import { findStoreForHeaders } from "@/lib/get-store";
import { pwaMetadata } from "@/lib/pwa/manifest";
import { TwoFactorReminder } from "./two-factor-reminder";
import { StoreAssistantHost } from "./store-assistant-host";
import { AdminShell } from "./shell/admin-shell";
import { loadShell } from "./shell/shell-data";

/** The store admin installs as its own app, scoped to /store-admin (#563). */
export async function generateMetadata(): Promise<Metadata> {
  const store = await findStoreForHeaders(await headers());
  return store ? pwaMetadata(store, "store-admin") : {};
}

export default async function StoreAdminLayout({ children }: { children: React.ReactNode }) {
  // Null on sign-in, 2FA set-up and for anyone who is not a member: those pages render bare.
  const shell = await loadShell();
  return (
    <>
      {shell ? (
        <AdminShell data={shell}>
          <TwoFactorReminder />
          {children}
        </AdminShell>
      ) : (
        <>
          <TwoFactorReminder />
          {children}
        </>
      )}
      <StoreAssistantHost />
    </>
  );
}
