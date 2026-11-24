import Link from "next/link";
import type { ValidatedStore } from "@/lib/get-store";
import { formatUsPhone, mapsUrl, telHref } from "@/lib/format";
import { storeContact } from "@/lib/order/delivery-address";
export function StorefrontFooter({ store }: { store: ValidatedStore }) {
  const contact = storeContact(store);
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
            {(contact.address || contact.phone) && (
              <address className="sf-footer-contact">
                {contact.address && (
                  <a href={mapsUrl(contact.address)} target="_blank" rel="noopener noreferrer">
                    {contact.address}
                  </a>
                )}
                {contact.phone && <a href={telHref(contact.phone)}>{formatUsPhone(contact.phone)}</a>}
              </address>
            )}
          </div>
          {contact.hours.length > 0 && (
            <div className="sf-footer-hours">
              <h3>Hours</h3>
              <dl>
                {contact.hours.map((line) => (
                  <div key={line.day}>
                    <dt>{line.day}</dt><dd>{line.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
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
        </div>
      </div>
    </footer>
  );
}
