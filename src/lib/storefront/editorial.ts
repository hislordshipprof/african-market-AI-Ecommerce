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
  fish: "https://images.unsplash.com/photo-1689187015184-a9bc081f3de6?auto=format&fit=crop&w=1000&q=80",
};

export function photoOrFallback(
  url: string | null | undefined,
  fallback = editorial.market,
) {
  // Old demo vector assets are deliberately retired. Store-uploaded photos still win.
  return url && !url.endsWith(".svg") && !url.includes("wikimedia.org/") ? url : fallback;
}
