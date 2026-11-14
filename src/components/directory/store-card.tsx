import Image from "next/image";
import { Check, ShoppingBag, Truck, UserRound } from "lucide-react";
import type { DirectoryStore } from "@/lib/directory/stores";
import { storeInitials } from "@/lib/store-initials";
import { cuisineLabels } from "@/lib/directory/listing-fields";
import { formatMiles } from "@/lib/directory/distance";
import { deliveryLine } from "@/lib/directory/delivery-line";
import { OpenNow } from "./open-now";
import styles from "./directory.module.css";

/** `distanceMi` and `deliversToYou` come only from a near me search (#452). */
export type CardStore = DirectoryStore & { href: string; distanceMi?: number; deliversToYou?: boolean };

export function StoreCard({ store }: { store: CardStore }) {
  const delivery = deliveryLine(store);
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
          <OpenNow hours={store.hours} timezone={store.timezone} />
        </span>
        {store.distanceMi !== undefined ? (
          <span className={styles.distance}>
            {formatMiles(store.distanceMi)}
            <span className={styles.srOnly}> away</span>
          </span>
        ) : null}
      </span>
      {store.listingBlurb ? <span className={styles.blurb}>{store.listingBlurb}</span> : null}
      {store.cuisineTags.length > 0 ? (
        <span className={styles.cuisines}>{cuisineLabels(store.cuisineTags).join(" · ")}</span>
      ) : null}
      {store.ownerName || store.ownerStory ? <Owner store={store} /> : null}
      <span className={styles.foot}>
        <span className={styles.flags}>
          {store.pickupEnabled ? (
            <span className={styles.flag}><ShoppingBag aria-hidden="true" size={14} />Pickup</span>
          ) : null}
          {delivery ? (
            <span className={styles.flag} data-maybe={delivery === "Courier may be available" || undefined}>
              {delivery === "Delivers to you" ? <Check aria-hidden="true" size={14} /> : <Truck aria-hidden="true" size={14} />}
              {delivery}
            </span>
          ) : null}
        </span>
        <span className={styles.visit} aria-hidden="true">Visit store</span>
      </span>
    </a>
  );
}

// Store photos ship as .svg placeholders until the owner adds one, as on the storefront's story strip.
function Owner({ store }: { store: CardStore }) {
  const photo = store.ownerPhotoUrl && !store.ownerPhotoUrl.endsWith(".svg") ? store.ownerPhotoUrl : null;
  return (
    <span className={styles.owner}>
      {photo ? (
        <Image className={styles.face} src={photo} alt="" width={40} height={40} unoptimized />
      ) : (
        // Not initials: two letters such as "NO" read as a word.
        <span className={styles.face} aria-hidden="true"><UserRound size={20} strokeWidth={1.75} /></span>
      )}
      <span className={styles.ownerText}>
        {store.ownerName ? <span className={styles.ownerName}>Run by {store.ownerName}</span> : null}
        {store.ownerStory ? <span className={styles.story}>{store.ownerStory}</span> : null}
      </span>
    </span>
  );
}
