import { headers } from "next/headers";
import Link from "next/link";
import { findStore } from "@/lib/get-store";
import { listCategories } from "@/lib/storefront/service";
import { StorefrontShell } from "./storefront-shell";

export async function PageNotFound() {
  const slug = (await headers()).get("x-store-slug");
  const store = slug ? await findStore(slug) : null;
  if (!store) return <main className="sf-storefront"><div className="sf-container sf-not-found"><div className="sf-not-found-number" aria-hidden>404</div><h1 className="sf-page-title">Store not found</h1><p className="sf-page-intro">We could not find a store at this address.</p></div></main>;
  const categories = await listCategories();
  return <StorefrontShell store={store}><section className="sf-container sf-not-found" data-testid="page-not-found">
    <div className="sf-not-found-number" aria-hidden>404</div>
    <h2 className="sf-page-title">Page not found</h2>
    <p className="sf-page-intro">This shelf has moved. Let’s find what you came for.</p>
    <form action="/search" role="search"><label htmlFor="lost-search" className="sr-only">Search the store</label><input id="lost-search" name="q" placeholder="Try egusi, garri or plantain" /><button className="sf-button" type="submit">Search</button></form>
    <Link className="sf-text-link" href="/">Back to {store.name} →</Link>
    <h3>Explore popular aisles</h3><div className="sf-not-found-aisles">{categories.slice(0, 5).map(category => <Link className="sf-chip" key={category.id} href={`/categories/${category.slug}`}>{category.name}</Link>)}</div>
  </section></StorefrontShell>;
}
