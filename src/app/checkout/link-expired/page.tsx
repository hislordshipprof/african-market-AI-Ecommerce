import Link from "next/link";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStore } from "@/lib/get-store";

export const dynamic = "force-dynamic";

/** Where a used or expired WhatsApp checkout link lands (#559). */
export default async function CheckoutLinkExpiredRoute() {
  const store = await getStore();
  return (
    <StorefrontShell store={store}>
      <div className="sf-container flow-page">
        <div className="flow-closed">
          <h1>This checkout link has expired</h1>
          <p>
            Links sent on WhatsApp open checkout once and work for 60 minutes. Message {store.name} on WhatsApp
            and ask to check out for a new link, or shop here on the website.
          </p>
          <div className="flow-closed-actions">
            <Link href="/" className="sf-button">
              Explore the store
            </Link>
            <Link href="/cart" className="sf-text-link">
              Go to basket
            </Link>
          </div>
        </div>
      </div>
    </StorefrontShell>
  );
}
