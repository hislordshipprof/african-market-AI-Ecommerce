import Link from "next/link";
import { NearMe, type StateGroup } from "./near-me";
import { StoreCard, type CardStore } from "./store-card";
import styles from "./directory.module.css";

export function DirectoryHome({ stores, states }: { stores: CardStore[]; states: StateGroup[] }) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <span className={styles.wordmark}>African Markets</span>
        <Link className={styles.sell} href="/sell">Sell on African Markets</Link>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <h1 className={styles.title}>Find an African grocery store near you</h1>
          <p className={styles.lede}>
            Independent stores across the US. Each runs its own shop: pick one, then order pickup or delivery straight from that store.
          </p>
        </section>
        <NearMe states={states}>
          <section aria-labelledby="directory-stores">
            <h2 id="directory-stores" className={styles.count}>
              {stores.length === 1 ? "1 store" : `${stores.length} stores`}
            </h2>
            {stores.length === 0 ? (
              <p className={styles.empty}>No stores are listed yet. Check back soon.</p>
            ) : (
              <ul className={styles.grid}>
                {stores.map((store) => (
                  <li key={store.slug}><StoreCard store={store} /></li>
                ))}
              </ul>
            )}
          </section>
        </NearMe>
      </main>
    </div>
  );
}
