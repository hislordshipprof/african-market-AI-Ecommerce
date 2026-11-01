import type { ReactNode } from "react";
import type { ValidatedStore } from "@/lib/get-store";
import { CartProvider } from "./cart-provider";
import { MobileNav } from "./mobile-nav";
import { StorefrontHeader } from "./storefront-header";
import { StorefrontFooter } from "./storefront-footer";

export function StorefrontShell({
  store,
  children,
}: {
  store: ValidatedStore;
  children: ReactNode;
}) {
  return (
    <div className="sf-storefront">
      <CartProvider
        storeId={store.id}
        storeName={store.name}
        minimumOrderCents={store.minimumOrderCents}
      >
        <a href="#main-content" className="sf-skip-link">
          Skip to content
        </a>
        <StorefrontHeader store={store} />
        <main id="main-content">{children}</main>
        <StorefrontFooter store={store} />
        <MobileNav />
      </CartProvider>
    </div>
  );
}
