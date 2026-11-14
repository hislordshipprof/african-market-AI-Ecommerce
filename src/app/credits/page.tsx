import { getStore } from "@/lib/get-store";
import catalog from "@/lib/storefront/catalog-media.json";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import Link from "next/link";

export default async function CreditsPage() {
  const store = await getStore();
  const images = [...new Map(Object.entries(catalog).filter(([,entry]) => entry.imageUrl).map(([name,entry]) => [entry.imageUrl, { name, ...entry }])).values()];
  return <StorefrontShell store={store}><div className="sf-container sf-section">
    <nav className="sf-breadcrumb" aria-label="Breadcrumb"><Link href="/">Home</Link><span>/</span><span>Photo credits</span></nav>
    <h2 className="sf-page-title">A market, through many lenses.</h2>
    <p className="sf-page-intro">Thank you to the photographers who make these shelves feel like home. Product photos represent ingredients; packaging and appearance may vary.</p>
    <div className="sf-credits-grid">{images.map(entry => <article className="sf-credit" key={entry.imageUrl}><h3>{entry.name}</h3><p>Photography by {entry.author || "See source attribution"}</p><a href={entry.source} target="_blank" rel="noreferrer">Original photograph ↗</a><p>{entry.license}</p><small>{entry.imageUrl.startsWith("/images/products/") ? "Background removed; resized to 800px WebP. Original license retained, including ShareAlike." : "Resized for display. Original background retained."}</small></article>)}</div>
    <h3 className="sf-page-title">Around the market</h3><div className="sf-credits-grid">
      {[
        ["First hero slide - Bodija Market, Ibadan", "Tunde Buremo", "https://unsplash.com/photos/a-group-of-people-standing-around-a-table-filled-with-tomatoes-cnVn4Gg4b00"],
        ["Grain market", "Tunde Buremo", "https://unsplash.com/photos/a-man-standing-under-an-umbrella-in-a-market-NgH0WKgVR0A"],
        ["Spices and herbs", "Vincent Bélanger", "https://unsplash.com/photos/spices-and-herbs-in-wooden-bowls-on-a-table-3gmr5ez2otU"],
        ["Jollof inspiration", "Keesha’s Kitchen", "https://unsplash.com/photos/a-plate-of-food-gmQfS47FBOM"],
        ["Akosombo market", "Brah Lyrix", "https://unsplash.com/photos/a-pile-of-dried-bananas-sitting-on-top-of-a-blue-table-4i4y-5G4M9Q"],
      ].map(([name, author, source]) => <article className="sf-credit" key={name}><h3>{name}</h3><p>{author}</p><a href={source}>Original photograph ↗</a><p><a href="https://unsplash.com/license">Unsplash License</a> · cropped and resized</p></article>)}
    </div><p className="sf-page-intro">The story photograph shows Bodija Market, Ibadan. It does not depict the demo store or its fictional owner.</p>
  </div></StorefrontShell>;
}
