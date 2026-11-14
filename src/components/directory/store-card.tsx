import Image from "next/image";
import type { DirectoryStore } from "@/lib/directory/stores";
import { storeInitials } from "@/lib/store-initials";
import { cuisineLabels } from "@/lib/directory/listing-fields";
import { formatMiles } from "@/lib/directory/distance";
import styles from "./directory.module.css";

export type CardStore = DirectoryStore & { href: string; distanceMi?: number };

export function StoreCard({ store }: { store: CardStore }) {
  return (
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
        {store.distanceMi !== undefined ? <span className={styles.distance}>{formatMiles(store.distanceMi)}</span> : null}
      </span>
      {store.listingBlurb ? <span className={styles.blurb}>{store.listingBlurb}</span> : null}
      {store.cuisineTags.length > 0 ? (
        <span className={styles.cuisines}>{cuisineLabels(store.cuisineTags).join(" · ")}</span>
      ) : null}
      {store.ownerName ? <span className={styles.owner}>Run by {store.ownerName}</span> : null}
      <span className={styles.foot}>
        <span className={styles.flags}>
          {store.pickupEnabled ? <span className={styles.flag}>Pickup</span> : null}
          {store.storeDeliveryEnabled ? <span className={styles.flag}>Delivery</span> : null}
        </span>
        <span className={styles.visit} aria-hidden="true">Visit store →</span>
      </span>
    </a>
  );
}
