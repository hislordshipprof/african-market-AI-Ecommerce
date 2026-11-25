import Link from "next/link";
import { headers } from "next/headers";
import type { ValidatedStore } from "@/lib/get-store";
import { auth } from "@/lib/auth";
import { listCategories } from "@/lib/storefront/service";
import { SearchBar } from "./search-bar";
import { CartTrigger } from "./cart-provider";
import { FulfillmentChip } from "./fulfillment-chip";
import { ShrinkingHeader } from "./scroll-motion";
import { StoreLogo } from "./store-logo";

export async function StorefrontHeader({ store, pageTitled = false }: { store: ValidatedStore; pageTitled?: boolean }) {
  const StoreName = pageTitled ? "p" : "h1";
  const headerList = await headers();
  const [categories, session] = await Promise.all([
    listCategories(store.id),
    auth.api.getSession({ headers: headerList }),
  ]);
  return (
    <ShrinkingHeader>
      <div className="sf-header-main sf-container">
        <Link href="/" className="sf-brand">
          <StoreLogo src={store.logoUrl} name={store.name} />
          <StoreName className="sf-brand-name" data-testid="store-name" title={store.name}>{store.name}</StoreName>
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
      <nav aria-label="Store categories" className="sf-category-nav">
        <div className="sf-container">
          <Link href="/categories">All aisles</Link>
          {categories.slice(0, 8).map((cat) => (
            <Link key={cat.id} href={`/categories/${cat.slug}`}>
              {cat.name}
            </Link>
          ))}
        </div>
      </nav>
    </ShrinkingHeader>
  );
}
