import Link from "next/link";
import { headers } from "next/headers";
import type { ValidatedStore } from "@/lib/get-store";
import { auth } from "@/lib/auth";
import { SearchBar } from "./search-bar";
import { CartTrigger } from "./cart-provider";
import { FulfillmentChip } from "./fulfillment-chip";
import { ShrinkingHeader } from "./scroll-motion";
import { StoreLogo } from "./store-logo";
import { AislesButton } from "./aisle-menu";

// Past this length a store name steps down a size so it fits three lines whole.
const LONG_STORE_NAME = 30;

export async function StorefrontHeader({ store, pageTitled = false }: { store: ValidatedStore; pageTitled?: boolean }) {
  const StoreName = pageTitled ? "p" : "h1";
  const headerList = await headers();
  const session = await auth.api.getSession({ headers: headerList });
  return (
    <ShrinkingHeader>
      <div className="sf-header-main sf-container">
        <AislesButton />
        <Link href="/" className="sf-brand">
          <StoreLogo src={store.logoUrl} name={store.name} />
          <StoreName className="sf-brand-name" translate="no" data-long={store.name.length > LONG_STORE_NAME || undefined} data-testid="store-name" title={store.name}>{store.name}</StoreName>
        </Link>
        <div className="sf-header-window">
          <FulfillmentChip
            minutes={store.prepTimeMinutes}
            pickup={store.pickupEnabled}
            radius={Number(store.deliveryRadiusMi)}
            hours={store.hours}
            timezone={store.timezone}
          />
        </div>
        <div className="sf-header-search">
          <SearchBar storeId={store.id} />
        </div>
        <Link
          href={session ? "/account" : "/account/sign-in"}
          className="sf-header-signin"
        >
          {session ? "Account" : "Sign in"}
        </Link>
        <CartTrigger className="sf-header-cart" />
      </div>
    </ShrinkingHeader>
  );
}
