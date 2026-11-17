import { Suspense, type ReactNode } from "react";
import { AssistantHost } from "./assistant/assistant-host";
import type { ValidatedStore } from "@/lib/get-store";
import { CartProvider } from "./cart-provider";
import { MobileNav } from "./mobile-nav";
import { StorefrontHeader } from "./storefront-header";
import { StorefrontFooter } from "./storefront-footer";
import { StorefrontMotion } from "./motion-provider";
import { QuickViewProvider } from "./quick-view-provider";
import { InstallPrompt } from "../pwa/install-prompt-lazy";
import { AssistantSlot } from "./assistant/assistant-slot";

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
        {/* On phones the AI entry sits here in the flow; pages with their own slot win. */}
        <AssistantSlot label="Shop with AI" phoneOnly />
        <main id="main-content">{children}</main>
        <StorefrontFooter store={store} />
        <MobileNav />
        <InstallPrompt storeName={store.name} />
        <Suspense fallback={null}>
          <AssistantHost store={store} />
        </Suspense>
        </QuickViewProvider>
      </CartProvider></StorefrontMotion>
    </div>
  );
}
