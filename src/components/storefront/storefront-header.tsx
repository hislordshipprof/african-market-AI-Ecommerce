import Image from "next/image";
import Link from "next/link";
import type { ValidatedStore } from "@/lib/get-store";
import { listCategories } from "@/lib/storefront/service";
import { SearchBar } from "./search-bar";
import { CartTrigger } from "./cart-provider";
import { FulfillmentChip } from "./fulfillment-chip";
import { ShrinkingHeader } from "./scroll-motion";

export async function StorefrontHeader({ store }: { store: ValidatedStore }) {
  const categories = await listCategories();
  return (
    <ShrinkingHeader>
      <div className="sf-header-main sf-container">
        <Link href="/" className="sf-brand">
          {store.logoUrl && (
            <Image
              src={store.logoUrl}
              alt={`${store.name} logo`}
              width={44}
              height={44}
              className="sf-logo"
            />
          )}
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
