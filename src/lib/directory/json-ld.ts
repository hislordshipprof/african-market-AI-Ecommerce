type Described = {
  name: string;
  href: string;
  logoUrl: string | null;
  listingBlurb: string | null;
  city: string | null;
  state: string | null;
};

/** schema.org GroceryStore for a directory card. City and state only: the street address stays private (D5). */
export function groceryStoreJsonLd(store: Described) {
  return {
    "@context": "https://schema.org",
    "@type": "GroceryStore",
    name: store.name,
    url: store.href,
    ...(store.logoUrl ? { image: new URL(store.logoUrl, store.href).toString() } : {}),
    ...(store.listingBlurb ? { description: store.listingBlurb } : {}),
    address: {
      "@type": "PostalAddress",
      ...(store.city ? { addressLocality: store.city } : {}),
      ...(store.state ? { addressRegion: store.state } : {}),
      addressCountry: "US",
    },
  };
}

/** JSON for a script tag; `<` is escaped so an owner's blurb cannot end the tag. */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
