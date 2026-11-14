import Image from "next/image";
import type { DirectoryStore } from "@/lib/directory/stores";
import { storeInitials } from "@/lib/store-initials";
import styles from "./directory.module.css";

export function DirectoryHome({ stores }: { stores: (DirectoryStore & { href: string })[] }) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <span className={styles.wordmark}>African Markets</span>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <h1 className={styles.title}>Find an African grocery store near you</h1>
          <p className={styles.lede}>
            Independent stores across the US. Each runs its own shop: pick one, then order pickup or delivery straight from that store.
          </p>
        </section>
        <section aria-labelledby="directory-stores">
          <h2 id="directory-stores" className={styles.count}>
            {stores.length === 1 ? "1 store" : `${stores.length} stores`}
          </h2>
          {stores.length === 0 ? (
            <p className={styles.empty}>No stores are listed yet. Check back soon.</p>
          ) : (
            <ul className={styles.grid}>
              {stores.map((store) => (
                <li key={store.slug}>
                  <a className={styles.card} href={store.href}>
                    <span className={styles.cardHead}>
                      {store.logoUrl ? (
                        <Image className={styles.logo} src={store.logoUrl} alt="" width={48} height={48} unoptimized />
                      ) : (
                        <span className={styles.initials} aria-hidden="true">{storeInitials(store.name)}</span>
                      )}
                      <span className={styles.heading}>
                        <span className={styles.name}>{store.name}</span>
                        <span className={styles.place}>{[store.city, store.state].filter(Boolean).join(", ")}</span>
                      </span>
                    </span>
                    {store.listingBlurb ? <span className={styles.blurb}>{store.listingBlurb}</span> : null}
                    {store.ownerName ? <span className={styles.owner}>Run by {store.ownerName}</span> : null}
                    <span className={styles.foot}>
                      <span className={styles.flags}>
                        {store.pickupEnabled ? <span className={styles.flag}>Pickup</span> : null}
                        {store.storeDeliveryEnabled ? <span className={styles.flag}>Delivery</span> : null}
                      </span>
                      <span className={styles.visit} aria-hidden="true">Visit store →</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
