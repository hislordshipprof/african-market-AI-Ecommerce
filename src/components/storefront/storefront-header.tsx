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

export async function StorefrontHeader({ store }: { store: ValidatedStore }) {
  const headerList = await headers();
  const [categories, session] = await Promise.all([
    listCategories(),
    auth.api.getSession({ headers: headerList }),
  ]);
  return (
    <ShrinkingHeader>
      <div className="sf-header-main sf-container">
        <Link href="/" className="sf-brand">
          {store.logoUrl && <StoreLogo src={store.logoUrl} name={store.name} />}
          <h1 data-testid="store-name">{store.name}</h1>
        </Link>
        <div className="sf-header-window">
          <FulfillmentChip
            minutes={store.prepTimeMinutes}
            pickup={store.pickupEnabled}
            radius={Number(store.deliveryRadiusMi)}
          />
        </div>
        <div className="sf-header-search">
          <SearchBar storeId={store.id} />
        </div>
        <CartTrigger className="sf-header-cart" />
      </div>
      <nav aria-label="Store categories" className="sf-category-nav">
        <div className="sf-container">
          <Link
            href={session ? "/account" : "/account/sign-in"}
            className="sf-header-account"
          >
            {session ? "Account" : "Sign in"}
          </Link>
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
