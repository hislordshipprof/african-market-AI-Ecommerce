import Image from "next/image";
import Link from "next/link";
import { ShoppingBag, Truck } from "lucide-react";
import type { ValidatedStore } from "@/lib/get-store";
import { SearchBar } from "./search-bar";

export function StorefrontHeader({ store }: { store: ValidatedStore }) {
  return (
    <header
      className="sticky top-0 z-40 bg-primary shadow-sm"
      data-testid="storefront-header"
    >
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {store.logoUrl && (
            <Image
              src={store.logoUrl}
              alt={`${store.name} logo`}
              width={40}
              height={40}
              className="h-10 w-10 rounded-md object-contain"
            />
          )}
          <Link href="/" className="min-w-0 flex-1">
            <h1
              className="truncate font-display text-on-primary"
              style={{
                fontSize: "clamp(18px, 2.5vw, 24px)",
                fontWeight: 700,
                lineHeight: 1.2,
              }}
            >
              {store.name}
            </h1>
          </Link>

          <span className="hidden items-center gap-1.5 rounded-pill bg-white/15 px-3 py-1 font-label text-[13px] text-on-primary sm:inline-flex">
            <Truck className="h-3.5 w-3.5" aria-hidden="true" />
            {store.deliveryInfo || "Pickup & delivery"}
          </span>

          <button
            type="button"
            className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-on-primary transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-on-primary focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
            aria-label="Shopping cart"
          >
            <ShoppingBag className="h-5 w-5" />
            <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-on-primary font-label text-[11px] font-bold text-primary">
              0
            </span>
          </button>
        </div>

        <div className="mt-2">
          <SearchBar />
        </div>
      </div>
    </header>
  );
}
