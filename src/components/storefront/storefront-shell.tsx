import { Suspense, type ReactNode } from "react";
import { AssistantHost } from "./assistant/assistant-host";
import type { ValidatedStore } from "@/lib/get-store";
import { CartProvider } from "./cart-provider";
import { MobileNav } from "./mobile-nav";
import { StorefrontHeader } from "./storefront-header";
import { StorefrontFooter } from "./storefront-footer";
import { StorefrontMotion } from "./motion-provider";
import { QuickViewProvider } from "./quick-view-provider";

export function StorefrontShell({
  store,
  children,
}: {
  store: ValidatedStore;
  children: ReactNode;
}) {
  return (
    <div className="sf-storefront">
      <StorefrontMotion><CartProvider
        key={store.id}
        storeId={store.id}
        storeName={store.name}
        minimumOrderCents={store.minimumOrderCents}
      >
        <QuickViewProvider><a href="#main-content" className="sf-skip-link">
          Skip to content
        </a>
        <StorefrontHeader store={store} />
        <main id="main-content">{children}</main>
        <StorefrontFooter store={store} />
        <MobileNav />
        <Suspense fallback={null}>
          <AssistantHost store={store} />
        </Suspense>
        </QuickViewProvider>
      </CartProvider></StorefrontMotion>
    </div>
  );
}
