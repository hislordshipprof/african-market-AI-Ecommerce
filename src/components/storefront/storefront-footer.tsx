import Link from "next/link";
import type { ValidatedStore } from "@/lib/get-store";
export function StorefrontFooter({ store }: { store: ValidatedStore }) {
  return (
    <footer className="sf-footer" data-testid="storefront-footer">
      <div className="sf-container">
        <div className="sf-footer-top">
          <div>
            <h2 className="sf-footer-brand">{store.name}</h2>
            <p>
              {store.neighborhood ||
                "Your independent neighborhood grocery store."}
            </p>
          </div>
          <nav aria-label="Footer">
            <Link href="/">Home</Link>
            <Link href="/categories">All aisles</Link>
            <Link href="/search">Search</Link>
            {(store.ownerName || store.ownerStory) && <Link href="/#our-story">Our story</Link>}
            <Link href="/credits">Photo credits</Link>
          </nav>
        </div>
        <div className="sf-footer-bottom">
          <span>
            © {new Date().getFullYear()} {store.name}
          </span>
          <span>Powered by the Platform</span>
        </div>
      </div>
    </footer>
  );
}
