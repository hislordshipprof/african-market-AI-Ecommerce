import Link from "next/link";
import { MapPin } from "lucide-react";
import type { ValidatedStore } from "@/lib/get-store";

export function StorefrontFooter({ store }: { store: ValidatedStore }) {
  return (
    <footer
      data-testid="storefront-footer"
      className="bg-primary-deep text-on-primary"
    >
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <h3 className="font-display text-base font-bold">{store.name}</h3>
            {store.neighborhood && (
              <p className="mt-1 flex items-center gap-1.5 font-body text-sm text-on-primary/70">
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                {store.neighborhood}
              </p>
            )}
            {store.deliveryInfo && (
              <p className="mt-1 font-body text-sm text-on-primary/70">
                {store.deliveryInfo}
              </p>
            )}
          </div>

          <div>
            <h3 className="font-label text-xs uppercase tracking-wider text-on-primary/60">
              Quick links
            </h3>
            <ul className="mt-2 space-y-1.5 font-body text-sm text-on-primary/80">
              <li>
                <Link href="/" className="hover:text-on-primary">
                  Home
                </Link>
              </li>
              <li>
                <Link href="/search" className="hover:text-on-primary">
                  Search
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-label text-xs uppercase tracking-wider text-on-primary/60">
              About
            </h3>
            <p className="mt-2 font-body text-sm text-on-primary/70">
              Powered by the Platform
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-on-primary/10 px-4 py-4 text-center">
        <p className="font-body text-xs text-on-primary/50">
          &copy; {new Date().getFullYear()} {store.name}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
