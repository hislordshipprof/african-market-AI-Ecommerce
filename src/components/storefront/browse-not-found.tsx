import Link from "next/link";
import { EmptyState } from "./primitives";

export function BrowseNotFound({ item }: { item: string }) {
  return (
    <main className="sf-storefront sf-section">
      <div className="sf-container">
        <EmptyState
          title={`This ${item} isn't on the shelf`}
          description="The link may have changed, or this store no longer carries it. There's more to discover in the aisles."
        >
          <Link href="/categories" className="sf-button">
            Explore the aisles
          </Link>
          <Link href="/" className="sf-text-link">
            Back to the storefront
          </Link>
        </EmptyState>
      </div>
    </main>
  );
}
