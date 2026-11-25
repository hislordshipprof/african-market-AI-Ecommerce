// Verified source pages, authors and licenses are recorded in public/images/CREDITS.md.
export const editorial = {
  spices:
    "https://images.unsplash.com/photo-1677599082447-6549af4c5454?auto=format&fit=crop&w=640&q=75",
  jollof:
    "https://images.unsplash.com/photo-1665556899022-9761f95769e5?auto=format&fit=crop&w=800&q=80",
  market:
    "/images/market-bodija.webp",
  grains:
    "https://images.unsplash.com/photo-1734255074937-4b446b8dcf18?auto=format&fit=crop&w=1000&q=80",
};

/**
 * Hero photographs (#836): real African and Caribbean groceries, cropped full-frame so produce fills every width.
 * `focus` is the CSS object-position that keeps each photo's subject in frame.
 */
export const heroPhotos = {
  mamaNgoziYams: { src: "/images/hero/mama-ngozi-yams.webp", focus: "60% 55%" },
  mamaNgoziSpices: { src: "/images/hero/mama-ngozi-spices.webp", focus: "65% 60%" },
  mamaNgoziPeppers: { src: "/images/hero/mama-ngozi-peppers.webp", focus: "60% 60%" },
  tanteMarieMarket: { src: "/images/hero/tante-marie-market.webp", focus: "60% 65%" },
  tanteMariePlantains: { src: "/images/hero/tante-marie-plantains.webp", focus: "50% 60%" },
  tanteMarieAckee: { src: "/images/hero/tante-marie-ackee.webp", focus: "60% 50%" },
};

export function heroFocus(url: string) {
  return Object.values(heroPhotos).find((photo) => photo.src === url)?.focus ?? "50% 50%";
}

export const isRetiredRemote = (url: string) => /wikimedia\.org\//i.test(url);

export function photoOrFallback(
  url: string | null | undefined,
  fallback = editorial.market,
) {
  return url && !url.endsWith(".svg") && !isRetiredRemote(url) ? url : fallback;
}
