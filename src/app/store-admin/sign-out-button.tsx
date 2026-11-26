"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { signOutTo } from "@/lib/sign-out";

/** Every member's way out of the store admin (#784). A full load, so no cached admin page survives the session. */
export function SignOutButton({ storeSlug, compact = false }: { storeSlug: string; compact?: boolean }) {
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setSigningOut(true);
    setFailed(false);
    const left = await signOutTo(
      `/store-admin/sign-in?store=${encodeURIComponent(storeSlug)}`,
      () => authClient.signOut(),
      (path) => window.location.assign(path),
    );
    if (!left) {
      setSigningOut(false);
      setFailed(true);
    }
  }

  return (
    <div className="relative">
      {compact ? (
        <Button type="button" variant="ghost" size="icon" className="size-11 rounded-full" onClick={signOut} disabled={signingOut} aria-label={signingOut ? "Signing out…" : "Sign out"}>
          <LogOut aria-hidden className="size-4" />
        </Button>
      ) : (
        <Button type="button" variant="outline" className="min-h-11 rounded-full" onClick={signOut} disabled={signingOut}>
          <LogOut aria-hidden className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      )}
      {failed && (
        <p role="alert" className={`absolute right-0 z-10 w-60 rounded-lg ${compact ? "bottom-full mb-2" : "top-full mt-2"} border border-border bg-card p-2 text-sm text-destructive`}>
          Sign-out didn&apos;t go through. Check your connection and try again.
        </p>
      )}
    </div>
  );
}
