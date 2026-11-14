import type { ReactNode } from "react";
import { groceryStoreJsonLd, jsonLdHtml } from "@/lib/directory/json-ld";
import { StoreCard, type CardStore } from "./store-card";
import styles from "./directory.module.css";

type Crumb = { label: string; href?: string };
type PlaceLink = { name: string; href: string; count: number };

/** A state or city page of the Store directory (#451): server-rendered, no client script of its own. */
export function DirectoryPlace({ crumbs, title, lede, stores, places }: {
  crumbs: Crumb[];
  title: string;
  lede: string;
  stores: CardStore[];
  places?: { title: string; links: PlaceLink[] };
}) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <a href="/" className={styles.wordmark}>African Markets</a>
      </header>
      <main className={styles.main}>
        <nav aria-label="Breadcrumb" className={styles.crumbs}>
          <ol>
            {crumbs.map((crumb) => (
              <li key={crumb.label}>
                {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current="page">{crumb.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <section className={styles.intro}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.lede}>{lede}</p>
        </section>
        <section aria-labelledby="place-stores" className={styles.results}>
          <h2 id="place-stores" className={styles.count}>{stores.length === 1 ? "1 store" : `${stores.length} stores`}</h2>
          <ul className={styles.grid}>
            {stores.map((store) => (
              <li key={store.slug}>
                <StoreCard store={store} />
                <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(groceryStoreJsonLd(store)) }} />
              </li>
            ))}
          </ul>
        </section>
        {places && places.links.length > 0 ? <PlaceLinks {...places} /> : null}
      </main>
    </div>
  );
}

function PlaceLinks({ title, links }: { title: string; links: PlaceLink[] }): ReactNode {
  return (
    <section aria-labelledby="place-links" className={styles.results}>
      <h2 id="place-links" className={styles.resultsTitle}>{title}</h2>
      <ul className={styles.placeLinks}>
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href} className={styles.placeLink}>
              {link.name}
              <span className={styles.placeCount}>{link.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
