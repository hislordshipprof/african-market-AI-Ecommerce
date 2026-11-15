import Image from "next/image";
import { directoryLink } from "@/lib/directory/attribution";
import { ArrowRight, Check, ShoppingBag, Truck } from "lucide-react";
import type { DirectoryStore } from "@/lib/directory/stores";
import { storeInitials } from "@/lib/store-initials";
import { cuisineLabels } from "@/lib/directory/listing-fields";
import { formatMiles } from "@/lib/directory/distance";
import { deliveryLine } from "@/lib/directory/delivery-line";
import { OpenNow } from "./open-now";
import styles from "./directory.module.css";

/** `distanceMi` and `deliversToYou` come only from a near me search (#452). */
export type CardStore = DirectoryStore & { href: string; distanceMi?: number; deliversToYou?: boolean };

// Store photos ship as .svg placeholders until the owner adds one, as on the storefront's story strip.
const ownerPhoto = (url: string | null) => (url && !url.endsWith(".svg") ? url : null);

/** The directory's one card (#453, #690): the home, its search results and the state and city pages. */
export function StoreCard({ store }: { store: CardStore }) {
  const delivery = deliveryLine(store);
  const photo = ownerPhoto(store.ownerPhotoUrl);
  const cuisines = cuisineLabels(store.cuisineTags);
  return (
    <a className={styles.card} href={directoryLink(store.href)}>
      <span className={styles.cardHead}>
        {photo ? (
          <Image className={styles.face} src={photo} alt="" width={56} height={56} unoptimized />
        ) : store.logoUrl ? (
          <Image className={styles.logo} src={store.logoUrl} alt="" width={56} height={56} unoptimized />
        ) : (
          <span className={styles.initials} aria-hidden="true">{storeInitials(store.name)}</span>
        )}
        <span className={styles.heading}>
          <span className={styles.name}>{store.name}</span>
          <span className={styles.place}>{store.neighborhood?.trim() || [store.city, store.state].filter(Boolean).join(", ")}</span>
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
      {store.ownerName || store.ownerStory ? (
        <span className={styles.owner}>
          {store.ownerName ? <span className={styles.ownerName}>Run by {store.ownerName}</span> : null}
          {store.ownerStory ? <span className={styles.story}>{store.ownerStory}</span> : null}
        </span>
      ) : null}
      {cuisines.length > 0 || store.pickupEnabled || delivery ? (
        <span className={styles.flags}>
          {cuisines.map((label) => <span key={label} className={styles.tag}>{label}</span>)}
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
      ) : null}
      <span className={styles.visit} aria-hidden="true">
        Visit {store.name}
        <ArrowRight size={18} />
      </span>
    </a>
  );
}
